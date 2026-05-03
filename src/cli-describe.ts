/**
 * Rill CLI - Describe project or runtime callables as a JSON contract
 *
 * Subcommands:
 *   project [--mount <name>] [--strict] [--config <path>]
 *     Describe extension surface (default when no subcommand given)
 *   handler [--strict] [--config <path>]
 *     Describe the project's own handler (main: "file.rill:name")
 *   builtins [--strict]
 *     Describe @rcrsr/rill runtime callables (no config needed)
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import {
  isCallable,
  isDict,
  isScriptCallable,
  formatStructure,
  createRuntimeContext,
  parse,
  execute,
} from '@rcrsr/rill';
import type { RillValue, RillCallable, RuntimeOptions } from '@rcrsr/rill';
import {
  resolveConfigPath,
  loadProject,
  parseMainField,
  ConfigError,
} from '@rcrsr/rill-config';
import { detectHelpVersionFlag, VERSION } from './cli-shared.js';
import { resolvePrefix } from './commands/prefix.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type Subcommand = 'project' | 'handler' | 'builtins';

interface ProjectArgs {
  cmd: 'project';
  mountName: string | undefined;
  strict: boolean;
  configFlag: string | undefined;
  stubs: boolean;
}

interface HandlerArgs {
  cmd: 'handler';
  strict: boolean;
  configFlag: string | undefined;
}

interface BuiltinsArgs {
  cmd: 'builtins';
  strict: boolean;
}

type ParsedArgs = ProjectArgs | HandlerArgs | BuiltinsArgs;

const SUBCOMMANDS: ReadonlySet<string> = new Set([
  'project',
  'handler',
  'builtins',
]);

const USAGE_LINE = 'Usage: rill describe [project|handler|builtins] [options]';

class DescribeArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DescribeArgError';
  }
}

class DescribeExitError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'DescribeExitError';
    this.code = code;
  }
}

function fail(message: string): never {
  throw new DescribeArgError(`Error: ${message}\n${USAGE_LINE}`);
}

function parseArgs(argv: string[]): ParsedArgs | { mode: 'help' } {
  const helpVersionFlag = detectHelpVersionFlag(argv);
  if (helpVersionFlag !== null && helpVersionFlag.mode === 'help') {
    return { mode: 'help' };
  }

  // Resolve subcommand from argv[0]. Default to 'project' when the first
  // token is missing or starts with a flag prefix.
  let subcommand: Subcommand;
  let rest: string[];
  const first = argv[0];
  if (first === undefined || first.startsWith('-')) {
    subcommand = 'project';
    rest = argv;
  } else if (SUBCOMMANDS.has(first)) {
    subcommand = first as Subcommand;
    rest = argv.slice(1);
  } else {
    fail(`unknown subcommand "${first}"`);
  }

  switch (subcommand) {
    case 'project':
      return parseProjectArgs(rest);
    case 'handler':
      return parseHandlerArgs(rest);
    case 'builtins':
      return parseBuiltinsArgs(rest);
  }
}

function parseProjectArgs(argv: string[]): ProjectArgs {
  let mountName: string | undefined;
  let strict = false;
  let configFlag: string | undefined;
  let stubs = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--strict') {
      strict = true;
    } else if (arg === '--stubs') {
      stubs = true;
    } else if (arg === '--mount') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        fail('--mount requires a value');
      }
      mountName = next;
      i++;
    } else if (arg === '--config') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        fail('--config requires a value');
      }
      configFlag = next;
      i++;
    } else if (arg.startsWith('-') && arg !== '-') {
      fail(`unknown option "${arg}" for subcommand "project"`);
    } else {
      fail(`unexpected positional argument "${arg}"`);
    }
  }

  return { cmd: 'project', mountName, strict, configFlag, stubs };
}

function parseHandlerArgs(argv: string[]): HandlerArgs {
  let strict = false;
  let configFlag: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--strict') {
      strict = true;
    } else if (arg === '--config') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        fail('--config requires a value');
      }
      configFlag = next;
      i++;
    } else if (arg.startsWith('-') && arg !== '-') {
      fail(`unknown option "${arg}" for subcommand "handler"`);
    } else {
      fail(`unexpected positional argument "${arg}"`);
    }
  }

  return { cmd: 'handler', strict, configFlag };
}

function parseBuiltinsArgs(argv: string[]): BuiltinsArgs {
  let strict = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--strict') {
      strict = true;
    } else if (arg.startsWith('-') && arg !== '-') {
      fail(`unknown option "${arg}" for subcommand "builtins"`);
    } else {
      fail(`unexpected positional argument "${arg}"`);
    }
  }

  return { cmd: 'builtins', strict };
}

// ---------------------------------------------------------------------------
// Help / version
// ---------------------------------------------------------------------------

function showHelp(): void {
  process.stdout.write(`${USAGE_LINE}

Subcommands:
  project           Describe extension surface from rill-config.json (default)
  handler           Describe the project's own handler signature
  builtins          Describe @rcrsr/rill runtime callables

Options (project):
  --mount <name>    Limit output to a single mount
  --strict          Exit 1 if any callable has returnType: any
  --stubs           Stub unset env vars referenced as \${env.X} in rill-config.json
                    with literal "x" before constructing extensions. Use to
                    enumerate the surface before credentials are populated.
                    Note: only string-typed config is stubbed; numeric/bool
                    config may still cause factory construction to fail.
  --config <path>   Path to rill-config.json (defaults to ./rill-config.json)

Options (handler):
  --strict          Exit 1 if any callable has returnType: any
  --config <path>   Path to rill-config.json (defaults to ./rill-config.json)

Options (builtins):
  --strict          Exit 1 if any callable has returnType: any

Global:
  -h, --help        Show this help
`);
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

const RILL_KEY_PREFIX = '__rill_';

function rillReplacer(_key: string, v: unknown): unknown {
  if (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v as object).some((k) => k.startsWith(RILL_KEY_PREFIX))
  ) {
    return null;
  }
  return v;
}

function serializeRillValue(value: RillValue | undefined): unknown {
  if (value === undefined) {
    return null;
  }
  const json = JSON.stringify(value, rillReplacer);
  return JSON.parse(json) as unknown;
}

function serializeAnnotations(
  annotations: Record<string, RillValue>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(annotations)) {
    result[key] = serializeRillValue(val);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

interface CallableEntry {
  isProperty: boolean;
  params: Array<{
    name: string;
    type: unknown;
    typeDisplay: string;
    defaultValue: unknown;
    description: string | undefined;
  }>;
  returnType: unknown;
  returnTypeDisplay: string;
  annotations: Record<string, unknown>;
}

type ContractTree = CallableEntry | { [key: string]: ContractTree };

/**
 * Discriminate a CallableEntry from a nested ContractTree dict. Checks
 * the full CallableEntry shape (boolean isProperty + array params +
 * presence of returnType) rather than `'isProperty' in tree` alone, so
 * a user dict that coincidentally has an `isProperty` key cannot be
 * mistaken for a callable and short-circuit the traversal.
 */
