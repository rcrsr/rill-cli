/**
 * Tests for src/commands/install.ts
 * Covers registry install, --as overwrite, --range/--pin semver options,
 * concurrent installs, timing budget, missing .rill/npm/, mount collision,
 * npm non-zero exit, and post-install validation failures.
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

/**
 * Returns a spawn mock that emits close with the given exit code.
 * Attaches a stdout EventEmitter so that npmView (which uses stdio: pipe and
 * reads child.stdout) does not crash. For 'npm view' calls the mock emits a
 * rill extension-role JSON payload; for 'npm install' calls stdout is idle.
 */
function makeSpawnMock(
  exitCode: number
): (_cmd: string, args: string[]) => EventEmitter & { stdout: EventEmitter } {
  return (_cmd: string, args: string[]) => {
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdout });
    process.nextTick(() => {
      // Emit rill role JSON on stdout for 'npm view' calls so probePackageRole
      // receives a valid extension declaration and does not gate-reject.
      if (args[0] === 'view') {
        stdout.emit('data', Buffer.from(JSON.stringify({ role: 'extension' })));
      }
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
  // Registry install with caret version
  // ============================================================

  describe('registry install with caret version', () => {
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
  // --as overwrite, existing mount untouched
  // ============================================================

  describe('--as overwrite, existing mount untouched', () => {
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
  // --range custom semver
  // ============================================================

  describe('--range custom semver', () => {
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
  // --pin exact version
  // ============================================================

  describe('--pin exact version (no caret)', () => {
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
  // --pin and --range are mutually exclusive
  // ============================================================

  describe('--pin and --range are mutually exclusive', () => {
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
  // Concurrent installs — last-write-wins
  //
  // Two concurrent install calls each write their own config edit and the last
  // write wins. The spec does not require CLI-side locking, so there is no
  // behaviour here to assert. Recorded as a note rather than an `it.todo`: a
  // todo never runs, so it reads as owed coverage when the decision was that
  // none is owed.
  // ============================================================

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
  // Timing budget: config-edit + loadProject validation
  // ============================================================

  describe('completes config-edit and validation within timing budget', () => {
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
  // .rill/npm/ missing
  // ============================================================

  describe('.rill/npm/ missing emits the not-found error and exits 1', () => {
    it('writes the not-found error verbatim to stderr; no npm subprocess; exits 1', async () => {
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
      expect(err).toContain("Run 'rill init' first to initialize the project");
      // npm subprocess must not have been invoked
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Mount collision without --as
  // ============================================================

  describe('mount collision without --as exits 1 with the mount-exists error', () => {
    it('writes the mount-exists error verbatim to stderr; no npm subprocess; exits 1', async () => {
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
  // npm subprocess non-zero exit
  // ============================================================

  describe('npm non-zero exit propagates; config byte-equal', () => {
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
  // loadProject validation fails after install
  // ============================================================

  describe('factory failures no longer block install (FRICTION-NOTES 2026-05-03)', () => {
    it('install ignores factory errors entirely; loadProject is never invoked', async () => {
      bootstrapProject(tmpDir);
      const prefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');

      // npm succeeds; loadProject would reject if called, but install must not
      // call it. The previous contract (rollback on factory error)
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
  // writeFileSync fails after npm install
  // ============================================================

  describe('writeFileSync fails after npm install', () => {
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
  // npm not on PATH (NpmNotFoundError)
  // ============================================================

  describe('npm not on PATH exits 1 with readable message', () => {
    it('emits "npm not found on PATH" to stderr and exits 1', async () => {
      bootstrapProject(tmpDir);

      // Simulate spawn failing with ENOENT by emitting 'error' event.
      // stdout EventEmitter is attached so npmView does not crash on .on('data').
      mocks.spawn.mockImplementation(() => {
        const stdout = new EventEmitter();
        const child = Object.assign(new EventEmitter(), { stdout });
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
  // Pre-install role probe
  // ============================================================

  describe('pre-install role probe: rejects packages without rill.role', () => {
    it('rejects a registry package that returns no rill field from npm view', async () => {
      bootstrapProject(tmpDir);

      // npm view emits empty stdout (simulates a package with no rill field published)
      mocks.spawn.mockImplementation((_cmd: string, args: string[]) => {
        const stdout = new EventEmitter();
        const child = Object.assign(new EventEmitter(), { stdout });
        process.nextTick(() => {
          if (args[0] === 'view') {
            // Empty stdout — no rill field in package.json
            stdout.emit('data', Buffer.from(''));
          }
          child.emit('close', 0);
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
      expect(cap.stderr.join('')).toContain('does not declare a rill role');
      // npm install must not have been reached
      expect(mocks.spawn).toHaveBeenCalledTimes(1);
    });

    it('rejects a registry package that returns an unknown role value', async () => {
      bootstrapProject(tmpDir);

      // npm view emits a rill field with an unrecognised role value
      mocks.spawn.mockImplementation((_cmd: string, args: string[]) => {
        const stdout = new EventEmitter();
        const child = Object.assign(new EventEmitter(), { stdout });
        process.nextTick(() => {
          if (args[0] === 'view') {
            stdout.emit(
              'data',
              Buffer.from(JSON.stringify({ role: 'unknown-value' }))
            );
          }
          child.emit('close', 0);
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
      expect(cap.stderr.join('')).toContain('does not declare a rill role');
      // npm install must not have been reached
      expect(mocks.spawn).toHaveBeenCalledTimes(1);
    });

    it('rejects a local directory package without a rill.role in its package.json', async () => {
      bootstrapProject(tmpDir);

      // Create a local package directory with a package.json that has no rill field
      const localExtDir = path.join(tmpDir, 'local-ext');
      fs.mkdirSync(localExtDir, { recursive: true });
      fs.writeFileSync(
        path.join(localExtDir, 'package.json'),
        JSON.stringify({ name: 'my-local-ext', version: '1.0.0' }),
        'utf8'
      );

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['./local-ext', '--as', 'myext']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain('does not declare a rill role');
      // npm install must not have been reached
      expect(mocks.spawn).not.toHaveBeenCalled();
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
      expect(out).not.toContain('role is finalized at install time');
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
      expect(err).toContain("Run 'rill init'");
    });
  });

  // ============================================================
  // W-1 / #62: local package name preferred over derived mount basename
  // ============================================================

  describe('local package name preferred over derived mount basename', () => {
    it('records the harness by its package.json name, not the directory basename, in a bundle', async () => {
      const localHarnessDir = path.join(tmpDir, 'local-harness');
      fs.mkdirSync(localHarnessDir, { recursive: true });
      fs.writeFileSync(
        path.join(localHarnessDir, 'package.json'),
        JSON.stringify({
          name: 'custom-harness-name',
          version: '1.0.0',
          rill: { role: 'harness' },
        }),
        'utf8'
      );

      fs.writeFileSync(
        path.join(tmpDir, 'rill-bundle.json'),
        JSON.stringify(
          {
            name: 'test-bundle',
            version: '1.0.0',
            packages: [{ mount: 'app', project: 'packages/app' }],
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
      bootstrapProject(tmpDir);

      mocks.spawn.mockImplementation(makeSpawnMock(0));

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['./local-harness']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      const bundleConfig = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-bundle.json'), 'utf8')
      ) as { harness?: string };
      expect(bundleConfig.harness).toBe('custom-harness-name');
      expect(cap.stdout.join('')).toContain(
        "Harness 'custom-harness-name' recorded"
      );
    });
  });

  // ============================================================
  // W-1 / #61-1: writeBundleHarness BundleConfigError is caught, not thrown
  // ============================================================

  describe('writeBundleHarness failure surfaces as a ✗-prefixed error, not a stack trace', () => {
    it.skipIf(process.platform === 'win32')(
      'exits 1 with a ✗-prefixed message and no raw stack trace when the write fails',
      async () => {
        const localHarnessDir = path.join(tmpDir, 'local-harness');
        fs.mkdirSync(localHarnessDir, { recursive: true });
        fs.writeFileSync(
          path.join(localHarnessDir, 'package.json'),
          JSON.stringify({
            name: 'custom-harness-name',
            version: '1.0.0',
            rill: { role: 'harness' },
          }),
          'utf8'
        );

        fs.writeFileSync(
          path.join(tmpDir, 'rill-bundle.json'),
          JSON.stringify(
            {
              name: 'test-bundle',
              version: '1.0.0',
              packages: [{ mount: 'app', project: 'packages/app' }],
            },
            null,
            2
          ) + '\n',
          'utf8'
        );
        bootstrapProject(tmpDir);

        mocks.spawn.mockImplementation(makeSpawnMock(0));

        // Force the rill-bundle.json write inside writeBundleHarness to fail
        // with EACCES. The write is now atomic (temp file + rename), so a
        // read-only *file* no longer blocks it — rename replaces it regardless
        // of the destination's permission bits. Make the *directory* read-only
        // instead, so the temp-file write itself fails. readRawBundleJson (a
        // read) still succeeds, so the collision pre-check passes and only the
        // write itself fails.
        fs.chmodSync(tmpDir, 0o555);

        const { run } = await import('../../src/commands/install.js');
        const cap = captureOutput();
        let exitCode: number;
        try {
          exitCode = await run(['./local-harness']);
        } finally {
          cap.restore();
          fs.chmodSync(tmpDir, 0o755);
        }

        expect(exitCode).toBe(1);
        const stderr = cap.stderr.join('');
        expect(stderr).toMatch(/^✗ /);
        expect(stderr).not.toContain('at ');
      }
    );
  });

  // ============================================================
  // W-1 / #61-2: package-mode readConfigSnapshot guard (missing config)
  // ============================================================

  describe('package-mode install with rill-config.json missing', () => {
    it('exits 1 with the bootstrap-hint message, verbatim, before any npm call', async () => {
      // Bootstrap .rill/npm/ only; rill-config.json is never written.
      const rillNpm = path.join(tmpDir, '.rill', 'npm');
      fs.mkdirSync(rillNpm, { recursive: true });
      fs.writeFileSync(
        path.join(rillNpm, 'package.json'),
        '{"name":"rill-extensions","private":true}\n',
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
      expect(err).toContain('✗ rill-config.json not found');
      expect(err).toContain("Run 'rill init'");
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // W-1 / #61-3: malformed rill-config.json surfaces as ConfigParseError
  // ============================================================

  describe('malformed rill-config.json surfaces as a ConfigParseError, not a raw SyntaxError', () => {
    it('exits 1 with a ✗-prefixed parse error before any npm call', async () => {
      bootstrapProject(tmpDir);
      fs.writeFileSync(
        path.join(tmpDir, 'rill-config.json'),
        '{ not valid json',
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
      expect(err).toMatch(/^✗ /);
      expect(err).toContain('Failed to parse');
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // W-1 / #65g: single-file source rejects --for and --role
  // ============================================================

  describe('single-file source rejects --for and --role', () => {
    it('exits 1 without touching rill-config.json when --for is passed', async () => {
      bootstrapProject(tmpDir);
      const extPath = path.join(tmpDir, 'extensions', 'crawler.ts');
      fs.mkdirSync(path.dirname(extPath), { recursive: true });
      fs.writeFileSync(extPath, 'export default {};', 'utf8');
      const configBefore = fs.readFileSync(
        path.join(tmpDir, 'rill-config.json'),
        'utf8'
      );

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([
          './extensions/crawler.ts',
          '--as',
          'crawler',
          '--for',
          'app',
        ]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain(
        '--for/--role are not valid for single-file sources'
      );
      const configAfter = fs.readFileSync(
        path.join(tmpDir, 'rill-config.json'),
        'utf8'
      );
      expect(configAfter).toBe(configBefore);
    });

    it('exits 1 when --role is passed', async () => {
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
          '--role',
          'extension',
        ]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain(
        '--for/--role are not valid for single-file sources'
      );
    });
  });

  // ============================================================
  // W-1 / #65g: --dry-run preview echoes --for and --role
  // ============================================================

  describe('--dry-run preview echoes the effective --for target and --role', () => {
    it('prints [dry-run] for/role lines and a role-finalizes-at-install-time note', async () => {
      bootstrapProject(tmpDir);

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([
          '@rcrsr/rill-ext-datetime',
          '--dry-run',
          '--for',
          'app',
          '--role',
          'harness',
        ]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      expect(mocks.spawn).not.toHaveBeenCalled();
      const out = cap.stdout.join('');
      expect(out).toContain('[dry-run] for: app');
      expect(out).toContain('[dry-run] role: harness');
      expect(out).toContain('role is finalized at install time');
    });
  });

  // ============================================================
  // W-1 / #65j: --exact deprecation warning names 0.21, not 0.20
  // ============================================================

  describe('--exact deprecation warning names the removal version 0.21', () => {
    it('warns with "removed in 0.21"', async () => {
      bootstrapProject(tmpDir);
      const prefix = path.join(tmpDir, '.rill', 'npm');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');

      mocks.spawn.mockImplementation(makeSpawnMock(0));

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      try {
        await run(['@rcrsr/rill-ext-datetime', '--exact']);
      } finally {
        cap.restore();
      }

      expect(cap.stderr.join('')).toContain('removed in 0.21');
      expect(cap.stderr.join('')).not.toContain('removed in 0.20');
    });
  });
});
