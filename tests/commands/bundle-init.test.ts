/**
 * Tests for src/commands/bundle-init.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, captureOutput } from '../helpers/cli-fixtures.js';
import { run } from '../../src/commands/bundle-init.js';

describe('bundle-init', () => {
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
  });

  describe('invalid bundle name rejection', () => {
    it.each([['../x'], ['a/b'], ['a\\b']])(
      "rejects '%s' with exit 1, the message, and no rill-bundle.json",
      async (name) => {
        const cap = captureOutput();
        let exitCode: number;
        try {
          exitCode = await run([name]);
        } finally {
          cap.restore();
        }

        expect(exitCode).toBe(1);
        expect(cap.stderr.join('')).toBe(`invalid bundle name: '${name}'\n`);
        expect(fs.existsSync(path.join(tmpDir, 'rill-bundle.json'))).toBe(
          false
        );
      }
    );
  });

  describe('accepted names', () => {
    it('accepts a valid supplied name', async () => {
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run(['demo']);
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
    });

    it('falls back to the cwd basename when no name is supplied, without the check', async () => {
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      const bundleConfigPath = path.join(tmpDir, 'rill-bundle.json');
      expect(fs.existsSync(bundleConfigPath)).toBe(true);
      const bundleConfig = JSON.parse(
        fs.readFileSync(bundleConfigPath, 'utf8')
      ) as { name: string };
      expect(bundleConfig.name).toBe(path.basename(tmpDir));
    });
  });
});
