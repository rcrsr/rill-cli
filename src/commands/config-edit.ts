import fs from 'node:fs';
import path from 'node:path';
import type { RillConfigFile } from '@rcrsr/rill-config';
import { ConfigNotFoundError, loadProject } from '@rcrsr/rill-config';
import { CLI_VERSION } from '../cli-shared.js';
import { atomicWriteFile } from '../fs-atomic.js';
import { assertBootstrapped, BootstrapMissingError } from './prefix.js';
import { NpmNotFoundError } from './npm-runner.js';

export { ConfigNotFoundError };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConfigSnapshot {
  readonly path: string;
  readonly rawText: string;
  readonly parsed: RillConfigFile;
}

// ---------------------------------------------------------------------------
// ConfigWriteError
// ---------------------------------------------------------------------------

/**
 * Thrown when writing rill-config.json to disk fails.
 * Wraps the underlying I/O error message.
 */
export class ConfigWriteError extends Error {
  constructor(configPath: string, cause: unknown) {
    const underlying = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to write config file ${configPath}: ${underlying}`, {
      cause,
    });
    this.name = 'ConfigWriteError';
  }
}

// ---------------------------------------------------------------------------
// ConfigParseError
// ---------------------------------------------------------------------------

/**
 * Thrown when rill-config.json exists but is not valid JSON.
 * Wraps the underlying parse error message.
 */
export class ConfigParseError extends Error {
  constructor(configPath: string, cause: unknown) {
    const underlying = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to parse config file ${configPath}: ${underlying}`, {
      cause,
    });
    this.name = 'ConfigParseError';
  }
}

// ---------------------------------------------------------------------------
// readConfigSnapshot
// ---------------------------------------------------------------------------

/**
 * Reads <projectDir>/rill-config.json and returns a snapshot of the raw text
 * and parsed structure.
 *
 * @throws {ConfigNotFoundError} when the file does not exist (ENOENT).
 */
export async function readConfigSnapshot(
  projectDir: string
): Promise<ConfigSnapshot> {
  const configPath = path.resolve(projectDir, 'rill-config.json');

  let rawText: string;
  try {
    rawText = await fs.promises.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new ConfigNotFoundError(`Config file not found: ${configPath}`);
    }
    throw err;
  }

  let parsed: RillConfigFile;
  try {
    parsed = JSON.parse(rawText) as RillConfigFile;
  } catch (err) {
    throw new ConfigParseError(configPath, err);
  }

  return { path: configPath, rawText, parsed };
}

// ---------------------------------------------------------------------------
// applyMountEdit
// ---------------------------------------------------------------------------

/**
 * Applies a mount add/overwrite/remove edit to the config file on disk, then
 * validates the result via loadProject. On validation failure the original
 * rawText is written back byte-for-byte and the original error is re-thrown.
 *
 * @throws {ConfigWriteError} when the disk write itself fails.
 * @throws {MountValidationError | NamespaceCollisionError} on validation
 *   failure after rollback.
 */
export async function applyMountEdit(
  snapshot: ConfigSnapshot,
  edit: {
    kind: 'add' | 'overwrite' | 'remove';
    mount: string;
    value?: string;
  },
  prefix: string,
  options?: { skipValidation?: boolean }
): Promise<void> {
  // Build a mutable copy of the parsed config.
  const currentMounts: Record<string, string> = {
    ...snapshot.parsed.extensions?.mounts,
  };

  if (edit.kind === 'add' || edit.kind === 'overwrite') {
    currentMounts[edit.mount] = edit.value ?? '';
  } else {
    delete currentMounts[edit.mount];
  }

  const updatedConfig: RillConfigFile = {
    ...snapshot.parsed,
    extensions: {
      ...snapshot.parsed.extensions,
      mounts: currentMounts,
    },
  };

  // Serialize: 2-space indent + trailing newline when original had one.
  const trailingNewline = snapshot.rawText.endsWith('\n');
  const serialized =
    JSON.stringify(updatedConfig, null, 2) + (trailingNewline ? '\n' : '');

  // Write updated config to disk. Atomic: a write failure never truncates
  // the existing rill-config.json in place.
  try {
    await atomicWriteFile(snapshot.path, serialized, 'utf8');
  } catch (err) {
    throw new ConfigWriteError(snapshot.path, err);
  }

  // Validate the written config (skipped when caller opts out).
  if (options?.skipValidation === true) return;

  try {
    await loadProject({
      configPath: snapshot.path,
      rillVersion: CLI_VERSION,
      prefix,
    });
  } catch (validationErr) {
    // Rollback: restore raw text byte-for-byte, then re-throw ORIGINAL error,
    // annotated with whether the rollback write itself succeeded. A rollback
    // write failure must NOT be swallowed: the caller needs to know that
    // rill-config.json may be left in the modified (invalid) state. Atomic,
    // like the write above: a failed rollback never truncates the file.
    try {
      await atomicWriteFile(snapshot.path, snapshot.rawText, 'utf8');
      markRollbackResult(validationErr, true);
    } catch (rollbackErr) {
      markRollbackResult(validationErr, false, rollbackErr);
    }
    throw validationErr;
  }
}

