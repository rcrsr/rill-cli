/**
 * rill init bundle: Initialize a new rill bundle at the current directory.
 * Creates rill-bundle.json, .rill/npm/, and packages/ at cwd.
 */

import fs from 'node:fs';
import path from 'node:path';
import { scaffoldPackageDir, scaffoldRillNpmPrefix } from './package-init.js';
import { atomicWriteFile } from '../fs-atomic.js';

// ============================================================
// CONSTANTS
// ============================================================

// Mount/directory name for the starter package scaffolded alongside the
// bundle. A bundle without at least one package entry fails readBundleConfig
// (packages must contain at least one entry), so init must scaffold one.
const STARTER_PACKAGE_MOUNT = 'main';

// ============================================================
// IMPLEMENTATION
// ============================================================

/**
 * Initialize a rill bundle at cwd.
 *
 * Accepts an optional positional name argument. When omitted, the name
 * defaults to the basename of cwd. Fails with exit 1 if rill-bundle.json
 * already exists at cwd.
 */
export async function run(argv: string[]): Promise<number> {
  const cwd = process.cwd();

  // Resolve bundle name from first positional arg or cwd basename
  const name = argv[0] ?? path.basename(cwd);

  // Reject a supplied name that could escape the bundle directory. The
  // basename fallback is always a single path segment, so it needs no check.
  if (
    argv[0] !== undefined &&
    (name.includes('/') || name.includes('\\') || name.includes('..'))
  ) {
    process.stderr.write(`invalid bundle name: '${name}'\n`);
    return 1;
  }

  const bundleConfigPath = path.join(cwd, 'rill-bundle.json');

  // Guard: fail if rill-bundle.json already exists
  if (fs.existsSync(bundleConfigPath)) {
    process.stderr.write(`rill-bundle.json already exists in ${cwd}\n`);
    return 1;
  }

  // Ensure .rill/npm/ exists, with its package.json and .gitignore.
  // install/list's assertBootstrapped and harness resolution both anchor
  // createRequire on the package.json this scaffolds.
  const rillDir = path.join(cwd, '.rill');
  try {
    scaffoldRillNpmPrefix(rillDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Cannot create .rill/npm/: ${message}\n`);
    return 1;
  }

  // Ensure packages/ exists
  const packagesDir = path.join(cwd, 'packages');
  try {
    fs.mkdirSync(packagesDir, { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Cannot create packages/: ${message}\n`);
    return 1;
  }

  // Scaffold a starter package so the freshly-initialized bundle satisfies
  // readBundleConfig's requirement of at least one packages[] entry, and is
  // immediately usable with bundle-run/build.
  const starterPackageDir = path.join(packagesDir, STARTER_PACKAGE_MOUNT);
  await scaffoldPackageDir(starterPackageDir, STARTER_PACKAGE_MOUNT);

  // Write rill-bundle.json — durable bundle config, written atomically so a
  // failed write never truncates a pre-existing file in place.
  const bundleConfig = {
    name,
    version: '0.0.0',
    packages: [
      {
        mount: STARTER_PACKAGE_MOUNT,
        project: `./packages/${STARTER_PACKAGE_MOUNT}`,
      },
    ],
  };
  const bundleConfigContent = JSON.stringify(bundleConfig, null, 2) + '\n';
  try {
    await atomicWriteFile(bundleConfigPath, bundleConfigContent, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Cannot write rill-bundle.json: ${message}\n`);
    return 1;
  }

  process.stdout.write(`created bundle ${name} in ${cwd}\n`);
  return 0;
}