function isCallableEntry(tree: ContractTree): tree is CallableEntry {
  const t = tree as Partial<CallableEntry>;
  return (
    typeof t.isProperty === 'boolean' &&
    Array.isArray(t.params) &&
    'returnType' in t
  );
}

function buildTree(
  value: RillValue,
  visited: WeakSet<object>
): ContractTree | null {
  if (isCallable(value)) {
    return buildCallableEntry(value);
  }

  if (isDict(value)) {
    if (visited.has(value)) {
      return null;
    }
    visited.add(value);

    const tree: { [key: string]: ContractTree } = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, RillValue>)[key];
      if (child === undefined) {
        continue;
      }
      const subtree = buildTree(child, visited);
      if (subtree !== null) {
        tree[key] = subtree;
      }
    }
    return tree;
  }

  return null;
}

function buildCallableEntry(callable: RillCallable): CallableEntry {
  return {
    isProperty: callable.isProperty,
    params: callable.params.map((p) => ({
      name: p.name,
      type: p.type ?? null,
      typeDisplay: p.type ? formatStructure(p.type) : 'any',
      defaultValue: serializeRillValue(p.defaultValue),
      description:
        typeof p.annotations['description'] === 'string'
          ? p.annotations['description']
          : undefined,
    })),
    returnType: callable.returnType.structure,
    returnTypeDisplay: formatStructure(callable.returnType.structure),
    annotations: serializeAnnotations(callable.annotations),
  };
}

// ---------------------------------------------------------------------------
// Strict mode: collect callables with returnType: any
// ---------------------------------------------------------------------------

