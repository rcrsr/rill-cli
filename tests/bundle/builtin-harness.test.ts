import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTmpDir } from '../helpers/cli-fixtures.js';
import { builtinHarness } from '../../src/harness/builtin.js';
import { BuildError, buildPackage } from '../../src/build/build.js';
import type {
  CompiledPackage,
  PostBuildContext,
  ServeContext,
  Logger,
} from '../../src/harness.js';
import type { ResolvedRillBundleConfig } from '../../src/bundle/config.js';

// `access` is mocked module-wide so individual tests can simulate
// non-ENOENT filesystem errors (e.g. EACCES) via mockRejectedValueOnce,
// while other exports (writeFile, etc.) keep their real implementation.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: vi.fn(actual.access),
  };
});

// ============================================================
// FIXTURE HELPERS
// ============================================================

const SILENT_LOGGER: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const MINIMAL_BUNDLE: ResolvedRillBundleConfig = {
  name: 'test-bundle',
  version: '1.0.0',
  packages: [],
  config: {},
  defaultPackage: '',
};

function makeCompiledPackage(
  mount: string,
  outputDir: string
): CompiledPackage {
  return {
    mount,
    packageName: mount,
    packageDir: outputDir,
    buildOutput: {
      outputPath: path.join(outputDir, mount),
      checksum: 'fake-checksum',
    },
  };
}

/**
 * Write a handler.js fixture that mirrors the named-export lifecycle
 * contract build.ts's generateHandlerSource emits (describe/init/execute/
 * dispose) — never a default export. `result` is returned verbatim from
 * execute(); the sentinel log line lets tests assert the handler actually
 * ran and observe the args it received.
 */
function writeHandlerJs(
  outputDir: string,
  mount: string,
  result: unknown = 0
): void {
  const pkgDir = path.join(outputDir, mount);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'handler.js'),
    [
      `export function describe() { return null; }`,
      `export async function init() {}`,
      `export async function execute(request) {`,
      `  console.log(${JSON.stringify(mount + '-ran')}, JSON.stringify(request.params));`,
      `  return { state: 'completed', result: ${JSON.stringify(result)}, streamed: false };`,
      `}`,
      `export async function dispose() {}`,
      ``,
    ].join('\n'),
    'utf-8'
  );
}

function makePostBuildContext(
  outputDir: string,
  packages: readonly CompiledPackage[],
  bundle: ResolvedRillBundleConfig = MINIMAL_BUNDLE
): PostBuildContext {
  return {
    bundleDir: outputDir,
    outputDir,
    packages,
    bundle,
    config: {},
    logger: SILENT_LOGGER,
  };
}

/** Write package.json with "type":"module" so Node treats main.js as ESM. */
function writeEsmPackageJson(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ type: 'module' }),
    'utf-8'
  );
}

function makeServeContext(
  packages: readonly CompiledPackage[],
  opts: {
    bundle?: ResolvedRillBundleConfig;
    requestedMount?: string | undefined;
    args?: readonly string[];
  } = {}
): ServeContext {
  const {
    bundle = MINIMAL_BUNDLE,
    requestedMount = undefined,
    args = [],
  } = opts;
  return {
    bundleDir: '',
    bundle,
    config: {},
    logger: SILENT_LOGGER,
    packages,
    requestedMount,
    args,
    compile: () => Promise.resolve([...packages]),
    onSourceChange: () => undefined,
    onShutdown: () => undefined,
  };
}

