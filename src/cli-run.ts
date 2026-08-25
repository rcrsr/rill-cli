/**
 * rill run: Runs a rill project or bundle.
 *
 * When a rill-bundle.json is present at the resolved project directory,
 * delegates to bundle mode (builds all packages, invokes harness serve).
 * Otherwise falls through to the single-package path (reads rill-config.json).
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { config as dotenvConfig } from 'dotenv';
import {
  parse,
  execute,
  createRuntimeContext,
  invokeCallable,
  isInvalid,
  isScriptCallable,
  isStream,
  toNative,
  VERSION,
  type RuntimeOptions,
  type RillStream,
} from '@rcrsr/rill';
import {
  resolveConfigPath,
  loadProject,
  parseMainField,
  introspectHandler,
  marshalCliArgs,
  hasSessionVars,
  extractSessionVarNames,
  substituteSessionVars,
  ConfigError,
  type HandlerParam,
} from '@rcrsr/rill-config';
import {
  detectHelpVersionFlag,
  determineExitCode,
  formatStatus,
} from './cli-shared.js';
import { detectBundleAtCwd } from './bundle/config.js';
import { runBundleServe } from './commands/bundle-run.js';
import { resolvePrefix } from './commands/prefix.js';
import { explainError } from './cli-explain.js';
import {
  createStreamWriter,
  drainStream,
  formatHandlerError,
  formatOutput,
  runScript,
} from './run/runner.js';
import type { RunCliOptions } from './run/types.js';

// ============================================================
// HELP TEXT
// ============================================================

const USAGE = `\
Usage: rill run [project-dir]

Arguments:
  project-dir               Optional directory containing rill-config.json (default: cwd)

Options:
  --config <path>           Config file path (default: search from cwd)
  --format <mode>           Output format: human, json, compact (default: human)
  --verbose                 Show full error details (default: false)
  --max-stack-depth <n>     Error stack frame limit (default: 10)
  --trace                   Always print the trace chain on halt errors
  --no-trace                Suppress the trace chain on halt errors
  --show-recovered          Print guard-caught frames on a successful result
  --atom-only               JSON mode: emit only {atom, errorId} headers
  --create-bindings [dir]   Write bindings source to dir and exit (default: ./bindings)
  --explain <code>          Print error code documentation
  -h, --help                Print this help message and exit`.trimEnd();

// ============================================================
// BASE OPTIONS (used to separate known flags from handler args)
// ============================================================

const BASE_OPTIONS = {
  config: { type: 'string' as const },
  format: { type: 'string' as const },
  verbose: { type: 'boolean' as const },
  'max-stack-depth': { type: 'string' as const },
  help: { type: 'boolean' as const },
  explain: { type: 'string' as const },
  trace: { type: 'boolean' as const },
  'no-trace': { type: 'boolean' as const },
  'show-recovered': { type: 'boolean' as const },
  'atom-only': { type: 'boolean' as const },
};

// ============================================================
// CREATE-BINDINGS EXTRACTION
// ============================================================

/**
 * Extract --create-bindings [dir] from argv before parseArgs.
 * Handles the optional dir argument that parseArgs cannot natively support.
 * Returns the filtered argv (with --create-bindings removed) and the resolved dir.
 */
function extractCreateBindings(argv: string[]): {
  filteredArgv: string[];
  createBindings: string | undefined;
} {
  const idx = argv.indexOf('--create-bindings');
  if (idx === -1) {
    return { filteredArgv: argv, createBindings: undefined };
  }
  const next = argv[idx + 1];
  if (next !== undefined && !next.startsWith('-')) {
    return {
      filteredArgv: [...argv.slice(0, idx), ...argv.slice(idx + 2)],
      createBindings: next,
    };
  }
  return {
    filteredArgv: [...argv.slice(0, idx), ...argv.slice(idx + 1)],
    createBindings: './bindings',
  };
}

// ============================================================
// PARSE ARGS
// ============================================================

