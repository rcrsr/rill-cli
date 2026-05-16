/**
 * rill init package: Initialize a new rill package.
 * When inside a bundle, scaffolds at <bundleRoot>/packages/<name>/ and appends
 * the package entry to rill-bundle.json. Otherwise scaffolds at <cwd>/<name>/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { findBundleRoot } from '../bundle/config.js';

// ============================================================
// CONSTANTS
// ============================================================

const TSCONFIG_RILL_CONTENT =
  JSON.stringify(
    {
      compilerOptions: {
        baseUrl: './npm',
        paths: { '*': ['node_modules/*'] },
      },
    },
    null,
    2
  ) + '\n';

// ============================================================
// INTERNAL HELPERS
// ============================================================

/**
 * Scaffold the standard single-package layout inside targetDir.
 * Mirrors the structure that `rill bootstrap` creates, with the addition
 * of a src/index.ts placeholder.
 */
function scaffoldPackageDir(targetDir: string, packageName: string): void {
  // .rill/
  const rillDir = path.join(targetDir, '.rill');
  fs.mkdirSync(rillDir, { recursive: true });

  // .rill/.gitignore
  const rillGitignore = path.join(rillDir, '.gitignore');
  if (!fs.existsSync(rillGitignore)) {
    fs.writeFileSync(
      rillGitignore,
      '# rill build artifacts\n*\n!.gitignore\n',
      'utf8'
    );
  }

  // .rill/npm/
  const npmDir = path.join(rillDir, 'npm');
  fs.mkdirSync(npmDir, { recursive: true });

  // .rill/npm/package.json
  const npmPkgJson = path.join(npmDir, 'package.json');
  if (!fs.existsSync(npmPkgJson)) {
    fs.writeFileSync(
      npmPkgJson,
      '{"name":"rill-extensions","private":true}\n',
      'utf8'
    );
  }

  // .rill/npm/.gitignore
  const npmGitignore = path.join(npmDir, '.gitignore');
  if (!fs.existsSync(npmGitignore)) {
    fs.writeFileSync(
      npmGitignore,
      'node_modules/\npackage-lock.json\n',
      'utf8'
    );
  }

  // .rill/tsconfig.rill.json
  const tsconfigRill = path.join(rillDir, 'tsconfig.rill.json');
  if (!fs.existsSync(tsconfigRill)) {
    fs.writeFileSync(tsconfigRill, TSCONFIG_RILL_CONTENT, 'utf8');
  }

  // rill-config.json
  const configPath = path.join(targetDir, 'rill-config.json');
  if (!fs.existsSync(configPath)) {
    const configContent =
      JSON.stringify(
        {
          name: packageName,
          main: 'main.rill',
          extensions: { mounts: {} },
        },
        null,
        2
      ) + '\n';
    fs.writeFileSync(configPath, configContent, 'utf8');
  }

  // .gitignore — append .rill/ idempotently
  const gitignorePath = path.join(targetDir, '.gitignore');
  const rillEntry = '.rill/';
  let gitignoreLines: string[] = [];
  if (fs.existsSync(gitignorePath)) {
    gitignoreLines = fs.readFileSync(gitignorePath, 'utf8').split('\n');
  }
  if (!gitignoreLines.some((line) => line === rillEntry)) {
    const prefix =
      gitignoreLines.length > 0 &&
      gitignoreLines[gitignoreLines.length - 1] !== ''
        ? '\n'
        : '';
    fs.appendFileSync(gitignorePath, `${prefix}${rillEntry}\n`, 'utf8');
  }

  // src/index.ts placeholder
  const srcDir = path.join(targetDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const indexTs = path.join(srcDir, 'index.ts');
  if (!fs.existsSync(indexTs)) {
    fs.writeFileSync(indexTs, '// Entry point\n', 'utf8');
  }
}

/**
 * Read, update, and write rill-bundle.json to append a new package entry.
 * Uses the raw JSON approach (like writeBundleHarness) to preserve formatting
 * and avoid the strict validation that readBundleConfig applies to packages[].
 */
async function appendPackageToBundle(
  bundleDir: string,
  name: string
): Promise<void> {
  const filePath = path.join(bundleDir, 'rill-bundle.json');

  const rawText = await readFile(filePath, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Failed to parse rill-bundle.json: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('rill-bundle.json must be a JSON object');
  }

  const obj = { ...(parsed as Record<string, unknown>) };

  const existing = Array.isArray(obj['packages'])
    ? (obj['packages'] as unknown[])
    : [];

  const updated = [...existing, { mount: name, project: `./packages/${name}` }];
  obj['packages'] = updated;

  const trailingNewline = rawText.endsWith('\n');
  const serialized =
    JSON.stringify(obj, null, 2) + (trailingNewline ? '\n' : '');

  await writeFile(filePath, serialized, 'utf8');
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Initialize a rill package.
 *
 * When cwd is inside a bundle, scaffolds inside the bundle's packages/
 * directory and appends the entry to rill-bundle.json. Otherwise scaffolds
 * a standalone package at <cwd>/<name>/.
 */
export async function run(argv: string[]): Promise<number> {
  const cwd = process.cwd();

  const name = argv[0];
  if (name === undefined || name.trim() === '') {
    process.stderr.write('usage: rill init package <name>\n');
    return 1;
  }

  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    process.stderr.write(`invalid package name: '${name}'\n`);
    return 1;
  }

  const bundleRoot = findBundleRoot(cwd);

  if (bundleRoot !== null) {
    // Bundle-aware path
    const targetDir = path.join(bundleRoot, 'packages', name);

    // Read existing bundle config raw to check for mount collision
    const bundleConfigPath = path.join(bundleRoot, 'rill-bundle.json');
    let rawText: string;
    try {
      rawText = await readFile(bundleConfigPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Cannot read rill-bundle.json: ${message}\n`);
      return 1;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Cannot parse rill-bundle.json: ${message}\n`);
      return 1;
    }

    const obj = parsed as Record<string, unknown>;
    const existingPackages = Array.isArray(obj['packages'])
      ? (obj['packages'] as Array<Record<string, unknown>>)
      : [];

    // Check for mount collision
    const collision = existingPackages.some(
      (p) => typeof p['mount'] === 'string' && p['mount'] === name
    );
    if (collision) {
      process.stderr.write(`packages[] already contains mount '${name}'\n`);
      return 1;
    }

    // Create target directory and scaffold
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Cannot create ${targetDir}: ${message}\n`);
      return 1;
    }

    scaffoldPackageDir(targetDir, name);

    // Append entry to bundle config
    try {
      await appendPackageToBundle(bundleRoot, name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Cannot update rill-bundle.json: ${message}\n`);
      return 1;
    }

    process.stdout.write(`created package ${name} in ${targetDir}\n`);
  } else {
    // Non-bundle path: standalone package at <cwd>/<name>/
    const targetDir = path.join(cwd, name);

    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Cannot create ${targetDir}: ${message}\n`);
      return 1;
    }

    scaffoldPackageDir(targetDir, name);

    process.stdout.write(`created package ${name} in ${targetDir}\n`);
  }

  return 0;
}
