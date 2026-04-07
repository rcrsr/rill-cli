# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

[Unreleased]: https://github.com/rcrsr/rill-cli/compare/v0.18.7...HEAD
[0.18.7]: https://github.com/rcrsr/rill-cli/compare/v0.18.6...v0.18.7
[0.18.6]: https://github.com/rcrsr/rill-cli/compare/v0.18.5...v0.18.6
[0.18.5]: https://github.com/rcrsr/rill-cli/compare/v0.18.4...v0.18.5
[0.18.4]: https://github.com/rcrsr/rill-cli/compare/v0.18.3...v0.18.4
[0.18.3]: https://github.com/rcrsr/rill-cli/releases/tag/v0.18.3
