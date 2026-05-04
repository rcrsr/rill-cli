/**
 * Tests for src/commands/install.ts
 * Covers AC-2, AC-3, AC-B5, AC-B6, AC-B7, AC-B8 (doc), AC-P2
 * Phase 3.5 additions: AC-E1/E2/E5/E6 and EC-7/EC-8..EC-11/EC-31.
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

/**
 * Write a fake package.json at the node_modules location so install can read
 * the installed version.
 */
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

describe('install', () => {
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
  // AC-2: registry install with caret version
  // ============================================================

  describe('AC-2: registry install with caret version', () => {
    it('records caret mount and does not modify project-root package.json', async () => {
      bootstrapProject(tmpDir);
      const prefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');

      // Capture the project-root package.json state before install
      const projectPkgPath = path.join(tmpDir, 'package.json');
      const projectPkgBefore = fs.existsSync(projectPkgPath)
        ? fs.readFileSync(projectPkgPath, 'utf8')
        : null;

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['@rcrsr/rill-ext-datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      const config = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-config.json'), 'utf8')
      ) as { extensions: { mounts: Record<string, string> } };
      expect(config.extensions.mounts['datetime']).toBe(
        '@rcrsr/rill-ext-datetime@^0.19.0'
      );

      // Project-root package.json must be byte-equal (not modified)
      const projectPkgAfter = fs.existsSync(projectPkgPath)
        ? fs.readFileSync(projectPkgPath, 'utf8')
        : null;
      expect(projectPkgAfter).toBe(projectPkgBefore);
    });
  });

  // ============================================================
  // AC-3: --as overwrite, existing mount untouched
  // ============================================================

  describe('AC-3: --as overwrite, existing mount untouched', () => {
    it('registers new mount under --as name and leaves existing mount unchanged', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });
      const prefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(prefix, '@other/rill-ext-datetime', '0.19.0');

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['@other/rill-ext-datetime', '--as', 'dt']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      const config = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-config.json'), 'utf8')
      ) as { extensions: { mounts: Record<string, string> } };
      expect(config.extensions.mounts['dt']).toBe(
        '@other/rill-ext-datetime@^0.19.0'
      );
      // Original datetime mount must be unchanged
      expect(config.extensions.mounts['datetime']).toBe(
        '@rcrsr/rill-ext-datetime@^0.19.0'
      );
    });
  });

  // ============================================================
  // AC-B5: --range custom semver
  // ============================================================

  describe('AC-B5: --range custom semver', () => {
    it('records mount with verbatim range value', async () => {
      bootstrapProject(tmpDir);
      const prefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([
          '@rcrsr/rill-ext-datetime',
          '--range',
          '~0.19.0',
        ]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      const config = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-config.json'), 'utf8')
      ) as { extensions: { mounts: Record<string, string> } };
      expect(config.extensions.mounts['datetime']).toBe(
        '@rcrsr/rill-ext-datetime@~0.19.0'
      );
    });
  });

  // ============================================================
  // AC-B6: --pin exact version
  // ============================================================

  describe('AC-B6: --pin exact version (no caret)', () => {
    it('records mount with exact version when --pin is set', async () => {
      bootstrapProject(tmpDir);
      const prefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['@rcrsr/rill-ext-datetime', '--pin']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      const config = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-config.json'), 'utf8')
      ) as { extensions: { mounts: Record<string, string> } };
      expect(config.extensions.mounts['datetime']).toBe(
        '@rcrsr/rill-ext-datetime@0.19.0'
      );
    });
  });

  // ============================================================
  // AC-B7: --pin and --range are mutually exclusive
  // ============================================================

  describe('AC-B7: --pin and --range are mutually exclusive', () => {
    it('exits 1 and writes error to stderr', async () => {
      bootstrapProject(tmpDir);

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([
          '@rcrsr/rill-ext-datetime',
          '--pin',
          '--range',
          '~0.19.0',
        ]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain(
        '--pin/--exact and --range are mutually exclusive'
      );
    });
  });

  // ============================================================
  // AC-B8: concurrent installs — last-write-wins (documentation test)
  // ============================================================

  describe('AC-B8: concurrent installs (last-write-wins, no CLI-side locking)', () => {
    it.todo(
      'two concurrent install calls each write their own config edit; last write wins (spec does not require CLI-side locking)'
    );
  });

  // ============================================================
  // FRICTION-NOTES 2026-05-03: install never invokes the extension factory
  // ============================================================

  describe('install does not run the extension factory', () => {
    it('writes the mount, emits the configure hint, and never calls loadProject', async () => {
      bootstrapProject(tmpDir);
      const prefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');

      // loadProject must never be called from install. If it were, this would
      // throw and the test would fail.
      mocks.loadProject.mockRejectedValue(
        new Error('install must not invoke loadProject')
      );

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['@rcrsr/rill-ext-datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      expect(mocks.loadProject).not.toHaveBeenCalled();
      expect(cap.stdout.join('')).toContain(
        'Configure the mount in rill-config.json'
      );

      const config = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-config.json'), 'utf8')
      ) as { extensions: { mounts: Record<string, string> } };
      expect(config.extensions.mounts['datetime']).toBe(
        '@rcrsr/rill-ext-datetime@^0.19.0'
      );
    });
  });

  // ============================================================
  // AC-P2: config-edit + loadProject validation < 1s
  // ============================================================

  describe('AC-P2: config-edit + loadProject validation < 1s', () => {
    it('config-edit + loadProject validation completes in under 1000ms', async () => {
      bootstrapProject(tmpDir);
      const prefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      const start = performance.now();
      try {
        await run(['@rcrsr/rill-ext-datetime']);
      } finally {
        cap.restore();
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });

  // ============================================================
  // AC-E1 / EC-7: .rill/npm/ missing
  // ============================================================

  describe('AC-E1/EC-7: .rill/npm/ missing emits UXT-EXT-5 and exits 1', () => {
    it('writes UXT-EXT-5 verbatim to stderr; no npm subprocess; exits 1', async () => {
      // No bootstrapProject call — .rill/npm/ does not exist
      fs.writeFileSync(
        path.join(tmpDir, 'rill-config.json'),
        JSON.stringify({
          name: 'test',
          main: 'main.rill',
          extensions: { mounts: {} },
        }) + '\n',
        'utf8'
      );

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['@rcrsr/rill-ext-datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      const err = cap.stderr.join('');
      expect(err).toContain('✗ .rill/npm/ not found');
      expect(err).toContain(
        "Run 'rill bootstrap' first to initialize the project"
      );
      // npm subprocess must not have been invoked
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // AC-E2 / EC-8: Mount collision without --as
  // ============================================================

  describe('AC-E2/EC-8: mount collision without --as exits 1 with UXT-EXT-4', () => {
    it('writes UXT-EXT-4 verbatim to stderr; no npm subprocess; exits 1', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        // datetime already exists; no --as override
        exitCode = await run(['@rcrsr/rill-ext-datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      const err = cap.stderr.join('');
      expect(err).toContain("Mount path 'datetime' already exists");
      expect(err).toContain('--as <path>');
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // AC-E5 / EC-9: npm subprocess non-zero exit
  // ============================================================

  describe('AC-E5/EC-9: npm non-zero exit propagates; config byte-equal', () => {
    it('exits with npm exit code; rill-config.json unchanged; no rollback line', async () => {
      bootstrapProject(tmpDir);
      const configBefore = fs.readFileSync(
        path.join(tmpDir, 'rill-config.json'),
        'utf8'
      );

      // npm returns exit code 1
      mocks.spawn.mockImplementation(makeSpawnMock(1));

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['@rcrsr/rill-ext-datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);

      // Config must be byte-equal (no mount was added)
      const configAfter = fs.readFileSync(
        path.join(tmpDir, 'rill-config.json'),
        'utf8'
      );
      expect(configAfter).toBe(configBefore);

      // No rollback line in output
      const combined = [...cap.stdout, ...cap.stderr].join('');
      expect(combined).not.toContain('Rolled back');
    });
  });

  // ============================================================
  // AC-E6 / EC-10: loadProject validation fails after install
  // ============================================================

  describe('AC-E6/EC-10: factory failures no longer block install (FRICTION-NOTES 2026-05-03)', () => {
    it('install ignores factory errors entirely; loadProject is never invoked', async () => {
      bootstrapProject(tmpDir);
      const prefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');

      // npm succeeds; loadProject would reject if called, but install must not
      // call it. The previous AC-E6/EC-10 contract (rollback on factory error)
      // is intentionally dropped: factory validation lives in 'rill describe
      // project' and 'rill run', not install.
      mocks.spawn.mockImplementation(makeSpawnMock(0));
      const validationError = new Error('factory rejected: invalid manifest');
      validationError.name = 'MountValidationError';
      mocks.loadProject.mockRejectedValue(validationError);

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['@rcrsr/rill-ext-datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      expect(mocks.loadProject).not.toHaveBeenCalled();

      const config = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-config.json'), 'utf8')
      ) as { extensions: { mounts: Record<string, string> } };
      expect(config.extensions.mounts['datetime']).toBe(
        '@rcrsr/rill-ext-datetime@^0.19.0'
      );
    });
  });

  // ============================================================
  // EC-11: writeFileSync fails after npm install
  // ============================================================

  describe('EC-11: writeFileSync fails after npm install', () => {
    it('emits out-of-sync message to stderr and exits 1', async () => {
      bootstrapProject(tmpDir);
      const prefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');

      mocks.spawn.mockImplementation(makeSpawnMock(0));

      // Make fs.promises.writeFile throw to simulate disk failure
      const origWriteFile = fs.promises.writeFile;
      let writeCallCount = 0;
      fs.promises.writeFile = (async (
        ...args: Parameters<typeof fs.promises.writeFile>
      ) => {
        writeCallCount++;
        // First write = config update; throw on it
        if (writeCallCount === 1) {
          throw new Error('ENOSPC: no space left on device');
        }
        return origWriteFile(...args);
      }) as typeof fs.promises.writeFile;

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['@rcrsr/rill-ext-datetime']);
      } finally {
        cap.restore();
        fs.promises.writeFile = origWriteFile;
      }

      expect(exitCode).toBe(1);
      const err = cap.stderr.join('');
      expect(err).toContain('Failed to write rill-config.json');
      expect(err).toContain('out of sync');
    });
  });

  // ============================================================
  // EC-31: npm not on PATH (NpmNotFoundError)
  // ============================================================

  describe('EC-31: npm not on PATH exits 1 with readable message', () => {
    it('emits "npm not found on PATH" to stderr and exits 1', async () => {
      bootstrapProject(tmpDir);

      // Simulate spawn failing with ENOENT by emitting 'error' event
      mocks.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        process.nextTick(() => {
          const err = new Error('spawn npm ENOENT') as Error & {
            code?: string;
          };
          err.code = 'ENOENT';
          child.emit('error', err);
        });
        return child;
      });

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['@rcrsr/rill-ext-datetime']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain(
        'npm not found on PATH; install Node.js with npm'
      );
    });
  });

  // ============================================================
  // P2-1: --exact deprecation warning
  // ============================================================

  describe('P2-1: --exact deprecation warning', () => {
    it('prints deprecation warning when --exact is used', async () => {
      bootstrapProject(tmpDir);
      const prefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');

      mocks.spawn.mockImplementation(makeSpawnMock(0));
      mocks.loadProject.mockResolvedValue({});

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['@rcrsr/rill-ext-datetime', '--exact']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      expect(cap.stderr.join('')).toContain('--exact is deprecated');
    });

    it('does not warn when only --pin is used', async () => {
      bootstrapProject(tmpDir);
      const prefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');

      mocks.spawn.mockImplementation(makeSpawnMock(0));
      mocks.loadProject.mockResolvedValue({});

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      try {
        await run(['@rcrsr/rill-ext-datetime', '--pin']);
      } finally {
        cap.restore();
      }
      expect(cap.stderr.join('')).not.toContain('deprecated');
    });
  });

  // ============================================================
  // P2-2: --dry-run preview
  // ============================================================

  describe('P2-2: --dry-run preview', () => {
    it('prints preview without writing config or running npm', async () => {
      bootstrapProject(tmpDir);
      const configPath = path.join(tmpDir, 'rill-config.json');
      const before = fs.readFileSync(configPath, 'utf8');

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['@rcrsr/rill-ext-datetime', '--dry-run']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      expect(mocks.spawn).not.toHaveBeenCalled();
      const after = fs.readFileSync(configPath, 'utf8');
      expect(after).toBe(before);

      const out = cap.stdout.join('');
      expect(out).toContain('[dry-run] mount: datetime');
      expect(out).toContain('[dry-run] specifier: @rcrsr/rill-ext-datetime');
      expect(out).toContain('[dry-run] would run: npm install');
    });
  });

  // ============================================================
  // P0-3: single-file install
  // ============================================================

  describe('P0-3: single-file install', () => {
    it('installs a .ts file mount without npm', async () => {
      bootstrapProject(tmpDir);
      const extPath = path.join(tmpDir, 'extensions', 'crawler.ts');
      fs.mkdirSync(path.dirname(extPath), { recursive: true });
      fs.writeFileSync(extPath, 'export default {};', 'utf8');

      mocks.loadProject.mockResolvedValue({});

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['./extensions/crawler.ts', '--as', 'crawler']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      expect(mocks.spawn).not.toHaveBeenCalled();

      const config = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-config.json'), 'utf8')
      ) as { extensions: { mounts: Record<string, string> } };
      expect(config.extensions.mounts['crawler']).toBe(
        './extensions/crawler.ts'
      );
    });

    it('rejects single-file install without --as', async () => {
      bootstrapProject(tmpDir);
      const extPath = path.join(tmpDir, 'extensions', 'crawler.ts');
      fs.mkdirSync(path.dirname(extPath), { recursive: true });
      fs.writeFileSync(extPath, 'export default {};', 'utf8');

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['./extensions/crawler.ts']);
      } finally {
        cap.restore();
      }
      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain('requires --as');
    });

    it('rejects single-file install with --pin', async () => {
      bootstrapProject(tmpDir);
      const extPath = path.join(tmpDir, 'extensions', 'crawler.ts');
      fs.mkdirSync(path.dirname(extPath), { recursive: true });
      fs.writeFileSync(extPath, 'export default {};', 'utf8');

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([
          './extensions/crawler.ts',
          '--as',
          'crawler',
          '--pin',
        ]);
      } finally {
        cap.restore();
      }
      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain('not valid for single-file');
    });

    it('rejects single-file install when file is missing', async () => {
      bootstrapProject(tmpDir);
      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['./extensions/missing.ts', '--as', 'missing']);
      } finally {
        cap.restore();
      }
      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain('File not found');
    });

    it('emits bootstrap hint when rill-config.json is missing', async () => {
      // Create the file so the existence check passes; rill-config.json absent.
      const extPath = path.join(tmpDir, 'extensions', 'crawler.ts');
      fs.mkdirSync(path.dirname(extPath), { recursive: true });
      fs.writeFileSync(extPath, 'export default {};', 'utf8');

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['./extensions/crawler.ts', '--as', 'crawler']);
      } finally {
        cap.restore();
      }
      expect(exitCode).toBe(1);
      const err = cap.stderr.join('');
      expect(err).toContain('rill-config.json not found');
      expect(err).toContain("Run 'rill bootstrap'");
    });
  });
});
