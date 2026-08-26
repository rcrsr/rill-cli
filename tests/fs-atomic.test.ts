/**
 * Unit tests for src/fs-atomic.ts: atomicWriteFile.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir } from './helpers/cli-fixtures.js';
import { atomicWriteFile } from '../src/fs-atomic.js';

describe('atomicWriteFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves the target with the full new content after a successful write', async () => {
    const tmpDir = makeTmpDir();
    try {
      const filePath = path.join(tmpDir, 'rill-config.json');
      await atomicWriteFile(filePath, '{"a":1}\n', 'utf8');

      expect(fs.readFileSync(filePath, 'utf8')).toBe('{"a":1}\n');

      // No leftover temp file after a successful write.
      const residue = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
      expect(residue).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('leaves the original target content intact and removes the temp file when the rename fails', async () => {
    const tmpDir = makeTmpDir();
    try {
      const filePath = path.join(tmpDir, 'rill-config.json');
      fs.writeFileSync(filePath, '{"original":true}\n', 'utf8');

      const renameSpy = vi
        .spyOn(fs.promises, 'rename')
        .mockRejectedValue(new Error('EACCES: rename denied'));

      await expect(
        atomicWriteFile(filePath, '{"new":true}\n', 'utf8')
      ).rejects.toThrow('EACCES: rename denied');

      // Original content untouched: the destination was never opened for
      // writing directly, only the temp file was, and the rename never
      // completed.
      expect(fs.readFileSync(filePath, 'utf8')).toBe('{"original":true}\n');

      // No leftover temp file: the failure path removes it.
      const residue = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
      expect(residue).toEqual([]);

      renameSpy.mockRestore();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('leaves the original target content intact when the temp write itself fails', async () => {
    const tmpDir = makeTmpDir();
    try {
      const filePath = path.join(tmpDir, 'rill-config.json');
      fs.writeFileSync(filePath, '{"original":true}\n', 'utf8');

      const writeSpy = vi
        .spyOn(fs.promises, 'writeFile')
        .mockRejectedValue(new Error('ENOSPC: no space left on device'));

      await expect(
        atomicWriteFile(filePath, '{"new":true}\n', 'utf8')
      ).rejects.toThrow('ENOSPC: no space left on device');

      expect(fs.readFileSync(filePath, 'utf8')).toBe('{"original":true}\n');

      const residue = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
      expect(residue).toEqual([]);

      writeSpy.mockRestore();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects with the original error rather than swallowing it', async () => {
    const tmpDir = makeTmpDir();
    try {
      const filePath = path.join(tmpDir, 'rill-config.json');
      const originalError = new Error('EACCES: rename denied');
      vi.spyOn(fs.promises, 'rename').mockRejectedValue(originalError);

      await expect(atomicWriteFile(filePath, 'data', 'utf8')).rejects.toBe(
        originalError
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('writes the temp file in the same directory as the target', async () => {
    const tmpDir = makeTmpDir();
    try {
      const filePath = path.join(tmpDir, 'rill-config.json');
      const seenDirs: string[] = [];
      const origWriteFile = fs.promises.writeFile.bind(fs.promises);
      const writeSpy = vi
        .spyOn(fs.promises, 'writeFile')
        .mockImplementation(async (target, ...rest) => {
          seenDirs.push(path.dirname(String(target)));
          return origWriteFile(
            target as Parameters<typeof origWriteFile>[0],
            ...(rest as [])
          );
        });

      await atomicWriteFile(filePath, 'data', 'utf8');

      expect(seenDirs).toEqual([tmpDir]);
      writeSpy.mockRestore();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
