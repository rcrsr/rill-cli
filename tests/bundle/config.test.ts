import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir } from '../helpers/cli-fixtures.js';
import {
  readBundleConfig,
  detectBundleAtCwd,
  findBundleRoot,
  writeBundleHarness,
  BundleConfigError,
} from '../../src/bundle/config.js';

// ============================================================
// FIXTURE HELPERS
// ============================================================

const BUNDLE_FILE = 'rill-bundle.json';

function writeBundleJson(dir: string, content: unknown): void {
  fs.writeFileSync(
    path.join(dir, BUNDLE_FILE),
    JSON.stringify(content, null, 2) + '\n',
    'utf8'
  );
}

const VALID_CONFIG = {
  name: 'my-bundle',
  version: '1.0.0',
  harness: 'my-harness',
  config: { key: 'value' },
  defaultPackage: 'pkg-a',
  packages: [
    { mount: 'pkg-a', project: 'packages/pkg-a' },
    { mount: 'pkg-b', project: 'packages/pkg-b' },
  ],
};

// ============================================================
// readBundleConfig: happy path
// ============================================================

describe('readBundleConfig', () => {
  describe('valid config with full fields', () => {
    it('parses all fields correctly', async () => {
      const tmpDir = makeTmpDir();
      try {
        writeBundleJson(tmpDir, VALID_CONFIG);
        const result = await readBundleConfig(tmpDir);

        expect(result.name).toBe('my-bundle');
        expect(result.version).toBe('1.0.0');
        expect(result.harness).toBe('my-harness');
        expect(result.config).toEqual({ key: 'value' });
        expect(result.defaultPackage).toBe('pkg-a');
        expect(result.packages).toHaveLength(2);
        expect(result.packages[0]).toEqual({
          mount: 'pkg-a',
          project: 'packages/pkg-a',
        });
        expect(result.packages[1]).toEqual({
          mount: 'pkg-b',
          project: 'packages/pkg-b',
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================
  // readBundleConfig: defaultPackage defaulting
  // ============================================================

  describe('defaultPackage defaulting', () => {
    it('resolves defaultPackage to packages[0].mount when absent', async () => {
      const tmpDir = makeTmpDir();
      try {
        const config = {
          name: 'test-bundle',
          version: '1.0.0',
          packages: [{ mount: 'only-pkg', project: 'packages/only-pkg' }],
        };
        writeBundleJson(tmpDir, config);
        const result = await readBundleConfig(tmpDir);

        expect(result.defaultPackage).toBe('only-pkg');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('resolves defaultPackage to the single entry mount for single-entry packages array', async () => {
      const tmpDir = makeTmpDir();
      try {
        const config = {
          name: 'single-bundle',
          version: '0.1.0',
          packages: [{ mount: 'sole', project: 'packages/sole' }],
        };
        writeBundleJson(tmpDir, config);
        const result = await readBundleConfig(tmpDir);

        expect(result.defaultPackage).toBe('sole');
        expect(result.packages).toHaveLength(1);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================
  // readBundleConfig: config field defaulting
  // ============================================================

  describe('config field defaulting', () => {
    it('resolves config to {} when absent', async () => {
      const tmpDir = makeTmpDir();
      try {
        const config = {
          name: 'test-bundle',
          version: '1.0.0',
          packages: [{ mount: 'pkg', project: 'packages/pkg' }],
        };
        writeBundleJson(tmpDir, config);
        const result = await readBundleConfig(tmpDir);

        expect(result.config).toEqual({});
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================
  // readBundleConfig: error cases — NOT_FOUND
  // ============================================================

  describe('NOT_FOUND error', () => {
    it('throws BundleConfigError with code NOT_FOUND when file is absent', async () => {
      const tmpDir = makeTmpDir();
      try {
        await expect(readBundleConfig(tmpDir)).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
        await expect(readBundleConfig(tmpDir)).rejects.toBeInstanceOf(
          BundleConfigError
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================
  // readBundleConfig: error cases — PARSE
  // ============================================================

  describe('PARSE error', () => {
    it('throws BundleConfigError with code PARSE for invalid JSON', async () => {
      const tmpDir = makeTmpDir();
      try {
        fs.writeFileSync(
          path.join(tmpDir, BUNDLE_FILE),
          '{ invalid json !!!',
          'utf8'
        );

        await expect(readBundleConfig(tmpDir)).rejects.toMatchObject({
          code: 'PARSE',
        });
        await expect(readBundleConfig(tmpDir)).rejects.toBeInstanceOf(
          BundleConfigError
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================
  // readBundleConfig: error cases — SCHEMA (missing name)
  // ============================================================

  describe('SCHEMA error: missing name', () => {
    it('throws BundleConfigError with field name when name is absent', async () => {
      const tmpDir = makeTmpDir();
      try {
        const config = {
          version: '1.0.0',
          packages: [{ mount: 'pkg', project: 'packages/pkg' }],
        };
        writeBundleJson(tmpDir, config);

        await expect(readBundleConfig(tmpDir)).rejects.toMatchObject({
          code: 'SCHEMA',
          field: 'name',
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================
  // readBundleConfig: null field constraints
  // ============================================================

  describe('null field constraints', () => {
    it('rejects when harness is null', async () => {
      const tmpDir = makeTmpDir();
      try {
        writeBundleJson(tmpDir, {
          name: 'test',
          version: '1.0.0',
          harness: null,
          packages: [{ mount: 'pkg', project: 'packages/pkg' }],
        });

        await expect(readBundleConfig(tmpDir)).rejects.toMatchObject({
          code: 'SCHEMA',
          field: 'harness',
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('rejects when config is null', async () => {
      const tmpDir = makeTmpDir();
      try {
        writeBundleJson(tmpDir, {
          name: 'test',
          version: '1.0.0',
          config: null,
          packages: [{ mount: 'pkg', project: 'packages/pkg' }],
        });

        await expect(readBundleConfig(tmpDir)).rejects.toMatchObject({
          code: 'SCHEMA',
          field: 'config',
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('rejects when defaultPackage is null', async () => {
      const tmpDir = makeTmpDir();
      try {
        writeBundleJson(tmpDir, {
          name: 'test',
          version: '1.0.0',
          defaultPackage: null,
          packages: [{ mount: 'pkg', project: 'packages/pkg' }],
        });

        await expect(readBundleConfig(tmpDir)).rejects.toMatchObject({
          code: 'SCHEMA',
          field: 'defaultPackage',
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================
  // readBundleConfig: error cases — DUPLICATE_MOUNT
  // ============================================================

  describe('DUPLICATE_MOUNT error', () => {
    it('throws BundleConfigError with code DUPLICATE_MOUNT for repeated mount names', async () => {
      const tmpDir = makeTmpDir();
      try {
        writeBundleJson(tmpDir, {
          name: 'dup-bundle',
          version: '1.0.0',
          packages: [
            { mount: 'same', project: 'packages/a' },
            { mount: 'same', project: 'packages/b' },
          ],
        });

        await expect(readBundleConfig(tmpDir)).rejects.toMatchObject({
          code: 'DUPLICATE_MOUNT',
        });
        await expect(readBundleConfig(tmpDir)).rejects.toBeInstanceOf(
          BundleConfigError
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================
  // readBundleConfig: error cases — empty packages
  // ============================================================

  describe('empty packages array', () => {
    it('throws BundleConfigError when packages is an empty array', async () => {
      const tmpDir = makeTmpDir();
      try {
        writeBundleJson(tmpDir, {
          name: 'empty-bundle',
          version: '1.0.0',
          packages: [],
        });

        await expect(readBundleConfig(tmpDir)).rejects.toMatchObject({
          code: 'SCHEMA',
          field: 'packages',
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================
  // readBundleConfig: error cases — defaultPackage mismatch
  // ============================================================

  describe('defaultPackage mismatch', () => {
    it('throws BundleConfigError when defaultPackage references non-existent mount', async () => {
      const tmpDir = makeTmpDir();
      try {
        writeBundleJson(tmpDir, {
          name: 'mismatch-bundle',
          version: '1.0.0',
          defaultPackage: 'does-not-exist',
          packages: [{ mount: 'real-pkg', project: 'packages/real-pkg' }],
        });

        await expect(readBundleConfig(tmpDir)).rejects.toMatchObject({
          code: 'SCHEMA',
          field: 'defaultPackage',
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================
  // readBundleConfig: error cases — project path escapes bundleDir
  // ============================================================

  describe('project path traversal', () => {
    it('throws BundleConfigError when packages[].project contains .. that escapes bundleDir', async () => {
      const tmpDir = makeTmpDir();
      try {
        writeBundleJson(tmpDir, {
          name: 'escape-bundle',
          version: '1.0.0',
          packages: [{ mount: 'evil', project: '../../outside' }],
        });

        await expect(readBundleConfig(tmpDir)).rejects.toMatchObject({
          code: 'SCHEMA',
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

// ============================================================
// detectBundleAtCwd
// ============================================================

describe('detectBundleAtCwd', () => {
  it('returns true when rill-bundle.json exists in the given directory', () => {
    const tmpDir = makeTmpDir();
    try {
      writeBundleJson(tmpDir, {
        name: 'test',
        version: '1.0.0',
        packages: [{ mount: 'pkg', project: 'packages/pkg' }],
      });

      expect(detectBundleAtCwd(tmpDir)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns false when rill-bundle.json is absent', () => {
    const tmpDir = makeTmpDir();
    try {
      expect(detectBundleAtCwd(tmpDir)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not walk up to parent directories', () => {
    const tmpDir = makeTmpDir();
    try {
      // Place bundle only in parent, not in child
      writeBundleJson(tmpDir, {
        name: 'parent-bundle',
        version: '1.0.0',
        packages: [{ mount: 'pkg', project: 'packages/pkg' }],
      });
      const childDir = path.join(tmpDir, 'child');
      fs.mkdirSync(childDir, { recursive: true });

      expect(detectBundleAtCwd(childDir)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// findBundleRoot
// ============================================================

describe('findBundleRoot', () => {
  it('returns the directory itself when rill-bundle.json is present there', () => {
    const tmpDir = makeTmpDir();
    try {
      writeBundleJson(tmpDir, {
        name: 'root-bundle',
        version: '1.0.0',
        packages: [{ mount: 'pkg', project: 'packages/pkg' }],
      });

      expect(findBundleRoot(tmpDir)).toBe(path.resolve(tmpDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('walks up ancestor directories to find rill-bundle.json', () => {
    const tmpDir = makeTmpDir();
    try {
      writeBundleJson(tmpDir, {
        name: 'ancestor-bundle',
        version: '1.0.0',
        packages: [{ mount: 'pkg', project: 'packages/pkg' }],
      });

      const deepDir = path.join(tmpDir, 'a', 'b', 'c');
      fs.mkdirSync(deepDir, { recursive: true });

      expect(findBundleRoot(deepDir)).toBe(path.resolve(tmpDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns null when no ancestor directory contains rill-bundle.json', () => {
    const tmpDir = makeTmpDir();
    try {
      // tmpDir itself has no rill-bundle.json, so the walk returns null.
      expect(findBundleRoot(tmpDir)).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// writeBundleHarness
// ============================================================

describe('writeBundleHarness', () => {
  it('updates the harness field to the given name', async () => {
    const tmpDir = makeTmpDir();
    try {
      writeBundleJson(tmpDir, {
        name: 'harness-bundle',
        version: '1.0.0',
        packages: [{ mount: 'pkg', project: 'packages/pkg' }],
      });

      await writeBundleHarness(tmpDir, 'new-harness');

      const updated = JSON.parse(
        fs.readFileSync(path.join(tmpDir, BUNDLE_FILE), 'utf8')
      ) as { harness?: string };
      expect(updated.harness).toBe('new-harness');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('clears the harness field when null is passed', async () => {
    const tmpDir = makeTmpDir();
    try {
      writeBundleJson(tmpDir, {
        name: 'harness-bundle',
        version: '1.0.0',
        harness: 'existing-harness',
        packages: [{ mount: 'pkg', project: 'packages/pkg' }],
      });

      await writeBundleHarness(tmpDir, null);

      const updated = JSON.parse(
        fs.readFileSync(path.join(tmpDir, BUNDLE_FILE), 'utf8')
      ) as Record<string, unknown>;
      expect('harness' in updated).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws BundleConfigError with code NOT_FOUND when bundle file is absent', async () => {
    const tmpDir = makeTmpDir();
    try {
      await expect(writeBundleHarness(tmpDir, 'harness')).rejects.toMatchObject(
        {
          code: 'NOT_FOUND',
        }
      );
      await expect(
        writeBundleHarness(tmpDir, 'harness')
      ).rejects.toBeInstanceOf(BundleConfigError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws BundleConfigError with code WRITE when the file cannot be written', async () => {
    const tmpDir = makeTmpDir();
    const bundlePath = path.join(tmpDir, BUNDLE_FILE);
    try {
      writeBundleJson(tmpDir, {
        name: 'write-fail-bundle',
        version: '1.0.0',
        packages: [{ mount: 'pkg', project: 'packages/pkg' }],
      });

      // Make the file read-only so writeFile throws EACCES.
      fs.chmodSync(bundlePath, 0o444);

      await expect(
        writeBundleHarness(tmpDir, 'any-harness')
      ).rejects.toMatchObject({
        code: 'WRITE',
      });
      await expect(
        writeBundleHarness(tmpDir, 'any-harness')
      ).rejects.toBeInstanceOf(BundleConfigError);
    } finally {
      // Restore write permission so rmSync can clean up.
      try {
        fs.chmodSync(bundlePath, 0o644);
      } catch {
        // ignore if file was never created
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
