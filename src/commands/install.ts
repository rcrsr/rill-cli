/**
 * rill install: Install an extension from npm registry or local path.
 *
 * Constraints (FR-EXT-2/3/4, UXI-EXT-2/3/4):
 * - assertBootstrapped pre-check before any npm subprocess
 * - Collision pre-check before spawning npm (EC-8)
 * - npm subprocess uses --prefix so project-root package.json is never modified (NFR-EXT-6)
 * - Config edit + validation < 1s (NFR-EXT-2)
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  assertBootstrapped,
  BootstrapMissingError,
  resolvePrefix,
} from './prefix.js';
import { deriveMount, isLocalPath } from './mount-derive.js';
import {
  readConfigSnapshot,
  applyMountEdit,
  hasMount,
  ConfigWriteError,
} from './config-edit.js';
import { npmInstall, NpmNotFoundError } from './npm-runner.js';

// ============================================================
// HELP TEXT
// ============================================================

const USAGE = `\
Usage: rill install <pkg-or-path> [--as <mount>] [--pin] [--exact] [--range <semver>]

Install an extension package and mount it in rill-config.json.

Arguments:
  <pkg-or-path>   npm package name (e.g. @rcrsr/rill-ext-datetime) or local path (e.g. ./my-ext)

Options:
  --as <mount>    Override the mount path (default: derived from package name)
  --pin           Record exact installed version (no caret)
  --exact         Alias for --pin
  --range <semver> Record a custom semver range verbatim
  --help          Show this help message
`;

// ============================================================
// IMPLEMENTATION
// ============================================================

/**
 * Extract the bare package name from a registry specifier.
 *
 * Strips trailing version qualifier: the part after the last '@' that is NOT
 * in the leading scope position.
 *
 * Examples:
 *   "@rcrsr/rill-ext-datetime"       -> "@rcrsr/rill-ext-datetime"
 *   "@rcrsr/rill-ext-datetime@0.19.0"-> "@rcrsr/rill-ext-datetime"
 *   "my-pkg@^1.0.0"                  -> "my-pkg"
 *   "my-pkg"                         -> "my-pkg"
 */
function extractPackageName(specifier: string): string {
  // Scoped packages start with '@'; the leading '@' is NOT a version delimiter.
  // Find the last '@' that appears AFTER position 1 (so it isn't the scope prefix).
  const atIndex = specifier.indexOf('@', 1);
  if (atIndex === -1) {
    return specifier;
  }
  return specifier.slice(0, atIndex);
}

/**
 * Install an extension into the current project.
 *
 * Implements UXI-EXT-2 (registry) and UXI-EXT-3 (local path) order of operations.
 */
