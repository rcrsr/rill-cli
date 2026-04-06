import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';

const CLI_PATH = path.resolve(process.cwd(), 'dist/cli-build.js');

function run(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env['VITEST'];
    delete env['VITEST_WORKER_ID'];
    delete env['NODE_ENV'];

    const proc = spawn('node', [CLI_PATH, ...args], { env });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

// ============================================================
// --help flag
// ============================================================

describe('rill-build --help', () => {
  it('exits 0 and prints usage for --help', async () => {
    const result = await run(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('rill-build');
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
    expect(result.stdout).toContain('rill-build');
    expect(result.stdout).toMatch(/rill-build \d+\.\d+/);
  });

  it('exits 0 and prints version for -v', async () => {
    const result = await run(['-v']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('rill-build');
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
  it('exits 1 and reports missing rill-config.json for nonexistent dir', async () => {
    const result = await run(['/tmp/nonexistent-dir-xyz-rill-cli-test']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('rill-config.json not found');
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
