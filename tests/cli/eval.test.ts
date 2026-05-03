/**
 * Rill CLI Tests: rill-eval command
 */

import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import { ParseError, RuntimeError } from '@rcrsr/rill';
import { evaluateExpression } from '../../src/cli-eval.js';

const CLI_PATH = path.join(process.cwd(), 'dist', 'cli.js');

// Spawn env without VITEST vars so the CLI's shouldRunMain guard does not block execution
const SPAWN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => k !== 'VITEST' && k !== 'VITEST_WORKER_ID' && k !== 'NODE_ENV'
  )
);

function run(args: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  try {
    const stdout = execFileSync('node', [CLI_PATH, 'eval', ...args], {
      encoding: 'utf-8',
      timeout: 10000,
      env: SPAWN_ENV,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const spawnErr = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    return {
      stdout: spawnErr.stdout ?? '',
      stderr: spawnErr.stderr ?? '',
      exitCode: spawnErr.status ?? 1,
    };
  }
}

describe('rill-eval', () => {
  describe('evaluateExpression', () => {
    it('evaluates string methods', async () => {
      expect((await evaluateExpression('"hello".len')).result).toBe(5);
      expect((await evaluateExpression('"hello".upper')).result).toBe('HELLO');
      expect((await evaluateExpression('"  hi  ".trim')).result).toBe('hi');
    });

    it('evaluates arithmetic', async () => {
      expect((await evaluateExpression('5 + 3')).result).toBe(8);
      expect((await evaluateExpression('10 - 4')).result).toBe(6);
      expect((await evaluateExpression('6 * 7')).result).toBe(42);
    });

    it('evaluates pipes', async () => {
      expect((await evaluateExpression('"hello" -> .upper')).result).toBe(
        'HELLO'
      );
    });

    it('evaluates collections', async () => {
      expect((await evaluateExpression('list[1, 2, 3] -> .len')).result).toBe(
        3
      );
      expect(
        (await evaluateExpression('list[1, 2, 3] -> fan(|x|($x * 2))')).result
      ).toEqual([2, 4, 6]);
      expect((await evaluateExpression('dict[a: 1].a')).result).toBe(1);
    });

    it('returns closure as RillValue when expression returns a closure', async () => {
      const result = await evaluateExpression('|x| { $x }');
      expect(result.result).not.toBeNull();
      expect(typeof result.result).toBe('object');
    });

    it('handles empty values', async () => {
      expect((await evaluateExpression('""')).result).toBe('');
      expect((await evaluateExpression('list[]')).result).toEqual([]);
      expect((await evaluateExpression('0')).result).toBe(0);
    });

    it('throws parse errors', async () => {
      await expect(evaluateExpression('{')).rejects.toThrow(ParseError);
      await expect(evaluateExpression('|x| x }')).rejects.toThrow(ParseError);
    });

    it('throws runtime errors', async () => {
      await expect(evaluateExpression('$undefined')).rejects.toThrow(
        RuntimeError
      );
      await expect(evaluateExpression('"string" + 5')).rejects.toThrow(
        RuntimeError
      );
    });

    it('preserves error details', async () => {
      try {
        await evaluateExpression('$missing');
      } catch (err) {
        expect(err).toBeInstanceOf(RuntimeError);
        expect((err as RuntimeError).errorId).toBe('RILL-R005');
        expect((err as RuntimeError).location?.line).toBe(1);
      }
    });
  });
});

describe('rill-eval CLI flags', () => {
  beforeAll(() => {
    execSync('pnpm run build', { stdio: 'ignore' });
  }, 30000);

  describe('--help flag', () => {
    it('exits 0 and prints usage for --help', () => {
      const result = run(['--help']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage');
    });

    it('exits 0 and prints usage for -h', () => {
      const result = run(['-h']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage');
    });
  });

  describe('--version flag', () => {
    it('exits 0 and prints version for --version', () => {
      const result = run(['--version']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+/);
    });

    it('exits 0 and prints version for -v', () => {
      const result = run(['-v']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+/);
    });
  });

  describe('unknown flag rejection', () => {
    it('exits 1 and reports unknown flag for --unknown', () => {
      const result = run(['--unknown']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown option: --unknown');
    });

    it('exits 1 and reports unknown flag for -x', () => {
      const result = run(['-x']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown option: -x');
    });
  });

  describe('no args defaults to help', () => {
    it('exits 0 and prints usage when no args provided', () => {
      const result = run([]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage');
    });
  });

  describe('expression evaluation via CLI', () => {
    it('evaluates expression and prints result', () => {
      const result = run(['"hello".len']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('5');
    });
  });
});
