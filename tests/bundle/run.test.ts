import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, captureOutput } from '../helpers/cli-fixtures.js';

// ============================================================
// MODULE MOCK: buildPackage
// We mock buildPackage so in-process tests do not require real
// rill project fixtures. BuildError is preserved from the actual
// module so error-handling branches work as expected.
// ============================================================

const buildMocks = vi.hoisted(() => ({
  buildPackage: vi.fn(),
}));

vi.mock('../../src/build/build.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../src/build/build.js')>();
  return { ...actual, buildPackage: buildMocks.buildPackage };
});

// ============================================================
// FIXTURE HELPERS
// ============================================================

/**
 * Write a minimal rill-bundle.json into a tmp directory.
 */
function writeBundleJson(dir: string, content: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(dir, 'rill-bundle.json'),
    JSON.stringify(content, null, 2) + '\n',
    'utf8'
  );
}

/**
 * Install a fake harness module into the bundle dir's npm workspace
 * so resolveHarness() can find it.
 *
 * The package.json includes "type":"module" so Node treats index.js as
 * ESM and honours import/export syntax without a .mjs extension.
 */
function installFakeHarness(
  bundleDir: string,
  name: string,
  moduleContent: string
): void {
  const moduleDir = path.join(bundleDir, '.rill', 'npm', 'node_modules', name);
  fs.mkdirSync(moduleDir, { recursive: true });

  // "type":"module" enables ESM syntax in index.js
  fs.writeFileSync(
    path.join(moduleDir, 'package.json'),
    JSON.stringify(
      { name, version: '1.0.0', type: 'module', main: './index.js' },
      null,
      2
    ),
    'utf8'
  );

  // Harness index.js — ESM module with a default export
  fs.writeFileSync(path.join(moduleDir, 'index.js'), moduleContent, 'utf8');

  // .rill/npm/package.json so createRequire resolution anchor works
  const rillNpmDir = path.join(bundleDir, '.rill', 'npm');
  const rillNpmPkg = path.join(rillNpmDir, 'package.json');
  if (!fs.existsSync(rillNpmPkg)) {
    fs.writeFileSync(
      rillNpmPkg,
      JSON.stringify({ name: 'rill-extensions', private: true }, null, 2),
      'utf8'
    );
  }
}

/**
 * Make buildPackage resolve immediately with a fake CompiledPackage.
 * Call this in beforeEach for in-process tests so no real build runs.
 */
function stubBuildPackageSuccess(bundleDir: string): void {
  buildMocks.buildPackage.mockResolvedValue({
    outputPath: path.join(bundleDir, 'build', 'fake-pkg'),
    checksum: 'sha256:' + 'a'.repeat(64),
  });
}

// ============================================================
// SIGNAL LISTENER HYGIENE
// Capture and restore SIGINT/SIGTERM listeners around each test
// so in-process registrations from runBundleServe do not bleed
// between tests.
// ============================================================

let savedSigintListeners: Array<(...args: unknown[]) => void>;
let savedSigtermListeners: Array<(...args: unknown[]) => void>;

beforeEach(() => {
  savedSigintListeners = process.listeners('SIGINT') as Array<
    (...args: unknown[]) => void
  >;
  savedSigtermListeners = process.listeners('SIGTERM') as Array<
    (...args: unknown[]) => void
  >;
});

afterEach(() => {
  // Remove any listeners added by the test (runBundleServe registers once)
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  for (const l of savedSigintListeners) {
    process.on('SIGINT', l);
  }
  for (const l of savedSigtermListeners) {
    process.on('SIGTERM', l);
  }
  buildMocks.buildPackage.mockReset();
});

// ============================================================
// TEST 1: SIGINT during serve — shutdown handlers run, exit 0
// ============================================================

