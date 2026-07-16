/**
 * Tests for src/commands/list.ts — bundle-mode output.
 *
 * Human bundle mode prints a "Harness: ..." line followed by per-package
 * "[<mount>] <project>" sections, each with the existing 4-col table. JSON
 * bundle mode returns {harness, packages:[{mount,project,extensions}]}.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, captureOutput } from '../helpers/cli-fixtures.js';

// ============================================================
// MOCK SETUP
// ============================================================

vi.mock('../../src/cli-shared.js', () => ({
  CLI_VERSION: '0.0.0-test',
  VERSION: '0.0.0-test',
}));

// ============================================================
// FIXTURE HELPERS
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

/** Write a package's own rill-config.json with the given mounts (no .rill/npm/ bootstrap needed for list). */
function writePackageConfig(
  pkgDir: string,
  mounts: Record<string, string>
): void {
  fs.mkdirSync(pkgDir, { recursive: true });
  const config = {
    name: path.basename(pkgDir),
    main: 'main.rill',
    extensions: { mounts },
  };
  fs.writeFileSync(
    path.join(pkgDir, 'rill-config.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf8'
  );
}

// ============================================================
// TESTS
// ============================================================

describe('list (bundle-aware)', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('human mode with declared harness', () => {
    it('prints the Harness line, then per-package sections with the 4-col table, in bundle order', async () => {
      writeBundleJson(tmpDir, {
        harness: 'my-harness-pkg',
        packages: [
          { mount: 'web', project: 'packages/web' },
          { mount: 'api', project: 'packages/api' },
        ],
      });
      const bundlePrefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(bundlePrefix, 'my-harness-pkg', '3.1.0');

      const webDir = path.join(tmpDir, 'packages', 'web');
      writePackageConfig(webDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });
      writeInstalledPkg(
        path.join(webDir, '.rill', 'npm'),
        '@rcrsr/rill-ext-datetime',
        '0.19.0'
      );

      const apiDir = path.join(tmpDir, 'packages', 'api');
      writePackageConfig(apiDir, {
        yaml: '@rcrsr/rill-ext-yaml@^2.0.0',
      });
      writeInstalledPkg(
        path.join(apiDir, '.rill', 'npm'),
        '@rcrsr/rill-ext-yaml',
        '2.0.0'
      );

      process.chdir(tmpDir);
      const { run } = await import('../../src/commands/list.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      const out = cap.stdout.join('');
      const lines = out.split('\n');
      expect(lines[0]).toBe('Harness: my-harness-pkg (3.1.0)');

      // Multi-package ordering preserved: [web] before [api].
      const webIdx = out.indexOf('[web] packages/web');
      const apiIdx = out.indexOf('[api] packages/api');
      expect(webIdx).toBeGreaterThan(-1);
      expect(apiIdx).toBeGreaterThan(-1);
      expect(webIdx).toBeLessThan(apiIdx);

      expect(out).toContain('datetime');
      expect(out).toContain('yaml');
      expect(out).toContain('1 extensions installed.');
    });
  });

  describe('human mode with no harness declared', () => {
    it('prints "Harness: (none)" as the first line', async () => {
      writeBundleJson(tmpDir, {
        packages: [{ mount: 'app', project: 'packages/app' }],
      });
      writePackageConfig(path.join(tmpDir, 'packages', 'app'), {});

      process.chdir(tmpDir);
      const { run } = await import('../../src/commands/list.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      const out = cap.stdout.join('');
      expect(out.split('\n')[0]).toBe('Harness: (none)');
    });
  });

  describe('package with no rill-config.json', () => {
    it('shows "0 extensions installed." for that package without crashing', async () => {
      writeBundleJson(tmpDir, {
        packages: [{ mount: 'app', project: 'packages/app' }],
      });
      // Deliberately do not write packages/app/rill-config.json.
      fs.mkdirSync(path.join(tmpDir, 'packages', 'app'), { recursive: true });

      process.chdir(tmpDir);
      const { run } = await import('../../src/commands/list.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toContain('[app] packages/app');
      expect(out).toContain('0 extensions installed.');
    });
  });

  describe('invalid rill-bundle.json', () => {
    it('writes a ✗-prefixed error to stderr and exits 1', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'rill-bundle.json'),
        '{ not valid json',
        'utf8'
      );

      process.chdir(tmpDir);
      const { run } = await import('../../src/commands/list.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      const err = cap.stderr.join('');
      expect(err).toMatch(/^✗ /);
      expect(err).toContain('Failed to parse');
    });
  });

  describe('JSON bundle mode', () => {
    it('outputs {harness, packages:[{mount,project,extensions}]}; harness null when undeclared; local sources have null version', async () => {
      writeBundleJson(tmpDir, {
        packages: [{ mount: 'app', project: 'packages/app' }],
      });
      const appDir = path.join(tmpDir, 'packages', 'app');
      writePackageConfig(appDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
        'local-ext': './local-ext',
      });
      writeInstalledPkg(
        path.join(appDir, '.rill', 'npm'),
        '@rcrsr/rill-ext-datetime',
        '0.19.0'
      );

      process.chdir(tmpDir);
      const { run } = await import('../../src/commands/list.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['--json']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      const payload = JSON.parse(cap.stdout.join('')) as {
        harness: { name: string; version: string } | null;
        packages: Array<{
          mount: string;
          project: string;
          extensions: Array<{
            mount: string;
            specifier: string;
            version: string | null;
            source: string;
          }>;
        }>;
      };

      expect(payload.harness).toBeNull();
      expect(payload.packages).toHaveLength(1);
      const pkg = payload.packages[0];
      expect(pkg?.mount).toBe('app');
      expect(pkg?.project).toBe('packages/app');

      const datetimeExt = pkg?.extensions.find((e) => e.mount === 'datetime');
      expect(datetimeExt?.version).toBe('0.19.0');
      expect(datetimeExt?.source).toBe('registry');

      const localExt = pkg?.extensions.find((e) => e.mount === 'local-ext');
      expect(localExt?.version).toBeNull();
      expect(localExt?.source).toBe('local');
    });

    it('reports the harness name and installed version when a harness is declared', async () => {
      writeBundleJson(tmpDir, {
        harness: 'my-harness-pkg',
        packages: [{ mount: 'app', project: 'packages/app' }],
      });
      writeInstalledPkg(
        path.join(tmpDir, '.rill', 'npm'),
        'my-harness-pkg',
        '3.1.0'
      );
      writePackageConfig(path.join(tmpDir, 'packages', 'app'), {});

      process.chdir(tmpDir);
      const { run } = await import('../../src/commands/list.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['--json']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      const payload = JSON.parse(cap.stdout.join('')) as {
        harness: { name: string; version: string } | null;
      };
      expect(payload.harness).toEqual({
        name: 'my-harness-pkg',
        version: '3.1.0',
      });
    });
  });
});
