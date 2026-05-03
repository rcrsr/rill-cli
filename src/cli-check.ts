/**
 * CLI Check Entry Point
 *
 * Implements argument parsing for rill-check.
 * Validates Rill source files against linting rules.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Diagnostic, Severity } from './check/index.js';
import {
  VALIDATION_RULES,
  loadConfig,
  createDefaultConfig,
  validateScript,
  applyFixes,
} from './check/index.js';
import { parseWithRecovery } from '@rcrsr/rill';
import { detectHelpVersionFlag } from './cli-shared.js';

/** Severity threshold for failing exit code. */
export type MinSeverity = Severity;

/** Numeric ranking used to compare diagnostic severity to a threshold. */
const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

/**
 * Parsed command-line arguments for rill-check
 */
export type ParsedCheckArgs =
  | {
      mode: 'check';
      file: string;
      fix: boolean;
      verbose: boolean;
      format: 'text' | 'json';
      minSeverity: MinSeverity;
    }
  | { mode: 'types' }
  | { mode: 'help' };

/**
 * Parse command-line arguments for rill-check
 *
 * @param argv - Raw command-line arguments (typically process.argv.slice(2))
 * @returns Parsed command object
 */
export function parseCheckArgs(argv: string[]): ParsedCheckArgs {
  // Check for --help flag in any position. --version is handled by the dispatcher.
  const helpVersionFlag = detectHelpVersionFlag(argv);
  if (helpVersionFlag !== null && helpVersionFlag.mode === 'help') {
    return { mode: 'help' };
  }

  // P0-1: --types runs `tsc --noEmit` against the user's tsconfig.json,
  // resolving extension types out of .rill/npm/ via tsconfig.rill.json.
  // --types is exclusive: reject positional args and incompatible flags.
  if (argv.includes('--types')) {
    const incompatibleFlags = [
      '--fix',
      '--verbose',
      '--format',
      '--min-severity',
    ];
    const hasIncompatible = incompatibleFlags.some((f) => argv.includes(f));
    const hasPositional = argv.some(
      (a) => a !== '--types' && !a.startsWith('-')
    );
    if (hasPositional || hasIncompatible) {
      throw new Error(
        '--types is exclusive: cannot be combined with file arguments or ' +
          '--fix, --verbose, --format, --min-severity'
      );
    }
    return { mode: 'types' };
  }

  // Extract flags
  const fix = argv.includes('--fix');
  const verbose = argv.includes('--verbose');

  // Extract format flag
  let format: 'text' | 'json' = 'text';
  const formatIndex = argv.indexOf('--format');
  if (formatIndex !== -1) {
    const formatValue = argv[formatIndex + 1];
    if (formatValue === 'text' || formatValue === 'json') {
      format = formatValue;
    } else if (!formatValue || formatValue.startsWith('-')) {
      throw new Error('--format requires argument: text or json');
    } else {
      throw new Error(`Invalid format: ${formatValue}. Expected text or json`);
    }
  }

  // Extract --min-severity flag (default: error)
  let minSeverity: MinSeverity = 'error';
  const minSeverityIndex = argv.indexOf('--min-severity');
  if (minSeverityIndex !== -1) {
    const value = argv[minSeverityIndex + 1];
    if (!value || value.startsWith('-')) {
      throw new Error(
        '--min-severity requires argument: error, warning, or info'
      );
    }
    if (value !== 'error' && value !== 'warning' && value !== 'info') {
      throw new Error(
        `Invalid --min-severity: ${value}. Expected error, warning, or info`
      );
    }
    minSeverity = value;
  }

  // Check for unknown flags
  const knownFlags = new Set([
    '--help',
    '-h',
    '--fix',
    '--verbose',
    '--format',
    '--min-severity',
    '--types',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    // Skip non-flag arguments
    if (!arg.startsWith('-')) {
      continue;
    }

    // Skip value arguments for flags that take values
    if (i > 0) {
      const prev = argv[i - 1];
      if (prev === '--format' || prev === '--min-severity') {
        continue;
      }
    }

    // Check if unknown flag
    if (!knownFlags.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  // Extract file path (first non-flag argument)
  let file: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    // Skip flags
    if (arg.startsWith('-')) {
      // Skip flags that take values
      if (arg === '--format' || arg === '--min-severity') {
        i++; // Skip next argument (the value)
      }
      continue;
    }

    // First non-flag argument is the file
    file = arg;
    break;
  }

  if (!file) {
    throw new Error('Missing file argument');
  }

  return { mode: 'check', file, fix, verbose, format, minSeverity };
}

/**
 * Returns true when the diagnostic's severity meets or exceeds the threshold.
 * Severity ranks: info < warning < error.
 */
export function meetsSeverityThreshold(
  diagnostic: Diagnostic,
  min: MinSeverity
): boolean {
  return SEVERITY_RANK[diagnostic.severity] >= SEVERITY_RANK[min];
}

// ============================================================
// DIAGNOSTIC FORMATTING
// ============================================================

/**
 * Format diagnostics for output
 *
 * Adapts pattern from cli-shared.ts formatError function.
 * Text format: file:line:col: severity: message (code)
 * JSON format: complete schema with errors array and summary
 * Verbose mode: adds category field to diagnostics
 *
 * @param file - File path being checked
 * @param diagnostics - Array of diagnostics to format
 * @param format - Output format ('text' or 'json')
 * @param verbose - Whether to include category and doc references
 * @returns Formatted output string
 */
export function formatDiagnostics(
  file: string,
  diagnostics: Diagnostic[],
  format: 'text' | 'json',
  verbose: boolean
): string {
  if (format === 'json') {
    return formatDiagnosticsJSON(file, diagnostics, verbose);
  }
  return formatDiagnosticsText(file, diagnostics);
}

/**
 * Format diagnostics as text
 * Pattern: file:line:col: severity: message (code)
 */
function formatDiagnosticsText(
  file: string,
  diagnostics: Diagnostic[]
): string {
  return diagnostics
    .map((d) => {
      const { line, column } = d.location;
      return `${file}:${line}:${column}: ${d.severity}: ${d.message} (${d.code})`;
    })
    .join('\n');
}

/**
 * Format diagnostics as JSON
 * Includes file, errors array, and summary
 */
function formatDiagnosticsJSON(
  file: string,
  diagnostics: Diagnostic[],
  verbose: boolean
): string {
  // Build category lookup map from validation rules
  const categoryMap = new Map<string, string>();
  for (const rule of VALIDATION_RULES) {
    categoryMap.set(rule.code, rule.category);
  }

  // Format each diagnostic
  const errors = diagnostics.map((d) => {
    const error: Record<string, unknown> = {
      location: {
        line: d.location.line,
        column: d.location.column,
        offset: d.location.offset,
      },
      severity: d.severity,
      code: d.code,
      message: d.message,
      context: d.context,
    };

    // Add category if verbose mode
    if (verbose) {
      const category = categoryMap.get(d.code);
      if (category) {
        error['category'] = category;
      }
    }

    // Add fix if present
    if (d.fix) {
      error['fix'] = {
        description: d.fix.description,
        applicable: d.fix.applicable,
        range: {
          start: {
            line: d.fix.range.start.line,
            column: d.fix.range.start.column,
            offset: d.fix.range.start.offset,
          },
          end: {
            line: d.fix.range.end.line,
            column: d.fix.range.end.column,
            offset: d.fix.range.end.offset,
          },
        },
        replacement: d.fix.replacement,
      };
    }

    return error;
  });

  // Count diagnostics by severity
  const summary = {
    total: diagnostics.length,
    errors: diagnostics.filter((d) => d.severity === 'error').length,
    warnings: diagnostics.filter((d) => d.severity === 'warning').length,
    info: diagnostics.filter((d) => d.severity === 'info').length,
  };

  const output = {
    file,
    errors,
    summary,
  };

  return JSON.stringify(output, null, 2);
}

// ============================================================
// MIN-SEVERITY ONE-SHOT NOTICE (P1-3)
// ============================================================

/**
 * Print the 0.19.1 min-severity default-change notice once per project.
 *
 * Conditions:
 *  - User did not pass --min-severity (caller checks this).
 *  - No .rill-check.json in the project (project hasn't customized rules).
 *  - No marker file at .rill/.notices/min-severity-0.19.1.
 *
 * On first run that meets all three, write the marker and emit the notice.
 * Failures to read or write the marker are non-fatal; the notice may be
 * shown more than once on broken filesystems.
 */
function maybePrintMinSeverityNotice(): void {
  const cwd = process.cwd();

  if (fs.existsSync(path.join(cwd, '.rill-check.json'))) return;

  // Only persist the marker when .rill/ already exists (bootstrapped project).
  // For plain directories, print the notice every run rather than creating a
  // hidden .rill/ directory as a side effect of a read-only command.
  const rillDir = path.join(cwd, '.rill');
  const rillExists = fs.existsSync(rillDir);

  if (rillExists) {
    const noticesDir = path.join(rillDir, '.notices');
    const marker = path.join(noticesDir, 'min-severity-0.19.1');
    if (fs.existsSync(marker)) return;

    process.stderr.write(
      'notice: rill check defaults changed in 0.19.1 — info/warning diagnostics no longer fail. ' +
        'Pass --min-severity info to restore strict behavior.\n'
    );

    try {
      fs.mkdirSync(noticesDir, { recursive: true });
      fs.writeFileSync(marker, '', 'utf8');
    } catch {
      // Non-fatal: unwritable marker means we may emit the notice again on
      // the next run, which is acceptable.
    }
  } else {
    // Non-bootstrapped directory: just print the notice every run.
    process.stderr.write(
      'notice: rill check defaults changed in 0.19.1 — info/warning diagnostics no longer fail. ' +
        'Pass --min-severity info to restore strict behavior.\n'
    );
  }
}

// ============================================================
// TYPE CHECK (--types)
// ============================================================

/**
 * Run `tsc --noEmit` against the project's tsconfig.json.
 *
 * Resolves tsc in order: project node_modules/.bin/tsc, then
 * .rill/npm/node_modules/.bin/tsc. Fails with a clear hint when neither is
 * present — we don't bundle typescript with rill-cli to keep install size down.
 *
 * Relies on the user's tsconfig.json extending `./.rill/tsconfig.rill.json`
 * (written by `rill bootstrap`) so module resolution finds extension types
 * under .rill/npm/node_modules/.
 */
async function runTypeCheck(): Promise<number> {
  const cwd = process.cwd();
  const tsconfigPath = path.join(cwd, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) {
    process.stderr.write(
      `error: no tsconfig.json at ${tsconfigPath}\n` +
        '  Create one and add: "extends": "./.rill/tsconfig.rill.json"\n'
    );
    return 1;
  }

  // On Windows, npm/pnpm install <pkg>.cmd shims instead of POSIX binaries.
  // Build candidate list that checks both names on win32 and only the POSIX
  // name on other platforms.
  const binName = process.platform === 'win32' ? ['tsc.cmd', 'tsc'] : ['tsc'];
  const binDirs = [
    path.join(cwd, 'node_modules', '.bin'),
    path.join(cwd, '.rill', 'npm', 'node_modules', '.bin'),
  ];
  const candidates: string[] = [];
  for (const dir of binDirs) {
    for (const name of binName) {
      candidates.push(path.join(dir, name));
    }
  }
  const tsc = candidates.find((p) => fs.existsSync(p));
  if (tsc === undefined) {
    process.stderr.write(
      'error: tsc not found.\n' +
        '  Install TypeScript locally: npm install --save-dev typescript\n' +
        '  Or under .rill/npm: npm install --prefix .rill/npm typescript\n'
    );
    return 1;
  }

  return await new Promise<number>((resolveExit) => {
    const child = spawn(tsc, ['--noEmit', '-p', tsconfigPath], {
      cwd,
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolveExit(code ?? 1));
    child.on('error', (err) => {
      process.stderr.write(`error: failed to spawn tsc: ${err.message}\n`);
      resolveExit(1);
    });
  });
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

/**
 * Main entry point for rill-check CLI.
 * Orchestrates argument parsing, file reading, validation, fixing, and output.
 */
export async function main(argv: string[]): Promise<number> {
  try {
    // Parse command-line arguments
    const args = parseCheckArgs(argv);

    // Handle help mode
    if (args.mode === 'help') {
      console.log(`rill check - Validate Rill scripts

Usage:
  rill check [options] <file>     Lint a Rill script
  rill check --types              Run \`tsc --noEmit\` against tsconfig.json

Options:
  --fix                    Apply automatic fixes
  --format <fmt>           Output format: text (default) or json
  --verbose                Include category and documentation references
  --min-severity <level>   Severity threshold for non-zero exit:
                           error (default), warning, or info
  --types                  Run TypeScript type-check via local tsc.
                           Requires tsconfig.json to extend
                           ./.rill/tsconfig.rill.json (written by bootstrap).
  -h, --help               Show this help message

Exit codes:
  0   No diagnostics at or above --min-severity (default: error)
  1   Diagnostics at or above --min-severity, or CLI usage error
  2   File not found or path is a directory
  3   Parse error in source`);
      return 0;
    }

    if (args.mode === 'types') {
      return await runTypeCheck();
    }

    // At this point, args.mode must be 'check'
    // TypeScript needs explicit assertion after early returns
    if (args.mode !== 'check') {
      throw new Error('Unexpected mode');
    }

    // Load configuration from cwd (null if not present)
    const config = loadConfig(process.cwd()) ?? createDefaultConfig();

    // P1-3: One-shot notice on the 0.19.1 min-severity default change.
    // Suppressed by a marker file under .rill/.notices/. Skipped if the
    // user opted in (--min-severity) or has a .rill-check.json overriding defaults.
    if (!argv.includes('--min-severity')) {
      maybePrintMinSeverityNotice();
    }

    // Read source file
    let source: string;
    try {
      const fs = await import('node:fs');

      // Check if file exists
      if (!fs.existsSync(args.file)) {
        console.error(`Error [RILL-C001]: File not found: ${args.file}`);
        return 2;
      }

      // Check if path is a directory
      const stats = fs.statSync(args.file);
      if (stats.isDirectory()) {
        console.error(`Error [RILL-C002]: Path is a directory: ${args.file}`);
        return 2;
      }

      // Read file contents
      source = fs.readFileSync(args.file, 'utf-8');
    } catch (err) {
      // Handle read errors (permissions, etc.)
      if (
        err instanceof Error &&
        'code' in err &&
        typeof (err as { code?: string }).code === 'string'
      ) {
        const code = (err as { code: string }).code;
        if (code === 'ENOENT') {
          console.error(`Error [RILL-C001]: File not found: ${args.file}`);
        } else if (code === 'EISDIR') {
          console.error(`Error [RILL-C002]: Path is a directory: ${args.file}`);
        } else {
          console.error(`Error [RILL-C002]: Cannot read file: ${args.file}`);
        }
      } else {
        console.error(`Error [RILL-C002]: Cannot read file: ${args.file}`);
      }
      return 2;
    }

    // Parse AST with recovery to collect all errors
    const parseResult = parseWithRecovery(source);

    // Convert parse errors to diagnostics
    // Only report the first parse error; subsequent errors are usually cascade noise
    const parseDiagnostics: Diagnostic[] = parseResult.errors
      .slice(0, 1)
      .map((err) => {
        const location = err.location ?? { line: 1, column: 1, offset: 0 };
        const lineContent = source.split('\n')[location.line - 1]?.trim() ?? '';
        return {
          code: 'parse-error',
          severity: 'error' as const,
          message: err.message.replace(/ at \d+:\d+$/, ''),
          location,
          context: lineContent,
          fix: null,
        };
      });

    // If there are parse errors, report them and exit
    if (parseDiagnostics.length > 0) {
      const output = formatDiagnostics(
        args.file,
        parseDiagnostics,
        args.format,
        args.verbose
      );
      console.log(output);

      // If --fix was requested, report that fixes cannot be applied
      if (args.fix) {
        console.error('Cannot apply fixes: file has parse errors');
      }

      return 3;
    }

    const ast = parseResult.ast;

    // Run validation
    const diagnostics = validateScript(ast, source, config);

    // Apply fixes if requested
    if (args.fix && diagnostics.length > 0) {
      const result = applyFixes(source, diagnostics, {
        source,
        ast,
        config,
        diagnostics: [],
        variables: new Map(),
        assertedHostCalls: new Set(),
        variableScopes: new Map(),
        scopeStack: [],
      });

      // Write fixed source back to file
      if (result.applied > 0) {
        const fs = await import('node:fs');
        fs.writeFileSync(args.file, result.modified, 'utf-8');
      }

      // Report fix results to stderr
      if (result.applied > 0 || result.skipped > 0) {
        if (result.applied > 0) {
          console.error(
            `Applied ${result.applied} fix${result.applied === 1 ? '' : 'es'}`
          );
        }
        if (result.skipped > 0) {
          console.error(
            `Skipped ${result.skipped} fix${result.skipped === 1 ? '' : 'es'}`
          );
        }
      }
    }

    // Format and output diagnostics
    if (diagnostics.length === 0) {
      // No diagnostics - success
      if (args.format === 'json') {
        console.log(
          JSON.stringify(
            {
              file: args.file,
              errors: [],
              summary: { total: 0, errors: 0, warnings: 0, info: 0 },
            },
            null,
            2
          )
        );
      } else {
        console.log('No issues found');
      }
      return 0;
    }

    // Output all diagnostics regardless of severity (still useful info).
    // Exit code is gated by --min-severity threshold so info-level
    // advisories (e.g. PREFER_MAP, SPACING_BRACES) don't fail CI.
    const output = formatDiagnostics(
      args.file,
      diagnostics,
      args.format,
      args.verbose
    );
    console.log(output);

    const failingCount = diagnostics.filter((d) =>
      meetsSeverityThreshold(d, args.minSeverity)
    ).length;
    return failingCount > 0 ? 1 : 0;
  } catch (err) {
    // Handle unexpected errors
    if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(`Error: ${String(err)}`);
    }
    return 1;
  }
}
