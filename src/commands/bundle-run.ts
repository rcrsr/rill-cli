import { BuildError } from '../build/build.js';
import { readBundleConfig, BundleConfigError } from '../bundle/config.js';
import { builtinHarness } from '../harness/builtin.js';
import { makeLogger, resolveHarness, buildPackages } from './bundle-shared.js';
import type { RillHarness, CompiledPackage, ServeContext } from '../harness.js';

// ============================================================
// PUBLIC TYPES
// ============================================================

export interface BundleRunOptions {
  readonly [key: string]: unknown;
}

// ============================================================
// runBundleServe
// ============================================================

export async function runBundleServe(
  bundleDir: string,
  _opts: BundleRunOptions
): Promise<number> {
  // Step 1: Read bundle config
  let bundle;
  try {
    bundle = await readBundleConfig(bundleDir);
  } catch (err) {
    if (err instanceof BundleConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  // Step 2: Resolve harness
  let harness: RillHarness;
  if (bundle.harness !== undefined) {
    try {
      harness = await resolveHarness(bundle.harness, bundleDir);
    } catch (err) {
      if (err instanceof BuildError) {
        process.stderr.write(`${err.message}\n`);
        return 1;
      }
      throw err;
    }
  } else {
    harness = builtinHarness;
  }

  // Step 3: Build initial packages set
  const logger = makeLogger();
  logger.info('starting');

  const initialBuild = await buildPackages(bundleDir, bundle.packages);
  if (initialBuild.packages === null) {
    return initialBuild.exitCode;
  }

  // Mutable internal packages array — mutated in place by compile()
  const packagesArray: CompiledPackage[] = [...initialBuild.packages];

  // Step 4: Allocate handler registries
  const shutdownHandlers: Array<() => Promise<void> | void> = [];
  const sourceChangeHandlers: Array<(event: unknown) => void> = [];

  // Step 5: Build ServeContext
  const ctx: ServeContext = {
    bundleDir,
    bundle,
    config: bundle.config,
    logger,
    get packages() {
      return packagesArray as readonly CompiledPackage[];
    },
    compile: async (): Promise<CompiledPackage[]> => {
      const rebuild = await buildPackages(bundleDir, bundle.packages);
      if (rebuild.packages === null) {
        throw new BuildError(
          'compile() failed: one or more packages failed to build',
          'compilation'
        );
      }
      // Mutate in place so harness sees updated packages via ctx.packages
      packagesArray.length = 0;
      for (const pkg of rebuild.packages) {
        packagesArray.push(pkg);
      }
      return [...packagesArray];
    },
    onSourceChange: (handler: () => void | Promise<void>): void => {
      sourceChangeHandlers.push(handler as (event: unknown) => void);
    },
    onShutdown: (handler: () => void | Promise<void>): void => {
      shutdownHandlers.push(handler);
    },
  };

  // Step 6: Register process signal handlers. The signal handler resolves a
  // shutdown promise after running shutdown handlers instead of calling
  // process.exit() directly — the caller (cli.ts) owns the actual exit.
  let resolveShutdown: (() => void) | undefined;
  const shutdownSignal = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const handleSignal = async (): Promise<void> => {
    logger.info('shutting-down');
    for (const h of shutdownHandlers) {
      try {
        await h();
      } catch (e) {
        process.stderr.write(
          `shutdown handler error: ${e instanceof Error ? e.message : String(e)}\n`
        );
      }
    }
    resolveShutdown?.();
  };

  const handleSigint = () => void handleSignal();
  const handleSigterm = () => void handleSignal();
  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);

  // Step 7: Check harness implements serve
  if (harness.serve === undefined) {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    process.stderr.write(
      `Harness '${harness.name}' does not implement serve()\n`
    );
    logger.error('error');
    return 1;
  }

  // Step 8: Race serve() against the signal-triggered shutdown promise and
  // return its exit code
  logger.info('serving');
  let exitCode: number;
  try {
    exitCode = await Promise.race([
      harness.serve(ctx),
      shutdownSignal.then(() => 0),
    ]);
  } catch (err) {
    if (err instanceof BuildError) {
      logger.error('error');
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
  }
  return exitCode;
}
