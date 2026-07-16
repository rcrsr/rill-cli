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

/** Write a minimal rill-bundle.json at the given directory. */
function writeBundleJson(
  dir: string,
  opts: {
    harness?: string;
    packages?: Array<{ mount: string; project: string }>;
  } = {}
): void {
  const packages = opts.packages ?? [{ mount: 'app', project: 'packages/app' }];
  const content: Record<string, unknown> = {
    name: 'test-bundle',
    version: '1.0.0',
    packages,
  };
  if (opts.harness !== undefined) {
    content['harness'] = opts.harness;
  }
  fs.writeFileSync(
    path.join(dir, 'rill-bundle.json'),
    JSON.stringify(content, null, 2) + '\n',
    'utf8'
  );
}

/**
 * Bootstrap a bundle: write rill-bundle.json, create .rill/npm/ at the bundle
 * root, and write rill-config.json in each package sub-directory.
 */
function bootstrapBundle(
  bundleRoot: string,
  opts: {
    harness?: string;
    packages?: Array<{ mount: string; project: string }>;
  } = {}
): void {
  const packages = opts.packages ?? [{ mount: 'app', project: 'packages/app' }];
  writeBundleJson(bundleRoot, { harness: opts.harness, packages });

  const rillNpm = path.join(bundleRoot, '.rill', 'npm');
  fs.mkdirSync(rillNpm, { recursive: true });
  fs.writeFileSync(
    path.join(rillNpm, 'package.json'),
    '{"name":"rill-extensions","private":true}\n',
    'utf8'
  );

  for (const pkg of packages) {
    const pkgDir = path.join(bundleRoot, pkg.project);
    fs.mkdirSync(pkgDir, { recursive: true });
    bootstrapProject(pkgDir);
  }
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
      expect(err).toContain("Run 'rill init' first to initialize the project");
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

  // ============================================================
  // Bundle-aware behavior: --harness and --for
  // ============================================================

  describe('bundle mode', () => {
    describe('--harness removes the declared harness', () => {
      it('removes the harness field from rill-bundle.json, uninstalls from the bundle prefix, and exits 0', async () => {
        const harnessName = 'my-bundle-harness-pkg-u1';
        bootstrapBundle(tmpDir, {
          harness: harnessName,
          packages: [{ mount: 'app', project: 'packages/app' }],
        });
        const bundlePrefix = path.join(tmpDir, '.rill', 'npm');
        writeInstalledPkg(bundlePrefix, harnessName, '1.0.0');

        mocks.spawn.mockImplementation(makeSpawnMock(0));

        const { run } = await import('../../src/commands/uninstall.js');
        const cap = captureOutput();
        let exitCode: number;
        try {
          exitCode = await run(['--harness']);
        } finally {
          cap.restore();
        }

        expect(exitCode).toBe(0);

        const bundleConfig = JSON.parse(
          fs.readFileSync(path.join(tmpDir, 'rill-bundle.json'), 'utf8')
        ) as { harness?: string };
        expect(bundleConfig).not.toHaveProperty('harness');

        // npm uninstall must target the bundle-root prefix, not a package prefix.
        const uninstallCall = mocks.spawn.mock.calls.find(
          (call) => (call[1] as string[])[0] === 'uninstall'
        );
        expect(uninstallCall).toBeDefined();
        expect(uninstallCall?.[1]).toEqual([
          'uninstall',
          harnessName,
          '--prefix',
          bundlePrefix,
        ]);

        const out = cap.stdout.join('');
        expect(out).toContain(`ℹ Removing harness '${harnessName}'...`);
        expect(out).toContain('✓ Removed harness from rill-bundle.json');
        expect(out).toContain(
          `✓ Uninstalled from .rill/npm/node_modules/${harnessName}`
        );
      });
    });

    describe('--harness with no harness declared', () => {
      it('exits 1 with the no-harness-declared error and leaves rill-bundle.json unchanged', async () => {
        bootstrapBundle(tmpDir, {
          packages: [{ mount: 'app', project: 'packages/app' }],
        });
        const before = fs.readFileSync(
          path.join(tmpDir, 'rill-bundle.json'),
          'utf8'
        );

        const { run } = await import('../../src/commands/uninstall.js');
        const cap = captureOutput();
        let exitCode: number;
        try {
          exitCode = await run(['--harness']);
        } finally {
          cap.restore();
        }

        expect(exitCode).toBe(1);
        expect(cap.stderr.join('')).toContain(
          '✗ No harness declared in rill-bundle.json.'
        );
        expect(
          fs.readFileSync(path.join(tmpDir, 'rill-bundle.json'), 'utf8')
        ).toBe(before);
        expect(mocks.spawn).not.toHaveBeenCalled();
      });
    });

    describe('--harness outside a bundle', () => {
      it('exits 1 with the no-bundle error', async () => {
        // tmpDir has no rill-bundle.json ancestor.
        const { run } = await import('../../src/commands/uninstall.js');
        const cap = captureOutput();
        let exitCode: number;
        try {
          exitCode = await run(['--harness']);
        } finally {
          cap.restore();
        }

        expect(exitCode).toBe(1);
        expect(cap.stderr.join('')).toContain('--harness requires a bundle');
        expect(mocks.spawn).not.toHaveBeenCalled();
      });
    });

    describe('extension --for <mount> from the bundle root', () => {
      it('removes the mount from the target package config (not cwd) and uninstalls from that package prefix', async () => {
        bootstrapBundle(tmpDir, {
          packages: [{ mount: 'app', project: 'packages/app' }],
        });

        const pkgDir = path.join(tmpDir, 'packages', 'app');
        const pkgConfigPath = path.join(pkgDir, 'rill-config.json');
        const pkgConfig = JSON.parse(
          fs.readFileSync(pkgConfigPath, 'utf8')
        ) as { extensions: { mounts: Record<string, string> } };
        pkgConfig.extensions.mounts['datetime'] =
          '@rcrsr/rill-ext-datetime@^0.19.0';
        fs.writeFileSync(
          pkgConfigPath,
          JSON.stringify(pkgConfig, null, 2) + '\n',
          'utf8'
        );

        const pkgPrefix = path.join(pkgDir, '.rill', 'npm');
        writeInstalledPkg(pkgPrefix, '@rcrsr/rill-ext-datetime', '0.19.0');

        // cwd is the bundle root, not the package dir.
        mocks.spawn.mockImplementation(makeSpawnMock(0));

        const { run } = await import('../../src/commands/uninstall.js');
        const cap = captureOutput();
        let exitCode: number;
        try {
          exitCode = await run(['datetime', '--for', 'app']);
        } finally {
          cap.restore();
        }

        expect(exitCode).toBe(0);

        const updatedConfig = JSON.parse(
          fs.readFileSync(pkgConfigPath, 'utf8')
        ) as { extensions: { mounts: Record<string, string> } };
        expect(updatedConfig.extensions.mounts).not.toHaveProperty('datetime');

        const uninstallCall = mocks.spawn.mock.calls.find(
          (call) => (call[1] as string[])[0] === 'uninstall'
        );
        expect(uninstallCall).toBeDefined();
        expect(uninstallCall?.[1]).toEqual([
          'uninstall',
          '@rcrsr/rill-ext-datetime',
          '--prefix',
          pkgPrefix,
        ]);

        // The bundle-root rill-config.json (if any) must not be involved.
        expect(fs.existsSync(path.join(tmpDir, 'rill-config.json'))).toBe(
          false
        );
      });
    });
  });
});