function collectAnyReturnCallables(
  tree: ContractTree,
  currentPath: string,
  results: string[]
): void {
  if (isCallableEntry(tree)) {
    const structure = tree.returnType as { kind?: string } | null;
    if (
      structure !== null &&
      typeof structure === 'object' &&
      structure.kind === 'any'
    ) {
      results.push(currentPath);
    }
    return;
  }

  const node = tree as { [key: string]: ContractTree };
  for (const key of Object.keys(node).sort()) {
    const child = node[key];
    if (child !== undefined) {
      collectAnyReturnCallables(
        child,
        currentPath ? `${currentPath}.${key}` : key,
        results
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Config + project loading (shared by project + handler subcommands)
// ---------------------------------------------------------------------------

async function loadConfigAndProject(configFlag: string | undefined): Promise<{
  configPath: string;
  project: Awaited<ReturnType<typeof loadProject>>;
}> {
  let configPath: string;
  try {
    configPath = resolveConfigPath({
      ...(configFlag !== undefined ? { configFlag } : {}),
      cwd: process.cwd(),
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new DescribeExitError(err.message, 1);
    }
    throw err;
  }

  const projectDir = dirname(configPath);
  const prefix = resolvePrefix(projectDir);

  let project: Awaited<ReturnType<typeof loadProject>>;
  try {
    project = await loadProject({
      configPath,
      rillVersion: VERSION,
      prefix,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new DescribeExitError(err.message, 1);
    }
    throw err;
  }

  return { configPath, project };
}

async function disposeAll(
  disposes: ReadonlyArray<() => void | Promise<void>>
): Promise<void> {
  for (const d of disposes) {
    try {
      await d();
    } catch {
      // Swallow cleanup errors — don't mask describe output
    }
  }
}

// ---------------------------------------------------------------------------
// --stubs support (P0-2)
// ---------------------------------------------------------------------------

/**
 * Walk a rill-config.json text for `${env.NAME}` references and stub any
 * unset env vars to literal "x" so factories construct with a placeholder
 * credential instead of throwing.
 *
 * Returns the names of vars that were stubbed (already-set vars are left
 * alone). Idempotent: safe to call when no refs are present.
 */
function applyEnvStubs(configText: string): string[] {
  const stubbed: string[] = [];
  const seen = new Set<string>();
  // Accept any POSIX-shell-valid env var name. Convention is uppercase, but
  // Linux is case-sensitive and rill-config doesn't enforce upper-case.
  const re = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(configText)) !== null) {
    const name = match[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (process.env[name] === undefined || process.env[name] === '') {
      process.env[name] = 'x';
      stubbed.push(name);
    }
  }
  return stubbed;
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function runProject(args: ProjectArgs): Promise<number> {
  if (args.stubs) {
    let configPathForStubs: string;
    try {
      configPathForStubs = resolveConfigPath({
        ...(args.configFlag !== undefined
          ? { configFlag: args.configFlag }
          : {}),
        cwd: process.cwd(),
      });
    } catch (err) {
      if (err instanceof ConfigError) {
        process.stderr.write(err.message + '\n');
        return 1;
      }
      throw err;
    }
    let configText = '';
    try {
      configText = readFileSync(configPathForStubs, 'utf8');
    } catch {
      // Fall through; loadConfigAndProject will surface the real error.
    }
    if (configText !== '') {
      const stubbed = applyEnvStubs(configText);
      if (stubbed.length > 0) {
        process.stderr.write(
          `[describe] stubbed ${stubbed.length} env var${stubbed.length === 1 ? '' : 's'} for surface enumeration: ${stubbed.join(', ')}\n`
        );
      }
    }
  }

  const { configPath, project } = await loadConfigAndProject(args.configFlag);

  const visited = new WeakSet<object>();
  const mountTrees: { [key: string]: ContractTree } = {};

  for (const [name, value] of Object.entries(project.extTree)) {
    const subtree = buildTree(value, visited);
    if (subtree !== null) {
      mountTrees[name] = subtree;
    }
  }

  let outputMounts: { [key: string]: ContractTree };
  if (args.mountName !== undefined) {
    if (!(args.mountName in mountTrees)) {
      const available = Object.keys(mountTrees).sort().join(', ');
      process.stderr.write(
        `Error: mount "${args.mountName}" not found. Available mounts: ${available}\n`
      );
      await disposeAll(project.disposes);
      return 1;
    }
    const single = mountTrees[args.mountName]!;
    outputMounts = { [args.mountName]: single };
  } else {
    outputMounts = mountTrees;
  }

  const output = {
    rillVersion: VERSION,
    configPath,
    mounts: outputMounts,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');

  await disposeAll(project.disposes);

  if (args.strict) {
    const anyPaths: string[] = [];
    for (const key of Object.keys(outputMounts).sort()) {
      const child = outputMounts[key];
      if (child !== undefined) {
        collectAnyReturnCallables(child, key, anyPaths);
      }
    }
    if (anyPaths.length > 0) {
      for (const p of anyPaths) {
        process.stderr.write(
          `[strict] callable at path "${p}" has returnType: any\n`
        );
      }
      return 1;
    }
  }

  return 0;
}

async function runHandler(args: HandlerArgs): Promise<number> {
  const { configPath, project } = await loadConfigAndProject(args.configFlag);
  const projectRoot = dirname(configPath);

  const mainField = project.config.main;
  if (mainField === undefined) {
    process.stderr.write(
      'Error: rill-config.json has no main field; nothing to describe\n'
    );
    await disposeAll(project.disposes);
    return 1;
  }

  let parsedMain: ReturnType<typeof parseMainField>;
  try {
    parsedMain = parseMainField(mainField);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(err.message + '\n');
      await disposeAll(project.disposes);
      return 1;
    }
    throw err;
  }

  const { filePath, handlerName } = parsedMain;
  if (handlerName === undefined) {
    process.stderr.write(
      `Error: main "${mainField}" is not a handler reference; expected "file.rill:handlerName"\n`
    );
    await disposeAll(project.disposes);
    return 1;
  }

  const absolutePath = resolve(projectRoot, filePath);
  let source: string;
  try {
    source = readFileSync(absolutePath, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(message + '\n');
    await disposeAll(project.disposes);
    return 1;
  }

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(message + '\n');
    await disposeAll(project.disposes);
    return 1;
  }

  const runtimeOptions: RuntimeOptions = {
    ...project.resolverConfig,
    parseSource: parse,
  };
  const ctx = createRuntimeContext(runtimeOptions);

  try {
    await execute(ast, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(message + '\n');
    await disposeAll(project.disposes);
    return 1;
  }

  const handlerValue = ctx.variables.get(handlerName);
  if (handlerValue === undefined || !isScriptCallable(handlerValue)) {
    process.stderr.write(
      `Error: handler "${handlerName}" not found or is not a closure in ${filePath}\n`
    );
    await disposeAll(project.disposes);
    return 1;
  }

  const entry = buildCallableEntry(handlerValue);
  const output = {
    rillVersion: VERSION,
    configPath,
    handler: {
      name: handlerName,
      file: filePath,
      ...entry,
    },
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');

  await disposeAll(project.disposes);

  if (args.strict) {
    const anyPaths: string[] = [];
    collectAnyReturnCallables(entry, `handler.${handlerName}`, anyPaths);
    if (anyPaths.length > 0) {
      for (const p of anyPaths) {
        process.stderr.write(
          `[strict] callable at path "${p}" has returnType: any\n`
        );
      }
      return 1;
    }
  }

  return 0;
}

function runBuiltins(args: BuiltinsArgs): number {
  const ctx = createRuntimeContext();
  const visited = new WeakSet<object>();
  const callables: { [key: string]: ContractTree } = {};

  // Top-level functions: only typed callables with inspectable params are emitted.
  // Raw CallableFn entries and callable() wrappers (params: undefined) are skipped.
  for (const [name, fn] of ctx.functions) {
    const v = fn as RillValue;
    if (isCallable(v) && v.params !== undefined) {
      callables[name] = buildCallableEntry(v);
    }
  }

  // Per-type method dicts: nested under each type name.
  const typeNamespace: { [key: string]: ContractTree } = {};
  for (const [typeName, methodDict] of ctx.typeMethodDicts) {
    const subtree = buildTree(methodDict as RillValue, visited);
    if (subtree !== null) {
      typeNamespace[typeName] = subtree;
    }
  }

  const output = {
    rillVersion: VERSION,
    mode: 'builtins',
    callables,
    typeMethods: typeNamespace,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');

  if (args.strict) {
    const anyPaths: string[] = [];
    for (const key of Object.keys(callables).sort()) {
      const child = callables[key];
      if (child !== undefined) {
        collectAnyReturnCallables(child, key, anyPaths);
      }
    }
    for (const typeName of Object.keys(typeNamespace).sort()) {
      const child = typeNamespace[typeName];
      if (child !== undefined) {
        collectAnyReturnCallables(child, `typeMethods.${typeName}`, anyPaths);
      }
    }
    if (anyPaths.length > 0) {
      for (const p of anyPaths) {
        process.stderr.write(
          `[strict] callable at path "${p}" has returnType: any\n`
        );
      }
      return 1;
    }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  dotenvConfig({ quiet: true });

  let parsed: ParsedArgs | { mode: 'help' };
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof DescribeArgError) {
      process.stderr.write(err.message + '\n');
      return 1;
    }
    throw err;
  }

  try {
    if ('mode' in parsed) {
      showHelp();
      return 0;
    }

    switch (parsed.cmd) {
      case 'project':
        return await runProject(parsed);
      case 'handler':
        return await runHandler(parsed);
      case 'builtins':
        return runBuiltins(parsed);
    }
  } catch (err) {
    if (err instanceof DescribeExitError) {
      process.stderr.write(err.message + '\n');
      return err.code;
    }
    throw err;
  }
}
