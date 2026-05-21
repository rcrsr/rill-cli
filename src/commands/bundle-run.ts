import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPackage, BuildError } from '../build/build.js';
import { readBundleConfig, BundleConfigError } from '../bundle/config.js';
import { builtinHarness } from '../harness/builtin.js';
import type {
  RillHarness,
  CompiledPackage,
  ServeContext,
  Logger,
} from '../harness.js';

// ============================================================
// PUBLIC TYPES
// ============================================================

export interface BundleRunOptions {
  readonly [key: string]: unknown;
}

// ============================================================
// INTERNAL HELPERS
// ============================================================

function makeLogger(): Logger {
  return {
    info: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
  };
}

async function resolveHarness(
  harnessName: string,
  bundleDir: string
): Promise<RillHarness> {
  const npmRoot = path.resolve(bundleDir, '.rill/npm');
  const npmPkgJson = path.join(npmRoot, 'package.json');
  try {
    const req = createRequire(pathToFileURL(npmPkgJson).href);
    const resolvedPath = req.resolve(harnessName);
    const mod = (await import(pathToFileURL(resolvedPath).href)) as {
      default?: RillHarness;
    };
    const harness = mod.default;
    if (harness === undefined || typeof harness !== 'object') {
      throw new BuildError(
        `cannot resolve harness module '${harnessName}': module has no default export`,
        'harness'
      );
    }
    return harness;
  } catch (err) {
    if (err instanceof BuildError) throw err;
    const cause = err instanceof Error ? err.message : String(err);
    throw new BuildError(
      `cannot resolve harness module '${harnessName}': ${cause}`,
      'harness'
    );
  }
}

async function buildPackages(
  bundleDir: string,
  packageEntries: ReadonlyArray<{ mount: string; project: string }>
): Promise<{ packages: CompiledPackage[] | null; exitCode: number }> {
  const buildOutputDir = path.join(bundleDir, 'build');
  const settled = await Promise.allSettled(
    packageEntries.map((p) =>
      buildPackage(path.resolve(bundleDir, p.project), {
        outputDir: buildOutputDir,
      })
    )
  );

  const failures: Array<{ index: number; reason: unknown }> = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    if (result.status === 'rejected') {
      failures.push({ index: i, reason: result.reason });
    }
  }

  if (failures.length > 0) {
    for (const { index, reason } of failures) {
      const mount = packageEntries[index]?.mount ?? `packages[${index}]`;
      const msg = reason instanceof Error ? reason.message : String(reason);
      process.stderr.write(`package '${mount}' build failed: ${msg}\n`);
    }
    return { packages: null, exitCode: 1 };
  }

  const compiled: CompiledPackage[] = [];
  for (let i = 0; i < packageEntries.length; i++) {
    const entry = packageEntries[i]!;
    const result = settled[i]!;
    if (result.status !== 'fulfilled') continue;
    const buildOutput = result.value;
    const packageName = path.basename(buildOutput.outputPath);
    const packageDir = path.resolve(bundleDir, entry.project);
    compiled.push({
      mount: entry.mount,
      packageName,
      packageDir,
      buildOutput,
    });
  }

  return { packages: compiled, exitCode: 0 };
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

  // Step 6: Register process signal handlers
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
    process.exit(0);
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

  // Step 8: Invoke serve and return its exit code
  logger.info('serving');
  let exitCode: number;
  try {
    exitCode = await harness.serve(ctx);
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
