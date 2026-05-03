/**
 * rill bootstrap: Initialize a rill project.
 * Creates .rill/npm/, rill-config.json, and gitignores.
 *
 * Constraints (FR-EXT-1, NFR-EXT-1):
 * - No-op when both .rill/npm/ and rill-config.json exist (without --force).
 * - --force overwrites scaffolded files.
 * - File I/O completes in < 2s.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CLI_VERSION } from '../cli-shared.js';

// ============================================================
// HELP TEXT
// ============================================================

const USAGE = `\
Usage: rill bootstrap [--force]

Initialize a rill project in the current directory.

Creates:
  .rill/              Internal build artifacts directory
  .rill/npm/          Private npm workspace for extensions
  rill-config.json    Project configuration file

Options:
  --force     Overwrite existing scaffolded files
  --help      Show this help message
  --version   Print version
`;

// ============================================================
// IMPLEMENTATION
// ============================================================

/**
 * Initialize a rill project: create .rill/npm/, rill-config.json, gitignores.
 *
 * Constraints:
 * - File I/O completes in < 2s (NFR-EXT-1).
 * - No-op when both .rill/npm/ and rill-config.json exist (FR-EXT-1).
 * - --force overwrites scaffolded files (FR-EXT-1).
 * - rill-config.json: name=basename(cwd), main="main.rill", extensions.mounts={}.
 * - Adds .rill/ to project-root .gitignore idempotently.
 */
export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
    },
    strict: false,
  });

  if (values['help'] === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (values['version'] === true) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  const force = values['force'] === true;
  const cwd = process.cwd();

  // Step 1: mkdir .rill/ (recursive, idempotent)
  const rillDir = path.join(cwd, '.rill');
  fs.mkdirSync(rillDir, { recursive: true });

  // Step 2: write .rill/.gitignore — ignore all build artifacts, keep gitignore itself
  const rillGitignore = path.join(rillDir, '.gitignore');
  const rillGitignoreContent = '# rill build artifacts\n*\n!.gitignore\n';
  if (force || !fs.existsSync(rillGitignore)) {
    fs.writeFileSync(rillGitignore, rillGitignoreContent, 'utf8');
  }

  // Step 3: mkdir .rill/npm/ (recursive) — EC-4: EACCES -> exit 1
  const npmDir = path.join(rillDir, 'npm');
  try {
    fs.mkdirSync(npmDir, { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Cannot create .rill/npm/: ${message}\n`);
    return 1;
  }

  // Step 4: write .rill/npm/package.json
  const npmPkgJson = path.join(npmDir, 'package.json');
  const npmPkgContent = '{"name":"rill-extensions","private":true}\n';
  if (force || !fs.existsSync(npmPkgJson)) {
    fs.writeFileSync(npmPkgJson, npmPkgContent, 'utf8');
    process.stdout.write('✓ Created .rill/npm/package.json\n');
  }

  // Step 5: write .rill/npm/.gitignore
  const npmGitignore = path.join(npmDir, '.gitignore');
  const npmGitignoreContent = 'node_modules/\npackage-lock.json\n';
  if (force || !fs.existsSync(npmGitignore)) {
    fs.writeFileSync(npmGitignore, npmGitignoreContent, 'utf8');
  }

  // Step 6: write rill-config.json — EC-5: EACCES -> exit 1
  const configPath = path.join(cwd, 'rill-config.json');
  const projectName = path.basename(cwd);
  const configContent =
    JSON.stringify(
      {
        name: projectName,
        main: 'main.rill',
        extensions: { mounts: {} },
      },
      null,
      2
    ) + '\n';

  try {
    if (force || !fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, configContent, 'utf8');
      process.stdout.write('✓ Created rill-config.json\n');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Cannot write rill-config.json: ${message}\n`);
    return 1;
  }

  // Step 7: append .rill/ to project-root .gitignore idempotently
  const projectGitignore = path.join(cwd, '.gitignore');
  const rillEntry = '.rill/';
  let gitignoreLines: string[] = [];
  if (fs.existsSync(projectGitignore)) {
    const existing = fs.readFileSync(projectGitignore, 'utf8');
    gitignoreLines = existing.split('\n');
  }
  const alreadyPresent = gitignoreLines.some((line) => line === rillEntry);
  if (!alreadyPresent) {
    // Append with a leading newline if the file is non-empty and doesn't end with one
    const prefix =
      gitignoreLines.length > 0 &&
      gitignoreLines[gitignoreLines.length - 1] !== ''
        ? '\n'
        : '';
    fs.appendFileSync(projectGitignore, `${prefix}${rillEntry}\n`, 'utf8');
  }

  process.stdout.write(
    'Ready to install extensions. Try: rill install @rcrsr/rill-ext-datetime\n'
  );

  return 0;
}
