/**
 * Tests for src/commands/install.ts — local-path installs.
 * Covers AC-4 (local symlink + verbatim relative path, UXT-EXT-3 messages).
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
 * Create a minimal local extension directory.
 * The npmInstall mock will create the node_modules symlink fixture.
 */
function makeLocalExt(parentDir: string, name: string): string {
  const extDir = path.join(parentDir, name);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name, version: '0.0.1' }),
    'utf8'
  );
  return extDir;
}

// ============================================================
// TESTS: AC-4 — local-path install
// ============================================================

describe('install (local path)', () => {
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

  describe('AC-4: local extension symlink + verbatim relative path', () => {
    it('records verbatim relative path in mounts and exits 0', async () => {
      bootstrapProject(tmpDir);
      makeLocalExt(tmpDir, 'local-ext');

      // Mock npm install to succeed AND create the node_modules fixture
      // (npm install of a local path creates a symlink under node_modules/<name>)
      mocks.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        process.nextTick(() => {
          // Simulate npm creating a directory at node_modules/local-ext
          const nodeModulesDir = path.join(
            tmpDir,
            '.rill',
            'npm',
            'node_modules',
            'local-ext'
          );
          fs.mkdirSync(nodeModulesDir, { recursive: true });
          fs.writeFileSync(
            path.join(nodeModulesDir, 'package.json'),
            JSON.stringify({ name: 'local-ext', version: '0.0.1' }),
            'utf8'
          );
          child.emit('close', 0);
        });
        return child;
      });

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['./local-ext']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);

      const config = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'rill-config.json'), 'utf8')
      ) as { extensions: { mounts: Record<string, string> } };
      // Verbatim relative path stored as specifier
      expect(config.extensions.mounts['local-ext']).toBe('./local-ext');
    });

    it('emits UXT-EXT-3 messages on stdout', async () => {
      bootstrapProject(tmpDir);
      makeLocalExt(tmpDir, 'local-ext');

      mocks.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        process.nextTick(() => {
          const nodeModulesDir = path.join(
            tmpDir,
            '.rill',
            'npm',
            'node_modules',
            'local-ext'
          );
          fs.mkdirSync(nodeModulesDir, { recursive: true });
          fs.writeFileSync(
            path.join(nodeModulesDir, 'package.json'),
            JSON.stringify({ name: 'local-ext', version: '0.0.1' }),
            'utf8'
          );
          child.emit('close', 0);
        });
        return child;
      });

      const { run } = await import('../../src/commands/install.js');
      const cap = captureOutput();
      try {
        await run(['./local-ext']);
      } finally {
        cap.restore();
      }

      const out = cap.stdout.join('');
      // UXT-EXT-3: first line: "ℹ Installing <mount> from <specifier>..."
      expect(out).toContain('ℹ Installing local-ext from ./local-ext');
      // UXT-EXT-3: second line: "✓ Installed to .rill/npm/node_modules/<mount> (symlinked)"
      expect(out).toContain(
        '✓ Installed to .rill/npm/node_modules/local-ext (symlinked)'
      );
      // UXT-EXT-3: success mount line
      expect(out).toContain("✓ Mounted as 'local-ext' in rill-config.json");
    });
  });
});
