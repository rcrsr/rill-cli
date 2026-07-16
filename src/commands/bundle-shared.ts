import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPackage, BuildError } from '../build/build.js';
import type { RillHarness, CompiledPackage, Logger } from '../harness.js';

// ============================================================
// CONSTANTS
// ============================================================

// bounds concurrent esbuild memory; chdirQueue already serializes the dry-run
const MAX_CONCURRENT_BUILDS = Math.max(
  1,
  Math.min(4, os.availableParallelism?.() ?? 4)
);

// ============================================================
// LOGGER
// ============================================================

export function makeLogger(): Logger {
  return {
    info: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
  };
}

// ============================================================
// HARNESS RESOLUTION
// ============================================================

export async function resolveHarness(
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
// PACKAGE BUILDING
// ============================================================

export async function buildPackages(
  bundleDir: string,
  packageEntries: ReadonlyArray<{ mount: string; project: string }>
): Promise<{ packages: CompiledPackage[] | null; exitCode: number }> {
  const buildOutputDir = path.join(bundleDir, 'build');

  // bounds concurrent esbuild memory; chdirQueue already serializes the dry-run
  const settled: Array<
    PromiseSettledResult<Awaited<ReturnType<typeof buildPackage>>>
  > = new Array(packageEntries.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++;
      if (index >= packageEntries.length) return;
      const entry = packageEntries[index]!;
      try {
        const value = await buildPackage(
          path.resolve(bundleDir, entry.project),
          { outputDir: buildOutputDir }
        );
        settled[index] = { status: 'fulfilled', value };
      } catch (reason) {
        settled[index] = { status: 'rejected', reason };
      }
    }
  };
  const workerCount = Math.min(MAX_CONCURRENT_BUILDS, packageEntries.length);
  await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));

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
