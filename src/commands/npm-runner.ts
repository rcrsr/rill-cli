import { spawn } from 'node:child_process';

/**
 * Result returned by npmInstall and npmUninstall.
 * The exit code from the npm subprocess; caller decides exit semantics.
 */
export interface NpmResult {
  readonly exitCode: number;
}

/**
 * Thrown when the npm binary is not found on PATH (ENOENT on spawn).
 * Callers map this to EC-31: print "npm not found on PATH; install Node.js with npm" and exit 1.
 */
export class NpmNotFoundError extends Error {
  constructor() {
    super('npm not found on PATH; install Node.js with npm');
    this.name = 'NpmNotFoundError';
  }
}

/**
 * Spawn an npm subprocess with --prefix <prefix> and inherited stdio.
 *
 * Constraints:
 * - Uses child_process.spawn (NOT spawnSync) for non-blocking output streaming.
 * - stdio: 'inherit' for stdout/stderr (UXS-EXT-6 progress passthrough).
 * - No CLI-imposed timeout (UXS-EXT-6).
 * - Returns the npm exit code; caller decides exit semantics (EC-32).
 * - npm command resolved from PATH; on ENOENT, throws NpmNotFoundError (EC-31).
 * - All arguments passed as separate argv elements; no shell concatenation (security).
 */
function runNpm(
  subcommand: string,
  spec: string,
  prefix: string
): Promise<NpmResult> {
  return new Promise<NpmResult>((resolve, reject) => {
    const child = spawn('npm', [subcommand, spec, '--prefix', prefix], {
      stdio: 'inherit',
      shell: false,
    });

    child.on('error', (err: Error & { code?: string }) => {
      if (err.code === 'ENOENT') {
        reject(new NpmNotFoundError());
      } else {
        reject(err);
      }
    });

    child.on('close', (code: number | null) => {
      resolve({ exitCode: code ?? 1 });
    });
  });
}

/**
 * Run `npm install <spec> --prefix <prefix>`.
 *
 * Resolves with NpmResult containing the exit code.
 * Rejects with NpmNotFoundError when npm is absent from PATH.
 */
export function npmInstall(args: {
  spec: string;
  prefix: string;
}): Promise<NpmResult> {
  return runNpm('install', args.spec, args.prefix);
}

/**
 * Run `npm uninstall <spec> --prefix <prefix>`.
 *
 * Resolves with NpmResult containing the exit code.
 * Rejects with NpmNotFoundError when npm is absent from PATH.
 */
export function npmUninstall(args: {
  spec: string;
  prefix: string;
}): Promise<NpmResult> {
  return runNpm('uninstall', args.spec, args.prefix);
}
