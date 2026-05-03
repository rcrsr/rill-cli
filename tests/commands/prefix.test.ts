/**
 * Unit tests for prefix.ts: resolvePrefix and assertBootstrapped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  resolvePrefix,
  assertBootstrapped,
  BootstrapMissingError,
} from '../../src/commands/prefix.js';

// ============================================================
// HELPERS
// ============================================================

function makeTmpDir(): string {
  return path.join(os.tmpdir(), crypto.randomUUID());
}

// ============================================================
// resolvePrefix
// ============================================================

describe('resolvePrefix', () => {
  it('returns an absolute path', () => {
    const result = resolvePrefix('/some/project');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('returns <projectDir>/.rill/npm as absolute path', () => {
    const result = resolvePrefix('/my/project');
    expect(result).toBe(path.resolve('/my/project', '.rill', 'npm'));
  });

  it('resolves relative projectDir to absolute path', () => {
    const result = resolvePrefix('./my-project');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('path ends with .rill/npm', () => {
    const result = resolvePrefix('/any/dir');
    expect(result.endsWith(path.join('.rill', 'npm'))).toBe(true);
  });
});

// ============================================================
// assertBootstrapped
// ============================================================

describe('assertBootstrapped', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('when .rill/npm/package.json exists', () => {
    it('does not throw', () => {
      const npmDir = path.join(tmpDir, '.rill', 'npm');
      fs.mkdirSync(npmDir, { recursive: true });
      fs.writeFileSync(
        path.join(npmDir, 'package.json'),
        JSON.stringify({ name: 'prefix' })
      );

      expect(() => assertBootstrapped(tmpDir)).not.toThrow();
    });
  });

  describe('EC-27: when .rill/npm/package.json is absent', () => {
    it('throws BootstrapMissingError', () => {
      expect(() => assertBootstrapped(tmpDir)).toThrow(BootstrapMissingError);
    });

    it('error.prefix equals the resolved prefix path', () => {
      const expectedPrefix = resolvePrefix(tmpDir);

      let caught: unknown;
      try {
        assertBootstrapped(tmpDir);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(BootstrapMissingError);
      expect((caught as BootstrapMissingError).prefix).toBe(expectedPrefix);
    });

    it('error message contains the package.json path', () => {
      const expectedPrefix = resolvePrefix(tmpDir);
      const expectedPackageJson = path.join(expectedPrefix, 'package.json');

      let caught: unknown;
      try {
        assertBootstrapped(tmpDir);
      } catch (err) {
        caught = err;
      }

      expect((caught as BootstrapMissingError).message).toContain(
        expectedPackageJson
      );
    });

    it('error name is BootstrapMissingError', () => {
      let caught: unknown;
      try {
        assertBootstrapped(tmpDir);
      } catch (err) {
        caught = err;
      }

      expect((caught as BootstrapMissingError).name).toBe(
        'BootstrapMissingError'
      );
    });
  });
});
