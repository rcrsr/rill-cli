import { access } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { toNative } from '@rcrsr/rill';
import type { RillValue } from '@rcrsr/rill';
import { BuildError } from '../build/build.js';
import type {
  CompiledPackage,
  PostBuildContext,
  RillHarness,
  ServeContext,
} from '../harness.js';

// ============================================================
// INTERNAL HELPERS
// ============================================================

/**
 * Convert a package mount or name to a safe JS identifier fragment.
 * Replaces non-alphanumeric characters with underscores.
 */
function toSafeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * Verify that a handler file exists at the given path. If the file is
 * missing (ENOENT), throws BuildError with phase 'harness'. Any other
 * error (e.g. permission errors) is rethrown unchanged.
 */
async function assertHandlerFile(handlerPath: string): Promise<void> {
  try {
    await access(handlerPath);
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      throw new BuildError(`missing handler file: ${handlerPath}`, 'harness');
    }
    throw err;
  }
}

/**
 * Resolve the effective mount from process.argv[2], falling back to
 * the bundle's defaultPackage or the first available package mount.
 */
function resolveMount(
  packages: readonly CompiledPackage[],
  argvMount: string | undefined,
  defaultPackage: string | undefined
): string | undefined {
  if (argvMount !== undefined) return argvMount;
  if (defaultPackage !== undefined) return defaultPackage;
  return packages[0]?.mount;
}

// ============================================================
// DISPATCH BY MOUNT
// ============================================================

/** Introspected handler param, as returned by the handler module's describe(). */
interface HandlerParamDescriptor {
  readonly name: string;
}

/** Shape describe() returns: null when introspection was unavailable. */
interface HandlerDescription {
  readonly params?: readonly HandlerParamDescriptor[];
}

/** The handler lifecycle contract emitted by build.ts's generateHandlerSource. */
interface HandlerModule {
  readonly describe?: () => HandlerDescription | null;
  readonly init: (context?: Record<string, unknown>) => Promise<void>;
  readonly execute: (
    request?: { params?: Record<string, unknown> },
    context?: Record<string, unknown>
  ) => Promise<{ result?: unknown; streamed?: boolean }>;
  readonly dispose: () => Promise<void>;
}

/**
 * Map a positional args array onto a request.params dict, using the
 * handler's introspected param names in declaration order. Mirrors the
 * dict → positional mapping build.ts's execute() applies in the other
 * direction (build.ts:1099-1105). Only attempted when the caller passes
 * args; otherwise params stays empty, matching generateRunSource's
 * `execute({ params: {} }, ...)` call.
 */
function buildRequestParams(
  args: readonly string[],
  describeFn: HandlerModule['describe']
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (args.length === 0 || typeof describeFn !== 'function') {
    return params;
  }
  const desc = describeFn();
  if (desc === null || desc === undefined || !Array.isArray(desc.params)) {
    return params;
  }
  desc.params.forEach((p, i) => {
    if (i < args.length) {
      params[p.name] = args[i];
    }
  });
  return params;
}

/**
 * Routes a mount string to the compiled handler module, drives its
 * init/execute/dispose lifecycle with the provided args, and returns the
 * numeric exit code.
 *
 * On unknown mount, writes the standard error message to stderr and returns 1.
 * On missing handler file, throws BuildError with phase 'harness'.
 */
async function dispatchByMount(
  packages: readonly CompiledPackage[],
  mount: string | undefined,
  args: string[]
): Promise<number> {
  const availableMounts = packages.map((p) => p.mount);

  if (mount === undefined) {
    process.stderr.write(
      `Unknown package: ${String(mount)}. Available: ${availableMounts.join(', ')}.\n`
    );
    return 1;
  }

  const pkg = packages.find((p) => p.mount === mount);
  if (pkg === undefined) {
    process.stderr.write(
      `Unknown package: ${mount}. Available: ${availableMounts.join(', ')}.\n`
    );
    return 1;
  }

  const handlerPath = path.join(pkg.buildOutput.outputPath, 'handler.js');

  await assertHandlerFile(handlerPath);

  const handlerUrl = pathToFileURL(handlerPath).href;
  const mod = (await import(handlerUrl)) as Partial<HandlerModule>;

  if (
    typeof mod.init !== 'function' ||
    typeof mod.execute !== 'function' ||
    typeof mod.dispose !== 'function'
  ) {
    throw new BuildError(
      `handler module at ${handlerPath} does not export the init/execute/dispose lifecycle`,
      'harness'
    );
  }

  await mod.init({});
  try {
    const params = buildRequestParams(args, mod.describe);
    const { result, streamed } = await mod.execute({ params });
    if (
      streamed !== true &&
      result !== undefined &&
      result !== '' &&
      result !== false
    ) {
      process.stdout.write(
        `${JSON.stringify(toNative(result as RillValue).value, null, 2)}\n`
      );
    }
    return result === false || result === '' ? 1 : 0;
  } finally {
    await mod.dispose();
  }
}

