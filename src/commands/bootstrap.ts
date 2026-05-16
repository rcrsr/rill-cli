/**
 * rill bootstrap: Deprecated — use `rill init` instead.
 * This module preserves scaffoldSinglePackage for use by src/commands/init.ts.
 */

import fs from 'node:fs';
import path from 'node:path';

// ============================================================
// SHARED SCAFFOLD LOGIC
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
 * Scaffold a single-package rill project at cwd.
 *
 * Creates .rill/npm/, rill-config.json, gitignores, and tsconfig.rill.json.
 * When force is true, overwrites rill-config.json while preserving .rill/npm/.
 * When reset is true, wipes .rill/npm/ entirely and rewrites all scaffolded files.
 *
 * Returns 0 on success, 1 on error (writes error message to stderr).
 */
export async function scaffoldSinglePackage(
  cwd: string,
  force: boolean,
  reset: boolean
): Promise<number> {
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

  // Step 4: mkdir .rill/npm/ (recursive)
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

  // Step 7: write .rill/tsconfig.rill.json — path mapping for tsc and editors.
  // Always (re)written under --reset; otherwise only when missing.
  const tsconfigRill = path.join(rillDir, 'tsconfig.rill.json');
  if (reset || !fs.existsSync(tsconfigRill)) {
    fs.writeFileSync(tsconfigRill, TSCONFIG_RILL_CONTENT, 'utf8');
  }

  // Step 8: write rill-config.json; --force or --reset trigger overwrite.
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

  // Step 10: hint user to wire tsconfig.rill.json into their tsconfig.json
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

// ============================================================
// PUBLIC COMMAND
// ============================================================

/**
 * Deprecated. Prints a deprecation message and exits with code 1.
 * Use `rill init` instead.
 */
export async function run(_argv: string[]): Promise<number> {
  process.stderr.write(
    'rill bootstrap has been renamed to rill init. Use `rill init` to create a single package, or `rill init bundle` to create a bundle.\n'
  );
  return 1;
}
