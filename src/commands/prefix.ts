import path from 'node:path';
import fs from 'node:fs';

/**
 * Resolve the .rill/npm/ prefix path for a project directory.
 * Returns an absolute path. Does not check existence.
 */
export function resolvePrefix(projectDir: string): string {
  return path.resolve(projectDir, '.rill', 'npm');
}

/**
 * Throws BootstrapMissingError when .rill/npm/package.json is absent.
 * Used by install/uninstall/upgrade/list as a UXS-EXT-2 gate.
 */
export function assertBootstrapped(projectDir: string): void {
  const prefix = resolvePrefix(projectDir);
  const packageJson = path.join(prefix, 'package.json');
  if (!fs.existsSync(packageJson)) {
    throw new BootstrapMissingError(prefix);
  }
}

/**
 * Thrown when .rill/npm/package.json is absent.
 * Callers map this to UXT-EXT-5 and exit code 1.
 */
export class BootstrapMissingError extends Error {
  readonly prefix: string;

  constructor(prefix: string) {
    super(
      `Bootstrap prefix not initialised: ${path.join(prefix, 'package.json')} not found`
    );
    this.name = 'BootstrapMissingError';
    this.prefix = prefix;
  }
}
