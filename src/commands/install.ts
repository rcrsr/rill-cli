/**
 * rill install: Install an extension or harness from npm registry or local path.
 *
 * Operates in two modes:
 * - Package mode (no ancestor rill-bundle.json): installs extensions into the
 *   current project's .rill/npm/ prefix and writes mounts to rill-config.json.
 * - Bundle mode (ancestor rill-bundle.json found): role comes from the
 *   package's declared `rill.role` (with `--role` as an override). Extensions
 *   install into the target package's own .rill/npm/ prefix (resolved via
 *   `--for <mount>`) so the package's build can resolve them; harnesses
 *   install into <bundleRoot>/.rill/npm/ and are recorded in
 *   rill-bundle.json.
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
import { npmInstall, npmView, NpmNotFoundError } from './npm-runner.js';
import { resolveTargetPackageDir } from './bundle-resolve.js';
import {
  findBundleRoot,
  readBundleConfig,
  writeBundleHarness,
  BundleConfigError,
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

In bundle mode (ancestor rill-bundle.json found), the role comes from the
package's declared rill.role (--role overrides it). Extensions install into
the target package's own .rill/npm/ (resolved via --for <mount>); harnesses
install into <bundleRoot>/.rill/npm/. Writes the appropriate config record.

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
  --for <mount>        Target package mount to install an extension into (bundle mode).
  --role extension|harness
                       Override the package's declared rill.role.
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
        "  Run 'rill init' first to initialize the project\n"
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
 * Probes the declared rill role from a package's manifest before installation.
 *
 * For registry specifiers, runs `npm view <spec> rill --json` to read the
 * `rill` field from the published package.json without downloading the package.
 * For local directory paths, reads the package.json directly from disk.
 *
 * Returns 'extension' or 'harness' when the package declares a valid role.
 * Returns 'not-a-rill-package' when the field is absent or has an unrecognised value.
 */
async function probePackageRole(
  specifier: string,
  isLocal: boolean,
  projectDir: string
): Promise<'extension' | 'harness' | 'not-a-rill-package'> {
  if (isLocal) {
    const pkgJsonPath = path.join(
      path.resolve(projectDir, specifier),
      'package.json'
    );
    let pkgJson: Record<string, unknown>;
    try {
      const text = fs.readFileSync(pkgJsonPath, 'utf8');
      pkgJson = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return 'not-a-rill-package';
    }
    return extractRillRole(pkgJson);
  }

  const result = await npmView(specifier, 'rill');
  if (
    result.exitCode !== 0 ||
    result.stdout === '' ||
    result.stdout === 'undefined'
  ) {
    return 'not-a-rill-package';
  }
  let rill: unknown;
  try {
    rill = JSON.parse(result.stdout);
  } catch {
    return 'not-a-rill-package';
  }
  if (typeof rill !== 'object' || rill === null) return 'not-a-rill-package';
  const role = (rill as Record<string, unknown>)['role'];
  if (role === 'extension') return 'extension';
  if (role === 'harness') return 'harness';
  return 'not-a-rill-package';
}

function extractRillRole(
  pkgJson: Record<string, unknown>
): 'extension' | 'harness' | 'not-a-rill-package' {
  const rill = pkgJson['rill'];
  if (typeof rill !== 'object' || rill === null) return 'not-a-rill-package';
  const role = (rill as Record<string, unknown>)['role'];
  if (role === 'extension') return 'extension';
  if (role === 'harness') return 'harness';
  return 'not-a-rill-package';
}

// ============================================================
// BUNDLE TARGET RESOLUTION
// ============================================================

/**
 * Writes the verbatim bootstrap-missing error copy to stderr.
 *
 * Shared by the package-mode and bundle-mode (harness/extension) bootstrap
 * gates so the message stays byte-identical across all three call sites.
 */
