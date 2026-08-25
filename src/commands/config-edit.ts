import fs from 'node:fs';
import path from 'node:path';
import type { RillConfigFile } from '@rcrsr/rill-config';
import { ConfigNotFoundError, loadProject } from '@rcrsr/rill-config';
import { CLI_VERSION } from '../cli-shared.js';

export { ConfigNotFoundError };

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

  // Write updated config to disk.
  try {
    await fs.promises.writeFile(snapshot.path, serialized, 'utf8');
  } catch (err) {
    throw new ConfigWriteError(snapshot.path, err);
  }

  // Validate the written config (skipped when caller opts out).
  if (options?.skipValidation === true) return;

  try {
    await loadProjectWithPrefix({
      configPath: snapshot.path,
      rillVersion: CLI_VERSION,
      prefix,
    });
  } catch (validationErr) {
    // Rollback: restore raw text byte-for-byte, then re-throw ORIGINAL error,
    // annotated with whether the rollback write itself succeeded. A rollback
    // write failure must NOT be swallowed: the caller needs to know that
    // rill-config.json may be left in the modified (invalid) state.
    try {
      await fs.promises.writeFile(snapshot.path, snapshot.rawText, 'utf8');
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
