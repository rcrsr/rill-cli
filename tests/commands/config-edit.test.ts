/**
 * Unit tests for config-edit.ts helpers:
 *   readConfigSnapshot (IR-12, EC-28)
 *   applyMountEdit     (IR-13, EC-29, EC-30)
 *   hasMount           (IR-14)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir } from '../helpers/cli-fixtures.js';

// ============================================================
// MOCK SETUP
// ============================================================

const loadProjectMock = vi.hoisted(() => vi.fn());

vi.mock('@rcrsr/rill-config', () => ({
  loadProject: loadProjectMock,
  ConfigNotFoundError: class ConfigNotFoundError extends Error {
    constructor(m?: string) {
      super(m);
      this.name = 'ConfigNotFoundError';
    }
  },
  MountValidationError: class MountValidationError extends Error {
    constructor(m?: string) {
      super(m);
      this.name = 'MountValidationError';
    }
  },
}));

// cli-shared imports CLI_VERSION — stub the whole module to avoid wiring.
vi.mock('../../src/cli-shared.js', () => ({
  CLI_VERSION: '0.0.0-test',
  VERSION: '0.0.0-test',
}));

// ============================================================
// HELPERS
// ============================================================

function writeConfig(dir: string, content: object): string {
  const configPath = path.join(dir, 'rill-config.json');
  fs.writeFileSync(configPath, JSON.stringify(content, null, 2) + '\n', 'utf8');
  return configPath;
}

// ============================================================
// TESTS: readConfigSnapshot (IR-12, EC-28)
// ============================================================

describe('readConfigSnapshot', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('throws ConfigNotFoundError when rill-config.json is absent (EC-28 / IR-12)', async () => {
    const tmpDir = makeTmpDir();
    try {
      const { readConfigSnapshot, ConfigNotFoundError } =
        await import('../../src/commands/config-edit.js');

      await expect(readConfigSnapshot(tmpDir)).rejects.toMatchObject({
        name: 'ConfigNotFoundError',
      });
      await expect(readConfigSnapshot(tmpDir)).rejects.toBeInstanceOf(
        ConfigNotFoundError
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns ConfigSnapshot with correct path, rawText, and parsed (IR-12)', async () => {
    const tmpDir = makeTmpDir();
    const configContent = {
      version: '1',
      extensions: { mounts: { foo: 'pkg@^1.0.0' } },
    };
    const configPath = writeConfig(tmpDir, configContent);

    try {
      const { readConfigSnapshot } =
        await import('../../src/commands/config-edit.js');

      const snapshot = await readConfigSnapshot(tmpDir);

      expect(snapshot.path).toBe(configPath);
      expect(snapshot.rawText).toBe(fs.readFileSync(configPath, 'utf8'));
      expect(snapshot.parsed).toMatchObject(configContent);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// TESTS: applyMountEdit (IR-13, EC-29, EC-30)
// ============================================================

describe('applyMountEdit', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('writes new mount and calls loadProject on add (IR-13)', async () => {
    const tmpDir = makeTmpDir();
    const configContent = { version: '1', extensions: { mounts: {} } };
    writeConfig(tmpDir, configContent);
    loadProjectMock.mockResolvedValue({});

    try {
      const { readConfigSnapshot, applyMountEdit } =
        await import('../../src/commands/config-edit.js');

      const snapshot = await readConfigSnapshot(tmpDir);
      await applyMountEdit(
        snapshot,
        { kind: 'add', mount: 'foo', value: 'pkg@^1.0.0' },
        tmpDir
      );

      const written = fs.readFileSync(snapshot.path, 'utf8');
      const parsed = JSON.parse(written);
      expect(parsed.extensions.mounts.foo).toBe('pkg@^1.0.0');
      expect(loadProjectMock).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('removes a mount and calls loadProject on remove (IR-13)', async () => {
    const tmpDir = makeTmpDir();
    const configContent = {
      version: '1',
      extensions: { mounts: { foo: 'pkg@^1.0.0', bar: 'other@2.0.0' } },
    };
    writeConfig(tmpDir, configContent);
    loadProjectMock.mockResolvedValue({});

    try {
      const { readConfigSnapshot, applyMountEdit } =
        await import('../../src/commands/config-edit.js');

      const snapshot = await readConfigSnapshot(tmpDir);
      await applyMountEdit(snapshot, { kind: 'remove', mount: 'foo' }, tmpDir);

      const written = fs.readFileSync(snapshot.path, 'utf8');
      const parsed = JSON.parse(written);
      expect(parsed.extensions.mounts).not.toHaveProperty('foo');
      expect(parsed.extensions.mounts.bar).toBe('other@2.0.0');
      expect(loadProjectMock).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('restores original rawText and re-throws MountValidationError on rollback (EC-29)', async () => {
    const tmpDir = makeTmpDir();
    const configContent = {
      version: '1',
      extensions: { mounts: { existing: 'base@1.0.0' } },
    };
    writeConfig(tmpDir, configContent);

    const validationError = new Error('mount failed');
    validationError.name = 'MountValidationError';
    loadProjectMock.mockRejectedValue(validationError);

    try {
      const { readConfigSnapshot, applyMountEdit } =
        await import('../../src/commands/config-edit.js');

      const snapshot = await readConfigSnapshot(tmpDir);
      const originalRawText = snapshot.rawText;

      await expect(
        applyMountEdit(
          snapshot,
          { kind: 'add', mount: 'bad', value: 'broken@0.0.1' },
          tmpDir
        )
      ).rejects.toMatchObject({ name: 'MountValidationError' });

      // File must be byte-for-byte equal to original rawText after rollback.
      const afterContent = fs.readFileSync(snapshot.path, 'utf8');
      expect(afterContent).toBe(originalRawText);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips loadProject when skipValidation is true (options.skipValidation)', async () => {
    const tmpDir = makeTmpDir();
    const configContent = { version: '1', extensions: { mounts: {} } };
    writeConfig(tmpDir, configContent);

    try {
      const { readConfigSnapshot, applyMountEdit } =
        await import('../../src/commands/config-edit.js');

      const snapshot = await readConfigSnapshot(tmpDir);
      await applyMountEdit(
        snapshot,
        { kind: 'add', mount: 'foo', value: 'pkg@^1.0.0' },
        tmpDir,
        { skipValidation: true }
      );

      const written = fs.readFileSync(snapshot.path, 'utf8');
      const parsed = JSON.parse(written);
      expect(parsed.extensions.mounts.foo).toBe('pkg@^1.0.0');
      expect(loadProjectMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws ConfigWriteError when writeFile fails (EC-30)', async () => {
    const tmpDir = makeTmpDir();
    const configContent = { version: '1', extensions: { mounts: {} } };
    writeConfig(tmpDir, configContent);

    const writeSpy = vi
      .spyOn(fs.promises, 'writeFile')
      .mockRejectedValue(new Error('disk full'));

    try {
      const { readConfigSnapshot, applyMountEdit, ConfigWriteError } =
        await import('../../src/commands/config-edit.js');

      const snapshot = await readConfigSnapshot(tmpDir);

      await expect(
        applyMountEdit(
          snapshot,
          { kind: 'add', mount: 'foo', value: 'pkg@1.0.0' },
          tmpDir
        )
      ).rejects.toBeInstanceOf(ConfigWriteError);
    } finally {
      writeSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// TESTS: hasMount (IR-14)
// ============================================================

describe('hasMount', () => {
  it('returns true when the mount exists in the snapshot', async () => {
    const { hasMount } = await import('../../src/commands/config-edit.js');

    const snapshot = {
      path: '/fake/rill-config.json',
      rawText: '{}',
      parsed: {
        version: '1',
        extensions: { mounts: { foo: 'pkg@^1.0.0' } },
      } as never,
    };

    expect(hasMount(snapshot, 'foo')).toBe(true);
  });

  it('returns false when the mount is absent from the snapshot', async () => {
    const { hasMount } = await import('../../src/commands/config-edit.js');

    const snapshot = {
      path: '/fake/rill-config.json',
      rawText: '{}',
      parsed: {
        version: '1',
        extensions: { mounts: { bar: 'other@1.0.0' } },
      } as never,
    };

    expect(hasMount(snapshot, 'foo')).toBe(false);
  });

  it('returns false when no mounts exist in the snapshot', async () => {
    const { hasMount } = await import('../../src/commands/config-edit.js');

    const snapshot = {
      path: '/fake/rill-config.json',
      rawText: '{}',
      parsed: { version: '1' } as never,
    };

    expect(hasMount(snapshot, 'foo')).toBe(false);
  });
});