/**
 * Attaches rollback outcome metadata to a validation error before it is
 * re-thrown, so callers (e.g. `rill upgrade`) can distinguish a successful
 * rollback from a rollback-write failure and report each accurately.
 */
function markRollbackResult(
  err: unknown,
  rolledBack: boolean,
  cause?: unknown
): void {
  if (typeof err !== 'object' || err === null) return;
  const marked = err as RollbackAnnotatedError;
  marked.rolledBack = rolledBack;
  if (cause !== undefined) {
    marked.rollbackCause = cause;
  }
}

/**
 * Error shape produced by {@link applyMountEdit}'s rollback path. `rolledBack`
 * is `true` when the original config was successfully restored, `false` when
 * the rollback write itself failed (in which case `rollbackCause` holds the
 * write error and rill-config.json may be left modified).
 */
export interface RollbackAnnotatedError {
  rolledBack?: boolean;
  rollbackCause?: unknown;
}

// ---------------------------------------------------------------------------
// hasMount
// ---------------------------------------------------------------------------

/**
 * Returns true when the snapshot contains a mount entry for the given path.
 */
export function hasMount(snapshot: ConfigSnapshot, mount: string): boolean {
  return snapshot.parsed.extensions?.mounts?.[mount] !== undefined;
}

// ---------------------------------------------------------------------------
// assertBootstrappedOrReport
// ---------------------------------------------------------------------------

/**
 * Shared pre-flight gate for install/uninstall/upgrade: checks
 * `.rill/npm/package.json` exists under `projectDir` and, when it does not,
 * prints the verbatim bootstrap-missing message and returns `false`.
 *
 * Returns `true` when bootstrapped, so callers write
 * `if (!assertBootstrappedOrReport(dir)) return 1;`.
 */
export function assertBootstrappedOrReport(projectDir: string): boolean {
  try {
    assertBootstrapped(projectDir);
    return true;
  } catch (err) {
    if (err instanceof BootstrapMissingError) {
      process.stderr.write('✗ .rill/npm/ not found\n');
      process.stderr.write(
        "  Run 'rill init' first to initialize the project\n"
      );
      return false;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// reportNpmNotFound
// ---------------------------------------------------------------------------

/**
 * Shared handler for the `NpmNotFoundError` catch clause repeated across
 * install/uninstall/upgrade's npm subprocess calls: prints the verbatim
 * "npm not found" message and returns the exit code 1. Rethrows any other
 * error unchanged, so callers write `catch (err) { return reportNpmNotFound(err); }`.
 */
export function reportNpmNotFound(err: unknown): number {
  if (err instanceof NpmNotFoundError) {
    process.stderr.write('npm not found on PATH; install Node.js with npm\n');
    return 1;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// readInstalledPackageVersion
// ---------------------------------------------------------------------------

/**
 * Reads the `version` field from `<prefix>/node_modules/<pkgName>/package.json`.
 * Returns `undefined` when the file is missing, unreadable, invalid JSON, or
 * has no non-empty string `version` field. Callers decide how to react to a
 * missing version (treat as an error, or as "not yet installed").
 */
export function readInstalledPackageVersion(
  prefix: string,
  pkgName: string
): string | undefined {
  const pkgJsonPath = path.join(
    prefix,
    'node_modules',
    pkgName,
    'package.json'
  );
  try {
    const text = fs.readFileSync(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(text) as { version?: string };
    return typeof parsed.version === 'string' && parsed.version !== ''
      ? parsed.version
      : undefined;
  } catch {
    return undefined;
  }
}
