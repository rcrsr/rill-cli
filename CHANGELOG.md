# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.19.3] - 2026-05-03

### Added

- Unified `rill` CLI replaces six standalone binaries with a single entry point and new
  `bootstrap`, `install`, `uninstall`, `upgrade`, and `list` subcommands for managing
  project-scoped extensions
- `rill bootstrap`: new subcommand that initializes a project by creating `.rill/` and `.rill/npm/` under `<projectDir>`, writing a scoped `package.json` inside `.rill/npm/`, generating a starter `rill-config.json` at the project root, seeding `.rill/.gitignore` and `.rill/npm/.gitignore`, and appending `.rill/` to the project-root `.gitignore`. Must be run once before installing extensions. Dispatched via `src/cli.ts`
- `rill install <pkg>`: installs a rill extension into `.rill/npm/` and registers it in `rill-config.json`. Accepts `--as <mount>` (mount path override), `--pin` (record exact installed version, no caret), `--exact` (alias for `--pin`), and `--range <spec>` (custom semver range recorded verbatim). Replaces manual `npm install` + config editing
- `rill uninstall <mount>`: removes the extension registered under `<mount>` from `.rill/npm/` and from `rill-config.json`
- `rill upgrade <mount>`: upgrades the extension registered under `<mount>` to the latest compatible version inside `.rill/npm/`
- `rill list`: lists all registered extensions from `rill-config.json`. Accepts `--json` to emit machine-readable output

### Changed

- **Breaking:** Six standalone binaries (`rill-build`, `rill-check`, `rill-describe`, `rill-eval`, `rill-exec`, `rill-run`) are removed. A single `rill` binary now dispatches all subcommands: `rill build`, `rill check`, `rill describe`, `rill eval`, `rill exec`, `rill run`. Invocations of the old binary names will fail with `command not found`. Update scripts, CI pipelines, and `package.json` `scripts` fields accordingly
- **Breaking:** `package.json` `bin` field reduced from six entries (`rill-build`, `rill-check`, `rill-describe`, `rill-eval`, `rill-exec`, `rill-run`) to a single entry (`"rill": "./dist/cli.js"`). Global installs of previous versions must be uninstalled and reinstalled to pick up the unified binary
- **Breaking:** Extensions now resolve from `<projectDir>/.rill/npm/` instead of the project-root `node_modules/`. The isolated prefix prevents extension dependencies from colliding with application dependencies. `src/build/build.ts` passes `.rill/npm/` as the module resolution base. Existing projects whose extensions are installed in project-root `node_modules/` will fail `rill build` with the error "Run 'rill bootstrap' to initialize this project". Migration: run `rill bootstrap`, then `rill install <pkg>` for each previously-installed extension
- **Breaking:** `@rcrsr/rill-config` companion release adds a required `prefix` parameter to `loadProject()` and `loadExtensions()`. All consumers must compute `prefix = path.join(projectDir, '.rill/npm')` and pass it explicitly. Calls that omit `prefix` will resolve extensions against `node_modules/` and fail on bootstrapped projects

## [0.19.2] - 2026-04-30

### Fixed

- `rill-build`: `findOffendingDynamicRequires` returns `[]` when the bundled output wires `__require` via `createRequire(import.meta.url)`, exempting ESM-native extensions that inline CJS deps (e.g. `yaml`) from the false-positive CJS dynamic-require build error
- `rill-describe` loads `.env` via `dotenvConfig({ quiet: true })` at startup, matching `rill-run` behavior. Projects that rely on `.env` for extension config no longer require manual env sourcing before running `rill-describe`

## [0.19.1] - 2026-04-30

### Added

- `rill-check --min-severity <error|warning|info>` flag controls the severity threshold for non-zero exit. Default is `error`, so `info` advisories (e.g. `PREFER_MAP`, `SPACING_BRACES`) and `warning` diagnostics no longer fail CI by default. Diagnostics below the threshold still print to stdout so the user sees them; only the exit code is gated. Pass `--min-severity info` to restore the pre-fix strict behavior
- New `rill-describe` CLI binary with three subcommands: `project` (default), `handler`, and `builtins`. `project [--mount <name>]` reads `rill-config.json` via `loadProject` and walks `project.extTree` to emit per-mount callable trees with full `params`, `returnType`, and `annotations`. `handler` parses `main: "file.rill:name"`, executes the script, and emits the captured handler's signature with closure-level annotations. `builtins` walks `ctx.functions` and `ctx.typeMethodDicts` from a fresh runtime context. All subcommands accept `--strict` (exit 1 if any callable has `returnType: any`); `project` and `handler` accept `--config <path>` to override the default `./rill-config.json` lookup
- `@rcrsr/rill-ext-datetime` added as devDependency for `rill-describe project` mode tests

