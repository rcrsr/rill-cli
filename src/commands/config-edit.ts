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
// ConfigWriteError (EC-30)
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
// IR-12: readConfigSnapshot
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

  const parsed = JSON.parse(rawText) as RillConfigFile;

  return { path: configPath, rawText, parsed };
}

// ---------------------------------------------------------------------------
// IR-13: applyMountEdit
// ---------------------------------------------------------------------------

/**
 * Applies a mount add/overwrite/remove edit to the config file on disk, then
 * validates the result via loadProject. On validation failure the original
 * rawText is written back byte-for-byte and the original error is re-thrown.
 *
 * @throws {ConfigWriteError} when the disk write itself fails (EC-30).
 * @throws {MountValidationError | NamespaceCollisionError} on validation
 *   failure after rollback (EC-29).
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
    ...(snapshot.parsed.extensions?.mounts ?? {}),
  };

  if (edit.kind === 'add' || edit.kind === 'overwrite') {
    currentMounts[edit.mount] = edit.value ?? '';
  } else {
    delete currentMounts[edit.mount];
  }

  const updatedConfig: RillConfigFile = {
    ...snapshot.parsed,
    extensions: {
      ...(snapshot.parsed.extensions ?? {}),
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
    // Rollback: restore raw text byte-for-byte, then re-throw ORIGINAL error.
    try {
      await fs.promises.writeFile(snapshot.path, snapshot.rawText, 'utf8');
    } catch {
      // Rollback write failure is swallowed; the caller receives the original
      // validation error which is more actionable.
    }
    throw validationErr;
  }
}

// ---------------------------------------------------------------------------
// IR-14: hasMount
// ---------------------------------------------------------------------------

/**
 * Returns true when the snapshot contains a mount entry for the given path.
 */
export function hasMount(snapshot: ConfigSnapshot, mount: string): boolean {
  return snapshot.parsed.extensions?.mounts?.[mount] !== undefined;
}