function writeBootstrapMissingError(): void {
  process.stderr.write('✗ .rill/npm/ not found\n');
  process.stderr.write("  Run 'rill init' first to initialize the project\n");
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
 * In bundle mode (ancestor rill-bundle.json found), the role comes from the
 * package's declared `rill.role` (with `--role` as an override). Extensions
 * install into the target package's own .rill/npm/ prefix (resolved via
 * `--for <mount>`) and write a mount to that package's rill-config.json.
 * Harnesses install into <bundleRoot>/.rill/npm/ and are recorded in
 * rill-bundle.json.
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

  // Resolve effective npm prefix. In package mode this is the project prefix
  // and is known now; in bundle mode it depends on the package's effective
  // role (extension vs harness), which is not known until after the
  // pre-install role probe below (Step 4b), so it is set later.
  let effectivePrefix = bundleRoot === null ? resolvePrefix(projectDir) : '';
  let targetPackageDir = projectDir;

  // ---- Step 1: assertBootstrapped (package mode) ----
  // EC-7: .rill/npm/ missing -> UXT-EXT-5 verbatim
  // In bundle mode, the bootstrap gate is checked per-role below (Step 4c),
  // against the bundle root for harnesses or the target package for
  // extensions.
  if (bundleRoot === null) {
    try {
      assertBootstrapped(projectDir);
    } catch (err) {
      if (err instanceof BootstrapMissingError) {
        writeBootstrapMissingError();
        return 1;
      }
      throw err;
    }
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

  // ---- Step 4b: Pre-install role probe ----
  // Reject packages that do not declare a rill role in their package.json.
  // This prevents non-rill packages from entering .rill/npm/.
  let declaredRole: Awaited<ReturnType<typeof probePackageRole>>;
  try {
    declaredRole = await probePackageRole(specifier, local, projectDir);
  } catch (err) {
    if (err instanceof NpmNotFoundError) {
      // npm absent means we cannot probe and cannot install; surface it before spawning.
      process.stderr.write('npm not found on PATH; install Node.js with npm\n');
      return 1;
    }
    throw err;
  }
  if (declaredRole === 'not-a-rill-package') {
    process.stderr.write(
      `✗ '${specifier}' does not declare a rill role in its package.json\n`
    );
    process.stderr.write(
      '  Add "rill": { "role": "extension" } or "rill": { "role": "harness" } to its package.json\n'
    );
    return 1;
  }

  // The declared role drives installation; --role is an override, permitted
  // even when it differs from the manifest. declaredRole is a concrete
  // extension|harness here since not-a-rill-package was already rejected.
  const effectiveRole: 'extension' | 'harness' =
    roleFlag === 'harness'
      ? 'harness'
      : roleFlag === 'extension'
        ? 'extension'
        : declaredRole;

  // ---- Step 4c: Resolve npm prefix and bootstrap gate (bundle mode) ----
  // Extensions must install into the target package's own .rill/npm/ prefix
  // so that its build (src/build/build.ts) can resolve them; only harnesses
  // install into the bundle root.
  if (bundleRoot !== null) {
    if (effectiveRole === 'harness') {
      effectivePrefix = path.join(bundleRoot, '.rill', 'npm');
      try {
        assertBootstrapped(bundleRoot);
      } catch (err) {
        if (err instanceof BootstrapMissingError) {
          writeBootstrapMissingError();
          return 1;
        }
        throw err;
      }
    } else {
      const resolved = await resolveTargetPackageDir({
        bundleRoot,
        projectDir,
        forMount,
      });
      if ('error' in resolved) {
        return resolved.error;
      }
      targetPackageDir = resolved.dir;
      effectivePrefix = resolvePrefix(targetPackageDir);
      try {
        assertBootstrapped(targetPackageDir);
      } catch (err) {
        if (err instanceof BootstrapMissingError) {
          writeBootstrapMissingError();
          return 1;
        }
        throw err;
      }
    }
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

  // ---- Step 9: Bundle mode — config write ----
  // The role and target directory were already resolved (Step 4c), before
  // npm install ran, so the prefix used above matches the target package.
  if (bundleRoot !== null) {
    return await applyBundleInstall({
      bundleRoot,
      effectivePrefix,
      pkgName,
      mount,
      value,
      effectiveRole,
      targetPackageDir,
      replaceFlag,
      asOverride,
    });
  }

  // ---- Step 9 (package mode): Harness guard ----
  // Harness packages cannot be installed outside a bundle. Reject based on
  // effectiveRole (declared role with --role override applied); no
  // post-install detection needed.
  const noBundleIsHarness = effectiveRole === 'harness';
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
 * The role (extension vs harness) and, for extensions, the target package
 * directory were already resolved before npm install ran (see Step 4c in
 * `run()`), since the npm prefix used for install depends on them. This
 * function only validates flags and writes the appropriate config record; it
 * performs no npm operations (those have already completed).
 *
 * All error paths return exit code 1 and write verbatim error copy to stderr.
 * No filesystem writes occur when validation fails.
 */
async function applyBundleInstall(opts: {
  bundleRoot: string;
  effectivePrefix: string;
  pkgName: string;
  mount: string;
  value: string;
  effectiveRole: 'extension' | 'harness';
  targetPackageDir: string;
  replaceFlag: boolean;
  asOverride: string | undefined;
}): Promise<number> {
  const {
    bundleRoot,
    effectivePrefix,
    pkgName,
    mount,
    value,
    effectiveRole,
    targetPackageDir,
    replaceFlag,
    asOverride,
  } = opts;

  if (effectiveRole === 'harness') {
    // Read the bundle config to check for an existing harness declaration.
    let bundleConfig: Awaited<ReturnType<typeof readBundleConfig>>;
    try {
      bundleConfig = await readBundleConfig(bundleRoot);
    } catch (err) {
      if (err instanceof BundleConfigError) {
        process.stderr.write(`✗ ${err.message}\n`);
        return 1;
      }
      throw err;
    }

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

  // Extension role: targetPackageDir was already resolved before npm install
  // (see resolveTargetPackageDir, called from Step 4c in run()).
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
  if (mountExists && asOverride === undefined) {
    process.stderr.write(`✗ Mount path '${mount}' already exists\n`);
    process.stderr.write(
      '  Use --as <path> to override, or edit rill-config.json manually\n'
    );
    return 1;
  }
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