export function parseCliArgs(
  argv: string[] = process.argv.slice(2)
): (RunCliOptions & { rootDir?: string | undefined }) | { help: true } {
  const helpVersionFlag = detectHelpVersionFlag(argv);
  if (helpVersionFlag !== null && helpVersionFlag.mode === 'help') {
    return { help: true };
  }

  const { filteredArgv, createBindings } = extractCreateBindings(argv);

  const { values, positionals } = parseArgs({
    args: filteredArgv,
    options: BASE_OPTIONS,
    allowPositionals: true,
    strict: false,
  });

  // Distinguish positional `[project-dir]` from a value passed to an unknown
  // long flag (a handler param). With `strict: false`, `parseArgs` treats an
  // unknown `--foo` as a boolean and pushes the next token into `positionals`,
  // which would otherwise be misread as `rootDir`. Walk argv: if a token sits
  // immediately after an unknown long flag with no `=` and doesn't itself start
  // with `-`, mark it consumed.
  const knownLong = new Set(Object.keys(BASE_OPTIONS));
  const consumedIdx = new Set<number>();
  for (let i = 0; i < filteredArgv.length - 1; i++) {
    const tok = filteredArgv[i];
    if (
      tok !== undefined &&
      tok.startsWith('--') &&
      !tok.includes('=') &&
      !knownLong.has(tok.slice(2))
    ) {
      const next = filteredArgv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        consumedIdx.add(i + 1);
      }
    }
  }
  const positionalSet = new Set(positionals);
  let rootDir: string | undefined;
  for (let i = 0; i < filteredArgv.length; i++) {
    const tok = filteredArgv[i];
    if (tok === undefined) continue;
    if (consumedIdx.has(i)) continue;
    if (tok.startsWith('-')) continue;
    if (!positionalSet.has(tok)) continue;
    rootDir = tok;
    break;
  }
  const scriptArgs: string[] = [];

  const rawFormat = values['format'];
  const format =
    rawFormat === 'json' || rawFormat === 'compact' ? rawFormat : 'human';

  const rawDepth = values['max-stack-depth'] as string | undefined;
  const parsedDepth = rawDepth !== undefined ? parseInt(rawDepth, 10) : NaN;
  const maxStackDepth =
    !isNaN(parsedDepth) && parsedDepth >= 0 ? parsedDepth : 10;

  const traceFlag = values['trace'] === true;
  const noTraceFlag = values['no-trace'] === true;
  const trace: 'auto' | 'always' | 'never' = noTraceFlag
    ? 'never'
    : traceFlag
      ? 'always'
      : 'auto';

  return {
    scriptPath: undefined,
    scriptArgs,
    rootDir,
    config: (values['config'] as string | undefined) ?? './rill-config.json',
    format,
    verbose: values['verbose'] === true,
    maxStackDepth,
    explain: values['explain'] as string | undefined,
    createBindings,
    trace,
    showRecovered: values['show-recovered'] === true,
    atomOnly: values['atom-only'] === true,
  };
}

// ============================================================
// HANDLER ARG EXTRACTION
// ============================================================

/**
 * Extract unknown flags from argv as handler parameter strings.
 * Filters out known base options and their values.
 */
function extractHandlerArgs(
  argv: string[],
  params: ReadonlyArray<HandlerParam>
): Record<string, string> {
  const handlerOptions: Record<string, { type: 'string' | 'boolean' }> = {
    ...BASE_OPTIONS,
  };
  for (const param of params) {
    handlerOptions[param.name] = {
      type: param.type === 'bool' ? 'boolean' : 'string',
    };
  }

  const { filteredArgv } = extractCreateBindings(argv);

  const { values } = parseArgs({
    args: filteredArgv,
    options: handlerOptions,
    allowPositionals: true,
    strict: false,
  });

  const knownKeys = new Set(Object.keys(BASE_OPTIONS));
  const handlerArgs: Record<string, string> = {};

  for (const [key, value] of Object.entries(values)) {
    if (knownKeys.has(key)) continue;
    if (typeof value === 'string') {
      handlerArgs[key] = value;
    } else if (value === true) {
      handlerArgs[key] = '';
    }
  }

  return handlerArgs;
}

// ============================================================
// MAIN
// ============================================================

