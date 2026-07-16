import type { ResolvedRillBundleConfig } from './bundle/config.js';
import type { BuildResult } from './build/build.js';

export type {
  RillBundleConfig,
  ResolvedRillBundleConfig,
} from './bundle/config.js';

// ============================================================
// LOGGER
// ============================================================

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// ============================================================
// COMPILED PACKAGE
// ============================================================

export interface CompiledPackage {
  readonly mount: string;
  readonly packageName: string;
  readonly packageDir: string;
  readonly buildOutput: BuildResult;
}

// ============================================================
// HARNESS CONTEXT
// ============================================================

export interface HarnessContext {
  readonly bundleDir: string;
  readonly bundle: ResolvedRillBundleConfig;
  readonly config: Record<string, unknown>;
  readonly logger: Logger;
}

// ============================================================
// POST-BUILD CONTEXT
// ============================================================

export interface PostBuildContext extends HarnessContext {
  readonly outputDir: string;
  readonly packages: readonly CompiledPackage[];
}

// ============================================================
// SERVE CONTEXT
// ============================================================

export interface ServeContext extends HarnessContext {
  readonly packages: readonly CompiledPackage[];
  readonly compile: () => Promise<CompiledPackage[]>;
  /**
   * Register a handler to run when a source file changes.
   * NOT YET IMPLEMENTED: no filesystem watcher currently invokes registered
   * handlers. Registration is accepted so harnesses can call this method
   * without error, but handlers are never triggered.
   */
  readonly onSourceChange: (handler: () => void | Promise<void>) => void;
  readonly onShutdown: (handler: () => void | Promise<void>) => void;
}

// ============================================================
// RILL HARNESS
// ============================================================

export interface RillHarness {
  readonly name: string;
  readonly postBuild?: ((ctx: PostBuildContext) => Promise<void>) | undefined;
  readonly serve?: ((ctx: ServeContext) => Promise<number>) | undefined;
}