### Changed

- **Breaking:** `rill-check` default exit code semantics — previously any diagnostic (including `info`) caused exit 1. Now only diagnostics at or above the `--min-severity` threshold (default `error`) fail. 53 of 78 lint rules emit `info` severity, so the prior default treated advisory output as a build failure. Existing CI scripts that relied on `info`/`warning`-level failures must add `--min-severity info` (or `warning`) to opt back in
- `NAMING_SNAKE_CASE` rule treats quoted-string dict keys as an intentional escape for foreign API keys the user does not own (Gmail's `maxResults`, Stripe's `payment_intent`, etc.). Bare-identifier keys (`[maxResults: 10]`) still fire; quoted keys (`["maxResults": 10]`) are now accepted. Uses the `keyForm: 'string'` AST flag from rill ≥0.19.2 to distinguish the two forms. Bumps `@rcrsr/rill` peer-dep range from `~0.19.0` to `~0.19.2`. Violations on dict keys now include a hint pointing at the escape: `For foreign API keys you don't own, use the quoted-key form: ["maxResults": ...]`
- **Breaking:** `engines.node` raised from `>=20.0.0` to `>=22.16.0` to match the transitive constraint from `@rcrsr/rill@0.19.2`. CI already runs on Node 22/24/25 so this aligns the advertised range with what is actually tested

### Fixed

- `rill-run` handler mode now surfaces the full halt envelope (atom, message, source location, snippet, trace) instead of bare `runtime halt`. The handler-mode catch around `invokeCallable` previously took `err.message` from a `RuntimeHaltSignal` (whose default message is the literal string `runtime halt`) and wrote it raw, ignoring `--verbose`, `--trace`, `--format json`, `--format compact`, and `--atom-only`. Module mode was unaffected because `execute()` converts halts to `RuntimeError` before the catch runs
- `rill-build` now detects CJS dynamic `require()` calls left in compiled extension bundles and fails the build with an actionable `BuildError` instead of letting them surface at runtime as `Dynamic require of "X" is not supported`. esbuild emits a `__require`/`_require` shim when bundling CJS source to ESM (e.g. an extension that uses `require("process")`); the shim throws on first invocation. After the existing `package.json` inline post-process in `bundleExtensionToFile`, the bundled output is scanned for any remaining `_{1,2}require(...)` calls and the build aborts with the source path and offending require targets named in the error message

## [0.19.0] - 2026-04-28

### Added

- New lint rules for 0.19.0 error-handling primitives: `GUARD_BARE`, `RETRY_TRIVIAL`, `ATOM_UNREGISTERED`, `STATUS_PROBE_NO_FIELD`, `PRESENCE_OVER_NULL_GUARD`, `GUARD_OVER_TRY_CATCH`
- CLI flags `--trace`, `--no-trace`, `--show-recovered`, `--atom-only` for error output control
- Human error envelope unified across uncaught and guard-recovered halts: `error[:provider][ID[#ATOM]]: message` header, `--> path:line:col` location, source snippets per trace frame, and origin-first trace chain. Atom is suppressed when it is the underscore form of the error id (e.g., `#RILL_R038` for `RILL-R038`); `<script>` site placeholders are substituted with the active filename
- JSON error shape gains `atom`, `errorId`, `provider`, `trace[]`, `raw` fields

### Fixed

- Caret underline no longer appears under blank trailing lines for half-open spans that end at column 1 of a later line
- Trailing blank context lines (from a final newline at EOF) trimmed from snippet output
- `rill-run` and `rill-eval` detect invalid `RillValue` returned by guard-recovered scripts and exit non-zero with a formatted status

### Changed

- Collection-op rules `PREFER_MAP`, `BREAK_IN_PARALLEL`, `FOLD_INTERMEDIATES`, `FILTER_NEGATION`, `METHOD_SHORTHAND` rewritten against the `HostCall` AST (`seq` / `fan` / `fold` / `filter` / `acc`); messages reference 0.19.0 syntax
- `CLOSURE_LATE_BINDING` and `CLOSURE_BARE_DOLLAR` migrated to the new collection-op shape
- Peer-dependency range for `@rcrsr/rill` and `@rcrsr/rill-config` is now `~0.19.0`

## [0.18.12] - 2026-04-09

