/**
 * rill install: Install an extension or harness from npm registry or local path.
 *
 * Operates in two modes:
 * - Package mode (no ancestor rill-bundle.json): installs extensions into the
 *   current project's .rill/npm/ prefix and writes mounts to rill-config.json.
 * - Bundle mode (ancestor rill-bundle.json found): overrides the npm prefix to
 *   <bundleRoot>/.rill/npm/, inspects the installed package's exports to detect
 *   role (extension or harness), and writes the appropriate config record.
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
import {
  findBundleRoot,
  readBundleConfig,
  writeBundleHarness,
} from '../bundle/config.js';

// ============================================================
// HELP TEXT
// ============================================================

const USAGE = `\
Usage: rill install <pkg-or-path> [--as <mount>] [--pin] [--range <semver>] [--dry-run]
       rill install <pkg-or-path> [--for <mount>] [--role extension|harness] [--replace]

Install an extension or harness package.

In package mode (no ancestor rill-bundle.json), installs extensions into the
current project and writes mounts to rill-config.json.

In bundle mode (ancestor rill-bundle.json found), overrides the npm prefix to
<bundleRoot>/.rill/npm/, inspects the installed package to detect its role
(extension or harness), and writes the appropriate config record.

Arguments:
  <pkg-or-path>   One of:
                    - npm package name        e.g. @rcrsr/rill-ext-datetime
                    - local directory path    e.g. ./my-ext
                    - single-file source      e.g. ./extensions/crawler.ts (requires --as)

Options:
  --as <mount>         Override the mount path (default: derived from package name).
                       Required when <pkg-or-path> is a single-file source.
  --pin                Record exact installed version (no caret). Registry installs only.
  --exact              Deprecated alias for --pin (will be removed in 0.20).
  --range <semver>     Record a custom semver range verbatim. Registry installs only.
  --dry-run            Print what would be done without writing config or running npm.
  --for <mount>        Target package mount when installing an extension at bundle root.
  --role extension|harness
                       Disambiguate packages that export both extension and harness shapes.
  --replace            Swap the declared harness in an atomic operation (bundle mode only).
  --help               Show this help message
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
      prefix,
      { skipValidation: true }
    );
  } catch (err) {
    if (err instanceof ConfigWriteError) {
      process.stderr.write('✗ Failed to write rill-config.json\n');
      return 1;
    }
    throw err;
  }

  process.stdout.write(`✓ Mounted as '${asOverride}' in rill-config.json\n`);
  process.stdout.write(
    "ℹ Configure the mount in rill-config.json, then run 'rill describe project' or 'rill run' to validate.\n"
  );
  return 0;
}

// ============================================================
// ROLE DETECTION
// ============================================================

/**
 * Detects the install role of a package by statically importing its main
 * module from the given prefix's node_modules.
 *
 * Returns 'extension' when the package exports a named `extensionManifest`.
 * Returns 'harness' when the default export looks like a RillHarness shape
 * (has a `name` string field; optionally `postBuild` and `serve` functions).
 * Returns 'ambiguous' when both shapes are present.
 * Returns 'unknown' when neither shape is detected.
 *
 * Uses static `import()` only. Factory functions are never invoked.
 */
async function detectPackageRole(
  prefix: string,
  pkgName: string
): Promise<'extension' | 'harness' | 'ambiguous' | 'unknown'> {
  const pkgMainPath = path.join(prefix, 'node_modules', pkgName);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pkgMainPath)) as Record<string, unknown>;
  } catch {
    return 'unknown';
  }

  const hasExtensionManifest = 'extensionManifest' in mod;

  const defaultExport = mod['default'];
  const hasHarnessShape =
    typeof defaultExport === 'object' &&
    defaultExport !== null &&
    typeof (defaultExport as Record<string, unknown>)['name'] === 'string';

  if (hasExtensionManifest && hasHarnessShape) return 'ambiguous';
  if (hasExtensionManifest) return 'extension';
  if (hasHarnessShape) return 'harness';
  return 'unknown';
}

// ============================================================
// RUN
// ============================================================

