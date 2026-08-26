# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **Dependency and CI action updates:** Consolidate the open dependabot updates. Bump `esbuild` 0.28.0 → 0.28.2, `@rcrsr/rill-dev` 0.2.0 → 0.2.2, `@types/node` 26.1.2 → 26.2.0 (lockfile resolves 26.3.0), `knip` 6.29.0 → 6.32.2, `oxfmt` 0.61.0 → 0.65.0, `oxlint` 1.76.0 → 1.80.0, and `vitest` 4.1.10 → 4.1.11; the shared-tooling ranges (`knip`, `oxfmt`, `oxlint`, `vitest`) track the `@rcrsr/rill-dev` 0.2.2 baseline so `STD-DEP-1` stays conformant. Pin `github/codeql-action` `init`/`analyze` to v4.37.6. No CLI runtime changes. ([#72](https://github.com/rcrsr/rill-cli/pull/72))

- **`rill check` severity overlay:** `applySeverityOverlay` no longer remaps `warn`-state rules to `warning`; `runRules` already resolves a warn-state rule's severity before the overlay runs, so the branch was dead. The overlay now only applies explicit `severity` block overrides. Also: `rill check` continues to run the language service in its default `checkerMode`; per-code severity overrides already exist via the `severity` block, so a config key to change `checkerMode` is deferred until a user needs error-level enforcement of the strict-mode `use<>` rules, which live upstream in `@rcrsr/rill-language-service`. ([#40](https://github.com/rcrsr/rill-cli/issues/40), [#41](https://github.com/rcrsr/rill-cli/issues/41)) ([#71](https://github.com/rcrsr/rill-cli/pull/71))
- **Repository standards:** Repository now conforms to rill ecosystem standards with pnpm 11.18.0 pinning, release provenance, and pinned CI actions. No CLI runtime changes. ([#45](https://github.com/rcrsr/rill-cli/pull/45))
- **Standards checker:** Upgrade `@rcrsr/rill-dev` from 0.1.0 to 0.2.0, traversing 0.1.1. Its shipped `baseline.json` carries rill's canonical tooling pins, so `STD-LINT-1`, `STD-LINT-5`, `STD-LINT-9`, `STD-PM-2`, `STD-DEP-1`, `STD-DEP-2`, and `STD-DEP-5` now resolve here instead of reporting unchecked. `STD-PM-6`, `STD-SUP-2`, and `STD-PROC-7` are decided from the tree and pass. `STD-DEP-3` and `STD-DEP-4` are also decided from the tree, but as N/A, so they stay in the not-machine-checkable count; 0.1.0 collapsed `STD-DEP-1..5` into one skip line and 0.2.0 reports all five separately, which is why the reported line total grows rather than holding fixed. `STD-LINT-3` is the eleventh element to join the checked column, and it became checkable in 0.1.1 rather than in 0.2.0. That release required the `src/`-scoped `rill/no-spec-id-reference: "error"` override to be in place before the bump, and [#45](https://github.com/rcrsr/rill-cli/pull/45) had already added it. The tree-only run goes from 52 checked, 52 passed, 21 not machine-checkable under 0.1.0 to 63/63/14 under 0.2.0, still `CONFORMANT`, with no repository change needed to reach it. No CLI runtime changes. ([#48](https://github.com/rcrsr/rill-cli/pull/48))
- **Shared dev assets:** The standards checker, the standards index, and the custom lint rules now arrive as the `@rcrsr/rill-dev` devDependency instead of a copied `dev/` directory. `check:standards` and `test:rules` run its `rill-check-standards` and `rill-test-rules` binaries, `.oxlintrc.json` loads its lint rules by package specifier, and the CI drift-check job is gone. Conformance is unchanged at 52 checked, 52 passed, 21 not machine-checkable under `@rcrsr/rill-dev` 0.1.0. No CLI runtime changes. ([#45](https://github.com/rcrsr/rill-cli/pull/45))

### Fixed

- **Dead code and stale messaging cleanup:** Removed the never-populated `RunCliOptions.scriptArgs` pipe-value branch, the `EnrichedError.callStack`/`includeCallStack` formatter plumbing (base `RillError` never carries a call stack), and the `bundle-run.ts` source-change handler registry that queued handlers no watcher ever invoked (`ServeContext.onSourceChange` now warns once instead of silently discarding, now covered by a regression test). Also dropped the now-unread `FormatOptions.maxCallStackDepth` field and its construction sites — distinct from the still-live `RuntimeOptions.maxCallStackDepth` fed to the runtime. Simplified `build.ts`'s redundant pre-sort before `computeChecksum` (which already sorts) and `cli-check.ts`'s `existsSync`/`statSync` pre-checks (which duplicated the `ENOENT`/`EISDIR` catch and opened a TOCTOU window), and narrowed an impossible `null`/`undefined` cast in `check-adapter/config.ts`. Fixed the zero-package case in the built-in harness printing `Unknown package: undefined` (now `No package specified`), a `build.ts` read-failure mislabeled as a parse failure, a bare `Error` for an invalid extension version now thrown as `BuildError`, and `check-adapter/fixer.ts` swallowing the post-fix parse error's location instead of surfacing it. Corrected stale comments referencing a removed `version-data.ts`/`generate-version.ts` and the CLI dispatch harness's docs. ([#68](https://github.com/rcrsr/rill-cli/issues/68)) ([#71](https://github.com/rcrsr/rill-cli/pull/71))
- **Test hygiene and release gate:** Replaced vacuous `expect(true).toBe(true)` placeholders and error-swallowing `try`/`catch`/bare `catch {}` blocks with real assertions on output, exit codes, and rejections; unified the four per-file `beforeAll` `dist/` builds (a source of cross-worker races) into a single Vitest `globalSetup`; replaced a fixed `setTimeout` wait with a deterministic poll; reset the module-level runner test override in `afterEach`; and replaced `Date.now()`-named temp paths with `mkdtemp`-backed helpers. The release workflow now runs `pnpm run check` instead of separate build/test steps. Also stripped internal `AC-*`, `EC-*`, and `UXT-*` planning identifiers from test titles, comments, and module headers (111 references across 21 files) — a naming-only pass with no behavior change. ([#69](https://github.com/rcrsr/rill-cli/issues/69), [#39](https://github.com/rcrsr/rill-cli/issues/39)) ([#71](https://github.com/rcrsr/rill-cli/pull/71))
- **Atomic rill-config.json / rill-bundle.json writes:** `applyMountEdit` (including its rollback path), `rill init package`/`rill init bundle`'s scaffolded config, `rill bootstrap`'s config write, and `writeBundleHarness` now write through a new internal `atomicWriteFile` helper — temp file in the same directory, then rename over the target — so a failed write never truncates a pre-existing config file in place. ([#66](https://github.com/rcrsr/rill-cli/issues/66), [#67](https://github.com/rcrsr/rill-cli/issues/67)) ([#71](https://github.com/rcrsr/rill-cli/pull/71))
- **Open bug-report sweep:** Fix 12 open bug reports across build, extension lifecycle, exit codes, config resolution, check reporting, and CLI messaging. ([#70](https://github.com/rcrsr/rill-cli/pull/70))
- **`rill build --flat` no longer deletes the output directory:** In flat mode `packageOutDir` equalled `--output`, so the build ran `rm(recursive, force)` on the user-supplied directory. Flat builds now create the directory, refuse a non-empty directory not owned by a prior build, and remove only build-owned artifacts. ([#63](https://github.com/rcrsr/rill-cli/issues/63))
- **Built-in harness runs generated handlers:** `dispatchByMount` required a `default` export that `generateHandlerSource` never emits; it now drives the named `init`/`execute`/`dispose`/`describe` lifecycle, so a freshly built bundle serves under the built-in harness. ([#56](https://github.com/rcrsr/rill-cli/issues/56))
- **Extension commands fail loud, not with raw stacks:** `install`/`uninstall` now guard `BundleConfigError`, missing `rill-config.json`, and malformed config JSON (new `ConfigParseError`), each printing a `✗` line and returning 1. ([#61](https://github.com/rcrsr/rill-cli/issues/61))
- **Local-directory installs record the real npm package name:** install/uninstall read the local `package.json` `name` instead of assuming it equals the mount, so `uninstall` removes the package that `install` linked. ([#62](https://github.com/rcrsr/rill-cli/issues/62))
- **Extensions dispose on every exit path:** `rill run` handler mode and `rill describe` now dispose extensions on early returns and thrown errors, not only the success path. ([#60](https://github.com/rcrsr/rill-cli/issues/60))
- **Consistent invalid-result exit codes:** `rill run` handler mode and `rill exec` route results through `determineExitCode`, and the runner constrains tuple codes to 0/1, matching `eval` and module mode. ([#59](https://github.com/rcrsr/rill-cli/issues/59))
- **Module aliases resolve against the found config:** `rill run` resolves `modules` aliases and `main` relative to the located `rill-config.json`, not the current directory. ([#58](https://github.com/rcrsr/rill-cli/issues/58))
- **`rill check --fix` reports post-fix state:** the exit code and diagnostics now reflect the fixed source, so a run that fixes every error exits 0; the tsc spawn resolves on `'close'` so JSON output no longer truncates. ([#64](https://github.com/rcrsr/rill-cli/issues/64))
- **Assorted CLI argument and messaging fixes:** `rill eval '-5 + 3'` evaluates; `parseCliArgs` no longer calls `process.exit`; `--explain UNKNOWN` exits 1 in `run` as in `exec`; non-`ENOENT` read errors surface their real message; bundle mode rejects `--format=json`; single-file `install` rejects `--for`/`--role`; the uninstall hint reads `rill uninstall --harness`; rollback status reflects the actual write; the `--exact` deprecation note targets 0.21; caret underlines align with snippet columns; `rill init bundle` rejects path separators in names. ([#65](https://github.com/rcrsr/rill-cli/issues/65))
- **`rill init bundle` rejects invalid names:** bundle names containing `/`, `\`, or `..` are rejected, matching package init. ([#65](https://github.com/rcrsr/rill-cli/issues/65))
- **Test suite runs clean on `main`:** `vitest.config.ts` scopes collection to `tests/**`, so the `conduct/` symlink is no longer collected; two `code ?? 0` sites in the check tests now fail closed with `code ?? 1`. ([#57](https://github.com/rcrsr/rill-cli/issues/57), [#38](https://github.com/rcrsr/rill-cli/issues/38))

## [0.20.0] - 2026-07-30

### Added

- **Bundle mode:** Multi-package bundles in `rill build`/`rill run` via `rill-bundle.json`, with `rill init` scaffolding and `rill bootstrap` renamed to `rill init`. ([#35](https://github.com/rcrsr/rill-cli/pull/35))
- **Install flags:** `rill install` now accepts `--for`, `--role`, `--replace` flags for bundle-aware management with dispatch harness support. ([#35](https://github.com/rcrsr/rill-cli/pull/35))
- **Install role gate:** `rill install` rejects packages without `"rill": { "role": "extension" | "harness" }`, probed before `npm install`. ([#35](https://github.com/rcrsr/rill-cli/pull/35))
- **Bundle-aware uninstall/upgrade/list:** `rill uninstall` and `rill upgrade` accept `--for <mount>` to target a bundle package's extension and `--harness` to remove or upgrade the recorded harness. `rill list` shows the bundle harness and aggregates each package's mounts. ([#35](https://github.com/rcrsr/rill-cli/pull/35))

### Changed

- **Dev tooling:** Updated to TypeScript 7, oxlint, oxfmt, lefthook, and knip; no runtime changes. ([#36](https://github.com/rcrsr/rill-cli/pull/36))
- **Rules engine:** `rill check` delegates to @rcrsr/rill-language-service instead of the in-repo checker, removing the need for a sibling ../rill checkout to install or build. The engine provided 40 rules across 11 categories at the time of this change; the `~0.20.0` upgrade below raises that to 41. Configuration and severity mappings remain supported. ([#37](https://github.com/rcrsr/rill-cli/pull/37))
- **Upstream dependencies:** Upgrade `@rcrsr/rill`, `@rcrsr/rill-config`, `@rcrsr/rill-language-service`, and `@rcrsr/rill-ext-datetime` to `~0.20.0`. ([#44](https://github.com/rcrsr/rill-cli/pull/44))
- **Breaking, new diagnostics:** The 0.20.0 rules engine registers 41 rules, up from 40. `CONDITION_TYPE`, `FOLD_INTERMEDIATES`, and `THROWAWAY_CAPTURE` were inert stubs and now emit diagnostics, `SPACING_CLOSURE` and the new `SPACING_MEMBER` also emit. Scripts that passed `rill check` on 0.19.6 can now report findings. Disable individual rules in `rill-check.json` to retain prior output. ([#44](https://github.com/rcrsr/rill-cli/pull/44))

### Known issues

- `rill check --fix` renames a capture declaration to snake_case without renaming its references, leaving the original name undefined and the script unrunnable. The faulty fix payload originates in the rules engine and predates this release; it was masked on 0.19.6 because `THROWAWAY_CAPTURE` was inert. Avoid `--fix` on scripts whose captures are referenced. Tracked upstream in [rcrsr/rill#142](https://github.com/rcrsr/rill/issues/142).

## [0.19.6] - 2026-05-12

### Added

- `rill build` emits `returnType` in the generated handler's introspection JSON when `@rcrsr/rill` provides it on `HandlerMetadataStatic`, so downstream consumers can read the handler's declared return type (#33).

### Changed

- `rill build`-generated `handler.js` now binds `request.params` dict entries to positional arguments using the handler's introspection (mirroring the `rill run` CLI binding), so a closure like `|messages: list| { ... }` is invocable via `execute({ params: { messages: [...] } })`. Closures still read the full dict via `$` (`ctx.pipeValue`) (#33).
- `describe()` in generated handlers now returns a `structuredClone` of the introspection object so callers cannot mutate the shared object that `execute()` reads for positional binding (#33).
- Upgrade `@rcrsr/rill` to `~0.19.3` and `@rcrsr/rill-config` to `~0.19.2`. The new rill release adds `returnType` to `HandlerMetadataStatic` (now consumed directly without a defensive cast) and introduces the `TimeoutBlock` AST node, which `rill check`'s visitor now traverses (visits `duration` and `body`) (#33).

## [0.19.5] - 2026-05-04

### Added

- `rill check` with no arguments now scans the project for `*.rill` files (skipping `.rill/`, `node_modules/`, `dist/`, `.git/`) and lints each. Aggregates exit codes; returns the worst per `--min-severity`. With `--format json`, scan emits a single envelope `{ files: [{ file, errors, summary }, ...], summary: { files, errors, warnings, info } }` (FRICTION-NOTES 2026-05-03).
- `rill check [<file>] --types` is now combinable: lint runs first, then `tsc --noEmit`. The exit code reflects the worst of the two passes. `--fix` remains incompatible with `--types` (FRICTION-NOTES 2026-05-03).

### Changed

- **Breaking:** `rill install` no longer invokes the extension factory after writing the mount. The prior factory pass blocked the common bootstrap → install → configure → validate workflow because most extensions need configuration that doesn't exist at install time. Validation now lives exclusively in `rill describe project` and `rill run`. AC-E6/EC-10 (rollback-on-factory-error) is removed; install only rolls back when the disk write itself fails (FRICTION-NOTES 2026-05-03).
- `rill check --fix` without a file argument now errors with `--fix requires a file argument` instead of `Missing file argument`. The bare no-arg form scans the project; `--fix` would be too aggressive a default for project-wide scans.

### Fixed

- `rill run` no longer swallows the value of an unknown handler-param flag as the project directory. Previously, `rill run --max_scan 5` set `rootDir='5'` and tried to load `./5/rill-config.json`. The pre-scan now identifies tokens that follow unknown long flags and excludes them from `rootDir` selection (FRICTION-NOTES 2026-05-03).

### Documentation

- `rill describe project --stubs` help text now documents the JSON output schema as a stable contract for build tools and skills.
- `rill install --help` documents the new bootstrap → install → configure → validate workflow.

## [0.19.4] - 2026-05-03

### Added

- `rill bootstrap` writes `.rill/tsconfig.rill.json` with `paths` mapping into `.rill/npm/node_modules/` so that `tsc --noEmit` and editors can resolve extension types. When a project-root `tsconfig.json` exists without an `extends` reference, bootstrap prints a one-shot hint to add `"extends": "./.rill/tsconfig.rill.json"` (P0-1)
- `rill check --types` runs `tsc --noEmit` against the project's `tsconfig.json`. Resolves `tsc` from `<projectDir>/node_modules/.bin/` then `<projectDir>/.rill/npm/node_modules/.bin/`. On Windows, probes `tsc.cmd` before `tsc`. Errors with an actionable hint when `tsc` is not installed locally (P0-1)
- `rill describe project --stubs` walks `rill-config.json` for `${env.X}` references and stubs unset env vars to literal `"x"` before constructing extensions, unblocking surface enumeration before credentials are populated. Stubbed names are reported on stderr. String-typed config only; numeric/bool config may still cause factory construction to fail (P0-2)
- `rill install ./extensions/foo.ts --as <mount>` installs single-file extensions (`.ts`, `.js`, `.mjs`, `.cjs`, `.tsx`, `.jsx`). The path is recorded verbatim in `rill-config.json`; npm is not invoked. `--as` is required; version flags are rejected. `rill list` labels the source as `local-file`; `rill uninstall` unregisters but leaves the file on disk (P0-3)
- `rill install --dry-run <pkg-or-path>` prints the derived mount, target version, and would-be config write without touching disk or running npm (P2-2)
- `rill bootstrap --reset` wipes `.rill/npm/` entirely and rewrites all scaffolded files, restoring the previous destructive behavior of `--force` (P1-2)
- `rill build --flat` writes output directly into `<output>` without nesting under a package-name subdirectory (P3-2)
- One-shot stderr notice on the 0.19.1 `rill check` min-severity default change. Suppressed via marker file at `.rill/.notices/min-severity-0.19.1`. Skipped when `--min-severity` is supplied or `.rill-check.json` is present (P1-3)
- README documents the mount-name derivation algorithm under `rill install` (P2-2)

### Changed

- **Breaking:** `rill bootstrap --force` now overwrites only `rill-config.json`. `.rill/npm/` and installed extensions are preserved. Use `--reset` to restore the previous wipe-everything behavior. Migration: callers depending on the old destructive `--force` should switch to `--reset` (P1-2)
- `rill upgrade <mount>` is a no-op when the mount value is pinned (e.g. `pkg@1.2.3` with no caret/range marker). Prints a notice and exits 0; user re-pins via `rill install <pkg>@latest --pin --as <mount>` (P2-3)
- `rill install --exact` and `rill upgrade --exact` print a deprecation warning. The flag still works; will be removed in 0.20. Use `--pin` instead (P2-1)
- `rill` CLI entry now fails fast with a clear message when running on Node < 22.16.0 instead of letting downstream errors surface as opaque module-resolution failures (P1-1)

### Fixed

- `rill describe project --stubs` now restores the previous `process.env` values in a `finally` block. Stubbed credentials no longer leak into subsequent `main()` invocations within the same Node process (#29)
- `rill check --types` no longer silently ignores positional arguments and other flags. Combinations like `rill check foo.rill --types` or `rill check --types --min-severity warning` exit with a clear error (#29)
- `rill check` min-severity notice no longer creates a hidden `.rill/` directory as a side effect in non-bootstrapped projects. The notice still prints; the suppression marker is only written when `.rill/` already exists (#29)
- `rill bootstrap --force --reset` now exits with a clear error instead of silently letting `--reset` win and wipe `.rill/npm/` (#29)
- `rill upgrade` help text shows `rill install <pkg>@latest --pin --as <mount>` so re-pinning a custom mount alias preserves the alias (#29)
- `rill install` / `rill uninstall` / `rill list`: a local directory whose name ends in `.ts` / `.js` / `.mjs` / `.cjs` / `.tsx` / `.jsx` is no longer misclassified as a single-file extension. Single-file detection now stat-checks the path where it can; config-stored specifiers still use suffix-only matching (#29)

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

[Unreleased]: https://github.com/rcrsr/rill-cli/compare/v0.20.0...HEAD
[0.20.0]: https://github.com/rcrsr/rill-cli/compare/v0.19.6...v0.20.0
[0.19.6]: https://github.com/rcrsr/rill-cli/compare/v0.19.5...v0.19.6
[0.19.5]: https://github.com/rcrsr/rill-cli/compare/v0.19.4...v0.19.5
[0.19.4]: https://github.com/rcrsr/rill-cli/compare/v0.19.3...v0.19.4
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
