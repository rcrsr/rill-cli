/**
 * CLI Check Entry Point
 *
 * Implements argument parsing for rill-check.
 * Validates Rill source files against linting rules.
 */

import type { Diagnostic, Severity } from './check/index.js';
import {
  VALIDATION_RULES,
  loadConfig,
  createDefaultConfig,
  validateScript,
  applyFixes,
} from './check/index.js';
import { parseWithRecovery } from '@rcrsr/rill';
import { VERSION, CLI_VERSION, detectHelpVersionFlag } from './cli-shared.js';

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
  | { mode: 'help' | 'version' };

/**
 * Parse command-line arguments for rill-check
 *
 * @param argv - Raw command-line arguments (typically process.argv.slice(2))
 * @returns Parsed command object
 */
export function parseCheckArgs(argv: string[]): ParsedCheckArgs {
  // Check for --help or --version flags in any position
  const helpVersionFlag = detectHelpVersionFlag(argv);
  if (helpVersionFlag !== null) {
    return helpVersionFlag;
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
    '--version',
    '-v',
    '--fix',
    '--verbose',
    '--format',
    '--min-severity',
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

Usage: rill check [options] <file>

Options:
  --fix                    Apply automatic fixes
  --format <fmt>           Output format: text (default) or json
  --verbose                Include category and documentation references
  --min-severity <level>   Severity threshold for non-zero exit:
                           error (default), warning, or info
  -h, --help               Show this help message
  -v, --version            Show version number

Exit codes:
  0   No diagnostics at or above --min-severity (default: error)
  1   Diagnostics at or above --min-severity, or CLI usage error
  2   File not found or path is a directory
  3   Parse error in source`);
      return 0;
    }

    // Handle version mode
    if (args.mode === 'version') {
      console.log(`rill-check ${CLI_VERSION} (rill ${VERSION})`);
      return 0;
    }

    // At this point, args.mode must be 'check'
    // TypeScript needs explicit assertion after early returns
    if (args.mode !== 'check') {
      throw new Error('Unexpected mode');
    }

    // Load configuration from cwd (null if not present)
    const config = loadConfig(process.cwd()) ?? createDefaultConfig();

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
