# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.18.5]

### Added

- Session variable (`@{VAR}`) substitution from `process.env` in `rill-run`

### Changed

- Update `@rcrsr/rill-config` from 0.18.4 to 0.18.5
- Remove `env` parameter from `loadProject()` call (breaking change in rill-config)

## [0.18.4]

### Changed

- Move `@rcrsr/rill` and `@rcrsr/rill-config` from dependencies to peer dependencies
- Update `dotenv` from 16.x to 17.x
- Update `typescript` from 5.x to 6.x
- Update all dev dependencies to latest versions

## [0.18.3]

Initial standalone release. Extracted `@rcrsr/rill-cli` from the [rill monorepo](https://github.com/rcrsr/rill). No functional changes from the monorepo version.

[0.18.5]: https://github.com/rcrsr/rill-cli/compare/v0.18.4...v0.18.5
[0.18.4]: https://github.com/rcrsr/rill-cli/compare/v0.18.3...v0.18.4
[0.18.3]: https://github.com/rcrsr/rill-cli/releases/tag/v0.18.3