/**
 * Install an extension or harness into the current project or bundle.
 *
 * In package mode (no ancestor rill-bundle.json), installs extensions and
 * writes mounts to rill-config.json — today's behavior unchanged.
 *
 * In bundle mode (ancestor rill-bundle.json found), overrides the npm prefix
 * to <bundleRoot>/.rill/npm/, detects the package role from its exports, and
 * writes either a mount to the target package's rill-config.json (extension)
 * or the harness field to rill-bundle.json (harness).
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
      for: { type: 'string' },
      role: { type: 'string' },
      replace: { type: 'boolean', default: false },
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
  const forMount =
    typeof values['for'] === 'string' ? values['for'] : undefined;
  const roleFlag =
    typeof values['role'] === 'string' ? values['role'] : undefined;
  const replaceFlag = values['replace'] === true;

  const projectDir = process.cwd();

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
    const prefix = resolvePrefix(projectDir);
    return await installLocalFile({
      specifier,
      asOverride,
      projectDir,
      prefix,
      dryRun,
    });
  }

  // ---- Bundle walk-up ----
  const bundleRoot = findBundleRoot(projectDir);

  // Resolve effective npm prefix: bundle root overrides project dir.
  const effectivePrefix =
    bundleRoot !== null
      ? path.join(bundleRoot, '.rill', 'npm')
      : resolvePrefix(projectDir);

  // ---- Step 1: assertBootstrapped ----
  // EC-7: .rill/npm/ missing -> UXT-EXT-5 verbatim
  // In bundle mode, check the bundle prefix, not the project prefix.
  const bootstrapDir = bundleRoot !== null ? bundleRoot : projectDir;
  try {
    assertBootstrapped(bootstrapDir);
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

  // ---- Step 3 (package mode only): Read config snapshot + collision pre-check ----
  // In bundle mode the config snapshot is read after role detection, targeting
  // the correct package directory. Skip this step here for bundle mode.
  let snapshot: Awaited<ReturnType<typeof readConfigSnapshot>> | null = null;
  let kind: 'add' | 'overwrite' = 'add';

  if (bundleRoot === null) {
    snapshot = await readConfigSnapshot(projectDir);
    const mountExists = hasMount(snapshot, mount);
    if (mountExists && asOverride === undefined) {
      process.stderr.write(`✗ Mount path '${mount}' already exists\n`);
      process.stderr.write(
        '  Use --as <path> to override, or edit rill-config.json manually\n'
      );
      return 1;
    }
    kind = mountExists && asOverride !== undefined ? 'overwrite' : 'add';
  }

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
    npmResult = await npmInstall({ spec: npmSpec, prefix: effectivePrefix });
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
      effectivePrefix,
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

  // ---- Step 9: Bundle mode — role detection and config write ----
  if (bundleRoot !== null) {
    return await applyBundleInstall({
      bundleRoot,
      projectDir,
      effectivePrefix,
      pkgName,
      mount,
      value,
      forMount,
      roleFlag,
      replaceFlag,
    });
  }

  // ---- Step 9 (package mode): Harness guard ----
  // Harness packages cannot be installed outside a bundle. Detect role from
  // the installed package exports and reject harness installs early, before
  // any config write.
  const noBundleRole = await detectPackageRole(effectivePrefix, pkgName);
  const noBundleIsHarness =
    noBundleRole === 'harness' ||
    roleFlag === 'harness' ||
    (noBundleRole === 'ambiguous' && roleFlag === 'harness');
  if (noBundleIsHarness) {
    process.stderr.write(
      'Cannot install harness outside a bundle. A bundle requires rill-bundle.json at the root.\n'
    );
    return 1;
  }

  // ---- Step 10 (package mode): Apply mount edit ----
  // Install does not invoke the extension factory. Most extensions need
  // configuration that doesn't exist at install time, so factory failures
  // would block the common bootstrap → install → configure → validate flow.
  // Validation lives in 'rill describe project' and 'rill run'.
  if (snapshot === null) {
    snapshot = await readConfigSnapshot(projectDir);
  }
  try {
    await applyMountEdit(snapshot, { kind, mount, value }, effectivePrefix, {
      skipValidation: true,
    });
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
    throw err;
  }

  // ---- Step 10: Success output ----
  process.stdout.write(`✓ Mounted as '${mount}' in rill-config.json\n`);
  process.stdout.write(
    "ℹ Configure the mount in rill-config.json, then run 'rill describe project' or 'rill run' to validate.\n"
  );

  // UXT-EXT-2: registry-only "Ready to use" line (not emitted for local path per UXT-EXT-3)
  if (!local) {
    process.stdout.write(`Ready to use: use:${mount}\n`);
  }

  return 0;
}

// ============================================================
// BUNDLE INSTALL HELPER
// ============================================================

/**
 * Applies the post-npm-install config write in bundle mode.
 *
 * Detects the role of the installed package (extension vs harness), validates
 * flags, and writes the appropriate config record without performing any npm
 * operations (those have already completed).
 *
 * All error paths return exit code 1 and write verbatim error copy to stderr.
 * No filesystem writes occur when validation fails.
 */
