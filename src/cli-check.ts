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
      runTypes: boolean;
    }
  | {
      mode: 'scan';
      verbose: boolean;
      format: 'text' | 'json';
      minSeverity: MinSeverity;
      runTypes: boolean;
    }
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

  // --types runs `tsc --noEmit` against the user's tsconfig.json, resolving
  // extension types out of .rill/npm/ via tsconfig.rill.json. --types composes
  // with file args and the no-arg project scan: lint runs first, then tsc.
  // --fix has no semantic for a type pass and is rejected.
  const runTypes = argv.includes('--types');
  if (runTypes && argv.includes('--fix')) {
    throw new Error('--types cannot be combined with --fix');
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
    if (fix) {
      throw new Error('--fix requires a file argument');
    }
    return { mode: 'scan', verbose, format, minSeverity, runTypes };
  }

  return { mode: 'check', file, fix, verbose, format, minSeverity, runTypes };
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
function buildFileJsonResult(
  file: string,
  diagnostics: Diagnostic[],
  verbose: boolean
): FileJsonResult {
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

  return {
    file,
    errors,
    summary,
  };
}

function formatDiagnosticsJSON(
  file: string,
  diagnostics: Diagnostic[],
  verbose: boolean
): string {
  return JSON.stringify(
    buildFileJsonResult(file, diagnostics, verbose),
    null,
    2
  );
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
async function runTypeCheck(format: 'text' | 'json' = 'text'): Promise<number> {
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
    // In JSON mode, route tsc's stdout to our stderr so the lint envelope on
    // stdout stays a single parseable JSON document. tsc writes diagnostics
    // to stdout by default; mixing it with the JSON output would break
    // `JSON.parse` for any consumer of `rill check --types --format json`.
    const stdio: ('inherit' | 'pipe')[] =
      format === 'json'
        ? ['inherit', 'pipe', 'inherit']
        : ['inherit', 'inherit', 'inherit'];
    const child = spawn(tsc, ['--noEmit', '-p', tsconfigPath], {
      cwd,
      stdio,
    });
    if (format === 'json' && child.stdout) {
      child.stdout.pipe(process.stderr);
    }
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
 * Discover *.rill files under cwd for the no-arg `rill check` scan.
 * Walks the tree manually and prunes conventional build/dependency
 * directories at the directory level so we don't traverse into
 * `node_modules/`, `.rill/`, `dist/`, or `.git/`. A `readdir` with
 * `recursive: true` would walk those huge trees first and only filter
 * after the fact.
 */
async function discoverProjectFiles(cwd: string): Promise<string[]> {
  const skipDirs = new Set(['.rill', 'node_modules', 'dist', '.git']);
  const files: string[] = [];

  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        const childRel = rel === '' ? entry.name : path.join(rel, entry.name);
        await walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile() && entry.name.endsWith('.rill')) {
        files.push(rel === '' ? entry.name : path.join(rel, entry.name));
      }
    }
  }

  await walk(cwd, '');
  files.sort();
  return files;
}

/**
 * Per-file JSON document shape emitted by `formatDiagnosticsJSON`.
 * Used by scan mode to aggregate results into a single envelope.
 */
type FileJsonResult = {
  file: string;
  errors: unknown[];
  summary: { total: number; errors: number; warnings: number; info: number };
};

/**
 * Validate a single file. Returns the worst exit code observed
 * (0 = clean, 1 = diagnostics, 2 = read error, 3 = parse error).
 *
 * In JSON format, when `collect` is provided, the per-file JSON object is
 * pushed there instead of being written to stdout. Scan mode uses this so it
 * can emit a single combined document instead of multiple back-to-back ones.
 */
