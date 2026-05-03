/**
 * rill upgrade: Upgrade an installed extension to a newer version.
 *
 * Constraints (FR-EXT-6, UXI-EXT-6):
 * - assertBootstrapped pre-check before any npm subprocess (EC-17)
 * - Mount existence pre-check before any npm subprocess (EC-18)
 * - Local-path mounts rejected immediately; no npm, no config edit (EC-19)
 * - npm uses --prefix so project-root package.json is never modified (NFR-EXT-6)
 * - Config edit + validation < 1s (NFR-EXT-2)
 * - applyMountEdit rolls back on validation failure (EC-21)
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  assertBootstrapped,
  BootstrapMissingError,
  resolvePrefix,
} from './prefix.js';
import { extractPackageName, isLocalPath } from './mount-derive.js';
import { readConfigSnapshot, applyMountEdit, hasMount } from './config-edit.js';
import { npmInstall, NpmNotFoundError } from './npm-runner.js';

// ============================================================
// HELP TEXT
// ============================================================

const USAGE = `\
Usage: rill upgrade <mount> [--pin] [--range <semver>]

Upgrade an installed extension to a newer version. Pinned mounts (e.g.
"pkg@1.2.3" with no caret/range) are a no-op; re-pin with
\`rill install <pkg>@latest --pin --as <mount>\`.

Arguments:
  <mount>          Mount name as it appears in rill-config.json (e.g. datetime)

Options:
  --pin            Record exact installed version (no caret)
  --exact          Deprecated alias for --pin (will be removed in 0.20)
  --range <semver> Install and record a custom semver range verbatim
  --help           Show this help message
`;

/**
 * Detect whether a mount value is pinned to an exact version.
 *
 * A mount value is "pinned" when its version qualifier is a bare semver
 * (e.g. "@rcrsr/rill-ext-foo@1.2.3" or "pkg@1.2.3-beta.1") with no caret,
 * tilde, or range markers. Local-path mounts and bare package names without
 * any version are not pinned.
 */
function isPinnedMountValue(value: string): boolean {
  const atIndex = value.indexOf('@', 1);
  if (atIndex === -1) return false;
  const versionPart = value.slice(atIndex + 1);
  return /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(versionPart);
}

// ============================================================
// IMPLEMENTATION
// ============================================================

/**
 * Upgrade an extension in the current project.
 *
 * Implements UXI-EXT-6 order of operations per spec FR-EXT-6.
 *
 * EC-21 compliance: applyMountEdit rolls back rill-config.json on validation
 * failure before re-throwing. The caller (this function) emits the
 * UXT-EXT-6-style error + rollback messages and returns 1.
 */
