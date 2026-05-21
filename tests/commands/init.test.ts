/**
 * Tests for src/commands/init.ts — all dispatch paths.
 * Part A: bare `rill init` (single-package scaffold, same behavior as bootstrap)
 * Part B: `rill init bundle [name]`
 * Part C: `rill init package <name>`
 * Part D: `rill init --help`
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
// SHARED TEST CONTEXT
// ============================================================

describe('init', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ============================================================
  // PART A — bare `rill init` (single-package scaffold)
  // ============================================================

  describe('bare init in fresh empty directory', () => {
    it('creates all 4 expected files and exits 0', async () => {
      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      expect(
        fs.existsSync(path.join(tmpDir, '.rill', 'npm', 'package.json'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir, '.rill', 'npm', '.gitignore'))
      ).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.rill', '.gitignore'))).toBe(
        true
      );
      expect(fs.existsSync(path.join(tmpDir, 'rill-config.json'))).toBe(true);
    });

    it('rill-config.json has name=basename(cwd), main="main.rill", extensions.mounts={}', async () => {
      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      try {
        await run([]);
      } finally {
        cap.restore();
      }

      const configText = fs.readFileSync(
        path.join(tmpDir, 'rill-config.json'),
        'utf8'
      );
      const config = JSON.parse(configText) as {
        name: string;
        main: string;
        extensions: { mounts: Record<string, string> };
      };
      expect(config.name).toBe(path.basename(tmpDir));
      expect(config.main).toBe('main.rill');
      expect(config.extensions.mounts).toEqual({});
    });

    it('project-root .gitignore contains .rill/', async () => {
      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      try {
        await run([]);
      } finally {
        cap.restore();
      }

      const gitignore = fs.readFileSync(
        path.join(tmpDir, '.gitignore'),
        'utf8'
      );
      expect(gitignore).toContain('.rill/');
    });

    it('emits expected messages on stdout', async () => {
      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      try {
        await run([]);
      } finally {
        cap.restore();
      }

      const out = cap.stdout.join('');
      expect(out).toContain('✓ Created .rill/npm/package.json');
      expect(out).toContain('✓ Created rill-config.json');
      expect(out).toContain('Ready to install extensions');
    });
  });

  describe('bare init re-run without --force', () => {
    it('exits 0 and leaves existing files byte-equal', async () => {
      const { run } = await import('../../src/commands/init.js');
      const cap1 = captureOutput();
      try {
        await run([]);
      } finally {
        cap1.restore();
      }

      const configBefore = fs.readFileSync(
        path.join(tmpDir, 'rill-config.json'),
        'utf8'
      );
      const npmPkgBefore = fs.readFileSync(
        path.join(tmpDir, '.rill', 'npm', 'package.json'),
        'utf8'
      );

      const cap2 = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([]);
      } finally {
        cap2.restore();
      }

      expect(exitCode).toBe(0);
      const configAfter = fs.readFileSync(
        path.join(tmpDir, 'rill-config.json'),
        'utf8'
      );
      const npmPkgAfter = fs.readFileSync(
        path.join(tmpDir, '.rill', 'npm', 'package.json'),
        'utf8'
      );
      expect(configAfter).toBe(configBefore);
      expect(npmPkgAfter).toBe(npmPkgBefore);
    });
  });

  describe('bare init re-run with --force', () => {
    it('overwrites files when --force is set', async () => {
      const { run } = await import('../../src/commands/init.js');
      const cap1 = captureOutput();
      try {
        await run([]);
      } finally {
        cap1.restore();
      }

      // Mutate the config to verify it gets overwritten
      const configPath = path.join(tmpDir, 'rill-config.json');
      fs.writeFileSync(configPath, '{"name":"modified"}', 'utf8');
      const modifiedContent = fs.readFileSync(configPath, 'utf8');

      const cap2 = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['--force']);
      } finally {
        cap2.restore();
      }

      expect(exitCode).toBe(0);
      const configAfter = fs.readFileSync(configPath, 'utf8');
      expect(configAfter).not.toBe(modifiedContent);
      const parsed = JSON.parse(configAfter) as { name: string; main: string };
      expect(parsed.main).toBe('main.rill');
    });
  });

  describe('bare init EACCES on .rill/npm/ mkdir', () => {
    it('exits 1 and writes error to stderr when mkdirSync throws on .rill/npm/', async () => {
      const { run } = await import('../../src/commands/init.js');

      const origMkdirSync = fs.mkdirSync;
      let callCount = 0;
      vi.spyOn(fs, 'mkdirSync').mockImplementation((...args: unknown[]) => {
        callCount++;
        // First call is .rill/ (idempotent); second call is .rill/npm/
        if (callCount === 2) {
          const err = Object.assign(new Error('Permission denied'), {
            code: 'EACCES',
          });
          throw err;
        }
        return (origMkdirSync as (...a: unknown[]) => unknown)(...args);
      });

      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain('Cannot create .rill/npm/');
    });
  });

  describe('bare init EACCES on writeFile for rill-config.json', () => {
    it('exits 1 and writes error to stderr when writeFileSync throws on rill-config.json', async () => {
      const { run } = await import('../../src/commands/init.js');

      const realWriteFileSync = fs.writeFileSync.bind(fs);
      vi.spyOn(fs, 'writeFileSync').mockImplementation(
        (
          filePath: fs.PathOrFileDescriptor,
          data: unknown,
          options?: unknown
        ) => {
          if (
            typeof filePath === 'string' &&
            filePath.endsWith('rill-config.json')
          ) {
            const err = Object.assign(new Error('Permission denied'), {
              code: 'EACCES',
            });
            throw err;
          }
          // Delegate all other writes to the real implementation
          (
            realWriteFileSync as (
              p: fs.PathOrFileDescriptor,
              d: unknown,
              o?: unknown
            ) => void
          )(filePath, data, options);
        }
      );

      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain('Cannot write rill-config.json');
    });
  });

  describe('bare init with pre-existing files without --force', () => {
    it('does not emit "✓ Created" for pre-existing files', async () => {
      const { run } = await import('../../src/commands/init.js');

      // First run to create files
      const cap1 = captureOutput();
      try {
        await run([]);
      } finally {
        cap1.restore();
      }

      // Second run without --force
      const cap2 = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([]);
      } finally {
        cap2.restore();
      }

      expect(exitCode).toBe(0);
      // On second run without --force, no "Created" lines should appear
      const out = cap2.stdout.join('');
      expect(out).not.toContain('✓ Created .rill/npm/package.json');
      expect(out).not.toContain('✓ Created rill-config.json');
    });
  });

  describe('bare init tsconfig.rill.json handling', () => {
    it('writes .rill/tsconfig.rill.json on fresh init', async () => {
      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      try {
        await run([]);
      } finally {
        cap.restore();
      }
      const tsconfigRill = path.join(tmpDir, '.rill', 'tsconfig.rill.json');
      expect(fs.existsSync(tsconfigRill)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(tsconfigRill, 'utf8')) as {
        compilerOptions?: {
          baseUrl?: string;
          paths?: Record<string, string[]>;
        };
      };
      expect(parsed.compilerOptions?.baseUrl).toBe('./npm');
      expect(parsed.compilerOptions?.paths).toEqual({
        '*': ['node_modules/*'],
      });
    });

    it('hints user when tsconfig.json exists without extends', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'tsconfig.json'),
        '{"compilerOptions": {"strict": true}}\n',
        'utf8'
      );
      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      try {
        await run([]);
      } finally {
        cap.restore();
      }
      const out = cap.stdout.join('');
      expect(out).toContain('tsconfig.json detected');
      expect(out).toContain('"extends": "./.rill/tsconfig.rill.json"');
    });

    it('does not hint when tsconfig.json already extends rill config', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'tsconfig.json'),
        '{"extends": "./.rill/tsconfig.rill.json"}\n',
        'utf8'
      );
      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      try {
        await run([]);
      } finally {
        cap.restore();
      }
      const out = cap.stdout.join('');
      expect(out).not.toContain('tsconfig.json detected');
    });
  });

  describe('bare init --force and --reset split behavior', () => {
    it('--force preserves .rill/npm/package.json contents', async () => {
      const { run } = await import('../../src/commands/init.js');
      const cap1 = captureOutput();
      try {
        await run([]);
      } finally {
        cap1.restore();
      }
      const npmPkg = path.join(tmpDir, '.rill', 'npm', 'package.json');
      fs.writeFileSync(
        npmPkg,
        '{"name":"rill-extensions","private":true,"dependencies":{"foo":"^1.0.0"}}\n',
        'utf8'
      );

      const cap2 = captureOutput();
      try {
        await run(['--force']);
      } finally {
        cap2.restore();
      }
      const after = fs.readFileSync(npmPkg, 'utf8');
      expect(after).toContain('"foo"');
    });

    it('--reset wipes .rill/npm/ contents', async () => {
      const { run } = await import('../../src/commands/init.js');
      const cap1 = captureOutput();
      try {
        await run([]);
      } finally {
        cap1.restore();
      }
      const npmPkg = path.join(tmpDir, '.rill', 'npm', 'package.json');
      fs.writeFileSync(
        npmPkg,
        '{"name":"rill-extensions","private":true,"dependencies":{"foo":"^1.0.0"}}\n',
        'utf8'
      );

      const cap2 = captureOutput();
      try {
        await run(['--reset']);
      } finally {
        cap2.restore();
      }
      const after = fs.readFileSync(npmPkg, 'utf8');
      expect(after).not.toContain('"foo"');
    });
  });

  describe('bare init timing', () => {
    it('completes file I/O in under 2000ms', async () => {
      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      const start = performance.now();
      try {
        await run([]);
      } finally {
        cap.restore();
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(2000);
    });
  });

  // ============================================================
  // PART B — `rill init bundle [name]`
  // ============================================================

  describe('bundle subcommand', () => {
    it('creates rill-bundle.json, .rill/npm/, and packages/ when given a name', async () => {
      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['bundle', 'demo']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      const bundleConfigPath = path.join(tmpDir, 'rill-bundle.json');
      expect(fs.existsSync(bundleConfigPath)).toBe(true);

      const bundleConfig = JSON.parse(
        fs.readFileSync(bundleConfigPath, 'utf8')
      ) as { name: string };
      expect(bundleConfig.name).toBe('demo');

      expect(fs.existsSync(path.join(tmpDir, '.rill', 'npm'))).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir, '.rill', 'npm', '.gitignore'))
      ).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'packages'))).toBe(true);
    });

    it('defaults bundle name to cwd basename when name is omitted', async () => {
      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['bundle']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      const bundleConfig = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-bundle.json'), 'utf8')
      ) as { name: string };
      expect(bundleConfig.name).toBe(path.basename(tmpDir));
    });

    it('exits 1 with verbatim error when rill-bundle.json already exists', async () => {
      // Pre-create rill-bundle.json
      const bundleConfigPath = path.join(tmpDir, 'rill-bundle.json');
      const originalContent =
        JSON.stringify(
          { name: 'existing', version: '0.0.0', packages: [] },
          null,
          2
        ) + '\n';
      fs.writeFileSync(bundleConfigPath, originalContent, 'utf8');

      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['bundle', 'demo']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain(
        `rill-bundle.json already exists in ${tmpDir}`
      );
      // Original file must be unchanged
      expect(fs.readFileSync(bundleConfigPath, 'utf8')).toBe(originalContent);
    });
  });

  // ============================================================
  // PART C — `rill init package <name>`
  // ============================================================

  describe('package subcommand', () => {
    it('scaffolds package inside bundle and appends packages[] entry', async () => {
      // Set up a bundle at cwd
      const bundleConfigPath = path.join(tmpDir, 'rill-bundle.json');
      fs.writeFileSync(
        bundleConfigPath,
        JSON.stringify(
          { name: 'my-bundle', version: '0.0.0', packages: [] },
          null,
          2
        ) + '\n',
        'utf8'
      );

      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['package', 'hello']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      // Package directory exists
      const pkgDir = path.join(tmpDir, 'packages', 'hello');
      expect(fs.existsSync(pkgDir)).toBe(true);

      // Package scaffold includes src/index.ts (package-init behavior)
      expect(fs.existsSync(path.join(pkgDir, 'src', 'index.ts'))).toBe(true);

      // rill-bundle.json has updated packages[]
      const updatedConfig = JSON.parse(
        fs.readFileSync(bundleConfigPath, 'utf8')
      ) as { packages: Array<{ mount: string; project: string }> };
      expect(updatedConfig.packages).toContainEqual({
        mount: 'hello',
        project: './packages/hello',
      });
    });

    it('scaffolds standalone package at <cwd>/<name>/ when outside a bundle', async () => {
      // No rill-bundle.json anywhere (tmpDir is isolated in os.tmpdir())
      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['package', 'hello']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      const pkgDir = path.join(tmpDir, 'hello');
      expect(fs.existsSync(pkgDir)).toBe(true);

      // Package scaffold includes src/index.ts
      expect(fs.existsSync(path.join(pkgDir, 'src', 'index.ts'))).toBe(true);

      // rill-config.json created at target dir
      expect(fs.existsSync(path.join(pkgDir, 'rill-config.json'))).toBe(true);
    });

    it('exits 1 with verbatim error when mount already exists in packages[]', async () => {
      // Set up a bundle with an existing mount named 'hello'
      const bundleConfigPath = path.join(tmpDir, 'rill-bundle.json');
      const originalConfig = {
        name: 'my-bundle',
        version: '0.0.0',
        packages: [{ mount: 'hello', project: './packages/hello' }],
      };
      const originalContent = JSON.stringify(originalConfig, null, 2) + '\n';
      fs.writeFileSync(bundleConfigPath, originalContent, 'utf8');

      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['package', 'hello']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain(
        `packages[] already contains mount 'hello'`
      );
      // Bundle config must be unchanged
      expect(fs.readFileSync(bundleConfigPath, 'utf8')).toBe(originalContent);
      // No new directory created
      expect(fs.existsSync(path.join(tmpDir, 'packages', 'hello'))).toBe(false);
    });
  });

  // ============================================================
  // PART D — `rill init --help`
  // ============================================================

  describe('--help flag', () => {
    it('lists bundle and package subcommands on stdout and exits 0', async () => {
      const { run } = await import('../../src/commands/init.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['--help']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toContain('bundle');
      expect(out).toContain('package');
    });
  });
});
