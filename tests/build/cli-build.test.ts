import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { spawnCli } from '../helpers/spawn-cli.js';

function run(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return Promise.resolve(spawnCli(['build', ...args]));
}

// ============================================================
// --help flag
// ============================================================

describe('rill-build --help', () => {
  it('exits 0 and prints usage for --help', async () => {
    const result = await run(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });

  it('exits 0 and prints usage for -h', async () => {
    const result = await run(['-h']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });
});

// ============================================================
// --version flag
// ============================================================

describe('rill-build --version', () => {
  it('exits 0 and prints version for --version', async () => {
    const result = await run(['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+/);
  });

  it('exits 0 and prints version for -v', async () => {
    const result = await run(['-v']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+/);
  });
});

// ============================================================
// Unknown flag rejection
// ============================================================

describe('rill-build unknown flags', () => {
  it('exits 1 and reports unknown long flag', async () => {
    const result = await run(['--unknown']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown option: --unknown');
  });

  it('exits 1 and reports unknown short flag', async () => {
    const result = await run(['-x']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown option: -x');
  });
});

// ============================================================
// Missing rill-config.json (normal error path)
// ============================================================

describe('rill-build missing config', () => {
  it('exits 1 for nonexistent dir', async () => {
    const result = await run([
      path.join(os.tmpdir(), 'rill-build-nonexistent-xyz'),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

// ============================================================
// --help takes precedence over unknown flags
// ============================================================

describe('rill-build flag precedence', () => {
  it('shows help and exits 0 when --help appears alongside unknown flags', async () => {
    const result = await run(['--help', '--unknown']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });
});