// ============================================================
// POST-BUILD
// ============================================================

async function postBuild(ctx: PostBuildContext): Promise<void> {
  const { outputDir, packages, bundle, logger } = ctx;

  logger.info('[builtin harness] verifying handler files');

  // Verify each package's handler.js exists in the output directory.
  await Promise.all(
    packages.map((pkg) =>
      assertHandlerFile(path.join(outputDir, pkg.packageName, 'handler.js'))
    )
  );

  logger.info('[builtin harness] emitting main.js');

  // Build static import lines and handler registry — each package's
  // handler.js exports the named lifecycle (describe/init/execute/dispose),
  // never a default export (mirrors build.ts's generateHandlerSource).
  const importLines = packages
    .map((pkg) => {
      const id = toSafeIdentifier(pkg.packageName);
      return `import { describe as describe_${id}, init as init_${id}, execute as execute_${id}, dispose as dispose_${id} } from ${JSON.stringify(`./${pkg.packageName}/handler.js`)};`;
    })
    .join('\n');

  const registryEntries = packages
    .map((pkg) => {
      const id = toSafeIdentifier(pkg.packageName);
      return `  ${JSON.stringify(pkg.mount)}: { describe: describe_${id}, init: init_${id}, execute: execute_${id}, dispose: dispose_${id} },`;
    })
    .join('\n');

  // Determine the fallback mount for when no argv mount is provided.
  const defaultMount = bundle.defaultPackage || packages[0]?.mount || '';

  const availableMountsJson = JSON.stringify(
    packages.map((p) => p.mount).join(', ')
  );
  const unknownMountMessage = (mountExpr: string): string =>
    `\`Unknown package: \${${mountExpr}}. Available: \${${availableMountsJson}}.\``;

  const mainSource = [
    `// Generated by @rcrsr/rill-cli/builtin harness`,
    `import { toNative } from '@rcrsr/rill';`,
    importLines,
    ``,
    `const registry = {`,
    registryEntries,
    `};`,
    ``,
    `const mount = process.argv[2] ?? ${JSON.stringify(defaultMount)};`,
    `const entry = registry[mount];`,
    ``,
    `if (entry === undefined) {`,
    `  process.stderr.write(${unknownMountMessage('mount')} + '\\n');`,
    `  process.exit(1);`,
    `}`,
    ``,
    `const args = process.argv.slice(3);`,
    `await entry.init({});`,
    `let exitCode = 0;`,
    `try {`,
    `  const params = {};`,
    `  if (args.length > 0 && typeof entry.describe === 'function') {`,
    `    const desc = entry.describe();`,
    `    if (desc !== null && Array.isArray(desc.params)) {`,
    `      desc.params.forEach((p, i) => { if (i < args.length) params[p.name] = args[i]; });`,
    `    }`,
    `  }`,
    `  const result = await entry.execute({ params });`,
    `  if (result.streamed !== true && result.result !== undefined && result.result !== '' && result.result !== false) {`,
    `    process.stdout.write(JSON.stringify(toNative(result.result).value, null, 2) + '\\n');`,
    `  }`,
    `  exitCode = result.result === false || result.result === '' ? 1 : 0;`,
    `} finally {`,
    `  await entry.dispose();`,
    `}`,
    `process.exit(exitCode);`,
  ].join('\n');

  const mainFile = path.join(outputDir, 'main.js');
  await writeFile(mainFile, mainSource, 'utf-8');

  logger.info(`[builtin harness] wrote ${mainFile}`);

  const pkgFile = path.join(outputDir, 'package.json');
  try {
    await writeFile(pkgFile, '{"type":"module"}\n', {
      encoding: 'utf-8',
      flag: 'wx',
    });
    logger.info(`[builtin harness] wrote ${pkgFile}`);
  } catch (err) {
    if (
      typeof err !== 'object' ||
      err === null ||
      (err as { code?: unknown }).code !== 'EEXIST'
    )
      throw err;
  }
}

// ============================================================
// SERVE
// ============================================================

async function serve(ctx: ServeContext): Promise<number> {
  const { logger, bundle, onShutdown, packages, requestedMount, args } = ctx;

  onShutdown(() => {
    logger.info('[builtin harness] shutting down');
  });

  // Use the packages already built by the caller (e.g. runBundleServe's
  // initialBuild) rather than triggering a redundant full rebuild via
  // ctx.compile(); compile() is reserved for harnesses that implement
  // rebuild-on-change.
  const mount = resolveMount(packages, requestedMount, bundle.defaultPackage);

  logger.info(`[builtin harness] dispatching mount: ${String(mount)}`);

  return dispatchByMount(packages, mount, [...args]);
}

// ============================================================
// BUILTIN HARNESS
// ============================================================

export const builtinHarness: RillHarness = {
  name: '@rcrsr/rill-cli/builtin',
  postBuild,
  serve,
};