### Added

- Drain streams in generated build wrappers with backpressure-aware stdout writes
- `onChunk` callback in handler execute context for incremental stream output

## [0.18.11] - 2026-04-09

### Changed

- Stream chunks are written to stdout incrementally instead of buffering until drain completes

## [0.18.10] - 2026-04-09

### Added

- Drain returned rill streams in handler and module modes, outputting collected chunks instead of metadata

## [0.18.9] - 2026-04-06

### Changed

- Extension output files use package identity instead of mount alias (`my-ext@0.1.0.js` not `myExt.js`)
- Two mounts referencing the same package share one bundled `.js` file (deduplication)
- Extension file names include package version for cross-agent pooling

### Fixed

- Final `rill-config.json` reuses dedup-aware mount paths instead of reconstructing from aliases

## [0.18.8] - 2026-04-06

### Fixed

- Resolve `buildNodeModules` via `createRequire` for pnpm peer dep compatibility

## [0.18.7] - 2026-04-06

### Changed

- Rename internal "agent" references to "package" in rill-build source, tests, and docs
- `handler.js` exports 4 lifecycle functions (`describe`, `init`, `execute`, `dispose`) instead of a single default export
- `runtime.js` is a pure export module with no top-level execution
- `run.js` uses `init`/`execute`/`dispose` from handler.js
- `rill-build` introspects handler parameters at build time via static AST analysis (no script execution)
- Update `@rcrsr/rill` from ~0.18.3 to ~0.18.5 for `introspectHandlerFromAST` API

## [0.18.6] - 2026-04-06

### Added

- `rill-build` CLI command: compiles a rill project into a self-contained output directory with bundled extensions, entry files, and build metadata

### Changed

- Rename `rill-compile` to `rill-build` (bin entry, source files, public API types)
- Standardize `-h`/`-v` shorthands across all CLI commands (rill-eval, rill-run, rill-build)
- Add `--help`/`--version` and unknown flag rejection to `rill-build`
- Standardize stderr output to `process.stderr.write` in rill-eval
- Add CLI flag tests for rill-build, rill-eval, and rill-run

## [0.18.5] - 2026-04-06

### Added

- Session variable (`@{VAR}`) substitution from `process.env` in `rill-run`

### Changed

- Update `@rcrsr/rill-config` from 0.18.4 to 0.18.5
- Remove `env` parameter from `loadProject()` call (breaking change in rill-config)

## [0.18.4] - 2026-04-05

### Changed

- Move `@rcrsr/rill` and `@rcrsr/rill-config` from dependencies to peer dependencies
- Update `dotenv` from 16.x to 17.x
- Update `typescript` from 5.x to 6.x
- Update all dev dependencies to latest versions

## [0.18.3] - 2026-04-05

Initial standalone release. Extracted `@rcrsr/rill-cli` from the [rill monorepo](https://github.com/rcrsr/rill). No functional changes from the monorepo version.

[Unreleased]: https://github.com/rcrsr/rill-cli/compare/v0.19.3...HEAD
[0.19.3]: https://github.com/rcrsr/rill-cli/compare/v0.19.2...v0.19.3
[0.19.2]: https://github.com/rcrsr/rill-cli/compare/v0.19.1...v0.19.2
[0.19.1]: https://github.com/rcrsr/rill-cli/compare/v0.19.0...v0.19.1
[0.19.0]: https://github.com/rcrsr/rill-cli/compare/v0.18.12...v0.19.0
[0.18.12]: https://github.com/rcrsr/rill-cli/compare/v0.18.11...v0.18.12
[0.18.11]: https://github.com/rcrsr/rill-cli/compare/v0.18.10...v0.18.11
[0.18.10]: https://github.com/rcrsr/rill-cli/compare/v0.18.9...v0.18.10
[0.18.9]: https://github.com/rcrsr/rill-cli/compare/v0.18.8...v0.18.9
[0.18.8]: https://github.com/rcrsr/rill-cli/compare/v0.18.7...v0.18.8
[0.18.7]: https://github.com/rcrsr/rill-cli/compare/v0.18.6...v0.18.7
[0.18.6]: https://github.com/rcrsr/rill-cli/compare/v0.18.5...v0.18.6
[0.18.5]: https://github.com/rcrsr/rill-cli/compare/v0.18.4...v0.18.5
[0.18.4]: https://github.com/rcrsr/rill-cli/compare/v0.18.3...v0.18.4
[0.18.3]: https://github.com/rcrsr/rill-cli/releases/tag/v0.18.3
