/**
 * Tests for src/commands/bootstrap.ts — deprecation behavior only.
 * The scaffolding scenarios previously in this file now live in tests/commands/init.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { captureOutput } from '../helpers/cli-fixtures.js';

vi.mock('../../src/cli-shared.js', () => ({
  CLI_VERSION: '0.0.0-test',
  VERSION: '0.0.0-test',
}));

describe('bootstrap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('deprecation', () => {
    it('writes the rename notice to stderr and returns 1', async () => {
      const { run } = await import('../../src/commands/bootstrap.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await run([]);
      } finally {
        cap.restore();
      }

      expect(cap.stderr.join('')).toBe(
        'rill bootstrap has been renamed to rill init. Use `rill init` to create a single package, or `rill init bundle` to create a bundle.\n'
      );
      expect(exitCode).toBe(1);
    });
  });
});
