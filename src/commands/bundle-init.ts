/**
 * rill init bundle: Initialize a new rill bundle at the current directory.
 * Creates rill-bundle.json, .rill/npm/, and packages/ at cwd.
 */

import fs from 'node:fs';
import path from 'node:path';
import { scaffoldPackageDir } from './package-init.js';

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

  const bundleConfigPath = path.join(cwd, 'rill-bundle.json');

  // Guard: fail if rill-bundle.json already exists
  if (fs.existsSync(bundleConfigPath)) {
    process.stderr.write(`rill-bundle.json already exists in ${cwd}\n`);
    return 1;
  }

  // Ensure .rill/npm/ exists
  const rillNpmDir = path.join(cwd, '.rill', 'npm');
  try {
    fs.mkdirSync(rillNpmDir, { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Cannot create .rill/npm/: ${message}\n`);
    return 1;
  }

  // Write .rill/npm/package.json — install/list assertBootstrapped and
  // harness resolution both anchor createRequire on this file.
  const rillNpmPkgJsonPath = path.join(rillNpmDir, 'package.json');
  if (!fs.existsSync(rillNpmPkgJsonPath)) {
    fs.writeFileSync(
      rillNpmPkgJsonPath,
      '{"name":"rill-extensions","private":true}\n',
      'utf8'
    );
  }

  // Write .rill/npm/.gitignore if not already present
  const rillNpmGitignorePath = path.join(rillNpmDir, '.gitignore');
  if (!fs.existsSync(rillNpmGitignorePath)) {
    fs.writeFileSync(
      rillNpmGitignorePath,
      'node_modules/\npackage-lock.json\n',
      'utf8'
    );
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
  scaffoldPackageDir(starterPackageDir, STARTER_PACKAGE_MOUNT);

  // Write rill-bundle.json
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
    fs.writeFileSync(bundleConfigPath, bundleConfigContent, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Cannot write rill-bundle.json: ${message}\n`);
    return 1;
  }

  process.stdout.write(`created bundle ${name} in ${cwd}\n`);
  return 0;
}
