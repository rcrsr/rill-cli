import path from 'node:path';
import { BuildError } from '../build/build.js';
import { readBundleConfig, BundleConfigError } from '../bundle/config.js';
import { builtinHarness } from '../harness/builtin.js';
import { makeLogger, resolveHarness, buildPackages } from './bundle-shared.js';
import type { RillHarness, PostBuildContext } from '../harness.js';

// ============================================================
// PUBLIC TYPES
// ============================================================

export interface BundleBuildOptions {
  readonly [key: string]: unknown;
}

// ============================================================
// runBundleBuild
// ============================================================

export async function runBundleBuild(
  bundleDir: string,
  _opts: BundleBuildOptions
): Promise<number> {
  // Step 1: Read bundle config
  let bundleConfig;
  try {
    bundleConfig = await readBundleConfig(bundleDir);
  } catch (err) {
    if (err instanceof BundleConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  // Step 2: Build all packages concurrently
  const { packages } = bundleConfig;
  process.stdout.write(`building ${packages.length} packages...\n`);

  const built = await buildPackages(bundleDir, packages);
  if (built.packages === null) {
    return built.exitCode;
  }
  const compiledPackages = built.packages;

  // Step 3: Resolve harness
  let harness: RillHarness;
  if (bundleConfig.harness !== undefined) {
    try {
      harness = await resolveHarness(bundleConfig.harness, bundleDir);
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

  // Step 4: Build Logger and PostBuildContext
  const logger = makeLogger();

  const ctx: PostBuildContext = {
    bundleDir,
    bundle: bundleConfig,
    config: bundleConfig.config,
    logger,
    outputDir: path.join(bundleDir, 'build'),
    packages: compiledPackages,
  };

  // Step 5: Invoke harness.postBuild
  process.stdout.write('running harness postBuild...\n');

  if (harness.postBuild === undefined) {
    process.stderr.write(
      `harness '${harness.name}' does not define postBuild\n`
    );
    return 1;
  }

  try {
    await harness.postBuild(ctx);
  } catch (err) {
    if (err instanceof BuildError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  // Step 6: Report success
  //
  // No generic output-file check runs here: the RillHarness contract (see
  // src/harness.ts) does not oblige postBuild to emit any specific file —
  // that convention belongs to the built-in harness alone. A harness signals
  // failure by throwing (caught above), not by an inspectable output shape.
  process.stdout.write(`built bundle: ${path.join(bundleDir, 'build')}\n`);
  return 0;
}