export async function main(argv: string[]): Promise<number> {
  dotenvConfig({ quiet: true });

  const opts = parseCliArgs(argv);

  if ('help' in opts) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }

  if (opts.explain !== undefined) {
    const doc = explainError(opts.explain);
    if (doc === null) {
      process.stderr.write(`Invalid error ID: ${opts.explain}\n`);
      process.stderr.write(
        'Error ID must be in format RILL-{L|P|R|C}{3-digit}, e.g., RILL-R009\n'
      );
      return 1;
    }
    process.stdout.write(doc + '\n');
    return 0;
  }

  const hasExplicitConfig = opts.config !== './rill-config.json';

  const rootDir = opts.rootDir ?? process.cwd();

  // Bundle-mode detection: if rill-bundle.json exists at rootDir, delegate.
  if (detectBundleAtCwd(rootDir)) {
    // Bundle mode does not (yet) support the single-package flags below;
    // reject explicitly rather than silently ignoring them. Matches both
    // the standalone form (`--format json`) and the `=`-joined form
    // (`--format=json`).
    const hasFlag = (flag: string): boolean =>
      argv.some((a) => a === flag || a.startsWith(flag + '='));

    const unsupportedFlags = [
      hasExplicitConfig ? '--config' : null,
      hasFlag('--format') ? '--format' : null,
      hasFlag('--verbose') ? '--verbose' : null,
      hasFlag('--max-stack-depth') ? '--max-stack-depth' : null,
      hasFlag('--trace') ? '--trace' : null,
      hasFlag('--no-trace') ? '--no-trace' : null,
      hasFlag('--show-recovered') ? '--show-recovered' : null,
      hasFlag('--atom-only') ? '--atom-only' : null,
      opts.createBindings !== undefined ? '--create-bindings' : null,
    ].filter((flag): flag is string => flag !== null);

    if (unsupportedFlags.length > 0) {
      process.stderr.write(
        `rill run: ${unsupportedFlags.join(', ')} not supported in bundle mode\n`
      );
      return 1;
    }

    return runBundleServe(rootDir, {});
  }

  let configPath: string;
  try {
    configPath = resolveConfigPath({
      ...(hasExplicitConfig ? { configFlag: opts.config } : {}),
      cwd: rootDir,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(err.message + '\n');
      return 1;
    }
    throw err;
  }

  const prefix = resolvePrefix(dirname(configPath));

  let project: Awaited<ReturnType<typeof loadProject>>;
  try {
    project = await loadProject({
      configPath,
      rillVersion: VERSION,
      prefix,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(err.message + '\n');
      return 1;
    }
    throw err;
  }

  // Substitute session vars from environment
  if (hasSessionVars(project.config)) {
    const names = extractSessionVarNames(project.config);
    const vars: Record<string, string> = {};
    for (const name of names) {
      const val = process.env[name];
      if (val !== undefined) {
        vars[name] = val;
      }
    }
    project = {
      ...project,
      config: substituteSessionVars(project.config, vars),
    };
  }

  // Create bindings and exit early if --create-bindings was set
  if (opts.createBindings !== undefined) {
    const bindingsDir = resolve(dirname(configPath), opts.createBindings);

    mkdirSync(bindingsDir, { recursive: true });
    writeFileSync(
      resolve(bindingsDir, 'ext.rill'),
      project.extensionBindings + '\n'
    );
    if (project.config.context !== undefined) {
      writeFileSync(
        resolve(bindingsDir, 'context.rill'),
        project.contextBindings + '\n'
      );
    }
    for (const dispose of project.disposes) {
      try {
        await dispose();
      } catch {
        // Ignore dispose errors during cleanup
      }
    }
    return 0;
  }

  // Handler mode: main field contains "file.rill:handlerName"
  const mainField = project.config.main;
  if (mainField !== undefined && mainField.includes(':')) {
    const { filePath, handlerName } = parseMainField(mainField);
    const absolutePath = resolve(rootDir, filePath);

    // Single enclosing try/finally disposes project.disposes exactly once,
    // covering every early-return path below (read/parse/execute/handler
    // lookup/arg marshal/invocation), not just the final invocation.
    try {
      let source: string;
      try {
        source = readFileSync(absolutePath, 'utf-8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        return 1;
      }

      const formatErr = (err: unknown): string =>
        formatHandlerError(err, source, absolutePath, opts);

      let ast: ReturnType<typeof parse>;
      try {
        ast = parse(source);
      } catch (err) {
        process.stderr.write(formatErr(err) + '\n');
        return 1;
      }

      const runtimeOptions: RuntimeOptions = {
        ...project.resolverConfig,
        parseSource: parse,
        callbacks: {
          onLog: (msg: string) => {
            process.stdout.write(msg + '\n');
          },
        },
        maxCallStackDepth: opts.maxStackDepth,
      };

      const ctx = createRuntimeContext(runtimeOptions);

      try {
        await execute(ast, ctx);
      } catch (err) {
        process.stderr.write(formatErr(err) + '\n');
        return 1;
      }

      const handlerValue =
        handlerName !== undefined ? ctx.variables.get(handlerName) : undefined;

      if (handlerValue === undefined || !isScriptCallable(handlerValue)) {
        process.stderr.write(
          `Handler not found: $${handlerName ?? '(none)'} is not a closure\n`
        );
        return 1;
      }

      const introspection = introspectHandler(handlerValue);
      const rawHandlerArgs = extractHandlerArgs(argv, introspection.params);

      let handlerArgs: Record<string, unknown>;
      try {
        handlerArgs = marshalCliArgs(rawHandlerArgs, introspection.params);
      } catch (err) {
        if (err instanceof ConfigError) {
          process.stderr.write(err.message + '\n');
          return 1;
        }
        throw err;
      }

      ctx.pipeValue = handlerArgs as unknown as import('@rcrsr/rill').RillValue;

      // Map handler args to positional args in param order so marshalArgs
      // can bind them to the closure's declared parameters.
      // Omitted optional params stay undefined so closure defaults hydrate.
      // pipeValue is kept for zero-param closures that access $ directly.
      const positionalArgs = introspection.params.map(
        (p) =>
          (Object.prototype.hasOwnProperty.call(handlerArgs, p.name)
            ? handlerArgs[p.name]
            : undefined) as unknown as import('@rcrsr/rill').RillValue
      );

      let handlerResult: import('@rcrsr/rill').RillValue;
      let streamed = false;
      try {
        handlerResult = await invokeCallable(handlerValue, positionalArgs, ctx);
        if (isStream(handlerResult)) {
          streamed = true;
          const writer = createStreamWriter(opts.format);
          await drainStream(handlerResult as RillStream, ctx, writer.onChunk);
          await writer.finalize();
        }
      } catch (err) {
        process.stderr.write(formatErr(err) + '\n');
        return 1;
      }

      if (streamed) {
        return 0;
      }

      // Guard-recovered Invalid returned (not thrown) from the handler:
      // exit 1, render the status sidecar, and never fall through to
      // determineExitCode, which only sees the plain native value and
      // would silently drop the Invalid marker (e.g. a truthy string or
      // dict payload reads as success). Mirrors cli-eval.ts and
      // run/runner.ts's mapResultToRunResult.
      if (isInvalid(handlerResult)) {
        const formatted = formatStatus(
          handlerResult,
          {
            format: opts.format === 'compact' ? 'human' : opts.format,
            trace: opts.trace,
            atomOnly: opts.atomOnly,
          },
          source,
          absolutePath
        );
        process.stderr.write(formatted + '\n');
        return 1;
      }

      const nativeResult = toNative(handlerResult);
      const { code, message } = determineExitCode(nativeResult.value);

      if (message !== undefined) {
        process.stdout.write(message + '\n');
      } else if (
        handlerResult !== false &&
        handlerResult !== '' &&
        handlerResult !== undefined
      ) {
        const output = formatOutput(handlerResult, opts.format);
        process.stdout.write(output + '\n');
      }
      return code;
    } finally {
      for (const dispose of project.disposes) {
        try {
          await dispose();
        } catch {
          // Ignore dispose errors
        }
      }
    }
  }

  // Module mode: main field in config is required
  if (mainField === undefined) {
    process.stderr.write(
      'Error: no main field in rill-config.json\n' +
        'Add a "main" field pointing to your entry script, e.g.: "main": "src/index.rill"\n'
    );
    return 1;
  }

  const scriptPath = resolve(rootDir, mainField);

  const runOpts: RunCliOptions = {
    ...opts,
    scriptPath,
    resolvedConfigPath: configPath,
  };

  const runResult = await runScript(runOpts, project.config, project.extTree, [
    ...project.disposes,
  ]);

  if (runResult.output !== undefined) {
    process.stdout.write(runResult.output + '\n');
  }

  if (runResult.errorOutput !== undefined) {
    process.stderr.write(runResult.errorOutput + '\n');
  }

  return runResult.exitCode;
}
