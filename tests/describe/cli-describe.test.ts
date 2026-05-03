/**
 * CLI Describe Tests
 *
 * Tests for the rill-describe CLI binary (dist/cli-describe.js).
 * All tests invoke the binary via spawnSync to observe real exit codes and
 * stderr output. Fixtures under tests/fixtures/describe/ provide project
 * configs with known extension mounts and handler-form mains.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const BINARY = path.join(PROJECT_ROOT, 'dist', 'cli.js');
const FIXTURES = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'describe');
const DT_PROJECT = path.join(FIXTURES, 'dt-project');
const DT_CONFIG = path.join(DT_PROJECT, 'rill-config.json');
const HANDLER_PROJECT = path.join(FIXTURES, 'handler-project');
const HANDLER_CONFIG = path.join(HANDLER_PROJECT, 'rill-config.json');

// Ensure dist/cli.js exists before tests spawn it. `pnpm test`
// does not run build first, so a clean checkout would otherwise fail
// with ENOENT. tsbuildinfo can claim the project is up-to-date even
// when emitted JS is missing (manual deletion, dirty dist), so use
// --force to guarantee re-emission. Builds once, in-process.
beforeAll(() => {
  if (!existsSync(BINARY)) {
    execSync('pnpm exec tsc --build --force', {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
  }
}, 60_000);

function runDescribe(
  args: string[],
  cwd: string = PROJECT_ROOT
): { exitCode: number; stdout: string; stderr: string } {
  // Strip Vitest env vars so the entry guard (shouldRunMain) activates in the
  // child process. The guard skips main() when VITEST or VITEST_WORKER_ID are
  // set — the child inherits those from the test runner without this strip.
  const env = { ...process.env };
  delete env['VITEST'];
  delete env['VITEST_WORKER_ID'];
  delete env['NODE_ENV'];

  const result = spawnSync(process.execPath, [BINARY, 'describe', ...args], {
    cwd,
    encoding: 'utf-8',
    env,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('rill-describe CLI', () => {
  describe('builtins subcommand', () => {
    it('exits 0 and outputs JSON with mode, callables, and typeMethods keys', () => {
      const result = runDescribe(['builtins']);

      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output).toHaveProperty('mode', 'builtins');
      expect(output).toHaveProperty('callables');
      expect(output).toHaveProperty('typeMethods');
    });

    it('populates callables with identity, json, range, and fold', () => {
      const result = runDescribe(['builtins']);

      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout) as {
        callables: Record<string, unknown>;
      };
      expect(output.callables).toHaveProperty('identity');
      expect(output.callables).toHaveProperty('json');
      expect(output.callables).toHaveProperty('range');
      expect(output.callables).toHaveProperty('fold');
    });

    it('populates typeMethods with all 8 type namespaces', () => {
      const result = runDescribe(['builtins']);

      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout) as {
        typeMethods: Record<string, unknown>;
      };
      const namespaces = Object.keys(output.typeMethods).sort();
      expect(namespaces).toContain('string');
      expect(namespaces).toContain('number');
      expect(namespaces).toContain('bool');
      expect(namespaces).toContain('vector');
      expect(namespaces).toContain('datetime');
      expect(namespaces).toContain('duration');
      expect(namespaces).toContain('list');
      expect(namespaces).toContain('dict');
    });
  });

  describe('project subcommand', () => {
    it('emits mounts.dt.date with expected param and returnType shape', () => {
      const result = runDescribe(['project', '--config', DT_CONFIG]);

      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout) as {
        mounts: {
          dt: {
            date: {
              params: Array<{ name: string; type: { kind: string } }>;
              returnType: { kind: string };
            };
          };
        };
      };

      const dateCallable = output.mounts.dt.date;
      expect(dateCallable).toBeDefined();
      expect(dateCallable.returnType).toEqual({ kind: 'string' });
      expect(dateCallable.params[0]).toMatchObject({
        name: 'dt',
        type: { kind: 'datetime' },
      });
      expect(dateCallable.params[1]).toMatchObject({
        name: 'zone',
        type: { kind: 'string' },
      });
    });

    it('defaults to project subcommand when no subcommand is given', () => {
      const result = runDescribe(['--config', DT_CONFIG]);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output).toHaveProperty('mounts');
    });

    it('filters output to only the named mount when --mount matches', () => {
      const result = runDescribe([
        'project',
        '--config',
        DT_CONFIG,
        '--mount',
        'dt',
      ]);

      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout) as {
        mounts: Record<string, unknown>;
      };
      const mountKeys = Object.keys(output.mounts);
      expect(mountKeys).toEqual(['dt']);
    });

    it('exits 1 with mount-not-found error when --mount value does not match', () => {
      const result = runDescribe([
        'project',
        '--config',
        DT_CONFIG,
        '--mount',
        'noexist',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('mount "noexist" not found');
    });

    it('exits 1 with ConfigError message when no rill-config.json exists', () => {
      const result = runDescribe([
        'project',
        '--config',
        '/nonexistent/path/rill-config.json',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('handler subcommand', () => {
    it('emits handler envelope with name, file, params, and annotations', () => {
      const result = runDescribe(['handler', '--config', HANDLER_CONFIG]);

      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout) as {
        handler: {
          name: string;
          file: string;
          params: Array<{
            name: string;
            typeDisplay: string;
            defaultValue: unknown;
          }>;
          annotations: Record<string, unknown>;
        };
      };

      expect(output.handler.name).toBe('greet');
      expect(output.handler.file).toBe('main.rill');
      expect(output.handler.params).toHaveLength(2);
      expect(output.handler.params[0]).toMatchObject({
        name: 'name',
        typeDisplay: 'string',
      });
      expect(output.handler.params[1]).toMatchObject({
        name: 'count',
        typeDisplay: 'number',
      });
      expect(output.handler.annotations).toMatchObject({
        description: 'Greet a user by name',
      });
    });

    it('exits 1 when main field is not a handler reference', () => {
      const result = runDescribe(['handler', '--config', DT_CONFIG]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not a handler reference');
    });

    it('exits 1 with ConfigError when no rill-config.json exists', () => {
      const result = runDescribe([
        'handler',
        '--config',
        '/nonexistent/path/rill-config.json',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('argument parsing errors', () => {
    it('exits 1 with unknown subcommand message when first arg is not a known subcommand', () => {
      const result = runDescribe(['nope']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unknown subcommand "nope"');
    });

    it('exits 1 when project subcommand sees an unknown flag', () => {
      const result = runDescribe(['project', '--unknown-flag']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--unknown-flag');
    });

    it('exits 1 when builtins subcommand sees a project-only flag', () => {
      const result = runDescribe(['builtins', '--mount', 'dt']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--mount');
    });

    it('exits 1 when handler subcommand sees a project-only flag', () => {
      const result = runDescribe(['handler', '--mount', 'dt']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--mount');
    });

    it('exits 1 with requires-a-value message when --config has no value', () => {
      const result = runDescribe(['project', '--config']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--config requires a value');
    });

    it('exits 1 with requires-a-value message when --mount has no value', () => {
      const result = runDescribe(['project', '--mount']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--mount requires a value');
    });
  });

  describe('strict mode', () => {
    it('builtins --strict exits 1 because some builtins have returnType: any', () => {
      const result = runDescribe(['builtins', '--strict']);

      // Several built-in callables (identity, range, fold, etc.) use
      // returnType: any, so strict mode correctly exits 1.
      expect(result.exitCode).toBe(1);
    });

    it('project --strict against the datetime project exits 0 because all datetime callables are typed', () => {
      const result = runDescribe([
        'project',
        '--config',
        DT_CONFIG,
        '--strict',
      ]);

      expect(result.exitCode).toBe(0);
    });

    it('handler --strict exits 1 because script closures report returnType: any', () => {
      const result = runDescribe([
        'handler',
        '--config',
        HANDLER_CONFIG,
        '--strict',
      ]);

      // Script closures always have returnType 'any' per rill semantics, so
      // --strict reports the handler path and exits 1.
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('handler.greet');
    });
  });
});