export async function run(argv: string[]): Promise<number> {
  // ---- Argument parsing ----
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      pin: { type: 'boolean', default: false },
      exact: { type: 'boolean', default: false },
      range: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values['help'] === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const mount = positionals[0];
  if (mount === undefined || mount === '') {
    process.stderr.write('Usage: rill upgrade <mount>\n');
    process.stderr.write('  Missing required argument: <mount>\n');
    return 1;
  }

  // P2-1: --exact is deprecated; warn once before continuing.
  if (values['exact'] === true) {
    process.stderr.write(
      'warning: --exact is deprecated, use --pin (will be removed in 0.20)\n'
    );
  }

  const pin = values['pin'] === true || values['exact'] === true;
  const rangeArg =
    typeof values['range'] === 'string' ? values['range'] : undefined;

  // [ASSUMPTION] Spec does not explicitly assign EC-12 to upgrade, but
  // --pin/--exact and --range are still mutually exclusive by the same logic.
  // Documented as a defensive check.
  if (pin && rangeArg !== undefined) {
    process.stderr.write('--pin/--exact and --range are mutually exclusive\n');
    return 1;
  }

  const projectDir = process.cwd();
  const prefix = resolvePrefix(projectDir);

  // ---- Step 1: assertBootstrapped ----
  // EC-17: .rill/npm/ missing -> UXT-EXT-5 verbatim, exit 1
  try {
    assertBootstrapped(projectDir);
  } catch (err) {
    if (err instanceof BootstrapMissingError) {
      process.stderr.write('✗ .rill/npm/ not found\n');
      process.stderr.write(
        "  Run 'rill bootstrap' first to initialize the project\n"
      );
      return 1;
    }
    throw err;
  }

  // ---- Step 2: Read config snapshot + mount existence check ----
  const snapshot = await readConfigSnapshot(projectDir);

  // EC-18: Mount not in config -> UXT-EXT-8 verbatim, exit 1
  if (!hasMount(snapshot, mount)) {
    process.stderr.write(`✗ Mount '${mount}' not found in rill-config.json\n`);
    process.stderr.write("  Run 'rill list' to see installed extensions\n");
    return 1;
  }

  // ---- Step 3: Read current value + local-path detection ----
  const currentValue = snapshot.parsed.extensions?.mounts?.[mount] ?? mount;

  // EC-19: Local-path mount -> UXT-EXT-10 verbatim, no npm, no config edit
  if (isLocalPath(currentValue)) {
    process.stderr.write(
      `✗ Mount '${mount}' is a local-path source ('${currentValue}')\n`
    );
    process.stderr.write(
      `  Local-path mounts cannot be upgraded. Edit the source directly, then re-run 'rill install ${currentValue} --as ${mount}'.\n`
    );
    return 1;
  }

  // P2-3: Pinned mounts are a no-op for upgrade.
  // The user pinned on purpose; re-pin via 'rill install <pkg>@latest --pin'.
  if (isPinnedMountValue(currentValue)) {
    const atIndex = currentValue.indexOf('@', 1);
    const pkgName =
      atIndex === -1 ? currentValue : currentValue.slice(0, atIndex);
    const version = atIndex === -1 ? '?' : currentValue.slice(atIndex + 1);
    process.stdout.write(
      `mount '${mount}' is pinned to ${version}; upgrade is a no-op.\n` +
        `Use 'rill install ${pkgName}@latest --pin --as ${mount}' to repin.\n`
    );
    return 0;
  }

  // ---- Step 4: Print current value ----
  process.stdout.write(`ℹ Current: ${currentValue}\n`);

  // ---- Step 5: Compute install spec for npm ----
  const pkgName = extractPackageName(currentValue);

  let installSpec: string;
  if (rangeArg !== undefined) {
    // --range: install at the specific range so npm fetches that version set
    installSpec = `${pkgName}@${rangeArg}`;
  } else {
    // Default, --pin, or --exact: always fetch latest from npm
    installSpec = `${pkgName}@latest`;
  }

  // ---- Step 6: Print install start message ----
  process.stdout.write(`ℹ Installing ${installSpec}...\n`);

  // ---- Step 7: Run npm install ----
  let npmResult: { exitCode: number };
  try {
    npmResult = await npmInstall({ spec: installSpec, prefix });
  } catch (err) {
    if (err instanceof NpmNotFoundError) {
      // EC-31 mapping
      process.stderr.write('npm not found on PATH; install Node.js with npm\n');
      return 1;
    }
    throw err;
  }

  // EC-20: npm non-zero exit -> propagate; npm already streamed stderr; no rollback line
  if (npmResult.exitCode !== 0) {
    return npmResult.exitCode;
  }

  // ---- Step 8: Read new installed version ----
  const installedPkgJsonPath = path.join(
    prefix,
    'node_modules',
    pkgName,
    'package.json'
  );
  let newVersion: string;
  try {
    const pkgJsonText = fs.readFileSync(installedPkgJsonPath, 'utf8');
    const pkgJson = JSON.parse(pkgJsonText) as { version?: string };
    newVersion = pkgJson.version ?? '';
  } catch {
    process.stderr.write(
      `✗ Failed to read installed package.json at ${installedPkgJsonPath}\n`
    );
    return 1;
  }

  // ---- Step 9: Compute new mount value ----
  let newMountValue: string;
  if (rangeArg !== undefined) {
    // --range: record the verbatim range argument
    newMountValue = `${pkgName}@${rangeArg}`;
  } else if (pin) {
    // --pin / --exact: exact version, no caret
    newMountValue = `${pkgName}@${newVersion}`;
  } else {
    // Default: caret constraint
    newMountValue = `${pkgName}@^${newVersion}`;
  }

  // ---- Step 10: Already at latest check (AC-B10) ----
  if (newMountValue === currentValue) {
    process.stdout.write('Already at latest\n');
    return 0;
  }

  // ---- Step 11: Print installed confirmation ----
  process.stdout.write(`✓ Installed ${pkgName}@${newVersion}\n`);

  // ---- Step 12: Apply config edit with rollback on failure ----
  try {
    await applyMountEdit(
      snapshot,
      { kind: 'overwrite', mount, value: newMountValue },
      prefix
    );
  } catch (err) {
    // EC-21: validation failed; applyMountEdit already rolled back the file
    const errName = err instanceof Error ? err.constructor.name : 'Error';
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`✗ Config validation failed: ${errName}: ${errMsg}\n`);
    process.stderr.write('✓ Rolled back rill-config.json\n');
    // [ASSUMPTION] Guidance line adapted from install's UXT-EXT-6 for upgrade context.
    // Install says "Check the extension or use --as to pick a different mount path".
    // Upgrade equivalent directs user to check the upgrade target or use --range.
    process.stderr.write(
      '  Check the upgrade target or use --range to pick a different version\n'
    );
    return 1;
  }

  // ---- Step 13: Success output ----
  process.stdout.write(`✓ Updated mount '${mount}' to '${newMountValue}'\n`);
  process.stdout.write('✓ Verified config loads cleanly\n');

  return 0;
}
