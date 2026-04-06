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
// AGENT BUILDER (per-agent file operations)
// ============================================================

interface AgentBuildInput {
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
 * Build a single agent's output files from a rill-config.json project directory.
 * Compiles ALL extensions (local TS and npm packages) via esbuild, copies .rill
 * files, and rewrites all mount paths to local ./extensions/*.js references.
 * Returns the written file paths (rill-config.json excluded — written separately).
 */
async function buildAgentFiles(
  agent: AgentBuildInput,
  projectDir: string,
  agentOutDir: string
): Promise<{ writtenFiles: string[] }> {
  const writtenFiles: string[] = [];

  // Step: Copy entry .rill file (preserve original filename)
  const entrySrcPath = path.resolve(projectDir, agent.entry);
  if (!existsSync(entrySrcPath)) {
    throw new BuildError(
      `Entry file not found: ${entrySrcPath}`,
      'compilation'
    );
  }
  const entryBasename = path.basename(agent.entry);
  const entryDestPath = path.join(agentOutDir, entryBasename);
  await copyFile(entrySrcPath, entryDestPath);
  writtenFiles.push(entryDestPath);

  // Step: Copy module .rill files from modules directories
  const modulesMap = agent.modules;
  for (const [alias, relPath] of Object.entries(modulesMap)) {
    const srcPath = path.resolve(projectDir, relPath);
    const destPath = path.join(agentOutDir, 'modules', `${alias}.rill`);
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
  const extensionsOutDir = path.join(agentOutDir, 'extensions');
  const rewrittenMounts: Record<string, string> = {};

  for (const [alias, mountSpecifier] of Object.entries(agent.extensions)) {
    await mkdir(extensionsOutDir, { recursive: true });
    const safeName = alias.replace(/[^a-zA-Z0-9_-]/g, '-');
    const destPath = path.join(extensionsOutDir, `${safeName}.js`);

    if (isLocalExtension(mountSpecifier)) {
      // Local file: resolve relative to project directory
      const srcPath = path.resolve(projectDir, mountSpecifier);
      await bundleExtensionToFile(srcPath, destPath, projectDir);
    } else {
      // npm package: esbuild resolves from node_modules
      await bundleExtensionToFile(mountSpecifier, destPath, projectDir);
    }

    writtenFiles.push(destPath);
    rewrittenMounts[alias] = `./extensions/${safeName}.js`;
  }

  // Step: Write output rill-config.json with rewritten mount paths (without build section yet)
  const outputConfig = { ...agent.originalConfig };
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
  for (const [alias] of Object.entries(agent.modules)) {
    rewrittenModules[alias] = `./modules/${alias}.rill`;
  }
  if (Object.keys(rewrittenModules).length > 0) {
    outputConfig['modules'] = rewrittenModules;
  }
  const rillConfigDestPath = path.join(agentOutDir, 'rill-config.json');
  await writeFile(
    rillConfigDestPath,
    JSON.stringify(outputConfig, null, 2),
    'utf-8'
  );
  // Note: rill-config.json is NOT added to writtenFiles here — it will be
  // rewritten with the build section after checksum computation.

  return { writtenFiles };
}

// ============================================================
// COMPILE AGENT
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
 * @returns BuildResult with agent output path and checksum
 * @throws BuildError for file/compilation/bundling/validation failures
 */
export async function buildAgent(
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

  // Extract agent name and version from raw config
  const agentName =
    typeof rawConfigObj['name'] === 'string'
      ? rawConfigObj['name']
      : path.basename(absProjectDir);
  if (
    agentName.includes('/') ||
    agentName.includes('\\') ||
    agentName.includes('..')
  ) {
    throw new BuildError(`Invalid agent name: ${agentName}`, 'validation');
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

  const agentInput: AgentBuildInput = {
    name: agentName,
    entry: parsedMain.filePath,
    modules: modulesMap,
    extensions: extensionMounts,
    originalConfig: rawConfigObj,
  };

  // Create agent output directory: <outputDir>/<agentName>/
  // Only clean the agent subdirectory to preserve other agents' output.
  const agentOutDir = path.join(absOutputDir, agentName);
  try {
    await rm(agentOutDir, { recursive: true, force: true });
    await mkdir(agentOutDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BuildError(
      `Cannot write to output directory ${agentOutDir}: ${msg}`,
      'bundling'
    );
  }

  // Step: Build agent files (copy .rill, compile extensions, write initial rill-config.json)
  const { writtenFiles } = await buildAgentFiles(
    agentInput,
    absProjectDir,
    agentOutDir
  );

  // Collect files for checksum (agent files only, rill-config.json excluded
  // because we rewrite it with the build section after computing the checksum)
  const allWrittenFiles = [...writtenFiles];

  // Dry-run validation — loadProject() on completed output
  const outputRillConfigPath = path.join(agentOutDir, 'rill-config.json');
  const rillVersion = readRillVersion();

  const originalCwd = process.cwd();
  try {
    process.chdir(agentOutDir);
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
      await rm(agentOutDir, { recursive: true, force: true }).catch(
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
    ...agentInput.originalConfig,
    build: {
      checksum,
      rillVersion,
      configVersion: '3',
    },
  };
  // Re-apply extension mount rewrites — all extensions are bundled locally
  const rewrittenMounts: Record<string, string> = {};
  for (const [alias] of Object.entries(agentInput.extensions)) {
    const safeName = alias.replace(/[^a-zA-Z0-9_-]/g, '-');
    rewrittenMounts[alias] = `./extensions/${safeName}.js`;
  }
  if (Object.keys(rewrittenMounts).length > 0) {
    const existingExtBlock = outputConfigWithBuild['extensions'] as
      | Record<string, unknown>
      | undefined;
    outputConfigWithBuild['extensions'] = {
      ...(existingExtBlock ?? {}),
      mounts: rewrittenMounts,
    };
  }
  // Re-apply module path rewrites — all modules are copied locally
  const finalRewrittenModules: Record<string, string> = {};
  for (const [alias] of Object.entries(agentInput.modules)) {
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

  // Step: Generate runtime.js (bundled), run.js and handler.js (thin wrappers)
  const buildNodeModules = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'node_modules'
  );

  // runtime.js — bundled: rill + rill-config + project loading + handler resolution
  const runtimeSrcPath = path.join(agentOutDir, '_runtime.js');
  const runtimeDestPath = path.join(agentOutDir, 'runtime.js');
  try {
    await writeFile(runtimeSrcPath, generateRuntimeSource(mainField), 'utf-8');
    await esbuild({
      entryPoints: [runtimeSrcPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: runtimeDestPath,
      logLevel: 'silent',
      nodePaths: [buildNodeModules],
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
      path.join(agentOutDir, 'run.js'),
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
      path.join(agentOutDir, 'handler.js'),
      generateHandlerSource(),
      'utf-8'
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BuildError(`Cannot write handler.js: ${msg}`, 'bundling');
  }

  return {
    outputPath: agentOutDir,
    checksum,
  };
}

// ============================================================
// ENTRY POINT GENERATION
// ============================================================

/**
 * Generate runtime.js source — the heavy bundled module.
 * Loads the rill project, resolves extensions, parses and executes the
 * script, and exports the handler closure + project for thin wrappers.
 * This source gets bundled by esbuild to inline @rcrsr/rill and @rcrsr/rill-config.
 */
function generateRuntimeSource(mainField: string): string {
  return `
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveConfigPath,
  loadProject,
  parseMainField,
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
process.chdir(__dirname);

const configPath = resolveConfigPath({ cwd: __dirname });

let project = await loadProject({ configPath, rillVersion: VERSION });

if (hasSessionVars(project.config)) {
  const names = extractSessionVarNames(project.config);
  const vars = {};
  for (const name of names) {
    const val = process.env[name];
    if (val !== undefined) vars[name] = val;
  }
  project = { ...project, config: substituteSessionVars(project.config, vars) };
}

const mainFieldValue = ${JSON.stringify(mainField)};
const { filePath, handlerName } = parseMainField(mainFieldValue);
const absolutePath = resolve(__dirname, filePath);
const source = readFileSync(absolutePath, 'utf-8');
const ast = parse(source);

const ctx = createRuntimeContext({
  ...project.resolverConfig,
  parseSource: parse,
  callbacks: {
    onLog: (msg) => process.stdout.write(msg + '\\n'),
  },
});

await execute(ast, ctx);

let handler;
if (handlerName !== undefined) {
  handler = ctx.variables.get(handlerName);
  if (handler === undefined || !isScriptCallable(handler)) {
    throw new Error('Handler not found: $' + handlerName + ' is not a closure');
  }
}

export { handler, project, ctx, invokeCallable };
`.trimStart();
}

/**
 * Generate run.js — thin CLI wrapper that imports from runtime.js.
 */
function generateRunSource(): string {
  return `#!/usr/bin/env node
import { handler, project, ctx, invokeCallable } from './runtime.js';

try {
  if (handler !== undefined) {
    const result = await invokeCallable(handler, [], ctx);
    if (result !== undefined && result !== '' && result !== false) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\\n');
    }
    process.exitCode = result === false || result === '' ? 1 : 0;
  }
} finally {
  for (const dispose of project.disposes) {
    try { await dispose(); } catch {}
  }
}
`;
}

/**
 * Generate handler.js — exports a ComposedHandler for harness consumption.
 */
function generateHandlerSource(): string {
  return `import { handler, project, ctx, invokeCallable } from './runtime.js';

export default async function composedHandler(request, context) {
  ctx.pipeValue = request.params ?? {};
  if (context?.onLog) {
    ctx.callbacks = { ...ctx.callbacks, onLog: context.onLog };
  }
  const result = await invokeCallable(handler, [], ctx);
  return { state: 'completed', result };
}

export async function dispose() {
  for (const d of project.disposes) {
    try { await d(); } catch {}
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
