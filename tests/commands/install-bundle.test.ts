/**
 * Tests for src/commands/install.ts — bundle-aware install behavior.
 *
 * These tests cover the six bundle-mode scenarios: extension install with
 * --for, harness install, and the four error paths (extension without --for,
 * harness conflict, ambiguous dual-export, and no ancestor bundle).
 *
 * NOTE: "No fs writes" assertions for the error cases apply to CONFIG writes
 * (rill-bundle.json / rill-config.json). npm-managed files in .rill/npm/ are
 * populated by the spawn mock before role detection runs — this is correct
 * because the bundle-mode role-detection guard runs after npm install completes.
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
// FIXTURE HELPERS
// ============================================================

/**
 * Write a minimal rill-bundle.json at the given directory.
 *
 * Each package entry maps a mount name to a sub-directory path relative to
 * the bundle root. The directory is created so rill-config.json can be placed
 * there.
 */
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

  // Bootstrap the bundle-level .rill/npm/ prefix
  const rillNpm = path.join(bundleRoot, '.rill', 'npm');
  fs.mkdirSync(rillNpm, { recursive: true });
  fs.writeFileSync(
    path.join(rillNpm, 'package.json'),
    '{"name":"rill-extensions","private":true}\n',
    'utf8'
  );

  // Create each package sub-directory with a rill-config.json
  for (const pkg of packages) {
    const pkgDir = path.join(bundleRoot, pkg.project);
    fs.mkdirSync(pkgDir, { recursive: true });
    bootstrapProject(pkgDir);
  }
}

/**
 * Write a fake installed package at <prefix>/node_modules/<pkgName>/ with an
 * ESM index.js exporting the given role shape.
 *
 * - 'extension': exports `extensionManifest`
 * - 'harness':   exports a default with `name` string
 * - 'dual':      exports both shapes
 *
 * Each call uses the provided pkgName. To avoid Node.js module cache collisions
 * across tests, callers must pass a unique pkgName per test.
 */
function writeInstalledPackageFixture(
  prefix: string,
  pkgName: string,
  role: 'extension' | 'harness' | 'dual'
): void {
  const pkgDir = path.join(prefix, 'node_modules', pkgName);
  fs.mkdirSync(pkgDir, { recursive: true });

  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify(
      { name: pkgName, version: '1.0.0', type: 'module', main: 'index.js' },
      null,
      2
    ),
    'utf8'
  );

  let indexJs: string;
  if (role === 'extension') {
    indexJs = `export const extensionManifest = { mount: '${pkgName}' };\n`;
  } else if (role === 'harness') {
    indexJs = `export default { name: '${pkgName}', postBuild: async () => {} };\n`;
  } else {
    // dual: both shapes present
    indexJs = [
      `export const extensionManifest = { mount: '${pkgName}' };`,
      `export default { name: '${pkgName}', postBuild: async () => {} };`,
      '',
    ].join('\n');
  }
  fs.writeFileSync(path.join(pkgDir, 'index.js'), indexJs, 'utf8');
}

/**
 * Build a spawn mock that writes the package fixture into node_modules before
 * emitting the 'close' event with exit code 0.
 *
 * Attaches a stdout EventEmitter so that npmView (which uses stdio: pipe and
 * reads child.stdout) does not crash. For 'npm view' calls the mock emits the
 * declared rill role JSON on stdout so probePackageRole passes the gate check.
 * For 'npm install' calls the fixture files are written before close is emitted.
 *
 * Dual-role packages declare 'extension' as their rill.role field — the
 * 'ambiguous' outcome comes from post-install export detection, not the
 * declared role field.
 */
function makeSpawnMockWithFixture(
  prefix: string,
  pkgName: string,
  role: 'extension' | 'harness' | 'dual'
): (_cmd: string, args: string[]) => EventEmitter & { stdout: EventEmitter } {
  return (_cmd: string, args: string[]) => {
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdout });
    process.nextTick(() => {
      if (args[0] === 'view') {
        // Emit the raw rill field value (not wrapped in a package.json object).
        // probePackageRole parses this and reads .role directly.
        const declaredRole = role === 'dual' ? 'extension' : role;
        stdout.emit(
          'data',
          Buffer.from(JSON.stringify({ role: declaredRole }))
        );
      } else {
        writeInstalledPackageFixture(prefix, pkgName, role);
      }
      child.emit('close', 0);
    });
    return child;
  };
}

