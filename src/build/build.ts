import { readFileSync, existsSync } from 'node:fs';
import { mkdir, rm, writeFile, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build as esbuild } from 'esbuild';
import type { BuildFailure } from 'esbuild';
import {
  loadProject,
  parseMainField,
  ConfigEnvError,
  ExtensionLoadError,
} from '@rcrsr/rill-config';
import { parse, introspectHandlerFromAST } from '@rcrsr/rill';
import { computeChecksum } from './checksum.js';

// ============================================================
// COMPILE ERROR
// ============================================================

export class BuildError extends Error {
  readonly phase: string;
  constructor(message: string, phase: string) {
    super(message);
    this.name = 'BuildError';
    this.phase = phase;
  }
}

// ============================================================
// PUBLIC TYPES
// ============================================================

export interface BuildOptions {
  readonly outputDir?: string | undefined;
  readonly introspect?: boolean | undefined;
}

export interface BuildResult {
  readonly outputPath: string;
  readonly checksum: string;
}

// ============================================================
// INTERNAL HELPERS
// ============================================================

/**
 * Read the installed @rcrsr/rill version via createRequire.
 * Resolves the main entry point and walks up to the package.json.
 * Falls back to 'unknown' if the package.json cannot be resolved.
 */
function readRillVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const mainPath = require.resolve('@rcrsr/rill');
    let dir = path.dirname(mainPath);
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, 'package.json');
      try {
        const raw = readFileSync(candidate, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'name' in parsed &&
          (parsed as Record<string, unknown>)['name'] === '@rcrsr/rill' &&
          'version' in parsed &&
          typeof (parsed as Record<string, unknown>)['version'] === 'string'
        ) {
          return (parsed as Record<string, string>)['version']!;
        }
      } catch {
        // Not found at this level, continue up
      }
      dir = path.dirname(dir);
    }
  } catch {
    // Fall through to default
  }
  return 'unknown';
}

/**
 * Bundle an extension source (local file or npm package) to ESM via esbuild.
 * For local files, srcPath is a file path. For npm packages, srcPath is the
 * package specifier (e.g., '@rcrsr/rill-ext-openai') and esbuild resolves it.
 * Throws BuildError (phase: 'compilation') on resolution or build error.
 */
