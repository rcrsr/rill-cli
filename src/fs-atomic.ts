/**
 * Atomic file write helper.
 *
 * Writes durable config files (rill-config.json, rill-bundle.json) without
 * ever truncating the destination in place: a crash or a failed write must
 * leave the previous, valid content on disk rather than a half-written file.
 *
 * Internal module — not part of the published `.`/`./harness` entry points.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Writes `data` to `filePath` atomically: the content is written to a
 * temporary file in the same directory as `filePath`, then the temporary
 * file is renamed over the target. A rename within the same directory is an
 * atomic filesystem operation, so readers never observe a partially written
 * file.
 *
 * On failure at any step, the temporary file is removed (best-effort) and
 * the original error is rethrown unchanged. The destination is never opened
 * for writing directly, so a failure never truncates or corrupts it.
 *
 * @throws the original write/rename error
 */
export async function atomicWriteFile(
  filePath: string,
  data: string,
  encoding: BufferEncoding = 'utf8'
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const suffix = randomBytes(6).toString('hex');
  const tempPath = path.join(dir, `.${base}.${process.pid}.${suffix}.tmp`);

  try {
    await fs.writeFile(tempPath, data, encoding);

    // Fsync the temp file before rename so a crash between the write and the
    // rename cannot leave the temp content unflushed to disk: rename alone
    // only guarantees atomicity of the directory-entry swap, not durability
    // of the bytes it points at.
    const syncHandle = await fs.open(tempPath, 'r+');
    try {
      await syncHandle.sync();
    } finally {
      await syncHandle.close();
    }

    const destMode = await fs
      .stat(filePath)
      .then((s) => s.mode)
      .catch((statErr: NodeJS.ErrnoException) => {
        if (statErr.code === 'ENOENT') return undefined;
        throw statErr;
      });
    if (destMode !== undefined) {
      await fs.chmod(tempPath, destMode);
    }

    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