describe('runBundleServe SIGINT lifecycle', () => {
  it('invokes registered shutdown handlers and exits 0 on SIGINT', async () => {
    const bundleDir = makeTmpDir();
    try {
      writeBundleJson(bundleDir, {
        name: 'sigint-bundle',
        version: '1.0.0',
        harness: 'fake-harness',
        packages: [{ mount: 'pkg', project: 'packages/pkg' }],
      });

      // The harness registers a shutdown handler that sets a flag, then
      // returns a promise that never resolves (keeps serve alive until signal).
      const harnessSource = `
const harness = {
  name: 'fake-harness',
  async serve(ctx) {
    ctx.onShutdown(() => { globalThis.__shutdown_ran__ = true; });
    return new Promise(() => {});
  },
};
export default harness;
`;
      installFakeHarness(bundleDir, 'fake-harness', harnessSource);
      stubBuildPackageSuccess(bundleDir);

      const { runBundleServe } =
        await import('../../src/commands/bundle-run.js');

      // Start serve without awaiting — it never resolves on its own until
      // the shutdown signal promise resolves runBundleServe's internal race.
      const servePromise = runBundleServe(bundleDir, {});

      // Allow the event loop to advance so SIGINT/SIGTERM listeners register
      // and the harness shutdown handler registers inside serve().
      await new Promise<void>((r) => setTimeout(r, 100));

      // Verify the SIGINT listener was registered before firing it.
      expect(
        process.listenerCount('SIGINT'),
        'SIGINT listener must have been registered'
      ).toBeGreaterThan(0);

      // Emit SIGINT — the once-listener fires handleSignal() asynchronously.
      process.emit('SIGINT');

      // runBundleServe must resolve to 0 once the signal handler runs the
      // shutdown handlers and resolves the shutdown promise.
      const result = await servePromise;
      expect(result).toBe(0);

      // The shutdown handler registered via ctx.onShutdown must have run.
      expect((globalThis as Record<string, unknown>).__shutdown_ran__).toBe(
        true
      );

      delete (globalThis as Record<string, unknown>).__shutdown_ran__;
    } finally {
      fs.rmSync(bundleDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// TEST 2: Harness lacks serve — stderr message, exit 1
// ============================================================

describe('runBundleServe harness without serve', () => {
  it('writes error message to stderr and returns 1 when harness has no serve method', async () => {
    const bundleDir = makeTmpDir();

    try {
      writeBundleJson(bundleDir, {
        name: 'no-serve-bundle',
        version: '1.0.0',
        harness: 'no-serve-harness',
        packages: [{ mount: 'pkg', project: 'packages/pkg' }],
      });

      // Harness with no serve method
      const harnessSource = `
const harness = { name: 'no-serve-harness' };
export default harness;
`;
      installFakeHarness(bundleDir, 'no-serve-harness', harnessSource);
      stubBuildPackageSuccess(bundleDir);

      const { runBundleServe } =
        await import('../../src/commands/bundle-run.js');

      const captured = captureOutput();
      let result: number;
      try {
        result = await runBundleServe(bundleDir, {});
      } finally {
        captured.restore();
      }

      expect(result!).toBe(1);
      const stderrText = captured.stderr.join('');
      expect(stderrText).toContain(
        "Harness 'no-serve-harness' does not implement serve()"
      );
    } finally {
      fs.rmSync(bundleDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// TEST 3: Harness serve throws a plain Error — error re-thrown
// ============================================================

describe('runBundleServe harness serve throws', () => {
  it('re-throws the error from serve when serve throws a non-BuildError', async () => {
    const bundleDir = makeTmpDir();

    try {
      writeBundleJson(bundleDir, {
        name: 'throw-bundle',
        version: '1.0.0',
        harness: 'throwing-harness',
        packages: [{ mount: 'pkg', project: 'packages/pkg' }],
      });

      // Harness whose serve throws a plain Error
      const harnessSource = `
const harness = {
  name: 'throwing-harness',
  async serve(_ctx) {
    throw new Error('boom');
  },
};
export default harness;
`;
      installFakeHarness(bundleDir, 'throwing-harness', harnessSource);
      stubBuildPackageSuccess(bundleDir);

      const { runBundleServe } =
        await import('../../src/commands/bundle-run.js');

      // The implementation re-throws non-BuildError exceptions from serve.
      await expect(runBundleServe(bundleDir, {})).rejects.toThrow('boom');
    } finally {
      fs.rmSync(bundleDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// DOCUMENTATION: concurrent install is out of scope
//
// runBundleServe does not coordinate concurrent rill install
// invocations. If multiple processes modify .rill/npm while
// serve is running, the behavior is undefined. Addressing
// concurrent install locking is deferred and not part of the
// bundle-run lifecycle contract.
// ============================================================

describe('concurrent install behavior', () => {
  it.todo(
    'concurrent rill install during serve is out of scope — no locking is provided'
  );
});
