/**
 * Unit tests for npm-runner.ts: npmInstall and npmUninstall resolve with
 * non-zero exit codes and do NOT throw (EC-32).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ============================================================
// MOCK SETUP
// ============================================================

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

// ============================================================
// HELPERS
// ============================================================

/**
 * Returns a spawn mock implementation that creates a fresh EventEmitter and
 * schedules the 'close' event via process.nextTick AFTER returning.
 *
 * Using mockImplementation (not mockReturnValue) ensures the child is created
 * at the moment spawn() is called inside the implementation. The implementation
 * then registers its 'close' listener synchronously before nextTick fires.
 */
function spawnReturningExitCode(exitCode: number): () => EventEmitter {
  return () => {
    const child = new EventEmitter();
    process.nextTick(() => {
      child.emit('close', exitCode);
    });
    return child;
  };
}

// ============================================================
// TESTS
// ============================================================

describe('npmInstall', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('resolves with exitCode 0 on successful subprocess', async () => {
    spawnMock.mockImplementation(spawnReturningExitCode(0));

    const { npmInstall } = await import('../../src/commands/npm-runner.js');

    const result = await npmInstall({
      spec: 'some-pkg',
      prefix: '/tmp/prefix',
    });

    expect(result.exitCode).toBe(0);
  });

  it('resolves (does not throw) with exitCode 1 on non-zero exit (EC-32)', async () => {
    spawnMock.mockImplementation(spawnReturningExitCode(1));

    const { npmInstall } = await import('../../src/commands/npm-runner.js');

    const result = await npmInstall({ spec: 'bad-pkg', prefix: '/tmp/prefix' });

    expect(result.exitCode).toBe(1);
  });

  it('resolves with exitCode 2 for higher non-zero codes', async () => {
    spawnMock.mockImplementation(spawnReturningExitCode(2));

    const { npmInstall } = await import('../../src/commands/npm-runner.js');

    const result = await npmInstall({ spec: 'bad-pkg', prefix: '/tmp/prefix' });

    expect(result.exitCode).toBe(2);
  });

  it('does not throw when subprocess exits non-zero', async () => {
    spawnMock.mockImplementation(spawnReturningExitCode(127));

    const { npmInstall } = await import('../../src/commands/npm-runner.js');

    await expect(
      npmInstall({ spec: 'missing-pkg', prefix: '/tmp/prefix' })
    ).resolves.not.toThrow();
  });

  it('passes correct argv elements to spawn', async () => {
    spawnMock.mockImplementation(spawnReturningExitCode(0));

    const { npmInstall } = await import('../../src/commands/npm-runner.js');

    await npmInstall({ spec: 'my-pkg@1.0.0', prefix: '/my/prefix' });

    expect(spawnMock).toHaveBeenCalledWith(
      'npm',
      ['install', 'my-pkg@1.0.0', '--prefix', '/my/prefix'],
      expect.objectContaining({ shell: false })
    );
  });
});

describe('npmUninstall', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('resolves with exitCode 0 on successful subprocess', async () => {
    spawnMock.mockImplementation(spawnReturningExitCode(0));

    const { npmUninstall } = await import('../../src/commands/npm-runner.js');

    const result = await npmUninstall({
      spec: 'some-pkg',
      prefix: '/tmp/prefix',
    });

    expect(result.exitCode).toBe(0);
  });

  it('resolves (does not throw) with exitCode 1 on non-zero exit (EC-32)', async () => {
    spawnMock.mockImplementation(spawnReturningExitCode(1));

    const { npmUninstall } = await import('../../src/commands/npm-runner.js');

    const result = await npmUninstall({
      spec: 'bad-pkg',
      prefix: '/tmp/prefix',
    });

    expect(result.exitCode).toBe(1);
  });

  it('does not throw when subprocess exits non-zero', async () => {
    spawnMock.mockImplementation(spawnReturningExitCode(3));

    const { npmUninstall } = await import('../../src/commands/npm-runner.js');

    await expect(
      npmUninstall({ spec: 'gone-pkg', prefix: '/tmp/prefix' })
    ).resolves.not.toThrow();
  });

  it('passes correct argv elements to spawn', async () => {
    spawnMock.mockImplementation(spawnReturningExitCode(0));

    const { npmUninstall } = await import('../../src/commands/npm-runner.js');

    await npmUninstall({ spec: 'target-pkg', prefix: '/my/prefix' });

    expect(spawnMock).toHaveBeenCalledWith(
      'npm',
      ['uninstall', 'target-pkg', '--prefix', '/my/prefix'],
      expect.objectContaining({ shell: false })
    );
  });
});
