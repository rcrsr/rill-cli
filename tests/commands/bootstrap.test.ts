/**
 * Tests for src/commands/bootstrap.ts
 * Covers AC-1, AC-B3, AC-B4, EC-4, EC-5, EC-6, AC-P1
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
// TESTS: AC-1 — fresh dir bootstrap
// ============================================================

describe('bootstrap', () => {
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

  describe('AC-1: fresh empty directory', () => {
    it('creates all 4 expected files and exits 0', async () => {
      const { run } = await import('../../src/commands/bootstrap.js');
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
      const { run } = await import('../../src/commands/bootstrap.js');
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
      const { run } = await import('../../src/commands/bootstrap.js');
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

    it('emits UXT-EXT-1 messages on stdout', async () => {
      const { run } = await import('../../src/commands/bootstrap.js');
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

  // ============================================================
  // TESTS: AC-B3 — re-run without --force
  // ============================================================

  describe('AC-B3: re-run without --force', () => {
    it('exits 0 and leaves existing files byte-equal', async () => {
      const { run } = await import('../../src/commands/bootstrap.js');
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

  // ============================================================
  // TESTS: AC-B4 — re-run with --force
  // ============================================================

  describe('AC-B4: re-run with --force', () => {
    it('overwrites files when --force is set', async () => {
      const { run } = await import('../../src/commands/bootstrap.js');
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

  // ============================================================
  // TESTS: EC-4 — EACCES on .rill/npm/ mkdir
  // ============================================================

  describe('EC-4: EACCES on .rill/npm/ mkdir', () => {
    it('exits 1 and writes error to stderr when mkdirSync throws on .rill/npm/', async () => {
      const { run } = await import('../../src/commands/bootstrap.js');

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

  // ============================================================
  // TESTS: EC-5 — EACCES on writeFile for rill-config.json
  // ============================================================

  describe('EC-5: EACCES on writeFile for rill-config.json', () => {
    it('exits 1 and writes error to stderr when writeFileSync throws on rill-config.json', async () => {
      const { run } = await import('../../src/commands/bootstrap.js');

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

  // ============================================================
  // TESTS: EC-6 — pre-existing files without --force → silent no-op
  // ============================================================

  describe('EC-6: pre-existing files without --force', () => {
    it('does not emit "✓ Created" for pre-existing files', async () => {
      const { run } = await import('../../src/commands/bootstrap.js');

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

  // ============================================================
  // TESTS: AC-P1 — timing < 2s
  // ============================================================

  describe('AC-P1: timing < 2s', () => {
    it('completes file I/O in under 2000ms', async () => {
      const { run } = await import('../../src/commands/bootstrap.js');
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
});
