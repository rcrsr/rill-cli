/**
 * Shared helper for spawning the built CLI (`dist/cli.js`) as a child
 * process from a test.
 *
 * The CLI's entry guard (`shouldRunMain`) skips `main()` when `VITEST` or
 * `VITEST_WORKER_ID` are set, so a spawned child inheriting the test
 * runner's environment would otherwise exit without running the command.
 * `spawnCli` strips those (and `NODE_ENV`) before spawning.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const CLI_PATH = path.resolve(process.cwd(), 'dist', 'cli.js');

export interface SpawnCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Returns a copy of `process.env` with the Vitest-specific variables
 * stripped, suitable for passing as `env` to a spawned CLI child process.
 */
function strippedSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['VITEST'];
  delete env['VITEST_WORKER_ID'];
  delete env['NODE_ENV'];
  return env;
}

/**
 * Spawns the built CLI (`dist/cli.js`) with `args`, synchronously, and
 * returns its captured stdout/stderr/exit code.
 */
export function spawnCli(
  args: string[],
  options?: { cwd?: string }
): SpawnCliResult {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
    encoding: 'utf-8',
    env: strippedSpawnEnv(),
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
