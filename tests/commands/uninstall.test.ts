/**
 * Tests for src/commands/uninstall.ts
 * Covers AC-5, AC-B9, AC-P4
 * Phase 3.5 additions: EC-13, EC-15, EC-16.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  makeTmpDir,
  captureOutput,
  bootstrapProject,
} from '../helpers/cli-fixtures.js';

// ============================================================
// MOCK SETUP
// ============================================================

const mocks = vi.hoisted(() => ({
  loadProject: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('@rcrsr/rill-config', async (importActual) => {
  const actual = await importActual<typeof import('@rcrsr/rill-config')>();
  return { ...actual, loadProject: mocks.loadProject };
});

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

vi.mock('../../src/cli-shared.js', () => ({
  CLI_VERSION: '0.0.0-test',
  VERSION: '0.0.0-test',
}));

// ============================================================
// HELPERS
// ============================================================

/** Returns a spawn mock that emits close with the given exit code. */
function makeSpawnMock(exitCode: number): () => EventEmitter {
  return () => {
    const child = new EventEmitter();
    process.nextTick(() => {
      child.emit('close', exitCode);
    });
    return child;
  };
}

/** Write a fake installed package.json under node_modules. */
function writeInstalledPkg(
  prefix: string,
  pkgName: string,
  version: string
): void {
  const pkgDir = path.join(prefix, 'node_modules', pkgName);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: pkgName, version }),
    'utf8'
  );
}

// ============================================================
// TESTS
// ============================================================

