/**
 * Tests for src/cli.ts — unified dispatcher.
 * Covers AC-10 (UXT-EXT-11 help output), AC-P6 (dispatch < 100ms).
 * Phase 3.5 additions: EC-1/EC-2/EC-3 + AC-E8.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { captureOutput } from '../helpers/cli-fixtures.js';

// ============================================================
// MOCK SETUP
// ============================================================

const mocks = vi.hoisted(() => ({
  bootstrapRun: vi.fn(),
  installRun: vi.fn(),
  uninstallRun: vi.fn(),
  upgradeRun: vi.fn(),
  listRun: vi.fn(),
}));

vi.mock('../../src/commands/bootstrap.js', () => ({
  run: mocks.bootstrapRun,
}));

vi.mock('../../src/commands/install.js', () => ({
  run: mocks.installRun,
}));

vi.mock('../../src/commands/uninstall.js', () => ({
  run: mocks.uninstallRun,
}));

vi.mock('../../src/commands/upgrade.js', () => ({
  run: mocks.upgradeRun,
}));

vi.mock('../../src/commands/list.js', () => ({
  run: mocks.listRun,
}));

vi.mock('../../src/cli-shared.js', () => ({
  CLI_VERSION: '0.0.0-test',
  VERSION: '0.0.0-test',
}));

// ============================================================
// TESTS
// ============================================================

describe('cli dispatch', () => {
  beforeEach(() => {
    // Default all command mocks to return exit 0
    mocks.bootstrapRun.mockResolvedValue(0);
    mocks.installRun.mockResolvedValue(0);
    mocks.uninstallRun.mockResolvedValue(0);
    mocks.upgradeRun.mockResolvedValue(0);
    mocks.listRun.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ============================================================
  // AC-10: no-args → UXT-EXT-11 help
  // ============================================================

  describe('AC-10: no subcommand emits UXT-EXT-11 help and exits 0', () => {
    it('main([]) outputs help text and exits 0', async () => {
      const { main } = await import('../../src/cli.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await main([]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      const out = cap.stdout.join('');
      // Spot-check key strings from UXT-EXT-11 (printHelp output)
      expect(out).toContain('Usage: rill <command>');
      expect(out).toContain('bootstrap');
      expect(out).toContain('install');
      expect(out).toContain('uninstall');
      expect(out).toContain('upgrade');
      expect(out).toContain('list');
    });

    it('main(["--help"]) outputs help text and exits 0', async () => {
      const { main } = await import('../../src/cli.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await main(['--help']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toContain('Usage: rill <command>');
      expect(out).toContain('bootstrap');
    });

    it('main(["-h"]) outputs help text and exits 0', async () => {
      const { main } = await import('../../src/cli.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await main(['-h']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toContain('Usage: rill <command>');
    });
  });

  // ============================================================
  // AC-P6: dispatch overhead < 100ms
  // ============================================================

  describe('AC-P6: dispatch overhead < 100ms before subcommand body executes', () => {
    it('records handler entry timestamp within 100ms of main() call', async () => {
      const { main } = await import('../../src/cli.js');

      let handlerEntryTime: number | undefined;
      const mainCallTime = performance.now();

      mocks.bootstrapRun.mockImplementation(async () => {
        handlerEntryTime = performance.now();
        return 0;
      });

      const cap = captureOutput();
      try {
        await main(['bootstrap']);
      } finally {
        cap.restore();
      }

      expect(handlerEntryTime).toBeDefined();
      const dispatchOverhead = (handlerEntryTime ?? 0) - mainCallTime;
      expect(dispatchOverhead).toBeLessThan(100);
    });
  });

  // ============================================================
  // Subcommand routing sanity checks
  // ============================================================

  describe('subcommand routing', () => {
    it('routes "bootstrap" to bootstrap.run', async () => {
      const { main } = await import('../../src/cli.js');
      const cap = captureOutput();
      try {
        await main(['bootstrap']);
      } finally {
        cap.restore();
      }
      expect(mocks.bootstrapRun).toHaveBeenCalledOnce();
    });

    it('routes "install" to install.run with remaining argv', async () => {
      const { main } = await import('../../src/cli.js');
      const cap = captureOutput();
      try {
        await main(['install', '@rcrsr/rill-ext-datetime']);
      } finally {
        cap.restore();
      }
      expect(mocks.installRun).toHaveBeenCalledWith([
        '@rcrsr/rill-ext-datetime',
      ]);
    });

    it('routes "list" to list.run', async () => {
      const { main } = await import('../../src/cli.js');
      const cap = captureOutput();
      try {
        await main(['list']);
      } finally {
        cap.restore();
      }
      expect(mocks.listRun).toHaveBeenCalledOnce();
    });
  });

  // ============================================================
  // AC-E8 / EC-1: unknown subcommand
  // ============================================================

  describe('AC-E8/EC-1: unknown subcommand exits 1 with error message', () => {
    it('main(["foo"]) writes stderr and exits 1', async () => {
      const { main } = await import('../../src/cli.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await main(['foo']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      const err = cap.stderr.join('');
      expect(err).toContain('Unknown command: foo.');
      expect(err).toContain("Run 'rill --help' for available commands.");
    });

    it('main(["bar"]) writes stderr with correct subcommand name and exits 1', async () => {
      const { main } = await import('../../src/cli.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await main(['bar']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(1);
      expect(cap.stderr.join('')).toContain('Unknown command: bar.');
    });
  });

  // ============================================================
  // EC-2: --version / -v
  // ============================================================

  describe('EC-2: --version / -v exits 0 with CLI_VERSION on stdout', () => {
    it('main(["--version"]) outputs CLI_VERSION and exits 0', async () => {
      const { main } = await import('../../src/cli.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await main(['--version']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      // The mocked CLI_VERSION is '0.0.0-test'
      expect(cap.stdout.join('')).toContain('0.0.0-test');
    });

    it('main(["-v"]) outputs CLI_VERSION and exits 0', async () => {
      const { main } = await import('../../src/cli.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await main(['-v']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      expect(cap.stdout.join('')).toContain('0.0.0-test');
    });
  });

  // ============================================================
  // EC-3: --help / -h / no args -> UXT-EXT-11
  // ============================================================

  describe('EC-3: --help / -h / no args emit UXT-EXT-11 and exit 0', () => {
    it('main(["--help"]) emits key lines verbatim and exits 0', async () => {
      const { main } = await import('../../src/cli.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await main(['--help']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toContain('Usage: rill <command> [options]');
      expect(out).toContain('bootstrap');
      expect(out).toContain('install <pkg>');
      expect(out).toContain('uninstall <mount>');
      expect(out).toContain('upgrade <mount>');
      expect(out).toContain('list');
      expect(out).toContain("Run 'rill help <command>'");
    });

    it('main(["-h"]) emits key lines verbatim and exits 0', async () => {
      const { main } = await import('../../src/cli.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await main(['-h']);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toContain('Usage: rill <command> [options]');
      expect(out).toContain("Run 'rill help <command>'");
    });

    it('main([]) emits UXT-EXT-11 trailing instruction line and exits 0', async () => {
      const { main } = await import('../../src/cli.js');
      const cap = captureOutput();
      let exitCode: number;
      try {
        exitCode = await main([]);
      } finally {
        cap.restore();
      }

      expect(exitCode).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toContain(
        "Run 'rill help <command>' or 'rill <command> --help' for details."
      );
    });
  });
});