export async function run(argv: string[]): Promise<number> {
  // ---- Argument parsing ----
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      as: { type: 'string' },
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

  const specifier = positionals[0];
  if (specifier === undefined || specifier === '') {
    process.stderr.write('Usage: rill install <pkg-or-path>\n');
    process.stderr.write('  Missing required argument: <pkg-or-path>\n');
    return 1;
  }

  const pin = values['pin'] === true || values['exact'] === true;
  const rangeArg =
    typeof values['range'] === 'string' ? values['range'] : undefined;

  // EC-12: --pin/--exact and --range are mutually exclusive
  if (pin && rangeArg !== undefined) {
    process.stderr.write('--pin/--exact and --range are mutually exclusive\n');
    return 1;
  }

  const asOverride =
    typeof values['as'] === 'string' ? values['as'] : undefined;
  const projectDir = process.cwd();
  const prefix = resolvePrefix(projectDir);

  // ---- Step 1: assertBootstrapped ----
  // EC-7: .rill/npm/ missing -> UXT-EXT-5 verbatim
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

  // ---- Step 2: Compute mount ----
  const mount = deriveMount(specifier, asOverride);

  // ---- Step 3: Read config snapshot + collision pre-check ----
  const snapshot = await readConfigSnapshot(projectDir);

  const mountExists = hasMount(snapshot, mount);
  if (mountExists && asOverride === undefined) {
    // EC-8: Mount collision without --as -> UXT-EXT-4 verbatim
    process.stderr.write(`✗ Mount path '${mount}' already exists\n`);
    process.stderr.write(
      '  Use --as <path> to override, or edit rill-config.json manually\n'
    );
    return 1;
  }

  // Determine edit kind: overwrite when --as was supplied and mount already exists
  const kind: 'add' | 'overwrite' =
    mountExists && asOverride !== undefined ? 'overwrite' : 'add';

  // ---- Step 4: Determine if local path ----
  const local = isLocalPath(specifier);

  if (local) {
    // UXT-EXT-3 first line
    process.stdout.write(`ℹ Installing ${mount} from ${specifier}...\n`);
  }
  // Registry path: no "ℹ Installing" line here.
  // npm streams its own progress via stdio: 'inherit'.
  // UXT-EXT-2 first line is emitted after the version is resolved (step 6).

  // ---- Step 5: Spawn npm ----
  let npmSpec: string;
  if (local) {
    // For local paths, resolve to absolute path for npm install
    npmSpec = path.resolve(projectDir, specifier);
  } else {
    npmSpec = specifier;
  }

  let npmResult: { exitCode: number };
  try {
    npmResult = await npmInstall({ spec: npmSpec, prefix });
  } catch (err) {
    if (err instanceof NpmNotFoundError) {
      // EC-31
      process.stderr.write('npm not found on PATH; install Node.js with npm\n');
      return 1;
    }
    throw err;
  }

  if (npmResult.exitCode !== 0) {
    // EC-9: propagate npm exit code; npm already streamed its stderr
    return npmResult.exitCode;
  }

  // ---- Step 6: Read installed package.json version (registry only) ----
  let installedVersion: string | undefined;
  let pkgName: string;

  if (local) {
    // For local path, derive package name from the mount (basename of path)
    pkgName = mount;
  } else {
    pkgName = extractPackageName(specifier);

    const installedPkgJsonPath = path.join(
      prefix,
      'node_modules',
      pkgName,
      'package.json'
    );
    try {
      const pkgJsonText = fs.readFileSync(installedPkgJsonPath, 'utf8');
      const pkgJson = JSON.parse(pkgJsonText) as { version?: string };
      installedVersion = pkgJson.version;
    } catch {
      // If we can't read the installed package.json, proceed without a version.
      // applyMountEdit will still record whatever value we compute below.
    }
  }

  // ---- Step 7: Compute mount value ----
  let value: string;
  if (local) {
    // Local path: record relative path verbatim, no version constraint
    value = specifier;
  } else if (rangeArg !== undefined) {
    // --range: use verbatim semver range
    value = `${pkgName}@${rangeArg}`;
  } else if (pin) {
    // --pin / --exact: exact version, no caret
    value =
      installedVersion !== undefined
        ? `${pkgName}@${installedVersion}`
        : pkgName;
  } else {
    // Default: caret constraint
    value =
      installedVersion !== undefined
        ? `${pkgName}@^${installedVersion}`
        : pkgName;
  }

  // ---- Step 8: Print install confirmation ----
  if (local) {
    // UXT-EXT-3 second line
    process.stdout.write(
      `✓ Installed to .rill/npm/node_modules/${mount} (symlinked)\n`
    );
  } else {
    // UXT-EXT-2 first line: emitted here, after version is resolved from package.json
    const versionSuffix =
      installedVersion !== undefined ? `@${installedVersion}` : '';
    process.stdout.write(`ℹ Installing ${pkgName}${versionSuffix}...\n`);
    // UXT-EXT-2 second line
    process.stdout.write(`✓ Installed to .rill/npm/node_modules/${pkgName}\n`);
  }

  // ---- Step 9: Apply mount edit + validate ----
  try {
    await applyMountEdit(snapshot, { kind, mount, value }, prefix);
  } catch (err) {
    if (err instanceof ConfigWriteError) {
      // EC-11: writeFileSync failed after npm install — out-of-sync state
      process.stderr.write(
        '✗ Failed to write rill-config.json after npm install. Package state and config are out of sync.\n'
      );
      process.stderr.write(
        `  Manually update mounts.${mount} or re-run after resolving the filesystem error.\n`
      );
      return 1;
    }
    // EC-10: validation error (MountValidationError / NamespaceCollisionError)
    // applyMountEdit already performed rollback before re-throwing
    const errName = err instanceof Error ? err.constructor.name : 'Error';
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`✗ Config validation failed: ${errName}: ${errMsg}\n`);
    process.stderr.write('✓ Rolled back rill-config.json\n');
    process.stderr.write(
      '  Check the extension or use --as to pick a different mount path\n'
    );
    return 1;
  }

  // ---- Step 10: Success output ----
  process.stdout.write(`✓ Mounted as '${mount}' in rill-config.json\n`);
  process.stdout.write('✓ Verified config loads cleanly\n');

  // UXT-EXT-2: registry-only "Ready to use" line (not emitted for local path per UXT-EXT-3)
  if (!local) {
    process.stdout.write(`Ready to use: use:${mount}\n`);
  }

  return 0;
}
