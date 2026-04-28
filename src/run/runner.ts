/**
 * Script runner for rill-run.
 * Builds runtime options, executes rill scripts, and maps results to exit codes.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  parse,
  execute,
  createRuntimeContext,
  extResolver,
  moduleResolver,
  toNative,
  isTuple,
  isStream,
  isCallable,
  isInvalid,
  invokeCallable,
  type RillValue,
  type RillTuple,
  type RillStream,
  type RillCallable,
  type RuntimeContext,
  type RuntimeOptions,
  type SchemeResolver,
} from '@rcrsr/rill';
import {
  ParseError,
  RillError,
  RuntimeError,
  formatRillError,
  formatRillErrorJson,
} from '@rcrsr/rill';
import { formatError, formatStatus } from '../cli-shared.js';
import { viewFromRuntimeError } from '../cli-error-from-halt.js';
import type { RillConfigFile } from '@rcrsr/rill-config';
import type { RunCliOptions } from './types.js';

// ============================================================
// TYPES
// ============================================================

export interface RunResult {
  readonly exitCode: number;
  readonly output?: string | undefined;
  readonly errorOutput?: string | undefined;
}

// ============================================================
// MODULE RESOLVER
// ============================================================

/**
 * Build a custom module scheme resolver using folder aliasing.
 * Each config key maps to a directory. Dot-paths resolve to files within:
 * - `module:alias.sub.path` → `{dir}/sub/path.rill`
 * - `module:alias` → `{dir}/index.rill`
 */
export function buildModuleResolver(
  modulesConfig: Record<string, string>,
  configDir: string
): SchemeResolver {
  const moduleDirs: Record<string, string> = {};
  for (const [id, value] of Object.entries(modulesConfig)) {
    moduleDirs[id] = resolve(configDir, value);
  }

  const resolver: SchemeResolver = (resource: string) => {
    const dotIndex = resource.indexOf('.');
    const alias = dotIndex === -1 ? resource : resource.slice(0, dotIndex);

    const dirPath = moduleDirs[alias];
    if (dirPath === undefined) {
      return moduleResolver(resource, {});
    }

    const subPath = dotIndex === -1 ? '' : resource.slice(dotIndex + 1);
    const relPath =
      subPath.length > 0
        ? subPath.replaceAll('.', '/') + '.rill'
        : 'index.rill';
    const filePath = resolve(dirPath, relPath);

    return moduleResolver(resource, { [resource]: filePath });
  };
  return resolver;
}

// ============================================================
// STREAM DRAINING
// ============================================================

/**
 * Walk a RillStream linked list, collect all chunk values, then call dispose.
 * When onChunk is provided, each chunk is emitted immediately for streaming output
 * and collection is skipped to avoid unbounded memory growth.
 * Returns the collected chunks as an array (empty when onChunk is provided).
 */
export async function drainStream(
  stream: RillStream,
  ctx: RuntimeContext,
  onChunk?: (value: RillValue) => void | Promise<void>
): Promise<RillValue[]> {
  const chunks: RillValue[] = [];
  let current: RillStream = stream;

  try {
    while (!current.done) {
      if (current.value !== undefined) {
        if (onChunk) {
          await onChunk(current.value);
        } else {
          chunks.push(current.value);
        }
      }
      const nextFn = current.next;
      if (!isCallable(nextFn as RillValue)) break;
      const next = await invokeCallable(nextFn as RillCallable, [], ctx);
      if (!isStream(next as RillValue)) break;
      current = next as RillStream;
    }
  } finally {
    const disposeFn = (stream as Record<string, unknown>)[
      '__rill_stream_dispose'
    ];
    if (typeof disposeFn === 'function') disposeFn();
  }

  return chunks;
}

/** Write to stdout with backpressure handling. */
function writeWithBackpressure(data: string): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdout.write(data)) {
      resolve();
    } else {
      process.stdout.once('drain', resolve);
    }
  });
}

/**
 * Create an onChunk callback that writes stream chunks to stdout,
 * respecting the output format and handling backpressure.
 */
export function createStreamWriter(format: RunCliOptions['format']): {
  onChunk: (value: RillValue) => Promise<void>;
  finalize: () => Promise<void>;
} {
  if (format === 'json' || format === 'compact') {
    let isFirst = true;
    return {
      async onChunk(value: RillValue) {
        const json = JSON.stringify(toNative(value).value) ?? 'null';
        if (isFirst) {
          await writeWithBackpressure('[' + json);
          isFirst = false;
        } else {
          await writeWithBackpressure(',' + json);
        }
      },
      async finalize() {
        await writeWithBackpressure(isFirst ? '[]' : ']');
      },
    };
  }

  return {
    async onChunk(value: RillValue) {
      await writeWithBackpressure(String(value));
    },
    async finalize() {},
  };
}