/** Build a fake Node.js error carrying the given errno-style code. */
function makeFsError(code: string): Error & { code: string } {
  const err = new Error(`simulated ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

// ============================================================
// postBuild: emits main.js with handler imports
// ============================================================

describe('builtinHarness.postBuild', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('emitting main.js', () => {
    it('writes main.js to outputDir referencing each package handler', async () => {
      writeHandlerJs(tmpDir, 'alpha');
      writeHandlerJs(tmpDir, 'beta');

      const packages = [
        makeCompiledPackage('alpha', tmpDir),
        makeCompiledPackage('beta', tmpDir),
      ];
      const ctx = makePostBuildContext(tmpDir, packages);

      await builtinHarness.postBuild!(ctx);

      const mainPath = path.join(tmpDir, 'main.js');
      expect(fs.existsSync(mainPath)).toBe(true);

      const content = fs.readFileSync(mainPath, 'utf-8');
      expect(content).toContain('./alpha/handler.js');
      expect(content).toContain('./beta/handler.js');
    });
  });

  // ============================================================
  // postBuild: missing handler throws BuildError
  // ============================================================

  describe('missing handler file', () => {
    it('rejects with BuildError phase harness when a handler file does not exist', async () => {
      // alpha handler exists but beta handler does not
      writeHandlerJs(tmpDir, 'alpha');
      // deliberately omit beta/handler.js

      const packages = [
        makeCompiledPackage('alpha', tmpDir),
        makeCompiledPackage('beta', tmpDir),
      ];
      const ctx = makePostBuildContext(tmpDir, packages);

      await expect(builtinHarness.postBuild!(ctx)).rejects.toSatisfy(
        (err: unknown) => err instanceof BuildError && err.phase === 'harness'
      );
    });
  });

  // ============================================================
  // postBuild: non-ENOENT access errors are rethrown as-is
  // ============================================================

  describe('non-ENOENT access error', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('rethrows the original error when access rejects with EACCES', async () => {
      writeHandlerJs(tmpDir, 'alpha');

      const eaccesError = makeFsError('EACCES');
      vi.mocked(fsPromises.access).mockRejectedValueOnce(eaccesError);

      const packages = [makeCompiledPackage('alpha', tmpDir)];
      const ctx = makePostBuildContext(tmpDir, packages);

      await expect(builtinHarness.postBuild!(ctx)).rejects.toBe(eaccesError);
    });
  });
});

// ============================================================
// dispatchByMount (via serve): handler file access errors
// ============================================================

describe('builtinHarness.serve handler file access', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rejects with BuildError phase harness when the handler file does not exist', async () => {
    // deliberately omit alpha/handler.js
    const packages = [makeCompiledPackage('alpha', tmpDir)];
    const ctx = makeServeContext(packages, { requestedMount: 'alpha' });

    await expect(builtinHarness.serve!(ctx)).rejects.toSatisfy(
      (err: unknown) => err instanceof BuildError && err.phase === 'harness'
    );
  });

  it('rethrows the original error when access rejects with EACCES', async () => {
    writeHandlerJs(tmpDir, 'alpha');

    const eaccesError = makeFsError('EACCES');
    vi.mocked(fsPromises.access).mockRejectedValueOnce(eaccesError);

    const packages = [makeCompiledPackage('alpha', tmpDir)];
    const ctx = makeServeContext(packages, { requestedMount: 'alpha' });

    await expect(builtinHarness.serve!(ctx)).rejects.toBe(eaccesError);
  });
});

// ============================================================
// serve: dispatches using ctx.requestedMount/ctx.args/ctx.packages
// (previously read global process.argv, which under CLI dispatch never
// reflects the true user-supplied mount/args)
// ============================================================

describe('builtinHarness.serve dispatch', () => {
  let tmpDir: string;
  let logs: unknown[][];
  const SPY_LOGGER: Logger = {
    info: (...args) => {
      logs.push(args);
    },
    warn: () => undefined,
    error: () => undefined,
  };

  beforeEach(() => {
    tmpDir = makeTmpDir();
    logs = [];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dispatches to ctx.requestedMount using ctx.packages without calling compile()', async () => {
    writeHandlerJs(tmpDir, 'alpha');
    writeHandlerJs(tmpDir, 'beta');
    const packages = [
      makeCompiledPackage('alpha', tmpDir),
      makeCompiledPackage('beta', tmpDir),
    ];
    const ctx: ServeContext = {
      ...makeServeContext(packages, { requestedMount: 'beta' }),
      logger: SPY_LOGGER,
      compile: () => {
        throw new Error('compile() should not be called by serve()');
      },
    };

    const exitCode = await builtinHarness.serve!(ctx);

    expect(exitCode).toBe(0);
  });

  it('falls back to bundle.defaultPackage when requestedMount is undefined', async () => {
    writeHandlerJs(tmpDir, 'alpha');
    writeHandlerJs(tmpDir, 'beta');
    const packages = [
      makeCompiledPackage('alpha', tmpDir),
      makeCompiledPackage('beta', tmpDir),
    ];
    const bundle: ResolvedRillBundleConfig = {
      ...MINIMAL_BUNDLE,
      defaultPackage: 'beta',
    };
    const ctx = makeServeContext(packages, {
      bundle,
      requestedMount: undefined,
    });

    const exitCode = await builtinHarness.serve!(ctx);

    expect(exitCode).toBe(0);
  });

  it('forwards ctx.args to the dispatched handler, mapped to request.params via describe()', async () => {
    const pkgDir = path.join(tmpDir, 'alpha');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'handler.js'),
      [
        `export function describe() { return { params: [{ name: 'first' }, { name: 'second' }] }; }`,
        `export async function init() {}`,
        `export async function execute(request) {`,
        `  const ok = request.params.first === 'a' && request.params.second === 'b';`,
        `  return { state: 'completed', result: ok ? 0 : false, streamed: false };`,
        `}`,
        `export async function dispose() {}`,
        ``,
      ].join('\n'),
      'utf-8'
    );
    const packages = [makeCompiledPackage('alpha', tmpDir)];
    const ctx = makeServeContext(packages, {
      requestedMount: 'alpha',
      args: ['a', 'b'],
    });

    const exitCode = await builtinHarness.serve!(ctx);

    expect(exitCode).toBe(0);
  });

  it('returns exit code 1 when the handler result is false', async () => {
    writeHandlerJs(tmpDir, 'alpha', false);
    const packages = [makeCompiledPackage('alpha', tmpDir)];
    const ctx = makeServeContext(packages, { requestedMount: 'alpha' });

    const exitCode = await builtinHarness.serve!(ctx);

    expect(exitCode).toBe(1);
  });

  it('returns exit code 1 when the handler result is an empty string', async () => {
    writeHandlerJs(tmpDir, 'alpha', '');
    const packages = [makeCompiledPackage('alpha', tmpDir)];
    const ctx = makeServeContext(packages, { requestedMount: 'alpha' });

    const exitCode = await builtinHarness.serve!(ctx);

    expect(exitCode).toBe(1);
  });
});

// ============================================================
// emitted main.js: dispatch by argv mount
// ============================================================

describe('emitted main.js dispatch', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writeEsmPackageJson(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function buildMain(
    mounts: string[],
    bundle: ResolvedRillBundleConfig = MINIMAL_BUNDLE
  ): Promise<void> {
    for (const mount of mounts) {
      writeHandlerJs(tmpDir, mount);
    }
    const packages = mounts.map((m) => makeCompiledPackage(m, tmpDir));
    const ctx = makePostBuildContext(tmpDir, packages, bundle);
    await builtinHarness.postBuild!(ctx);
  }

  describe('known mount', () => {
    it('runs the handler for the specified mount and mirrors exit code zero', async () => {
      await buildMain(['alpha', 'beta']);

      const result = spawnSync(
        process.execPath,
        [path.join(tmpDir, 'main.js'), 'alpha'],
        {
          cwd: tmpDir,
          encoding: 'utf-8',
        }
      );

      expect(result.stdout).toContain('alpha-ran');
      expect(result.status).toBe(0);
    });

    it('exits 1 when the handler result is false', async () => {
      writeHandlerJs(tmpDir, 'alpha', false);
      const packages = [makeCompiledPackage('alpha', tmpDir)];
      const ctx = makePostBuildContext(tmpDir, packages);
      await builtinHarness.postBuild!(ctx);

      const result = spawnSync(
        process.execPath,
        [path.join(tmpDir, 'main.js'), 'alpha'],
        {
          cwd: tmpDir,
          encoding: 'utf-8',
        }
      );

      expect(result.status).toBe(1);
    });

    it('exits 1 when the handler result is an empty string', async () => {
      writeHandlerJs(tmpDir, 'alpha', '');
      const packages = [makeCompiledPackage('alpha', tmpDir)];
      const ctx = makePostBuildContext(tmpDir, packages);
      await builtinHarness.postBuild!(ctx);

      const result = spawnSync(
        process.execPath,
        [path.join(tmpDir, 'main.js'), 'alpha'],
        {
          cwd: tmpDir,
          encoding: 'utf-8',
        }
      );

      expect(result.status).toBe(1);
    });
  });

  // ============================================================
  // emitted main.js: no-arg dispatch to defaultPackage
  // ============================================================

  describe('no mount argument', () => {
    it('routes to defaultPackage when no argv mount is provided', async () => {
      const bundle: ResolvedRillBundleConfig = {
        ...MINIMAL_BUNDLE,
        defaultPackage: 'beta',
        packages: [
          { mount: 'alpha', project: 'packages/alpha' },
          { mount: 'beta', project: 'packages/beta' },
        ],
      };
      await buildMain(['alpha', 'beta'], bundle);

      const result = spawnSync(
        process.execPath,
        [path.join(tmpDir, 'main.js')],
        {
          cwd: tmpDir,
          encoding: 'utf-8',
        }
      );

      expect(result.stdout).toContain('beta-ran');
      expect(result.status).toBe(0);
    });

    it('routes to packages[0] when no argv mount and no defaultPackage are set', async () => {
      await buildMain(['alpha', 'beta']);

      const result = spawnSync(
        process.execPath,
        [path.join(tmpDir, 'main.js')],
        {
          cwd: tmpDir,
          encoding: 'utf-8',
        }
      );

      expect(result.stdout).toContain('alpha-ran');
      expect(result.status).toBe(0);
    });
  });

  // ============================================================
  // emitted main.js: unknown mount
  // ============================================================

  describe('unknown mount', () => {
    it('writes error to stderr and exits non-zero for an unrecognised mount', async () => {
      await buildMain(['alpha', 'beta']);

      const result = spawnSync(
        process.execPath,
        [path.join(tmpDir, 'main.js'), 'unknown-mount'],
        { cwd: tmpDir, encoding: 'utf-8' }
      );

      expect(result.stderr).toContain('Unknown package: unknown-mount');
      expect(result.stderr).toContain('alpha');
      expect(result.stderr).toContain('beta');
      expect(result.status).not.toBe(0);
    });
  });
});

// ============================================================
// real build.ts output: dispatchByMount/serve run an actual
// generateHandlerSource + runtime.js pair, not a hand-written mirror
// ============================================================

/**
 * Initialize the .rill/npm/package.json marker so buildPackage's
 * bootstrap pre-check passes. Mirrors tests/build/build.test.ts's
 * initRillNpm helper.
 */
function initRillNpm(projectDir: string): void {
  const rillNpmDir = path.join(projectDir, '.rill', 'npm');
  fs.mkdirSync(rillNpmDir, { recursive: true });
  fs.writeFileSync(
    path.join(rillNpmDir, 'package.json'),
    JSON.stringify({ name: 'rill-extensions', private: true }, null, 2),
    'utf-8'
  );
}

/**
 * Build a real rill package via build.ts's buildPackage() — the same
 * function tests/build/build.test.ts exercises — so the handler.js and
 * runtime.js fed into dispatchByMount/serve below are actual
 * generateHandlerSource/generateRuntimeSource output, not a hand-written
 * mirror of the lifecycle contract.
 */
async function buildRealPackage(
  mount: string,
  outputParentDir: string,
  createdDirs: string[]
): Promise<CompiledPackage> {
  const projectDir = makeTmpDir();
  createdDirs.push(projectDir);
  initRillNpm(projectDir);
  fs.writeFileSync(
    path.join(projectDir, 'rill-config.json'),
    JSON.stringify({
      name: mount,
      version: '1.0.0',
      main: 'main.rill:greet',
    }),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(projectDir, 'main.rill'),
    '|name: string| { $name } => $greet',
    'utf-8'
  );

  const result = await buildPackage(projectDir, {
    outputDir: outputParentDir,
  });

  return {
    mount,
    packageName: mount,
    packageDir: outputParentDir,
    buildOutput: result,
  };
}

describe('dispatchByMount/serve against real buildPackage output', () => {
  let tmpDir: string;
  let createdDirs: string[];
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    createdDirs = [];
    originalCwd = process.cwd();
  });

  afterEach(() => {
    // The real handler.js's init() does `process.chdir(__dirname)` as part
    // of its production single-process-per-worker contract (mirrors
    // generateHandlerSource in src/build/build.ts) — restore the real
    // process cwd before deleting the temp dirs it may still be sitting in,
    // otherwise a later test's process.cwd() call fails with ENOENT.
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const dir of createdDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs a real generateHandlerSource/runtime.js pair through serve() and returns the closure result', async () => {
    const pkg = await buildRealPackage('greeter', tmpDir, createdDirs);
    const ctx = makeServeContext([pkg], {
      requestedMount: 'greeter',
      args: ['world'],
    });

    const exitCode = await builtinHarness.serve!(ctx);

    expect(exitCode).toBe(0);
  });

  it('rejects with BuildError phase harness when the real build output handler.js is missing', async () => {
    const pkg = await buildRealPackage('greeter', tmpDir, createdDirs);
    await fsPromises.rm(path.join(pkg.buildOutput.outputPath, 'handler.js'));
    const ctx = makeServeContext([pkg], { requestedMount: 'greeter' });

    await expect(builtinHarness.serve!(ctx)).rejects.toSatisfy(
      (err: unknown) => err instanceof BuildError && err.phase === 'harness'
    );
  });
});
