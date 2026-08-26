/**
 * Vitest global setup: builds dist/ once, before any test worker starts.
 *
 * Several test files spawn the compiled CLI from dist/. Building inside a
 * per-file beforeAll races other workers writing to the same dist/ output;
 * running the build here, in the main process before workers are created,
 * makes it a single, ordered step instead.
 *
 * `pnpm check` already runs the build once before invoking the test suite, so
 * rebuilding here would duplicate that work. Skip the rebuild when the build
 * is already fresh relative to `src/`.
 *
 * `tsc --build` is per-file incremental, so a single output file's mtime
 * (e.g. `dist/cli.js`) does not reflect the freshness of the whole build: a
 * source file that isn't reachable from that one entry point can change
 * without ever touching it. `tsconfig.tsbuildinfo` is written on every
 * incremental `tsc --build` invocation regardless of which files changed, so
 * its mtime is a build-wide freshness signal. Fall back to the newest mtime
 * across `dist/**\/*.js` if the buildinfo file is missing.
 */
import { execSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TSBUILDINFO = path.join(REPO_ROOT, 'tsconfig.tsbuildinfo');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const SRC_DIR = path.join(REPO_ROOT, 'src');

function newestMtimeMs(
  dir: string,
  filter?: (name: string) => boolean
): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    const mtimeMs = entry.isDirectory()
      ? newestMtimeMs(entryPath, filter)
      : !filter || filter(entry.name)
        ? statSync(entryPath).mtimeMs
        : 0;
    if (mtimeMs > newest) newest = mtimeMs;
  }
  return newest;
}

function buildOutputMtimeMs(): number | undefined {
  if (existsSync(TSBUILDINFO)) {
    return statSync(TSBUILDINFO).mtimeMs;
  }
  if (existsSync(DIST_DIR)) {
    return newestMtimeMs(DIST_DIR, (name) => name.endsWith('.js'));
  }
  return undefined;
}

function isBuildFresh(): boolean {
  const outputMtimeMs = buildOutputMtimeMs();
  if (outputMtimeMs === undefined) return false;
  return outputMtimeMs > newestMtimeMs(SRC_DIR);
}

export default function setup(): void {
  if (isBuildFresh()) return;
  execSync('pnpm run build', { stdio: 'inherit' });
}