// ============================================================
// EXIT CODE MAPPING
// ============================================================

function mapResultToRunResult(
  result: RillValue,
  opts: RunCliOptions,
  source?: string
): RunResult {
  // Invalid value (guard-recovered) returned to host: exit 1, render status.
  if (isInvalid(result)) {
    const formatted = formatStatus(
      result,
      {
        format: opts.format === 'compact' ? 'human' : opts.format,
        trace: opts.trace,
        atomOnly: opts.atomOnly,
      },
      source,
      opts.scriptPath
    );
    return { exitCode: 1, errorOutput: formatted };
  }

  if (isTuple(result)) {
    const tuple = result as RillTuple;
    if (tuple.entries.length === 2) {
      const code = tuple.entries[0];
      const message = tuple.entries[1];
      if (typeof code === 'number' && typeof message === 'string') {
        return {
          exitCode: code,
          output: message.length > 0 ? message : undefined,
        };
      }
    }
  }

  if (result === false || result === '') {
    return { exitCode: 1 };
  }

  const formatted = formatOutput(result, opts.format);
  return { exitCode: 0, output: formatted };
}

export function formatOutput(
  value: RillValue,
  format: RunCliOptions['format']
): string {
  const native = toNative(value);
  if (format === 'json' || format === 'compact') {
    return JSON.stringify(native.value);
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(native.value, null, 2);
}

// ============================================================
// RUNNER
// ============================================================

/**
 * Run a rill script file with the given extension tree and config.
 */
export async function runScript(
  opts: RunCliOptions,
  config: RillConfigFile,
  extTree: Record<string, RillValue>,
  disposes: Array<() => void | Promise<void>>
): Promise<RunResult> {
  if (!opts.scriptPath) {
    return { exitCode: 1, errorOutput: 'no script path provided' };
  }

  let source: string;
  try {
    source = readFileSync(opts.scriptPath, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, errorOutput: message };
  }

  const modulesConfig = config.modules ?? {};
  const configDir = dirname(resolve(opts.config));
  const customModuleResolver = buildModuleResolver(modulesConfig, configDir);

  const runtimeOptions: RuntimeOptions = {
    resolvers: {
      ext: extResolver,
      module: customModuleResolver,
    },
    configurations: {
      resolvers: {
        ext: extTree,
      },
    },
    parseSource: parse,
    callbacks: {
      onLog: (msg: string) => {
        process.stdout.write(msg + '\n');
      },
    },
    maxCallStackDepth: opts.maxStackDepth,
  };

  const ctx = createRuntimeContext(runtimeOptions);

  if (opts.scriptArgs.length > 0) {
    ctx.pipeValue = opts.scriptArgs.join(' ');
  }

  const formatOpts = {
    format: opts.format,
    verbose: opts.verbose,
    includeCallStack: true,
    maxCallStackDepth: opts.maxStackDepth,
    trace: opts.trace,
    showRecovered: opts.showRecovered,
    atomOnly: opts.atomOnly,
  };

  const formatRillErr = (err: RillError): string => {
    if (err instanceof RuntimeError && viewFromRuntimeError(err) !== null) {
      return formatError(err, source, formatOpts, undefined, opts.scriptPath);
    }
    return opts.format === 'json'
      ? formatRillErrorJson(err, {
          maxStackDepth: opts.maxStackDepth,
          filePath: opts.scriptPath!,
        })
      : formatRillError(err, {
          verbose: opts.verbose,
          maxStackDepth: opts.maxStackDepth,
          filePath: opts.scriptPath!,
          sources: { script: source },
        });
  };

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source);
  } catch (err: unknown) {
    if (err instanceof ParseError) {
      return { exitCode: 1, errorOutput: formatRillErr(err) };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, errorOutput: message };
  }

  let result: RillValue;
  try {
    const execResult = await execute(ast, ctx);
    result = execResult.result;
    if (isStream(result)) {
      const writer = createStreamWriter(opts.format);
      await drainStream(result as RillStream, ctx, writer.onChunk);
      await writer.finalize();
      return { exitCode: 0 };
    }
  } catch (err: unknown) {
    if (err instanceof RillError) {
      return { exitCode: 1, errorOutput: formatRillErr(err) };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, errorOutput: message };
  } finally {
    for (const dispose of disposes) {
      try {
        await dispose();
      } catch {
        // Ignore dispose errors
      }
    }
  }

  return mapResultToRunResult(result, opts, source);
}
