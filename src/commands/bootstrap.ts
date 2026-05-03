/**
 * rill bootstrap: Initialize a rill project.
 * Creates .rill/npm/, rill-config.json, gitignores, and tsconfig.rill.json.
 *
 * Constraints (FR-EXT-1, NFR-EXT-1):
 * - No-op when both .rill/npm/ and rill-config.json exist (without --force).
 * - --force overwrites rill-config.json only; preserves .rill/npm/ contents.
 * - --reset wipes .rill/npm/ entirely and rewrites all scaffolded files.
 * - File I/O completes in < 2s.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

// ============================================================
// HELP TEXT
// ============================================================

const USAGE = `\
Usage: rill bootstrap [--force | --reset]

Initialize a rill project in the current directory.

Creates:
  .rill/                    Internal build artifacts directory
  .rill/npm/                Private npm workspace for extensions
  .rill/tsconfig.rill.json  Path mapping for tsc + IDE
  rill-config.json          Project configuration file

Options:
  --force     Overwrite rill-config.json. .rill/npm/ contents are preserved.
  --reset     Wipe .rill/npm/ entirely and rewrite all scaffolded files.
              Deletes installed extensions; you must re-run 'rill install' for each.
  --help      Show this help message
`;

// ============================================================
// IMPLEMENTATION
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

/**
 * Initialize a rill project: create .rill/npm/, rill-config.json, gitignores,
 * tsconfig.rill.json.
 *
 * Constraints:
 * - File I/O completes in < 2s (NFR-EXT-1).
 * - No-op when both .rill/npm/ and rill-config.json exist (FR-EXT-1).
 * - --force rewrites rill-config.json; preserves .rill/npm/.
 * - --reset wipes .rill/npm/ and rewrites all scaffolded files.
 * - rill-config.json: name=basename(cwd), main="main.rill", extensions.mounts={}.
 * - Adds .rill/ to project-root .gitignore idempotently.
 */
export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      force: { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: false,
  });

  if (values['help'] === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const force = values['force'] === true;
  const reset = values['reset'] === true;

  if (force && reset) {
    process.stderr.write(
      'error: --force and --reset are mutually exclusive. ' +
        'Use --force to overwrite rill-config.json only, ' +
        'or --reset to wipe .rill/npm/ and rewrite all files.\n'
    );
    return 1;
  }

  const cwd = process.cwd();

  // Step 1: mkdir .rill/ (recursive, idempotent)
  const rillDir = path.join(cwd, '.rill');
  fs.mkdirSync(rillDir, { recursive: true });

  // Step 2: write .rill/.gitignore — ignore all build artifacts, keep gitignore itself
  const rillGitignore = path.join(rillDir, '.gitignore');
  const rillGitignoreContent = '# rill build artifacts\n*\n!.gitignore\n';
  if (reset || !fs.existsSync(rillGitignore)) {
    fs.writeFileSync(rillGitignore, rillGitignoreContent, 'utf8');
  }

  // Step 3: --reset wipes .rill/npm/ entirely so npm state matches a fresh init.
  const npmDir = path.join(rillDir, 'npm');
  if (reset && fs.existsSync(npmDir)) {
    try {
      fs.rmSync(npmDir, { recursive: true, force: true });
      process.stdout.write('✓ Reset .rill/npm/\n');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Cannot remove .rill/npm/: ${message}\n`);
      return 1;
    }
  }

  // Step 4: mkdir .rill/npm/ (recursive) — EC-4: EACCES -> exit 1
  try {
    fs.mkdirSync(npmDir, { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Cannot create .rill/npm/: ${message}\n`);
    return 1;
  }

  // Step 5: write .rill/npm/package.json (only when missing or --reset)
  const npmPkgJson = path.join(npmDir, 'package.json');
  const npmPkgContent = '{"name":"rill-extensions","private":true}\n';
  if (reset || !fs.existsSync(npmPkgJson)) {
    fs.writeFileSync(npmPkgJson, npmPkgContent, 'utf8');
    process.stdout.write('✓ Created .rill/npm/package.json\n');
  }

  // Step 6: write .rill/npm/.gitignore (only when missing or --reset)
  const npmGitignore = path.join(npmDir, '.gitignore');
  const npmGitignoreContent = 'node_modules/\npackage-lock.json\n';
  if (reset || !fs.existsSync(npmGitignore)) {
    fs.writeFileSync(npmGitignore, npmGitignoreContent, 'utf8');
  }

  // Step 7: write .rill/tsconfig.rill.json — path mapping that lets `tsc` and
  // editors resolve extension type imports out of .rill/npm/node_modules/.
  // Always (re)written under --reset; otherwise only when missing.
  const tsconfigRill = path.join(rillDir, 'tsconfig.rill.json');
  if (reset || !fs.existsSync(tsconfigRill)) {
    fs.writeFileSync(tsconfigRill, TSCONFIG_RILL_CONTENT, 'utf8');
  }

  // Step 8: write rill-config.json — EC-5: EACCES -> exit 1
  // --force or --reset trigger overwrite.
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
    if (force || reset || !fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, configContent, 'utf8');
      process.stdout.write('✓ Created rill-config.json\n');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Cannot write rill-config.json: ${message}\n`);
    return 1;
  }

  // Step 9: append .rill/ to project-root .gitignore idempotently
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

  // Step 10: hint user to wire tsconfig.rill.json into their tsconfig.json so
  // `tsc --noEmit` and editors can resolve extension types out of .rill/npm/.
  const userTsconfig = path.join(cwd, 'tsconfig.json');
  if (fs.existsSync(userTsconfig)) {
    let userTsconfigText = '';
    try {
      userTsconfigText = fs.readFileSync(userTsconfig, 'utf8');
    } catch {
      // Unreadable — skip the hint.
    }
    if (
      userTsconfigText !== '' &&
      !userTsconfigText.includes('.rill/tsconfig.rill.json')
    ) {
      process.stdout.write(
        'ℹ tsconfig.json detected. To resolve extension types, add:\n' +
          '    "extends": "./.rill/tsconfig.rill.json"\n'
      );
    }
  }

  process.stdout.write(
    'Ready to install extensions. Try: rill install @rcrsr/rill-ext-datetime\n'
  );

  return 0;
}
