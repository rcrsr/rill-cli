/**
 * Tests for src/commands/list.ts
 * Covers AC-7, AC-8, AC-B1, AC-B2, AC-P5
 * Phase 3.5 additions: EC-22, EC-23, EC-25.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeTmpDir,
  captureOutput,
  bootstrapProject,
} from '../helpers/cli-fixtures.js';

// ============================================================
// MOCK SETUP
// ============================================================

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

// ============================================================
// TESTS
// ============================================================

describe('list', () => {
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
  // AC-7: human mode with 3 mounts
  // ============================================================

  describe('AC-7: human mode with 3 mounts', () => {
    it('outputs header + 3 rows + footer "3 extensions installed." and exits 0', async () => {
      const prefix = path.join(tmpDir, '.rill', 'npm');
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
        markdown: '@rcrsr/rill-ext-markdown@^1.0.0',
        yaml: '@rcrsr/rill-ext-yaml@^2.0.0',
      });
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-markdown', '1.0.0');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-yaml', '2.0.0');

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
      // Header must be present
      expect(out).toContain('MOUNT');
      expect(out).toContain('PACKAGE');
      expect(out).toContain('VERSION');
      expect(out).toContain('SOURCE');
      // 3 data rows
      expect(out).toContain('datetime');
      expect(out).toContain('markdown');
      expect(out).toContain('yaml');
      // Footer
      expect(out).toContain('3 extensions installed.');
    });
  });

  // ============================================================
  // AC-8: JSON mode with 3 mounts, 1 local
  // ============================================================

  describe('AC-8: JSON mode with mixed registry + local mounts', () => {
    it('outputs JSON array of 3; local row has version null and source "local"', async () => {
      const prefix = path.join(tmpDir, '.rill', 'npm');
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
        markdown: '@rcrsr/rill-ext-markdown@^1.0.0',
        'local-ext': './local-ext',
      });
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-markdown', '1.0.0');
      // No node_modules entry for local-ext (it's a local path)

      const { run } = await import('../../src/commands/list.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['--json']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      const jsonOutput = JSON.parse(cap.stdout.join('')) as Array<{
        mount: string;
        specifier: string;
        version: string | null;
        source: string;
      }>;
      expect(jsonOutput).toHaveLength(3);

      const localRow = jsonOutput.find((r) => r.mount === 'local-ext');
      expect(localRow).toBeDefined();
      expect(localRow?.version).toBeNull();
      expect(localRow?.source).toBe('local');

      // Specifiers must be byte-equal to what was registered
      const datetimeRow = jsonOutput.find((r) => r.mount === 'datetime');
      expect(datetimeRow?.specifier).toBe('@rcrsr/rill-ext-datetime@^0.19.0');
      const markdownRow = jsonOutput.find((r) => r.mount === 'markdown');
      expect(markdownRow?.specifier).toBe('@rcrsr/rill-ext-markdown@^1.0.0');
    });
  });

  // ============================================================
  // AC-B1: empty mounts — human mode
  // ============================================================

  describe('AC-B1: empty mounts, human mode', () => {
    it('outputs header + "0 extensions installed." and exits 0', async () => {
      bootstrapProject(tmpDir, {});

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
      expect(out).toContain('MOUNT');
      expect(out).toContain('0 extensions installed.');
    });
  });

  // ============================================================
  // AC-B2: empty mounts — JSON mode
  // ============================================================

  describe('AC-B2: empty mounts, JSON mode', () => {
    it('outputs "[]\n" and exits 0', async () => {
      bootstrapProject(tmpDir, {});

      const { run } = await import('../../src/commands/list.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['--json']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      expect(cap.stdout.join('')).toBe('[]\n');
    });
  });

  // ============================================================
  // AC-P5: timing < 500ms
  // ============================================================

  describe('AC-P5: timing < 500ms', () => {
    it('completes in under 500ms', async () => {
      const prefix = path.join(tmpDir, '.rill', 'npm');
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });
      writeInstalledPkg(prefix, '@rcrsr/rill-ext-datetime', '0.19.0');

      const { run } = await import('../../src/commands/list.js');
      const cap = captureOutput();
      const start = performance.now();
      try {
        await run([]);
      } finally {
        cap.restore();
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(500);
    });
  });

  // ============================================================
  // EC-22: rill-config.json missing
  // ============================================================

  describe('EC-22: rill-config.json missing emits bootstrap hint and exits 1', () => {
    it('writes "Run rill bootstrap first" to stderr and exits 1', async () => {
      // No rill-config.json written — tmpDir is empty
      const { run } = await import('../../src/commands/list.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain("Run 'rill bootstrap' first");
    });
  });

  // ============================================================
  // EC-23: .rill/npm/ missing in --json mode
  // ============================================================

  describe('EC-23: .rill/npm/ missing in --json mode emits bootstrap hint and exits 1', () => {
    it('writes "Run rill bootstrap first" to stderr and exits 1', async () => {
      // Write rill-config.json but no .rill/npm/package.json
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

      const { run } = await import('../../src/commands/list.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['--json']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain("Run 'rill bootstrap' first");
    });
  });

  // ============================================================
  // EC-25: Installed package.json unreadable
  // ============================================================

  describe('EC-25: installed package.json unreadable', () => {
    it('exits 0; version column shows "unknown"; no error thrown', async () => {
      bootstrapProject(tmpDir, {
        datetime: '@rcrsr/rill-ext-datetime@^0.19.0',
      });
      // Deliberately do NOT write the installed package.json — simulates unreadable file

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
      expect(out).toContain('unknown');
    });
  });
});
