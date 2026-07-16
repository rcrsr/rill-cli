/**
 * Shared bundle-resolution helpers for extension and harness commands.
 *
 * install.ts, uninstall.ts, upgrade.ts, and list.ts all need to determine
 * which project directory (and therefore which .rill/npm/ prefix) an
 * extension or harness operation applies to, depending on whether the
 * current directory is inside a package or a bundle. This module centralizes
 * that resolution so behavior stays byte-identical across commands.
 */

import path from 'node:path';
import {
  findBundleRoot,
  readBundleConfig,
  BundleConfigError,
} from '../bundle/config.js';
import { resolvePrefix } from './prefix.js';

// ============================================================
// TARGET PACKAGE DIR RESOLUTION
// ============================================================

/**
 * Resolves the target package directory for an extension install in bundle
 * mode.
 *
 * When installing from the bundle root, `--for <mount>` is required to
 * disambiguate which package should mount the extension. Otherwise the
 * current project directory is the target.
 *
 * Returns the resolved directory, or an error exit code after writing
 * verbatim stderr copy explaining why resolution failed.
 */
export async function resolveTargetPackageDir(opts: {
  bundleRoot: string;
  projectDir: string;
  forMount: string | undefined;
}): Promise<{ dir: string } | { error: number }> {
  const { bundleRoot, projectDir, forMount } = opts;

  const atBundleRoot = path.resolve(projectDir) === path.resolve(bundleRoot);

  if (atBundleRoot && forMount === undefined) {
    process.stderr.write(
      'Cannot determine target package. Use `rill install <pkg> --for <mount>` to specify which package should mount this extension.\n'
    );
    return { error: 1 };
  }

  if (forMount !== undefined) {
    let bundleConfig: Awaited<ReturnType<typeof readBundleConfig>>;
    try {
      bundleConfig = await readBundleConfig(bundleRoot);
    } catch (err) {
      if (err instanceof BundleConfigError) {
        process.stderr.write(`✗ ${err.message}\n`);
        return { error: 1 };
      }
      throw err;
    }
    const entry = bundleConfig.packages.find((p) => p.mount === forMount);
    if (entry === undefined) {
      process.stderr.write(
        `✗ Package mount '${forMount}' not found in rill-bundle.json\n`
      );
      return { error: 1 };
    }
    return { dir: path.resolve(bundleRoot, entry.project) };
  }

  return { dir: projectDir };
}

// ============================================================
// EXTENSION TARGET RESOLUTION
// ============================================================

export interface ExtensionTarget {
  readonly bundleRoot: string | null;
  readonly targetDir: string;
  readonly prefix: string;
}

/**
 * Resolves the extension target (directory whose rill-config.json and
 * .rill/npm/ apply) for uninstall/upgrade/list commands.
 *
 * In package mode (no ancestor rill-bundle.json), the target is always the
 * project directory itself. In bundle mode, delegates to
 * resolveTargetPackageDir to disambiguate via `--for <mount>`.
 */
export async function resolveExtensionTarget(opts: {
  projectDir: string;
  forMount: string | undefined;
}): Promise<{ target: ExtensionTarget } | { error: number }> {
  const { projectDir, forMount } = opts;

  const bundleRoot = findBundleRoot(projectDir);

  if (bundleRoot === null) {
    return {
      target: {
        bundleRoot: null,
        targetDir: projectDir,
        prefix: resolvePrefix(projectDir),
      },
    };
  }

  const resolved = await resolveTargetPackageDir({
    bundleRoot,
    projectDir,
    forMount,
  });

  if ('error' in resolved) {
    return { error: resolved.error };
  }

  return {
    target: {
      bundleRoot,
      targetDir: resolved.dir,
      prefix: resolvePrefix(resolved.dir),
    },
  };
}

// ============================================================
// HARNESS TARGET RESOLUTION
// ============================================================

export interface HarnessTarget {
  readonly bundleRoot: string;
  readonly prefix: string;
  readonly harnessName: string;
}

/**
 * Resolves the harness target (bundle root, prefix, and recorded harness
 * specifier) for `--harness` uninstall/upgrade commands.
 *
 * Requires an ancestor rill-bundle.json with a `harness` field declared.
 */
export async function resolveHarnessTarget(
  projectDir: string
): Promise<{ target: HarnessTarget } | { error: number }> {
  const bundleRoot = findBundleRoot(projectDir);

  if (bundleRoot === null) {
    process.stderr.write(
      '✗ --harness requires a bundle. No rill-bundle.json found in this directory or any parent.\n'
    );
    return { error: 1 };
  }

  let bundleConfig: Awaited<ReturnType<typeof readBundleConfig>>;
  try {
    bundleConfig = await readBundleConfig(bundleRoot);
  } catch (err) {
    if (err instanceof BundleConfigError) {
      process.stderr.write(`✗ ${err.message}\n`);
      return { error: 1 };
    }
    throw err;
  }

  if (bundleConfig.harness === undefined) {
    process.stderr.write('✗ No harness declared in rill-bundle.json.\n');
    return { error: 1 };
  }

  return {
    target: {
      bundleRoot,
      prefix: path.join(bundleRoot, '.rill', 'npm'),
      harnessName: bundleConfig.harness,
    },
  };
}