// ============================================================
// TESTS
// ============================================================

describe('install (bundle-aware)', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origCwd = process.cwd();
    mocks.loadProject.mockResolvedValue({});
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  // ============================================================
  // Success: extension install with --for writes to package config
  // ============================================================

  describe('extension install at bundle root with --for writes mount to target package config', () => {
    it('records mount in the target package rill-config.json and exits 0', async () => {
      bootstrapBundle(tmpDir, {
        packages: [{ mount: 'app', project: 'packages/app' }],
      });
      process.chdir(tmpDir);

      const prefix = path.join(tmpDir, '.rill', 'npm');
      // Use a plain name (no rill-ext- prefix) so the derived mount equals pkgName.
      const pkgName = 'bundle-test-extension-pkg-1';

      mocks.spawn.mockImplementation(
        makeSpawnMockWithFixture(prefix, pkgName, 'extension')
      );

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([pkgName, '--for', 'app']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      const targetConfigPath = path.join(
        tmpDir,
        'packages',
        'app',
        'rill-config.json'
      );
      const config = JSON.parse(fs.readFileSync(targetConfigPath, 'utf8')) as {
        extensions: { mounts: Record<string, string> };
      };

      // deriveMount returns pkgName as-is when no rill-ext- prefix is present.
      expect(config.extensions.mounts[pkgName]).toMatch(
        new RegExp(`^${pkgName}@`)
      );
    });
  });

  // ============================================================
  // Success: harness install writes harness field to rill-bundle.json
  // ============================================================

  describe('harness install at bundle root without existing harness writes to rill-bundle.json', () => {
    it('records harness name in rill-bundle.json and exits 0', async () => {
      bootstrapBundle(tmpDir, {
        packages: [{ mount: 'app', project: 'packages/app' }],
      });
      process.chdir(tmpDir);

      const prefix = path.join(tmpDir, '.rill', 'npm');
      const pkgName = 'rill-harness-bundle-success-harness-2';

      mocks.spawn.mockImplementation(
        makeSpawnMockWithFixture(prefix, pkgName, 'harness')
      );

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([pkgName]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      const bundleConfig = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-bundle.json'), 'utf8')
      ) as { harness?: string };
      expect(bundleConfig.harness).toBe(pkgName);
    });
  });

  // ============================================================
  // Error: extension install at bundle root without --for
  // ============================================================

  describe('extension install at bundle root without --for emits ambiguous-target error', () => {
    it('writes mount-required error to stderr verbatim, leaves configs unchanged, exits 1', async () => {
      bootstrapBundle(tmpDir, {
        packages: [{ mount: 'app', project: 'packages/app' }],
      });
      process.chdir(tmpDir);

      const prefix = path.join(tmpDir, '.rill', 'npm');
      const pkgName = 'rill-ext-bundle-err-no-for-3';

      mocks.spawn.mockImplementation(
        makeSpawnMockWithFixture(prefix, pkgName, 'extension')
      );

      // Capture config bytes before invocation
      const bundleBefore = fs.readFileSync(
        path.join(tmpDir, 'rill-bundle.json'),
        'utf8'
      );
      const appConfigBefore = fs.readFileSync(
        path.join(tmpDir, 'packages', 'app', 'rill-config.json'),
        'utf8'
      );

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([pkgName]); // no --for flag
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain(
        'Cannot determine target package. Use `rill install <pkg> --for <mount>` to specify which package should mount this extension.'
      );

      // Config files must be byte-identical (no writes occurred)
      expect(
        fs.readFileSync(path.join(tmpDir, 'rill-bundle.json'), 'utf8')
      ).toBe(bundleBefore);
      expect(
        fs.readFileSync(
          path.join(tmpDir, 'packages', 'app', 'rill-config.json'),
          'utf8'
        )
      ).toBe(appConfigBefore);
    });
  });

  // ============================================================
  // Error: harness install with existing harness and no --replace
  // ============================================================

  describe('harness install with existing harness and no --replace emits harness-conflict error', () => {
    it('writes replace-required error to stderr verbatim, leaves rill-bundle.json unchanged, exits 1', async () => {
      const existingHarness = 'existing-harness-pkg';
      bootstrapBundle(tmpDir, {
        harness: existingHarness,
        packages: [{ mount: 'app', project: 'packages/app' }],
      });
      process.chdir(tmpDir);

      const prefix = path.join(tmpDir, '.rill', 'npm');
      const newHarness = 'rill-harness-bundle-err-conflict-4';

      mocks.spawn.mockImplementation(
        makeSpawnMockWithFixture(prefix, newHarness, 'harness')
      );

      // Capture config bytes before invocation
      const bundleBefore = fs.readFileSync(
        path.join(tmpDir, 'rill-bundle.json'),
        'utf8'
      );
      const appConfigBefore = fs.readFileSync(
        path.join(tmpDir, 'packages', 'app', 'rill-config.json'),
        'utf8'
      );

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([newHarness]); // no --replace flag
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain(
        `Bundle already has a harness declared: ${existingHarness}. Run \`rill uninstall ${existingHarness}\` first, or use \`rill install ${newHarness} --replace\` to swap harnesses.`
      );

      // Config files must be byte-identical (no writes occurred)
      expect(
        fs.readFileSync(path.join(tmpDir, 'rill-bundle.json'), 'utf8')
      ).toBe(bundleBefore);
      expect(
        fs.readFileSync(
          path.join(tmpDir, 'packages', 'app', 'rill-config.json'),
          'utf8'
        )
      ).toBe(appConfigBefore);
    });
  });

  // ============================================================
  // Error: dual-export package without --role
  // ============================================================

  describe('dual-export package install without --role emits ambiguous-role error', () => {
    it('writes role-required error to stderr verbatim, leaves configs unchanged, exits 1', async () => {
      bootstrapBundle(tmpDir, {
        packages: [{ mount: 'app', project: 'packages/app' }],
      });
      process.chdir(tmpDir);

      const prefix = path.join(tmpDir, '.rill', 'npm');
      const pkgName = 'rill-dual-bundle-err-ambiguous-5';

      mocks.spawn.mockImplementation(
        makeSpawnMockWithFixture(prefix, pkgName, 'dual')
      );

      // Capture config bytes before invocation
      const bundleBefore = fs.readFileSync(
        path.join(tmpDir, 'rill-bundle.json'),
        'utf8'
      );
      const appConfigBefore = fs.readFileSync(
        path.join(tmpDir, 'packages', 'app', 'rill-config.json'),
        'utf8'
      );

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([pkgName]); // no --role flag
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain(
        'Package exports both extensionManifest and RillHarness. Use `--role extension` or `--role harness` to specify which to install.'
      );

      // Config files must be byte-identical (no writes occurred)
      expect(
        fs.readFileSync(path.join(tmpDir, 'rill-bundle.json'), 'utf8')
      ).toBe(bundleBefore);
      expect(
        fs.readFileSync(
          path.join(tmpDir, 'packages', 'app', 'rill-config.json'),
          'utf8'
        )
      ).toBe(appConfigBefore);
    });
  });

  // ============================================================
  // Error: harness install outside bundle (no ancestor rill-bundle.json)
  // ============================================================

  describe('harness install in non-bundle directory emits no-bundle-harness error', () => {
    it('writes no-ancestor-bundle error to stderr verbatim, exits 1, writes no config', async () => {
      // Set up a plain project directory with no rill-bundle.json ancestor
      const projectDir = path.join(tmpDir, 'standalone-project');
      fs.mkdirSync(projectDir, { recursive: true });
      bootstrapProject(projectDir);
      process.chdir(projectDir);

      const prefix = path.join(projectDir, '.rill', 'npm');
      const pkgName = 'rill-harness-bundle-err-no-bundle-6';

      mocks.spawn.mockImplementation(
        makeSpawnMockWithFixture(prefix, pkgName, 'harness')
      );

      // Capture config bytes before invocation
      const configBefore = fs.readFileSync(
        path.join(projectDir, 'rill-config.json'),
        'utf8'
      );

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([pkgName]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain(
        'Cannot install harness outside a bundle. A bundle requires rill-bundle.json at the root.'
      );

      // rill-config.json must be byte-identical (no mount was written)
      expect(
        fs.readFileSync(path.join(projectDir, 'rill-config.json'), 'utf8')
      ).toBe(configBefore);
    });
  });
});
