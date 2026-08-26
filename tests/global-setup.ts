/**
 * Vitest global setup: builds dist/ once, before any test worker starts.
 *
 * Several test files spawn the compiled CLI from dist/. Building inside a
 * per-file beforeAll races other workers writing to the same dist/ output;
 * running the build here, in the main process before workers are created,
 * makes it a single, ordered step instead.
 */
import { execSync } from 'node:child_process';

export default function setup(): void {
  execSync('pnpm run build', { stdio: 'inherit' });
}
