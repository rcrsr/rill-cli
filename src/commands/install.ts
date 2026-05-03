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
import {
  deriveMount,
  extractPackageName,
  isLocalPath,
  looksLikeLocalFilePath,
} from './mount-derive.js';
import {
  readConfigSnapshot,
  applyMountEdit,
  hasMount,
  ConfigNotFoundError,
  ConfigWriteError,
} from './config-edit.js';
import { npmInstall, NpmNotFoundError } from './npm-runner.js';

// ============================================================
// HELP TEXT
// ============================================================

const USAGE = `\
Usage: rill install <pkg-or-path> [--as <mount>] [--pin] [--range <semver>] [--dry-run]

Install an extension package and mount it in rill-config.json.

Arguments:
  <pkg-or-path>   One of:
                    - npm package name        e.g. @rcrsr/rill-ext-datetime
                    - local directory path    e.g. ./my-ext
                    - single-file source      e.g. ./extensions/crawler.ts (requires --as)

Options:
  --as <mount>    Override the mount path (default: derived from package name).
                  Required when <pkg-or-path> is a single-file source.
  --pin           Record exact installed version (no caret). Registry installs only.
  --exact         Deprecated alias for --pin (will be removed in 0.20).
  --range <semver> Record a custom semver range verbatim. Registry installs only.
  --dry-run       Print what would be done without writing config or running npm.
  --help          Show this help message
`;

// ============================================================
// IMPLEMENTATION
// ============================================================

/**
 * Install a single-file local source (P0-3).
 *
 * Skips npm entirely; writes the path verbatim into rill-config.json. The
 * caller has already validated --as and rejected version flags.
 */
async function installLocalFile(opts: {
  specifier: string;
  asOverride: string;
  projectDir: string;
  prefix: string;
  dryRun: boolean;
}): Promise<number> {
  const { specifier, asOverride, projectDir, prefix, dryRun } = opts;

  // Verify the file actually exists; npm-less install can't catch this otherwise.
  const absPath = path.resolve(projectDir, specifier);
  if (!fs.existsSync(absPath)) {
    process.stderr.write(`✗ File not found: ${specifier}\n`);
    return 1;
  }

  let snapshot: Awaited<ReturnType<typeof readConfigSnapshot>>;
  try {
    snapshot = await readConfigSnapshot(projectDir);
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      process.stderr.write('✗ rill-config.json not found\n');
      process.stderr.write(
        "  Run 'rill bootstrap' first to initialize the project\n"
      );
      return 1;
    }
    throw err;
  }
  const mountExists = hasMount(snapshot, asOverride);
  const kind: 'add' | 'overwrite' = mountExists ? 'overwrite' : 'add';

  if (dryRun) {
    process.stdout.write(`[dry-run] mount: ${asOverride}\n`);
    process.stdout.write(`[dry-run] specifier: ${specifier}\n`);
    process.stdout.write(
      `[dry-run] would write to rill-config.json: extensions.mounts.${asOverride} = "${specifier}"\n`
    );
    process.stdout.write(`[dry-run] would run: (no npm; single-file source)\n`);
    return 0;
  }

  process.stdout.write(`ℹ Installing ${asOverride} from ${specifier}...\n`);

  try {
    await applyMountEdit(
      snapshot,
      { kind, mount: asOverride, value: specifier },
      prefix
    );
  } catch (err) {
    if (err instanceof ConfigWriteError) {
      process.stderr.write('✗ Failed to write rill-config.json\n');
      return 1;
    }
    const errName = err instanceof Error ? err.constructor.name : 'Error';
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`✗ Config validation failed: ${errName}: ${errMsg}\n`);
    process.stderr.write('✓ Rolled back rill-config.json\n');
    return 1;
  }

  process.stdout.write(`✓ Mounted as '${asOverride}' in rill-config.json\n`);
  process.stdout.write('✓ Verified config loads cleanly\n');
  return 0;
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
      'dry-run': { type: 'boolean', default: false },
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

  // P2-1: --exact is deprecated; warn once before continuing.
  if (values['exact'] === true) {
    process.stderr.write(
      'warning: --exact is deprecated, use --pin (will be removed in 0.20)\n'
    );
  }

  const pin = values['pin'] === true || values['exact'] === true;
  const rangeArg =
    typeof values['range'] === 'string' ? values['range'] : undefined;
  const dryRun = values['dry-run'] === true;

  // EC-12: --pin/--exact and --range are mutually exclusive
  if (pin && rangeArg !== undefined) {
    process.stderr.write('--pin/--exact and --range are mutually exclusive\n');
    return 1;
  }

  const asOverride =
    typeof values['as'] === 'string' ? values['as'] : undefined;
  const projectDir = process.cwd();
  const prefix = resolvePrefix(projectDir);

  // ---- Single-file local source short-circuit (P0-3) ----
  // Single-file extensions skip npm entirely. Mount value is the path verbatim.
  // --as is required; --pin/--exact/--range are rejected since there is no version.
  if (looksLikeLocalFilePath(specifier)) {
    if (asOverride === undefined) {
      process.stderr.write(
        `✗ Single-file extension '${specifier}' requires --as <mount>\n`
      );
      process.stderr.write(
        '  Example: rill install ./extensions/crawler.ts --as crawler\n'
      );
      return 1;
    }
    if (pin || rangeArg !== undefined) {
      process.stderr.write(
        '✗ --pin/--exact/--range are not valid for single-file sources\n'
      );
      return 1;
    }
    return await installLocalFile({
      specifier,
      asOverride,
      projectDir,
      prefix,
      dryRun,
    });
  }

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

  // ---- P2-2: --dry-run preview ----
  if (dryRun) {
    let plannedValue: string;
    let plannedNpm: string | null;
    if (local) {
      plannedValue = specifier;
      plannedNpm = `npm install --prefix .rill/npm ${path.resolve(projectDir, specifier)}`;
    } else {
      const pkgName = extractPackageName(specifier);
      const versionPart =
        rangeArg !== undefined ? `@${rangeArg}` : '@<resolved>';
      plannedValue = pin
        ? `${pkgName}@<resolved>`
        : rangeArg !== undefined
          ? `${pkgName}@${rangeArg}`
          : `${pkgName}@^<resolved>`;
      plannedNpm = `npm install --prefix .rill/npm ${pkgName}${versionPart}`;
    }
    process.stdout.write(`[dry-run] mount: ${mount}\n`);
    process.stdout.write(`[dry-run] specifier: ${specifier}\n`);
    process.stdout.write(
      `[dry-run] would write to rill-config.json: extensions.mounts.${mount} = "${plannedValue}"\n`
    );
    process.stdout.write(`[dry-run] would run: ${plannedNpm}\n`);
    return 0;
  }

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
    } catch (err) {
      // npm install succeeded but the installed package.json is unreadable or invalid.
      // Refuse to record an unversioned mount when the rest of the workflow assumes
      // versioned specifiers — surface the read failure instead of silently masking it.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `✗ Failed to read installed package metadata at ${installedPkgJsonPath}: ${msg}\n`
      );
      process.stderr.write(
        '  npm install completed but the package may be corrupt. Re-run install or inspect .rill/npm/.\n'
      );
      return 1;
    }

    if (installedVersion === undefined || installedVersion === '') {
      process.stderr.write(
        `✗ Installed package.json at ${installedPkgJsonPath} has no version field\n`
      );
      return 1;
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
