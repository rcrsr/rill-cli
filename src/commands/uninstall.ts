/**
 * rill uninstall: Remove an extension mount and uninstall from .rill/npm/.
 *
 * Constraints (FR-EXT-5, UXI-EXT-5):
 * - assertBootstrapped pre-check before any config or npm operation (EC-13)
 * - Mount existence pre-check before any config edit (EC-14)
 * - Config written first (mount removed), then npm uninstall, then loadProject validation
 * - On validation failure (EC-16): do NOT roll back — mount removal is the desired terminal state
 * - Project-root package.json MUST NOT be modified (NFR-EXT-6)
 */

import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadProject } from '@rcrsr/rill-config';
import {
  assertBootstrapped,
  BootstrapMissingError,
  resolvePrefix,
} from './prefix.js';
import { readConfigSnapshot, hasMount, applyMountEdit } from './config-edit.js';
import { npmUninstall, NpmNotFoundError } from './npm-runner.js';
import { isLocalPath, isLocalFilePath } from './mount-derive.js';
import { CLI_VERSION } from '../cli-shared.js';

// ---------------------------------------------------------------------------
// Local interface that mirrors the companion @rcrsr/rill-config release which
// adds the `prefix` parameter to loadProject. Cast through this until the
// published types catch up.
// ---------------------------------------------------------------------------
interface LoadProjectWithPrefix {
  (options: {
    configPath: string;
    rillVersion: string;
    prefix?: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

const loadProjectWithPrefix = loadProject as unknown as LoadProjectWithPrefix;

// ============================================================
// HELP TEXT
// ============================================================

const USAGE = `\
Usage: rill uninstall <mount>

Remove an extension mount from rill-config.json and uninstall from .rill/npm/.

Arguments:
  <mount>   Mount name as it appears in rill-config.json (e.g. datetime)

Options:
  --help    Show this help message
`;

// ============================================================
// HELPERS
// ============================================================

/**
 * Derive the npm package name from a config specifier.
 *
 * - Registry specifier (e.g. "@rcrsr/rill-ext-datetime@^0.19.0"): strip the
 *   trailing version qualifier (last '@' not at position 0).
 * - Local-path specifier (starts with './', '../', or '/'): npm symlinks under
 *   node_modules/<mount>, so the package name IS the mount name.
 */
function deriveNpmPackageName(specifier: string, mount: string): string {
  if (isLocalPath(specifier)) {
    return mount;
  }

  // Strip trailing version qualifier: find last '@' after position 0.
  const atIndex = specifier.indexOf('@', 1);
  if (atIndex === -1) {
    return specifier;
  }
  return specifier.slice(0, atIndex);
}

// ============================================================
// IMPLEMENTATION
// ============================================================

/**
 * Uninstall an extension from the current project.
 *
 * Implements UXI-EXT-5 order of operations per spec FR-EXT-5.
 *
 * EC-16 compliance: config is written without rollback wiring. If loadProject
 * validation fails after config write, we do NOT restore the original config.
 * The mount removal is the desired terminal state even on validation failure.
 */
export async function run(argv: string[]): Promise<number> {
  // ---- Argument parsing ----
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
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
    process.stderr.write('Usage: rill uninstall <mount>\n');
    process.stderr.write('  Missing required argument: <mount>\n');
    return 1;
  }

  const projectDir = process.cwd();
  const prefix = resolvePrefix(projectDir);

  // ---- Step 1: assertBootstrapped ----
  // EC-13: .rill/npm/ missing -> UXT-EXT-5 verbatim, exit 1
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

  // EC-14: Mount not in config -> UXT-EXT-8 verbatim, exit 1; NO edit, NO npm
  if (!hasMount(snapshot, mount)) {
    process.stderr.write(`✗ Mount '${mount}' not found in rill-config.json\n`);
    process.stderr.write("  Run 'rill list' to see installed extensions\n");
    return 1;
  }

  // ---- Step 3: Read specifier from mount value ----
  const specifierVerbatim =
    snapshot.parsed.extensions?.mounts?.[mount] ?? mount;
  const pkgName = deriveNpmPackageName(specifierVerbatim, mount);
  const localFile = isLocalFilePath(specifierVerbatim);

  // ---- Step 4: Print removal start message (UXT-EXT-7 line 1) ----
  process.stdout.write(
    `ℹ Removing mount '${mount}' (${specifierVerbatim})...\n`
  );

  // ---- Step 5: Write config with mount removed (EC-16: skipValidation = no rollback wiring) ----
  await applyMountEdit(snapshot, { kind: 'remove', mount }, prefix, {
    skipValidation: true,
  });

  // ---- Step 6: Print config updated (UXT-EXT-7 line 2) ----
  process.stdout.write('✓ Updated rill-config.json\n');

  // ---- Step 7: npm uninstall (skipped for single-file local sources) ----
  if (localFile) {
    // P0-3: single-file mounts have nothing under .rill/npm/; just unregister.
    process.stdout.write(
      `✓ Removed mount (single-file source left on disk: ${specifierVerbatim})\n`
    );
  } else {
    let npmResult: { exitCode: number };
    try {
      npmResult = await npmUninstall({ spec: pkgName, prefix });
    } catch (err) {
      if (err instanceof NpmNotFoundError) {
        process.stderr.write(
          'npm not found on PATH; install Node.js with npm\n'
        );
        return 1;
      }
      throw err;
    }

    // EC-15: npm uninstall non-zero exit -> propagate exit code; npm already streamed stderr
    if (npmResult.exitCode !== 0) {
      return npmResult.exitCode;
    }

    // UXT-EXT-7 line 3: uninstalled message
    // AC-B9: missing package directory is NOT an error; npm uninstall returns 0 in that case.
    process.stdout.write(
      `✓ Uninstalled from .rill/npm/node_modules/${pkgName}\n`
    );
  }

  // ---- Step 8: Post-uninstall loadProject validation ----
  // EC-16: on failure do NOT roll back config; emit error and return 1.
  const configPath = path.resolve(projectDir, 'rill-config.json');
  try {
    await loadProjectWithPrefix({
      configPath,
      rillVersion: CLI_VERSION,
      prefix,
    });
  } catch (validationErr) {
    const errMsg =
      validationErr instanceof Error
        ? validationErr.message
        : String(validationErr);
    process.stderr.write(
      `✗ Config validation failed after uninstall: ${errMsg}\n`
    );
    return 1;
  }

  // UXT-EXT-7 line 4
  process.stdout.write('✓ Verified config loads cleanly\n');

  return 0;
}