async function applyBundleInstall(opts: {
  bundleRoot: string;
  projectDir: string;
  effectivePrefix: string;
  pkgName: string;
  mount: string;
  value: string;
  forMount: string | undefined;
  roleFlag: string | undefined;
  replaceFlag: boolean;
}): Promise<number> {
  const {
    bundleRoot,
    projectDir,
    effectivePrefix,
    pkgName,
    mount,
    value,
    forMount,
    roleFlag,
    replaceFlag,
  } = opts;

  // Detect role from installed package exports.
  const detectedRole = await detectPackageRole(effectivePrefix, pkgName);

  // Resolve the effective role, honouring --role flag for disambiguation.
  let effectiveRole: 'extension' | 'harness';
  if (detectedRole === 'ambiguous') {
    if (roleFlag === 'extension') {
      effectiveRole = 'extension';
    } else if (roleFlag === 'harness') {
      effectiveRole = 'harness';
    } else {
      process.stderr.write(
        'Package exports both extensionManifest and RillHarness. Use `--role extension` or `--role harness` to specify which to install.\n'
      );
      return 1;
    }
  } else if (detectedRole === 'extension') {
    effectiveRole = 'extension';
  } else if (detectedRole === 'harness') {
    effectiveRole = 'harness';
  } else {
    // Unknown role: fall back to extension (today's default behaviour).
    effectiveRole = 'extension';
  }

  // Override with explicit --role when detection gave a definitive answer.
  if (roleFlag === 'extension') effectiveRole = 'extension';
  if (roleFlag === 'harness') effectiveRole = 'harness';

  if (effectiveRole === 'harness') {
    // Read the bundle config to check for an existing harness declaration.
    const bundleConfig = await readBundleConfig(bundleRoot);

    if (bundleConfig.harness !== undefined && !replaceFlag) {
      process.stderr.write(
        `Bundle already has a harness declared: ${bundleConfig.harness}. Run \`rill uninstall ${bundleConfig.harness}\` first, or use \`rill install ${pkgName} --replace\` to swap harnesses.\n`
      );
      return 1;
    }

    await writeBundleHarness(bundleRoot, pkgName);
    process.stdout.write(
      `✓ Harness '${pkgName}' recorded in rill-bundle.json\n`
    );
    return 0;
  }

  // Extension role: resolve target package directory.
  const atBundleRoot = path.resolve(projectDir) === path.resolve(bundleRoot);

  if (atBundleRoot && forMount === undefined) {
    process.stderr.write(
      'Cannot determine target package. Use `rill install <pkg> --for <mount>` to specify which package should mount this extension.\n'
    );
    return 1;
  }

  let targetPackageDir: string;
  if (forMount !== undefined) {
    // Resolve the target package dir from the bundle config.
    const bundleConfig = await readBundleConfig(bundleRoot);
    const entry = bundleConfig.packages.find((p) => p.mount === forMount);
    if (entry === undefined) {
      process.stderr.write(
        `✗ Package mount '${forMount}' not found in rill-bundle.json\n`
      );
      return 1;
    }
    targetPackageDir = path.resolve(bundleRoot, entry.project);
  } else {
    targetPackageDir = projectDir;
  }

  // Read the target package's rill-config.json and write the mount.
  let targetSnapshot: Awaited<ReturnType<typeof readConfigSnapshot>>;
  try {
    targetSnapshot = await readConfigSnapshot(targetPackageDir);
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      process.stderr.write(
        `✗ rill-config.json not found in target package directory: ${targetPackageDir}\n`
      );
      return 1;
    }
    throw err;
  }

  const mountExists = hasMount(targetSnapshot, mount);
  const editKind: 'add' | 'overwrite' = mountExists ? 'overwrite' : 'add';

  try {
    await applyMountEdit(
      targetSnapshot,
      { kind: editKind, mount, value },
      effectivePrefix,
      { skipValidation: true }
    );
  } catch (err) {
    if (err instanceof ConfigWriteError) {
      process.stderr.write(
        '✗ Failed to write rill-config.json after npm install. Package state and config are out of sync.\n'
      );
      process.stderr.write(
        `  Manually update mounts.${mount} or re-run after resolving the filesystem error.\n`
      );
      return 1;
    }
    throw err;
  }

  process.stdout.write(
    `✓ Mounted as '${mount}' in ${targetPackageDir}/rill-config.json\n`
  );
  process.stdout.write(
    "ℹ Configure the mount in rill-config.json, then run 'rill describe project' or 'rill run' to validate.\n"
  );
  process.stdout.write(`Ready to use: use:${mount}\n`);
  return 0;
}