describe('uninstall', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origCwd = process.cwd();
    process.chdir(tmpDir);
    mocks.loadProject.mockResolvedValue({});
    mocks.spawn.mockImplementation(makeSpawnMock(0));
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  // ============================================================
  // AC-5: mount installed, uninstall removes mount + package dir
  // ============================================================

  describe('AC-5: uninstall removes mount from config and package directory', () => {
    it('removes mount from rill-config.json and exits 0', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });
      const prefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');

      // Simulate npm uninstall removing the package directory
      mocks.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        process.nextTick(() => {
          const pkgDir = path.join(
            prefix,
            'node_modules',
            '@rcrsr',
            'rill-ext-datetime'
          );
          fs.rmSync(pkgDir, { recursive: true, force: true });
          child.emit('close', 0);
        });
        return child;
      });

      const { run } = await import('../../src/commands/uninstall.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      const config = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-config.json'), 'utf8')
      ) as { extensions: { mounts: Record<string, string> } };
      expect(config.extensions.mounts).not.toHaveProperty('datetime');
    });

    it('emits UXT-EXT-7 messages on stdout', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });
      const prefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');

      mocks.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        process.nextTick(() => {
          child.emit('close', 0);
        });
        return child;
      });

      const { run } = await import('../../src/commands/uninstall.js');
      const cap = captureOutput();
      try {
        await run(['datetime']);
      } finally {
        cap.restore();
      }

      const out = cap.stdout.join('');
      // UXT-EXT-7 line 1
      expect(out).toContain(
        "ℹ Removing mount 'datetime' (@rcrsr/rill-ext-datetime@^0.19.0)"
      );
      // UXT-EXT-7 line 2
      expect(out).toContain('✓ Updated rill-config.json');
      // UXT-EXT-7 line 3
      expect(out).toContain(
        '✓ Uninstalled from .rill/npm/node_modules/@rcrsr/rill-ext-datetime'
      );
      // UXT-EXT-7 line 4
      expect(out).toContain('✓ Verified config loads cleanly');
    });
  });

  // ============================================================
  // AC-B9: mount exists, package directory absent — success
  // ============================================================

  describe('AC-B9: mount exists but package directory absent', () => {
    it('removes mount from config and exits 0 when package directory is missing', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });
      // Do NOT create the node_modules package directory — it is absent

      // npm uninstall reports exit 0 even when package was not installed
      mocks.spawn.mockImplementation(makeSpawnMock(0));

      const { run } = await import('../../src/commands/uninstall.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      const config = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-config.json'), 'utf8')
      ) as { extensions: { mounts: Record<string, string> } };
      expect(config.extensions.mounts).not.toHaveProperty('datetime');
    });
  });

  // ============================================================
  // AC-P4: timing < 5s
  // ============================================================

  describe('AC-P4: timing < 5s', () => {
    it('completes uninstall in under 5000ms', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });
      mocks.spawn.mockImplementation(makeSpawnMock(0));

      const { run } = await import('../../src/commands/uninstall.js');
      const cap = captureOutput();
      const start = performance.now();
      try {
        await run(['datetime']);
      } finally {
        cap.restore();
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(5000);
    });
  });

  // ============================================================
  // EC-13: .rill/npm/ missing
  // ============================================================

  describe('EC-13: .rill/npm/ missing emits UXT-EXT-5 and exits 1', () => {
    it('writes UXT-EXT-5 verbatim to stderr and exits 1', async () => {
      // Only rill-config.json; no .rill/npm/ directory
      fs.writeFileSync(
        path.join(tmpDir, 'rill-config.json'),
        JSON.stringify({
          name: 'test',
          main: 'main.rill',
          extensions: {
            mounts: { datetime: '@rcrsr/rill-ext-datetime@^0.19.0' },
          },
        }) + '\n',
        'utf8'
      );

      const { run } = await import('../../src/commands/uninstall.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      const err = cap.stderr.join('');
      expect(err).toContain('✗ .rill/npm/ not found');
      expect(err).toContain(
        "Run 'rill bootstrap' first to initialize the project"
      );
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // EC-15: npm uninstall non-zero exit
  // ============================================================

  describe('EC-15: npm uninstall non-zero exit propagates exit code', () => {
    it('returns npm exit code when npm uninstall fails', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });

      // npm uninstall returns exit code 2
      mocks.spawn.mockImplementation(makeSpawnMock(2));

      const { run } = await import('../../src/commands/uninstall.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(2);
    });
  });

  // ============================================================
  // C7: single-file uninstall — no npm, source file stays on disk
  // ============================================================

  describe('C7: single-file mount uninstall skips npm and leaves source file', () => {
    it('removes mount from config, does not invoke npm, leaves source file on disk', async () => {
      // Set up a source file that the mount points to
      const extPath = path.join(tmpDir, 'extensions', 'crawler.ts');
      fs.mkdirSync(path.dirname(extPath), { recursive: true });
      fs.writeFileSync(extPath, 'export default {};', 'utf8');

      bootstrapProject(tmpDir, {
        crawler: './extensions/crawler.ts',
      });

      const { run } = await import('../../src/commands/uninstall.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['crawler']);
      } finally {
        cap.restore();
      }

      // Command must succeed
      expect(exitCode).toBe(0);

      // Mount must be removed from config
      const config = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-config.json'), 'utf8')
      ) as { extensions: { mounts: Record<string, string> } };
      expect(config.extensions.mounts).not.toHaveProperty('crawler');

      // npm uninstall must NOT have been invoked
      expect(mocks.spawn).not.toHaveBeenCalled();

      // Source file must remain untouched on disk
      expect(fs.existsSync(extPath)).toBe(true);
    });
  });

  // ============================================================
  // EC-16: loadProject validation fails after uninstall
  // ============================================================

  describe('EC-16: loadProject validation fails after uninstall', () => {
    it('exits 1; emits validation error; mount removal stays (config NOT rolled back)', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
        other: '@rcrsr/rill-ext-other@^1.0.0',
      });
      writeInstalledPkg(
        path.join(tmpDir, '.rill', 'npm'),
        '@rcrsr/rill-ext-datetime',
        '0.19.0'
      );

      mocks.spawn.mockImplementation(makeSpawnMock(0));
      mocks.loadProject.mockRejectedValue(
        new Error('validation error: namespace conflict')
      );

      const { run } = await import('../../src/commands/uninstall.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      const err = cap.stderr.join('');
      expect(err).toContain('Config validation failed after uninstall');

      // Mount removal must persist — config NOT rolled back
      const config = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-config.json'), 'utf8')
      ) as { extensions: { mounts: Record<string, string> } };
      expect(config.extensions.mounts).not.toHaveProperty('datetime');
      // Other mount must still be present
      expect(config.extensions.mounts).toHaveProperty('other');
    });
  });
});
