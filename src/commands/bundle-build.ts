import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPackage, BuildError } from '../build/build.js';
import { readBundleConfig, BundleConfigError } from '../bundle/config.js';
import { builtinHarness } from '../harness/builtin.js';
import type {
  RillHarness,
  CompiledPackage,
  PostBuildContext,
  Logger,
} from '../harness.js';

// ============================================================
// PUBLIC TYPES
// ============================================================

export interface BundleBuildOptions {
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

  const buildOutputDir = path.join(bundleDir, 'build');
  const settled = await Promise.allSettled(
    packages.map((p) =>
      buildPackage(path.resolve(bundleDir, p.project), {
        outputDir: buildOutputDir,
      })
    )
  );

  // Step 3: Collect failures
  const failures: Array<{ index: number; reason: unknown }> = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    if (result.status === 'rejected') {
      failures.push({ index: i, reason: result.reason });
    }
  }

  if (failures.length > 0) {
    for (const { index, reason } of failures) {
      const mount = packages[index]?.mount ?? `packages[${index}]`;
      const msg = reason instanceof Error ? reason.message : String(reason);
      process.stderr.write(`package '${mount}' build failed: ${msg}\n`);
    }
    return 1;
  }

  // Step 4: Build CompiledPackage[]
  const compiledPackages: CompiledPackage[] = [];
  for (let i = 0; i < packages.length; i++) {
    const entry = packages[i]!;
    const result = settled[i]!;
    // All results are fulfilled at this point (failures returned above)
    if (result.status !== 'fulfilled') continue;
    const buildOutput = result.value;
    const packageName = path.basename(buildOutput.outputPath);
    const packageDir = path.resolve(bundleDir, entry.project);
    compiledPackages.push({
      mount: entry.mount,
      packageName,
      packageDir,
      buildOutput,
    });
  }

  // Step 5: Resolve harness
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

  // Step 6: Build Logger and PostBuildContext
  const logger = makeLogger();

  const ctx: PostBuildContext = {
    bundleDir,
    bundle: bundleConfig,
    config: bundleConfig.config,
    logger,
    outputDir: path.join(bundleDir, 'build'),
    packages: compiledPackages,
  };

  // Step 7: Invoke harness.postBuild
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

  // Step 8: Verify build/main.js exists
  const mainJsPath = path.join(bundleDir, 'build', 'main.js');
  try {
    await access(mainJsPath);
  } catch {
    process.stderr.write('build/main.js missing after postBuild\n');
    return 1;
  }

  // Step 9: Report success
  process.stdout.write(`built bundle: ${path.join(bundleDir, 'build')}\n`);
  return 0;
}
