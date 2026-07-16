/**
 * Tests for src/commands/bundle-resolve.ts
 *
 * These are pure-fs helper functions (no npm/child_process/loadProject
 * interaction), so no mocks are needed: real tmp dirs with rill-bundle.json
 * fixtures exercise findBundleRoot/readBundleConfig directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, captureOutput } from '../helpers/cli-fixtures.js';
import {
  resolveExtensionTarget,
  resolveHarnessTarget,
} from '../../src/commands/bundle-resolve.js';

// ============================================================
// FIXTURE HELPERS
// ============================================================

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

/** Create a bundle root with one package sub-directory (no rill-config.json needed here). */
function makeBundle(
  bundleRoot: string,
  opts: {
    harness?: string;
    packages?: Array<{ mount: string; project: string }>;
  } = {}
): void {
  const packages = opts.packages ?? [{ mount: 'app', project: 'packages/app' }];
  writeBundleJson(bundleRoot, { harness: opts.harness, packages });
  for (const pkg of packages) {
    fs.mkdirSync(path.join(bundleRoot, pkg.project), { recursive: true });
  }
}

// ============================================================
// TESTS
// ============================================================

describe('bundle-resolve', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ============================================================
  // resolveExtensionTarget
  // ============================================================

  describe('resolveExtensionTarget', () => {
    it('resolves package mode (no ancestor bundle) to the project dir itself', async () => {
      const projectDir = path.join(tmpDir, 'plain-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const result = await resolveExtensionTarget({
        projectDir,
        forMount: undefined,
      });

      expect('target' in result).toBe(true);
      if ('target' in result) {
        expect(result.target.bundleRoot).toBeNull();
        expect(result.target.targetDir).toBe(projectDir);
        expect(result.target.prefix).toBe(
          path.join(projectDir, '.rill', 'npm')
        );
      }
    });

    it('resolves bundle mode from within a package directory to that package dir', async () => {
      makeBundle(tmpDir, {
        packages: [{ mount: 'app', project: 'packages/app' }],
      });
      const pkgDir = path.join(tmpDir, 'packages', 'app');

      const result = await resolveExtensionTarget({
        projectDir: pkgDir,
        forMount: undefined,
      });

      expect('target' in result).toBe(true);
      if ('target' in result) {
        expect(result.target.bundleRoot).toBe(tmpDir);
        expect(result.target.targetDir).toBe(pkgDir);
        expect(result.target.prefix).toBe(path.join(pkgDir, '.rill', 'npm'));
      }
    });

    it('resolves bundle root with --for <mount> to the matching package project dir', async () => {
      makeBundle(tmpDir, {
        packages: [{ mount: 'app', project: 'packages/app' }],
      });

      const result = await resolveExtensionTarget({
        projectDir: tmpDir,
        forMount: 'app',
      });

      expect('target' in result).toBe(true);
      if ('target' in result) {
        expect(result.target.bundleRoot).toBe(tmpDir);
        expect(result.target.targetDir).toBe(
          path.resolve(tmpDir, 'packages', 'app')
        );
      }
    });

    it('errors with "Cannot determine target package" when at bundle root without --for', async () => {
      makeBundle(tmpDir, {
        packages: [{ mount: 'app', project: 'packages/app' }],
      });

      const cap = captureOutput();
      let result: Awaited<ReturnType<typeof resolveExtensionTarget>>;
      try {
        result = await resolveExtensionTarget({
          projectDir: tmpDir,
          forMount: undefined,
        });
      } finally {
        cap.restore();
      }

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe(1);
      }
      expect(cap.stderr.join('')).toContain('Cannot determine target package');
    });
  });

  // ============================================================
  // resolveHarnessTarget
  // ============================================================

  describe('resolveHarnessTarget', () => {
    it('errors when there is no ancestor bundle', async () => {
      const projectDir = path.join(tmpDir, 'plain-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const cap = captureOutput();
      let result: Awaited<ReturnType<typeof resolveHarnessTarget>>;
      try {
        result = await resolveHarnessTarget(projectDir);
      } finally {
        cap.restore();
      }

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe(1);
      }
      expect(cap.stderr.join('')).toBe(
        '✗ --harness requires a bundle. No rill-bundle.json found in this directory or any parent.\n'
      );
    });

    it('errors when the bundle has no harness declared', async () => {
      makeBundle(tmpDir, {
        packages: [{ mount: 'app', project: 'packages/app' }],
      });

      const cap = captureOutput();
      let result: Awaited<ReturnType<typeof resolveHarnessTarget>>;
      try {
        result = await resolveHarnessTarget(tmpDir);
      } finally {
        cap.restore();
      }

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe(1);
      }
      expect(cap.stderr.join('')).toBe(
        '✗ No harness declared in rill-bundle.json.\n'
      );
    });

    it('resolves bundleRoot, prefix, and harnessName when a harness is declared', async () => {
      makeBundle(tmpDir, {
        harness: 'my-harness-pkg',
        packages: [{ mount: 'app', project: 'packages/app' }],
      });

      const result = await resolveHarnessTarget(tmpDir);

      expect('target' in result).toBe(true);
      if ('target' in result) {
        expect(result.target.bundleRoot).toBe(tmpDir);
        expect(result.target.prefix).toBe(path.join(tmpDir, '.rill', 'npm'));
        expect(result.target.harnessName).toBe('my-harness-pkg');
      }
    });
  });
});
