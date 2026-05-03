/**
 * Tests for src/commands/upgrade.ts
 * Covers AC-6, AC-B10, AC-P3
 * Phase 3.5 additions: EC-17, EC-18, AC-E4/EC-19, EC-20, EC-21.
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

/**
 * Returns a spawn mock that emits close with exitCode and writes an updated
 * package.json at the given node_modules path (simulating npm installing a
 * new version).
 */
function makeUpgradeSpawnMock(
  prefix: string,
  pkgName: string,
  newVersion: string,
  exitCode = 0
): () => EventEmitter {
  return () => {
    const child = new EventEmitter();
    process.nextTick(() => {
      writeInstalledPkg(prefix, pkgName, newVersion);
      child.emit('close', exitCode);
    });
    return child;
  };
}

// ============================================================
// TESTS
// ============================================================

describe('upgrade', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origCwd = process.cwd();
    process.chdir(tmpDir);
    mocks.loadProject.mockResolvedValue({});
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  // ============================================================
  // AC-6: upgrade from ^0.19.0 to ^0.20.1
  // ============================================================

  describe('AC-6: upgrade to newer version', () => {
    it('updates mount value to new caret version and exits 0', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });
      const prefix = path.join(tmpDir, '.rill', 'npm');

      mocks.spawn.mockImplementation(
        makeUpgradeSpawnMock(prefix, '@rcrsr/rill-ext-datetime', '0.20.1')
      );

      const { run } = await import('../../src/commands/upgrade.js');
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
      expect(config.extensions.mounts['datetime']).toBe(
        '@rcrsr/rill-ext-datetime@^0.20.1'
      );
    });

    it('emits UXT-EXT-9 messages on stdout', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });
      const prefix = path.join(tmpDir, '.rill', 'npm');

      mocks.spawn.mockImplementation(
        makeUpgradeSpawnMock(prefix, '@rcrsr/rill-ext-datetime', '0.20.1')
      );

      const { run } = await import('../../src/commands/upgrade.js');
      const cap = captureOutput();
      try {
        await run(['datetime']);
      } finally {
        cap.restore();
      }

      const out = cap.stdout.join('');
      expect(out).toContain('ℹ Current: @rcrsr/rill-ext-datetime@^0.19.0');
      expect(out).toContain('✓ Installed @rcrsr/rill-ext-datetime@0.20.1');
      expect(out).toContain(
        "✓ Updated mount 'datetime' to '@rcrsr/rill-ext-datetime@^0.20.1'"
      );
      expect(out).toContain('✓ Verified config loads cleanly');
    });
  });

  // ============================================================
  // AC-B10: already at latest
  // ============================================================

  describe('AC-B10: already at latest version', () => {
    it('emits "Already at latest" and exits 0 without changing mount', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.20.1',
      });
      const prefix = path.join(tmpDir, '.rill', 'npm');

      // npm installs same version as current
      mocks.spawn.mockImplementation(
        makeUpgradeSpawnMock(prefix, '@rcrsr/rill-ext-datetime', '0.20.1')
      );

      const { run } = await import('../../src/commands/upgrade.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      const out = cap.stdout.join('');
      expect(out).toContain('Already at latest');

      // Mount value must be unchanged
      const config = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-config.json'), 'utf8')
      ) as { extensions: { mounts: Record<string, string> } };
      expect(config.extensions.mounts['datetime']).toBe(
        '@rcrsr/rill-ext-datetime@^0.20.1'
      );
    });
  });

  // ============================================================
  // AC-P3: config-edit + loadProject validation < 1s
  // ============================================================

  describe('AC-P3: timing < 1s', () => {
    it('config-edit + loadProject validation completes in under 1000ms', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });
      const prefix = path.join(tmpDir, '.rill', 'npm');

      mocks.spawn.mockImplementation(
        makeUpgradeSpawnMock(prefix, '@rcrsr/rill-ext-datetime', '0.20.1')
      );

      const { run } = await import('../../src/commands/upgrade.js');
      const cap = captureOutput();
      const start = performance.now();
      try {
        await run(['datetime']);
      } finally {
        cap.restore();
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });

  // ============================================================
  // EC-17: .rill/npm/ missing
  // ============================================================

  describe('EC-17: .rill/npm/ missing emits UXT-EXT-5 and exits 1', () => {
    it('writes UXT-EXT-5 verbatim to stderr and exits 1; no npm subprocess', async () => {
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

      const { run } = await import('../../src/commands/upgrade.js');
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
  // EC-18: Mount not in config
  // ============================================================

  describe('EC-18: unknown mount exits 1 with "Mount not found" message', () => {
    it('writes mount-not-found message to stderr and exits 1', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });

      const { run } = await import('../../src/commands/upgrade.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['ghost']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain(
        "Mount 'ghost' not found in rill-config.json"
      );
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // AC-E4 / EC-19: Local-path mount refused
  // ============================================================

  describe('AC-E4/EC-19: local-path mount refused with UXT-EXT-10; no npm', () => {
    it('emits UXT-EXT-10 verbatim to stderr; no npm subprocess; exits 1', async () => {
      bootstrapProject(tmpDir, {
        'local-ext': './local-ext',
      });

      const { run } = await import('../../src/commands/upgrade.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['local-ext']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      const err = cap.stderr.join('');
      expect(err).toContain("Mount 'local-ext' is a local-path source");
      expect(err).toContain('./local-ext');
      expect(err).toContain('Local-path mounts cannot be upgraded');
      expect(err).toContain("'rill install ./local-ext --as local-ext'");
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // EC-20: npm install non-zero exit
  // ============================================================

  describe('EC-20: npm install non-zero exit propagates; no rollback line', () => {
    it('returns npm exit code; no rollback line in output', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });

      // npm returns exit code 1
      mocks.spawn.mockImplementation(
        makeUpgradeSpawnMock(
          path.join(tmpDir, '.rill', 'npm'),
          '@rcrsr/rill-ext-datetime',
          '0.20.1',
          1
        )
      );

      const { run } = await import('../../src/commands/upgrade.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      const combined = [...cap.stdout, ...cap.stderr].join('');
      expect(combined).not.toContain('Rolled back');
    });
  });

  // ============================================================
  // EC-21: loadProject validation fails after upgrade
  // ============================================================

  describe('EC-21: loadProject validation fails after upgrade', () => {
    it('exits 1; emits rollback message; rill-config.json reverted', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });
      const prefix = path.join(tmpDir, '.rill', 'npm');

      const configBefore = fs.readFileSync(
        path.join(tmpDir, 'rill-config.json'),
        'utf8'
      );

      mocks.spawn.mockImplementation(
        makeUpgradeSpawnMock(prefix, '@rcrsr/rill-ext-datetime', '0.20.1')
      );
      mocks.loadProject.mockRejectedValue(
        new Error('factory rejected: incompatible API')
      );

      const { run } = await import('../../src/commands/upgrade.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      const err = cap.stderr.join('');
      expect(err).toContain('Config validation failed');
      expect(err).toContain('Rolled back rill-config.json');

      // Config must be reverted byte-for-byte
      const configAfter = fs.readFileSync(
        path.join(tmpDir, 'rill-config.json'),
        'utf8'
      );
      expect(configAfter).toBe(configBefore);
    });
  });

  // ============================================================
  // P2-3: Pinned mount no-op
  // ============================================================

  describe('P2-3: pinned mount no-op', () => {
    it('exits 0 and does not run npm when mount is pinned', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@1.2.3',
      });

      const { run } = await import('../../src/commands/upgrade.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      expect(mocks.spawn).not.toHaveBeenCalled();
      const out = cap.stdout.join('');
      expect(out).toContain("mount 'datetime' is pinned to 1.2.3");
      expect(out).toContain('--pin --as datetime');

      // Config must remain byte-equal
      const cfg = fs.readFileSync(
        path.join(tmpDir, 'rill-config.json'),
        'utf8'
      );
      const parsed = JSON.parse(cfg) as {
        extensions: { mounts: Record<string, string> };
      };
      expect(parsed.extensions.mounts['datetime']).toBe(
        '@rcrsr/rill-ext-datetime@1.2.3'
      );
    });

    it('treats caret as upgradeable, not pinned', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^1.2.3',
      });
      const prefix = path.join(tmpDir, '.rill', 'npm');
      mocks.spawn.mockImplementation(
        makeUpgradeSpawnMock(prefix, '@rcrsr/rill-ext-datetime', '1.3.0')
      );

      const { run } = await import('../../src/commands/upgrade.js');
      const cap = captureOutput();
      try {
        await run(['datetime']);
      } finally {
        cap.restore();
      }
      expect(mocks.spawn).toHaveBeenCalled();
    });
  });

  // ============================================================
  // P2-1: --exact deprecation warning
  // ============================================================

  describe('P2-1: --exact deprecation warning', () => {
    it('prints deprecation warning when --exact is used', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });
      const prefix = path.join(tmpDir, '.rill', 'npm');
      mocks.spawn.mockImplementation(
        makeUpgradeSpawnMock(prefix, '@rcrsr/rill-ext-datetime', '0.20.1')
      );

      const { run } = await import('../../src/commands/upgrade.js');
      const cap = captureOutput();
      try {
        await run(['datetime', '--exact']);
      } finally {
        cap.restore();
      }
      expect(cap.stderr.join('')).toContain('--exact is deprecated');
    });
  });
});