async function bundleExtensionToFile(
  srcPath: string,
  destPath: string,
  projectDir: string
): Promise<void> {
  // Only check file existence for local paths, not npm specifiers
  const isLocal =
    srcPath.startsWith('./') ||
    srcPath.startsWith('../') ||
    path.isAbsolute(srcPath);
  if (isLocal && !existsSync(srcPath)) {
    throw new BuildError(
      `Extension source not found: ${srcPath}`,
      'compilation'
    );
  }

  // For npm packages, find the package.json before bundling so we can
  // inline it post-build if esbuild's CJS shim references it.
  // Resolve from the project directory where extensions are installed.
  let sourcePkgJson: string | undefined;
  if (!isLocal) {
    try {
      const projectRequire = createRequire(
        pathToFileURL(path.resolve(projectDir, 'package.json')).href
      );
      const entryPath = projectRequire.resolve(srcPath);
      let dir = path.dirname(entryPath);
      while (dir !== path.dirname(dir)) {
        const candidate = path.join(dir, 'package.json');
        if (existsSync(candidate)) {
          sourcePkgJson = readFileSync(candidate, 'utf-8').trim();
          break;
        }
        dir = path.dirname(dir);
      }
    } catch {
      // Not critical — extension will work without version info
    }
  }

  try {
    await esbuild({
      entryPoints: [srcPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: destPath,
      logLevel: 'silent',
      absWorkingDir: projectDir,
    });

    // Post-process: inline _require("...package.json") left by esbuild's
    // CJS-to-ESM shim. createRequire wraps can't be intercepted by plugins.
    if (sourcePkgJson !== undefined) {
      let bundled = readFileSync(destPath, 'utf-8');
      const before = bundled;
      bundled = bundled.replace(
        /_require\("[^"]*package\.json"\)/g,
        sourcePkgJson
      );
      if (bundled !== before) {
        await writeFile(destPath, bundled, 'utf-8');
      }
    }
  } catch (err) {
    const failure = err as BuildFailure;
    if (Array.isArray(failure.errors) && failure.errors.length > 0) {
      const first = failure.errors[0]!;
      const file = first.location?.file ?? srcPath;
      const line = first.location?.line ?? 0;
      const msg = first.text;
      throw new BuildError(
        `Compilation error in ${file}:${line}: ${msg}`,
        'compilation'
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new BuildError(
      `Compilation error in ${srcPath}:0: ${msg}`,
      'compilation'
    );
  }
}

// ============================================================
// PACKAGE BUILDER (per-package file operations)
// ============================================================

interface PackageBuildInput {
  readonly name: string;
  readonly entry: string;
  readonly modules: Record<string, string>;
  readonly extensions: Record<string, string>;
  readonly originalConfig: Record<string, unknown>;
}

/**
 * Returns true when a mount specifier refers to a local file
 * (starts with './' or '../', or is an absolute path).
 */
function isLocalExtension(mountSpecifier: string): boolean {
  return (
    mountSpecifier.startsWith('./') ||
    mountSpecifier.startsWith('../') ||
    path.isAbsolute(mountSpecifier)
  );
}

/**
 * Resolve the version for an extension mount.
 * For npm packages: walks up from the resolved entry to find the package.json
 * version field. For local files: uses the project config's own version field.
 * Returns '0.0.0' when the version cannot be determined.
 */
function resolveExtensionVersion(
  mountSpecifier: string,
  projectDir: string,
  pkg: PackageBuildInput
): string {
  if (isLocalExtension(mountSpecifier)) {
    const v = pkg.originalConfig['version'];
    return typeof v === 'string' && v.length > 0 ? v : '0.0.0';
  }
  try {
    const projectRequire = createRequire(
      pathToFileURL(path.resolve(projectDir, 'package.json')).href
    );
    const entryPath = projectRequire.resolve(mountSpecifier);
    let dir = path.dirname(entryPath);
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, 'package.json');
      if (existsSync(candidate)) {
        const raw = JSON.parse(readFileSync(candidate, 'utf-8')) as unknown;
        if (
          raw !== null &&
          typeof raw === 'object' &&
          'version' in raw &&
          typeof (raw as Record<string, unknown>)['version'] === 'string'
        ) {
          return (raw as Record<string, string>)['version']!;
        }
        break;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // Best-effort — fall through to default
  }
  return '0.0.0';
}

/**
 * Build a single package's output files from a rill-config.json project directory.
 * Compiles ALL extensions (local TS and npm packages) via esbuild, copies .rill
 * files, and rewrites all mount paths to local ./extensions/*.js references.
 * Returns the written file paths (rill-config.json excluded — written separately).
 */
async function buildPackageFiles(
  pkg: PackageBuildInput,
  projectDir: string,
  packageOutDir: string
): Promise<{
  writtenFiles: string[];
  rewrittenMounts: Record<string, string>;
}> {
  const writtenFiles: string[] = [];

  // Step: Copy entry .rill file (preserve original filename)
  const entrySrcPath = path.resolve(projectDir, pkg.entry);
  if (!existsSync(entrySrcPath)) {
    throw new BuildError(
      `Entry file not found: ${entrySrcPath}`,
      'compilation'
    );
  }
  const entryBasename = path.basename(pkg.entry);
  const entryDestPath = path.join(packageOutDir, entryBasename);
  await copyFile(entrySrcPath, entryDestPath);
  writtenFiles.push(entryDestPath);

  // Step: Copy module .rill files from modules directories
  const modulesMap = pkg.modules;
  for (const [alias, relPath] of Object.entries(modulesMap)) {
    if (alias.includes('/') || alias.includes('\\') || alias.includes('..')) {
      throw new BuildError(`Invalid module alias: ${alias}`, 'validation');
    }
    const srcPath = path.resolve(projectDir, relPath);
    const destPath = path.join(packageOutDir, 'modules', `${alias}.rill`);
    if (!existsSync(srcPath)) {
      throw new BuildError(
        `Module '${alias}' source not found: ${srcPath}`,
        'compilation'
      );
    }
    try {
      await mkdir(path.dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BuildError(
        `Module '${alias}' copy failed: ${msg}`,
        'compilation'
      );
    }
    writtenFiles.push(destPath);
  }

  // Step: Bundle ALL extensions via esbuild (local TS and npm packages)
  // Deduplicate: mounts sharing the same package identity share one .js file.
  const extensionsOutDir = path.join(packageOutDir, 'extensions');
  const rewrittenMounts: Record<string, string> = {};
  const bundledByIdentity = new Map<string, string>(); // identity → relative output path

  const usedFileNames = new Set<string>();

  for (const [alias, mountSpecifier] of Object.entries(pkg.extensions)) {
    // Canonical identity: resolved absolute path for local files, specifier for npm
    const identity = isLocalExtension(mountSpecifier)
      ? path.resolve(projectDir, mountSpecifier)
      : mountSpecifier;

    const existing = bundledByIdentity.get(identity);
    if (existing) {
      rewrittenMounts[alias] = existing;
      continue;
    }

    await mkdir(extensionsOutDir, { recursive: true });

    // Derive file name from package identity, not mount alias.
    // Local files: basename without extension. npm packages: sanitized specifier.
    let baseName = isLocalExtension(mountSpecifier)
      ? path.basename(identity).replace(/\.[^.]+$/, '')
      : mountSpecifier;
    let safeName = baseName.replace(/[^a-zA-Z0-9_-]/g, '-');
    // Disambiguate collisions (e.g. ./foo/ext.ts and ./bar/ext.ts)
    if (usedFileNames.has(safeName)) {
      let i = 2;
      while (usedFileNames.has(`${safeName}-${i}`)) i++;
      safeName = `${safeName}-${i}`;
    }
    usedFileNames.add(safeName);

    const version = resolveExtensionVersion(mountSpecifier, projectDir, pkg);
    const versionedName = `${safeName}@${version}`;
    const destPath = path.join(extensionsOutDir, `${versionedName}.js`);

    if (isLocalExtension(mountSpecifier)) {
      await bundleExtensionToFile(identity, destPath, projectDir);
    } else {
      await bundleExtensionToFile(mountSpecifier, destPath, projectDir);
    }

    writtenFiles.push(destPath);
    const relativePath = `./extensions/${versionedName}.js`;
    bundledByIdentity.set(identity, relativePath);
    rewrittenMounts[alias] = relativePath;
  }

  // Step: Write output rill-config.json with rewritten mount paths (without build section yet)
  const outputConfig = { ...pkg.originalConfig };
  if (Object.keys(rewrittenMounts).length > 0) {
    const existingExtBlock = outputConfig['extensions'] as
      | Record<string, unknown>
      | undefined;
    outputConfig['extensions'] = {
      ...(existingExtBlock ?? {}),
      mounts: rewrittenMounts,
    };
  }
  // Rewrite modules paths to point to the copied ./modules/<alias>.rill files
  const rewrittenModules: Record<string, string> = {};
  for (const [alias] of Object.entries(pkg.modules)) {
    rewrittenModules[alias] = `./modules/${alias}.rill`;
  }
  if (Object.keys(rewrittenModules).length > 0) {
    outputConfig['modules'] = rewrittenModules;
  }
  const rillConfigDestPath = path.join(packageOutDir, 'rill-config.json');
  await writeFile(
    rillConfigDestPath,
    JSON.stringify(outputConfig, null, 2),
    'utf-8'
  );
  // Note: rill-config.json is NOT added to writtenFiles here — it will be
  // rewritten with the build section after checksum computation.

  return { writtenFiles, rewrittenMounts };
}

// ============================================================
// BUILD PACKAGE
// ============================================================

/**
 * Compile a rill project into a self-contained output directory.
 *
 * Reads rill-config.json from projectDir, compiles local TypeScript extensions,
 * copies .rill files, rewrites extension mount paths in output config,
 * validates the completed output via loadProject() dry-run, then enriches
 * rill-config.json with a build metadata section.
 *
 * Output structure:
 *   build/
 *     <name>/
 *       main.rill
 *       rill-config.json    ← enriched with build metadata
 *       extensions/
 *
 * @param projectDir - Directory containing rill-config.json
 * @param options - Optional outputDir (default: 'build/')
 * @returns BuildResult with package output path and checksum
 * @throws BuildError for file/compilation/bundling/validation failures
 */
export async function buildPackage(
  projectDir: string,
  options?: BuildOptions
): Promise<BuildResult> {
  const absProjectDir = path.resolve(projectDir);
  const outputDir = path.resolve(options?.outputDir ?? 'build');

  // Validate rill-config.json exists
  const rillConfigSrc = path.join(absProjectDir, 'rill-config.json');
  if (!existsSync(rillConfigSrc)) {
    throw new BuildError(
      `rill-config.json not found: ${rillConfigSrc}`,
      'validation'
    );
  }

  // Read rill-config.json
  let rawConfigStr: string;
  try {
    rawConfigStr = readFileSync(rillConfigSrc, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BuildError(
      `Failed to parse rill-config.json: ${msg}`,
      'validation'
    );
  }

  // Parse raw JSON directly for build-time metadata extraction.
  // Do NOT call parseConfig here — it interpolates ${VAR} references and throws
  // ConfigEnvError when env vars are absent. The output preserves
  // ${VAR} placeholders for runtime resolution by the harness.
  let rawConfigObj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawConfigStr) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error('expected a JSON object');
    }
    rawConfigObj = parsed as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BuildError(
      `Failed to parse rill-config.json: ${msg}`,
      'validation'
    );
  }

  // Extract package name and version from raw config
  const packageName =
    typeof rawConfigObj['name'] === 'string'
      ? rawConfigObj['name']
      : path.basename(absProjectDir);
  if (
    packageName.includes('/') ||
    packageName.includes('\\') ||
    packageName.includes('..')
  ) {
    throw new BuildError(`Invalid package name: ${packageName}`, 'validation');
  }
  if (
    typeof rawConfigObj['version'] !== 'string' ||
    rawConfigObj['version'].length === 0
  ) {
    throw new BuildError(
      `Failed to parse rill-config.json: missing required 'version' field`,
      'validation'
    );
  }

  // Parse main field to get entry file path
  const mainField =
    typeof rawConfigObj['main'] === 'string' ? rawConfigObj['main'] : '';
  if (mainField.length === 0) {
    throw new BuildError(
      `Failed to parse rill-config.json: missing required 'main' field`,
      'validation'
    );
  }

  let parsedMain: ReturnType<typeof parseMainField>;
  try {
    parsedMain = parseMainField(mainField);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BuildError(
      `Failed to parse rill-config.json: invalid 'main' field: ${msg}`,
      'validation'
    );
  }

  // Build extensions map (alias → mount specifier)
  const extensionsBlock =
    rawConfigObj['extensions'] !== null &&
    typeof rawConfigObj['extensions'] === 'object' &&
    !Array.isArray(rawConfigObj['extensions'])
      ? (rawConfigObj['extensions'] as Record<string, unknown>)
      : undefined;
  const rawMounts: Record<string, unknown> =
    extensionsBlock !== undefined &&
    extensionsBlock['mounts'] !== null &&
    typeof extensionsBlock['mounts'] === 'object' &&
    !Array.isArray(extensionsBlock['mounts'])
      ? (extensionsBlock['mounts'] as Record<string, unknown>)
      : {};
  const extensionMounts: Record<string, string> = {};
  for (const [alias, specifier] of Object.entries(rawMounts)) {
    if (typeof specifier === 'string') {
      extensionMounts[alias] = specifier;
    } else if (
      specifier !== null &&
      typeof specifier === 'object' &&
      'package' in specifier &&
      typeof (specifier as Record<string, unknown>)['package'] === 'string'
    ) {
      extensionMounts[alias] = (specifier as Record<string, string>)[
        'package'
      ]!;
    }
  }

  // Build modules map (alias → relative path)
  const modulesObj =
    rawConfigObj['modules'] !== null &&
    typeof rawConfigObj['modules'] === 'object' &&
    !Array.isArray(rawConfigObj['modules'])
      ? (rawConfigObj['modules'] as Record<string, unknown>)
      : {};
  const modulesMap: Record<string, string> = {};
  for (const [alias, relPath] of Object.entries(modulesObj)) {
    if (typeof relPath === 'string') {
      modulesMap[alias] = relPath;
    }
  }

  // Validate outputDir does not overlap with project directory
  const absOutputDir = path.resolve(outputDir);
  const homedir = (await import('node:os')).homedir();
  const dangerousPaths = ['/', homedir];
  if (
    absOutputDir === absProjectDir ||
    absProjectDir.startsWith(absOutputDir + path.sep) ||
    dangerousPaths.includes(absOutputDir)
  ) {
    throw new BuildError(
      'Output directory must not overlap with project directory',
      'validation'
    );
  }

  const packageInput: PackageBuildInput = {
    name: packageName,
    entry: parsedMain.filePath,
    modules: modulesMap,
    extensions: extensionMounts,
    originalConfig: rawConfigObj,
  };

  // Create package output directory: <outputDir>/<packageName>/
  // Only clean the package subdirectory to preserve other packages' output.
  const packageOutDir = path.join(absOutputDir, packageName);
  try {
    await rm(packageOutDir, { recursive: true, force: true });
    await mkdir(packageOutDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BuildError(
      `Cannot write to output directory ${packageOutDir}: ${msg}`,
      'bundling'
    );
  }

  // Step: Build package files (copy .rill, compile extensions, write initial rill-config.json)
  const { writtenFiles, rewrittenMounts: extensionMountPaths } =
    await buildPackageFiles(packageInput, absProjectDir, packageOutDir);

  // Collect files for checksum (package files only, rill-config.json excluded
  // because we rewrite it with the build section after computing the checksum)
  const allWrittenFiles = [...writtenFiles];

  // Dry-run validation — loadProject() on completed output
  const outputRillConfigPath = path.join(packageOutDir, 'rill-config.json');
  const rillVersion = readRillVersion();

  const originalCwd = process.cwd();
  try {
    process.chdir(packageOutDir);
    const dryRunResult = await loadProject({
      configPath: outputRillConfigPath,
      rillVersion,
    });
    for (const dispose of dryRunResult.disposes) {
      await dispose();
    }
  } catch (err) {
    if (
      err instanceof ConfigEnvError ||
      (err instanceof ExtensionLoadError &&
        !err.message.startsWith('Cannot find packages:'))
    ) {
      // Validation skipped: will be validated at runtime by the harness
    } else {
      await rm(packageOutDir, { recursive: true, force: true }).catch(
        () => undefined
      );
      const msg = err instanceof Error ? err.message : String(err);
      throw new BuildError(`Bundle validation failed: ${msg}`, 'validation');
    }
  } finally {
    process.chdir(originalCwd);
  }

  // Compute checksum over all output files EXCEPT rill-config.json
  const sortedFiles = [...allWrittenFiles].sort();
  const checksum = computeChecksum(sortedFiles);

  // Step: Rewrite rill-config.json with build metadata section
  const outputConfigWithBuild: Record<string, unknown> = {
    ...packageInput.originalConfig,
    build: {
      checksum,
      rillVersion,
      configVersion: '3',
    },
  };
  // Re-apply extension mount rewrites — reuse paths computed during bundling
  if (Object.keys(extensionMountPaths).length > 0) {
    const existingExtBlock = outputConfigWithBuild['extensions'] as
      | Record<string, unknown>
      | undefined;
    outputConfigWithBuild['extensions'] = {
      ...(existingExtBlock ?? {}),
      mounts: extensionMountPaths,
    };
  }
  // Re-apply module path rewrites — all modules are copied locally
  const finalRewrittenModules: Record<string, string> = {};
  for (const [alias] of Object.entries(packageInput.modules)) {
    finalRewrittenModules[alias] = `./modules/${alias}.rill`;
  }
  if (Object.keys(finalRewrittenModules).length > 0) {
    outputConfigWithBuild['modules'] = finalRewrittenModules;
  }
  try {
    await writeFile(
      outputRillConfigPath,
      JSON.stringify(outputConfigWithBuild, null, 2),
      'utf-8'
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BuildError(
      `Cannot write rill-config.json to ${outputRillConfigPath}: ${msg}`,
      'bundling'
    );
  }

  // Build-time introspection: extract handler signature for describe()
  // Uses static AST analysis — no script execution at build time.
  const shouldIntrospect = options?.introspect !== false; // default true
  let introspectionJson: string | null = null;
  if (shouldIntrospect && parsedMain.handlerName !== undefined) {
    try {
      const introSource = readFileSync(
        path.resolve(packageOutDir, path.basename(parsedMain.filePath)),
        'utf-8'
      );
      const introAst = parse(introSource);
      const metadata = introspectHandlerFromAST(
        introAst,
        parsedMain.handlerName
      );
      if (metadata !== null) {
        introspectionJson = JSON.stringify({
          name: packageName,
          description: metadata.description,
          params: metadata.params,
        });
      }
    } catch {
      // Introspection failed — describe() will return null at runtime
    }
  }

  // Step: Generate runtime.js (bundled), run.js and handler.js (thin wrappers)
  // Resolve @rcrsr/rill and @rcrsr/rill-config from both the build tool's
  // node_modules and the project's node_modules (covers all installation layouts)
  // Resolve the node_modules directory containing rill-cli's own dependencies.
  // Uses createRequire to find @rcrsr/rill-config's entry point, then walks up
  // to the enclosing node_modules. Works under pnpm hoisting where peer deps
  // live multiple levels above dist/.
  let buildNodeModules: string;
  try {
    const require = createRequire(import.meta.url);
    const rillConfigEntry = require.resolve('@rcrsr/rill-config');
    let dir = path.dirname(rillConfigEntry);
    while (dir !== path.dirname(dir)) {
      if (path.basename(dir) === 'node_modules') {
        buildNodeModules = dir;
        break;
      }
      dir = path.dirname(dir);
    }
    buildNodeModules ??= path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'node_modules'
    );
  } catch {
    buildNodeModules = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'node_modules'
    );
  }
  const projectNodeModules = path.join(absProjectDir, 'node_modules');

  // runtime.js — bundled: rill + rill-config + project loading + handler resolution
  const runtimeSrcPath = path.join(packageOutDir, '_runtime.js');
  const runtimeDestPath = path.join(packageOutDir, 'runtime.js');
  try {
    await writeFile(runtimeSrcPath, generateRuntimeSource(), 'utf-8');
    await esbuild({
      entryPoints: [runtimeSrcPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: runtimeDestPath,
      logLevel: 'silent',
      nodePaths: [projectNodeModules, buildNodeModules],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BuildError(`Cannot generate runtime.js: ${msg}`, 'bundling');
  } finally {
    await rm(runtimeSrcPath, { force: true }).catch(() => undefined);
  }

  // run.js — thin CLI wrapper (not bundled, imports from ./runtime.js)
  try {
    await writeFile(
      path.join(packageOutDir, 'run.js'),
      generateRunSource(),
      'utf-8'
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BuildError(`Cannot write run.js: ${msg}`, 'bundling');
  }

  // handler.js — thin handler export (not bundled, imports from ./runtime.js)
  try {
    await writeFile(
      path.join(packageOutDir, 'handler.js'),
      generateHandlerSource(mainField, introspectionJson),
      'utf-8'
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BuildError(`Cannot write handler.js: ${msg}`, 'bundling');
  }

  return {
    outputPath: packageOutDir,
    checksum,
  };
}

// ============================================================
// ENTRY POINT GENERATION
// ============================================================

/**
 * Generate runtime.js source — the heavy bundled module.
 * Exports rill + rill-config utilities for handler.js to use.
 * This source gets bundled by esbuild to inline @rcrsr/rill and @rcrsr/rill-config.
 */
function generateRuntimeSource(): string {
  return `import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveConfigPath,
  loadProject,
  parseMainField,
  interpolate,
  hasSessionVars,
  extractSessionVarNames,
  substituteSessionVars,
} from '@rcrsr/rill-config';
import {
  parse,
  execute,
  createRuntimeContext,
  invokeCallable,
  isScriptCallable,
  VERSION,
} from '@rcrsr/rill';

const __dirname = dirname(fileURLToPath(import.meta.url));

export {
  readFileSync, resolve, __dirname,
  resolveConfigPath, loadProject, parseMainField,
  interpolate, hasSessionVars, extractSessionVarNames, substituteSessionVars,
  parse, execute, createRuntimeContext, invokeCallable, isScriptCallable, VERSION,
};
`;
}

/**
 * Generate run.js — thin CLI wrapper that uses the handler lifecycle.
 */
function generateRunSource(): string {
  return `#!/usr/bin/env node
import { describe, init, execute, dispose } from './handler.js';

await init({});
try {
  const desc = describe();
  if (desc !== null) {
    const result = await execute({ params: {} }, {});
    if (result.result !== undefined && result.result !== '' && result.result !== false) {
      process.stdout.write(JSON.stringify(result.result, null, 2) + '\\n');
    }
    process.exitCode = result.result === false || result.result === '' ? 1 : 0;
  }
} finally {
  await dispose();
}
`;
}

/**
 * Generate handler.js — exports the handler lifecycle contract:
 * describe(), init(context), execute(request, context), dispose().
 */
function generateHandlerSource(
  mainField: string,
  introspectionJson: string | null
): string {
  const describeBody =
    introspectionJson !== null
      ? `return ${introspectionJson};`
      : `return null;`;

  return `import {
  readFileSync, resolve, __dirname,
  resolveConfigPath, loadProject, parseMainField,
  interpolate, hasSessionVars, extractSessionVarNames, substituteSessionVars,
  parse, execute as rillExecute, createRuntimeContext, invokeCallable, isScriptCallable, VERSION,
} from './runtime.js';

let project;
let handler;
let ctx;

export function describe() {
  ${describeBody}
}

export async function init(context = {}) {
  process.chdir(__dirname);
  const configPath = resolveConfigPath({ cwd: __dirname });
  project = await loadProject({ configPath, rillVersion: VERSION });

  if (context.globalVars) {
    project = { ...project, config: interpolate(project.config, context.globalVars) };
  }

  const mainFieldValue = ${JSON.stringify(mainField)};
  const { filePath, handlerName } = parseMainField(mainFieldValue);
  const absolutePath = resolve(__dirname, filePath);
  const source = readFileSync(absolutePath, 'utf-8');
  const ast = parse(source);

  ctx = createRuntimeContext({
    ...project.resolverConfig,
    parseSource: parse,
    callbacks: {
      onLog: (msg) => process.stdout.write(msg + '\\n'),
    },
  });

  if (context.ahiResolver) {
    ctx.ahiResolver = context.ahiResolver;
  }

  await rillExecute(ast, ctx);

  if (handlerName !== undefined) {
    handler = ctx.variables.get(handlerName);
    if (handler === undefined || !isScriptCallable(handler)) {
      throw new Error('Handler not found: $' + handlerName + ' is not a closure');
    }
  }
}

export async function execute(request = {}, context = {}) {
  if (handler === undefined) {
    return { state: 'completed', result: undefined };
  }
  const effectiveConfig = (context.sessionVars && hasSessionVars(project.config))
    ? substituteSessionVars(project.config, context.sessionVars)
    : project.config;
  ctx.resolverConfig = { ...ctx.resolverConfig, config: effectiveConfig };

  if (context.onLog) {
    ctx.callbacks = { ...ctx.callbacks, onLog: context.onLog };
  }

  ctx.pipeValue = request.params ?? {};

  const result = await invokeCallable(handler, [], ctx);
  return { state: 'completed', result };
}

export async function dispose() {
  if (project) {
    for (const d of project.disposes) {
      try { await d(); } catch {}
    }
  }
}
`;
}

// ============================================================
// DIRECTORY WALKER (used by tests)
// ============================================================

/**
 * Recursively collect all file paths under a directory.
 */
export async function walkDir(dir: string): Promise<string[]> {
  const items = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      results.push(...(await walkDir(full)));
    } else {
      results.push(full);
    }
  }
  return results;
}