async function checkFile(
  file: string,
  options: {
    fix: boolean;
    verbose: boolean;
    format: 'text' | 'json';
    minSeverity: MinSeverity;
    config: ReturnType<typeof createDefaultConfig>;
    collect?: FileJsonResult[];
  }
): Promise<number> {
  let source: string;
  try {
    if (!fs.existsSync(file)) {
      console.error(`Error [RILL-C001]: File not found: ${file}`);
      return 2;
    }
    const stats = fs.statSync(file);
    if (stats.isDirectory()) {
      console.error(`Error [RILL-C002]: Path is a directory: ${file}`);
      return 2;
    }
    source = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (
      err instanceof Error &&
      'code' in err &&
      typeof (err as { code?: string }).code === 'string'
    ) {
      const code = (err as { code: string }).code;
      if (code === 'ENOENT') {
        console.error(`Error [RILL-C001]: File not found: ${file}`);
      } else if (code === 'EISDIR') {
        console.error(`Error [RILL-C002]: Path is a directory: ${file}`);
      } else {
        console.error(`Error [RILL-C002]: Cannot read file: ${file}`);
      }
    } else {
      console.error(`Error [RILL-C002]: Cannot read file: ${file}`);
    }
    return 2;
  }

  const parseResult = parseWithRecovery(source);

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

  if (parseDiagnostics.length > 0) {
    if (options.format === 'json' && options.collect) {
      options.collect.push(
        buildFileJsonResult(file, parseDiagnostics, options.verbose)
      );
    } else {
      const output = formatDiagnostics(
        file,
        parseDiagnostics,
        options.format,
        options.verbose
      );
      console.log(output);
    }
    if (options.fix) {
      console.error('Cannot apply fixes: file has parse errors');
    }
    return 3;
  }

  const ast = parseResult.ast;
  const diagnostics = validateScript(ast, source, options.config);

  if (options.fix && diagnostics.length > 0) {
    const result = applyFixes(source, diagnostics, {
      source,
      ast,
      config: options.config,
      diagnostics: [],
      variables: new Map(),
      assertedHostCalls: new Set(),
      variableScopes: new Map(),
      scopeStack: [],
    });
    if (result.applied > 0) {
      fs.writeFileSync(file, result.modified, 'utf-8');
    }
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

  if (diagnostics.length === 0) {
    if (options.format === 'json') {
      const result = buildFileJsonResult(file, [], options.verbose);
      if (options.collect) {
        options.collect.push(result);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } else {
      console.log(`${file}: No issues found`);
    }
    return 0;
  }

  if (options.format === 'json' && options.collect) {
    options.collect.push(
      buildFileJsonResult(file, diagnostics, options.verbose)
    );
  } else {
    const output = formatDiagnostics(
      file,
      diagnostics,
      options.format,
      options.verbose
    );
    console.log(output);
  }

  const failingCount = diagnostics.filter((d) =>
    meetsSeverityThreshold(d, options.minSeverity)
  ).length;
  return failingCount > 0 ? 1 : 0;
}

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
  rill check                      Scan project for *.rill files and lint each
  rill check [options] <file>     Lint a single Rill script
  rill check --types              Run \`tsc --noEmit\` against tsconfig.json
  rill check [<file>] --types     Lint then run tsc in one invocation

Options:
  --fix                    Apply automatic fixes (incompatible with --types)
  --format <fmt>           Output format: text (default) or json
  --verbose                Include category and documentation references
  --min-severity <level>   Severity threshold for non-zero exit:
                           error (default), warning, or info
  --types                  Run TypeScript type-check via local tsc after the
                           lint pass. Requires tsconfig.json to extend
                           ./.rill/tsconfig.rill.json (written by bootstrap).
  -h, --help               Show this help message

Exit codes:
  0   No diagnostics at or above --min-severity (default: error)
  1   Diagnostics at or above --min-severity, or CLI usage error
  2   File not found or path is a directory
  3   Parse error in source`);
      return 0;
    }

    // Load configuration from cwd (null if not present)
    const config = loadConfig(process.cwd()) ?? createDefaultConfig();

    // P1-3: One-shot notice on the 0.19.1 min-severity default change.
    // Suppressed by a marker file under .rill/.notices/. Skipped if the
    // user opted in (--min-severity) or has a .rill-check.json overriding defaults.
    if (!argv.includes('--min-severity')) {
      maybePrintMinSeverityNotice();
    }

    let lintExit = 0;

    if (args.mode === 'scan') {
      const files = await discoverProjectFiles(process.cwd());
      // Aggregate per-file JSON results so scan emits a single envelope
      // instead of multiple back-to-back documents that would break
      // `JSON.parse` on the consuming side.
      const collect: FileJsonResult[] = [];
      const checkOpts: Parameters<typeof checkFile>[1] = {
        fix: false,
        verbose: args.verbose,
        format: args.format,
        minSeverity: args.minSeverity,
        config,
        ...(args.format === 'json' ? { collect } : {}),
      };
      for (const file of files) {
        const result = await checkFile(file, checkOpts);
        if (result > lintExit) lintExit = result;
      }
      if (args.format === 'json') {
        const items = collect;
        const summary = items.reduce(
          (acc, r) => ({
            files: acc.files + 1,
            errors: acc.errors + r.summary.errors,
            warnings: acc.warnings + r.summary.warnings,
            info: acc.info + r.summary.info,
          }),
          { files: 0, errors: 0, warnings: 0, info: 0 }
        );
        console.log(JSON.stringify({ files: items, summary }, null, 2));
      } else if (files.length === 0) {
        console.log('No *.rill files found in project');
      }
    } else if (args.mode === 'check') {
      lintExit = await checkFile(args.file, {
        fix: args.fix,
        verbose: args.verbose,
        format: args.format,
        minSeverity: args.minSeverity,
        config,
      });
    }

    // --types pass runs after lint. Skip when lint hit a hard error
    // (parse error or read failure) so users see the lint failure first.
    if (args.runTypes && lintExit !== 2 && lintExit !== 3) {
      const typesExit = await runTypeCheck(args.format);
      if (typesExit > lintExit) lintExit = typesExit;
    }

    return lintExit;
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
