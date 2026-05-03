# Migration Guide: Extension CLI DX

This guide applies to the coordinated minor-version release of `rill-cli` and `@rcrsr/rill-config`
that introduces the `.rill/npm/` extension prefix, the unified `rill` binary, and the new lifecycle
subcommands (`bootstrap`, `install`, `uninstall`, `upgrade`, `list`). See CHANGELOG.md for the
full list of changes included in this release.

---

## Bootstrap an existing project

- Run `rill bootstrap` once inside any existing rill project directory.
- The command creates the following files and directories:
  - `.rill/` — the new per-project rill state directory
  - `.rill/npm/package.json` — npm workspace root for installed extensions
  - `.rill/npm/.gitignore` — ignores `node_modules/` inside `.rill/npm/`
  - `rill-config.json` — created only if the file does not already exist
- The command also appends `.rill/` to the project-root `.gitignore` (creating the file if absent).
- Bootstrap is a no-op for any file or directory that already exists; run `rill bootstrap --force`
  to overwrite existing artifacts.

---

## Re-install previously-installed extensions

- The new `.rill/npm/` prefix has an empty `node_modules/` after bootstrap; it does not inherit
  any extensions from the project-root `node_modules/`.
- Every extension previously installed in project-root `node_modules/` (or recorded in an older
  `rill-config.json`) must be re-installed explicitly.
- For each npm-hosted extension package `<pkg>`, run:
  - `rill install <pkg>`
- For each locally-developed extension at a relative path, run:
  - `rill install ./<local-path>`
- `rill install` records the extension mount in `rill-config.json` automatically; no manual edits
  are required.

---

## Expected breakage

- **Non-bootstrapped project — build fails.**
  Running `rill build` (or any subcommand that loads extensions) against a project that has not
  been bootstrapped produces this error message and exits with code 1:

  ```
  Run 'rill bootstrap' to initialize this project, or pass a project-dir argument pointing at an existing bootstrapped project.
  ```

- **Standalone binaries removed.**
  The packages `rill-build`, `rill-check`, `rill-describe`, `rill-eval`, `rill-exec`, and
  `rill-run` no longer exist as separate binaries. The `package.json` `bin` field now registers
  only the single `rill` binary. Replace every invocation:

  | Old command | New command |
  |---|---|
  | `rill-build .` | `rill build .` |
  | `rill-check .` | `rill check .` |
  | `rill-describe .` | `rill describe .` |
  | `rill-eval .` | `rill eval .` |
  | `rill-exec .` | `rill exec .` |
  | `rill-run .` | `rill run .` |

- **`@rcrsr/rill-config` direct consumers — new required parameter.**
  Library consumers that import `@rcrsr/rill-config` and call `loadProject` or `loadExtensions`
  directly must add the new required `prefix` parameter. The value must be the path to the
  `.rill/npm` directory inside the project directory (e.g., `<projectDir>/.rill/npm`).
  Calls without `prefix` will fail at the TypeScript level and at runtime.

---

## No automated migration tool

- Migration is manual: run `rill bootstrap`, then re-install each extension with `rill install`.
- There is no `rill migrate` command in this release.
- No automated tool reads old `node_modules/` contents and reconstructs `rill-config.json`.

---

## Quickstart for migration

1. Run `rill bootstrap` in the project root.
2. For each previously-installed npm extension `<pkg>`, run `rill install <pkg>`.
   For each local extension at a relative path, run `rill install ./<path>`.
3. Run `rill list` to verify that the expected extension mounts are present.
4. Run `rill build` (or whichever subcommand you use) to confirm the migration succeeded.
