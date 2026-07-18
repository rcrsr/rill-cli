[![CI](https://github.com/rcrsr/rill-cli/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rcrsr/rill-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rcrsr/rill-cli)](https://www.npmjs.com/package/@rcrsr/rill-cli)
[![Node](https://img.shields.io/node/v/@rcrsr/rill-cli)](https://www.npmjs.com/package/@rcrsr/rill-cli)
[![License](https://img.shields.io/npm/l/@rcrsr/rill-cli)](https://github.com/rcrsr/rill-cli/blob/main/LICENSE)

# @rcrsr/rill-cli

Command-line tools for running and validating [rill](https://rill.run) scripts.

> [!WARNING]
> **This language is experimental.** Breaking changes will occur before stabilization.

| Subcommand | Purpose |
|------------|---------|
| `rill init` | Scaffold a new single-package project (`rill-config.json` + `.rill/npm/`) |
| `rill init bundle [name]` | Scaffold a new multi-package bundle (`rill-bundle.json` + `packages/`) |
| `rill init package <name>` | Add a package inside an existing bundle (or scaffold standalone) |
| `rill bootstrap` | **Removed** — renamed to `rill init`; prints a rename notice and exits 1 |
| `rill install <pkg>` | Install an extension into .rill/npm/ and mount it |
| `rill uninstall <mount>` | Remove a mounted extension |
| `rill upgrade <mount>` | Update a mounted extension to a newer version |
| `rill list` | List installed extensions and their mount paths |
| `rill build` | Compile the project (package or bundle) for production |
| `rill check` | Validate rill-config.json and source files |
| `rill describe` | Print callable contracts (handler signatures) |
| `rill eval <expr>` | Evaluate a rill expression and print the result |
| `rill exec <file>` | Execute a rill script file or stdin input |
| `rill run [project-dir]` | Execute the project entry from rill-config.json |

Run `rill help <command>` or `rill <command> --help` for details.

## Concepts

Four terms appear throughout this documentation. They are defined here for clarity.

**Package** — a single rill project. It has a `rill-config.json` at its root and produces one compiled output when you run `rill build`. This is the original and default project unit.

**Bundle** — a multi-package workspace. It has a `rill-bundle.json` at its root and contains two or more packages under a `packages/` directory. Running `rill build` or `rill run` at the bundle root compiles or runs all member packages together.

**Mount** — the short name under which an extension (or a package within a bundle) is accessible at runtime. For example, installing `@rcrsr/rill-ext-datetime --as dt` mounts the extension at `dt`. Bundle packages declare their mount in `rill-bundle.json` via the `mount` field.

**Harness** — a TypeScript module that controls how a bundle is compiled and served. It receives compiled packages after `rill build` and decides how to start a server during `rill run`. The built-in harness handles common HTTP serving scenarios. Custom harnesses implement the `RillHarness` interface exported from `@rcrsr/rill-cli/harness`.

## Install

Requires **Node.js >= 22.16.0**. The CLI checks `process.versions.node` at entry and exits with a clear error on older runtimes.

```bash
npm install -g @rcrsr/rill-cli
```

Or as a project dependency (`@rcrsr/rill` and `@rcrsr/rill-config` are declared as both runtime and peer dependencies, and will deduplicate with your project's installed versions):

```bash
npm install @rcrsr/rill-cli
```

## Quickstart

```bash
rill init                           # initialize project + .rill/npm/
rill install @rcrsr/rill-ext-datetime  # add an extension
rill list                           # show installed extensions
rill build                          # compile for production
rill run                            # execute the project
```

## Subcommands

### rill init

Scaffold a new project. The subcommand determines the project shape.

```bash
rill init                           # single-package project in cwd
rill init bundle [name]             # multi-package bundle in cwd
rill init package <name>            # add a package to a bundle (or standalone)
rill init --help                    # list available subcommands
```

**`rill init` (no subcommand)**

Creates `rill-config.json` and `.rill/npm/` in the current directory for a single-package project.

**`rill init bundle [name]`**

Creates `rill-bundle.json`, `.rill/npm/`, and a `packages/` directory in the current directory. The optional `name` argument sets the bundle name in `rill-bundle.json`. Use this when you want a workspace that compiles and serves multiple packages together under one harness.

**`rill init package <name>`**

When run inside a bundle (any parent directory contains `rill-bundle.json`), creates a new package directory at `<bundle-root>/packages/<name>/`. When run outside a bundle, creates a standalone single-package project in the current directory under a `<name>/` subdirectory.

**TypeScript types for custom extensions.** `rill init` writes `.rill/tsconfig.rill.json` with a `paths` mapping into `.rill/npm/node_modules/`. Add this line to your `tsconfig.json` so editors and `tsc --noEmit` resolve extension imports:

```json
{ "extends": "./.rill/tsconfig.rill.json" }
```

Or use `rill check --types` (see below) to typecheck without managing tsconfig directly.

---

### rill bootstrap

> **Removed.** `rill bootstrap` has been renamed to `rill init` and no longer scaffolds a project. Running `rill bootstrap` (with any arguments, including `--help`) prints a rename notice and exits with code 1. Use `rill init` (single package), `rill init bundle` (bundle), or `rill init package <name>` (package inside a bundle) instead.

### rill install

Install an extension into `.rill/npm/` and register it as a mount in `rill-config.json`.

```bash
rill install @rcrsr/rill-ext-datetime          # install from npm
rill install @rcrsr/rill-ext-datetime --as dt  # custom mount name
rill install ./local-ext                       # install from a local directory
rill install ./extensions/crawler.ts --as crawler  # single-file source
rill install --dry-run @rcrsr/rill-ext-anthropic   # preview without writing
```

**Options:**

| Flag | Description |
|------|-------------|
| `--as <mount>` | Mount name to use (default: derived from package name; required for single-file sources) |
| `--pin` | Pin to the exact installed version (no caret prefix). Registry installs only. |
| `--exact` | **Deprecated** alias for `--pin`. Will be removed in 0.20. |
| `--range <semver>` | Specify a custom semver range. Registry installs only. |
| `--dry-run` | Print what would be done without writing config or running npm. |
| `--for <mount>` | Target a specific package mount when installing an extension from a bundle root. |
| `--role extension\|harness` | Disambiguate packages that export both an extension and a harness. |
| `--replace` | Atomically swap the declared harness in `rill-bundle.json` with the installed package. |

**Bundle-aware install.** When run at a bundle root (where `rill-bundle.json` exists), use `--for <mount>` to install an extension into a specific member package rather than the bundle root. Use `--role harness` combined with `--replace` to swap the active harness in one operation.

**Mount name derivation.** When `--as` is omitted, the mount name comes from:

1. Local path (`./foo`, `/abs/path`): `path.basename(specifier)`.
2. Scoped rill-ext (`@scope/rill-ext-X`): `X`.
3. Plain rill-ext (`rill-ext-X`): `X`.
4. Scoped package (`@scope/name`): `name` (last segment).
5. Plain package: the specifier verbatim.

Use `rill install --dry-run <pkg>` to preview the derived name before installing.

**Source kinds:**

- **Registry** — `@rcrsr/rill-ext-foo` or `pkg@^1.2.3`. npm install into `.rill/npm/`. Eligible for `--pin`/`--range`.
- **Local directory** — `./my-ext`. npm symlinks the directory; source edits propagate without reinstalling. Cannot be upgraded with `rill upgrade`.
- **Single-file source** — `./extensions/crawler.ts` (`.ts`/`.js`/`.mjs`/`.cjs`/`.tsx`/`.jsx`). Path is recorded verbatim in `rill-config.json`; npm is not invoked. `--as` is required, version flags are rejected. `rill list` labels it `local-file`. `rill uninstall` unregisters but leaves the file on disk.

### rill uninstall

Remove a mounted extension from `.rill/npm/` and unregister it from `rill-config.json`.

```bash
rill uninstall <mount>
```

### rill upgrade

Update a mounted extension to a newer version. Resolves the latest version matching the configured range and reinstalls.

```bash
rill upgrade <mount>
```

Local-path mounts cannot be upgraded; they are symlinked, so edits to the source directory are picked up automatically.

Pinned mounts (`pkg@1.2.3` with no caret/range) are a no-op — the mount was pinned on purpose. To repin to a new version, run `rill install <pkg>@latest --pin --as <mount>`.

### rill list

List all installed extensions and their mount paths.

```bash
rill list
rill list --json                    # machine-readable output
```

**Options:**

| Flag | Description |
|------|-------------|
| `--json` | Emit results as JSON array |

The `source` column distinguishes:

- `registry` — installed from npm into `.rill/npm/`.
- `local` — local directory, symlinked into `.rill/npm/`.
- `local-file` — single-file source (`.ts`/`.js`/`.mjs`/etc.) recorded verbatim in `rill-config.json`.

### rill exec

Execute a rill script file.

```bash
rill exec script.rill [args...]
rill exec -                        # read from stdin
```

Positional arguments pass to the script as `$` (pipe value):

```bash
rill exec greet.rill alice bob
# Inside script: $ == ["alice", "bob"]
```

Read from stdin with `-`:

```bash
echo '"Hello" -> log' | rill exec -
```

**Exit codes:**

| Return Value | Exit Code |
|-------------|-----------|
| `true` or non-empty string | 0 |
| `false` or empty string | 1 |
| `[0, "message"]` | 0 (prints message) |
| `[1, "message"]` | 1 (prints message) |

### rill eval

Evaluate a single rill expression. No file context or module loading.

```bash
rill eval '"hello".len'            # 5
rill eval '5 + 3'                  # 8
rill eval '[1, 2, 3] -> map |x|($x * 2)'  # [2, 4, 6]
```

### rill check

Lint and validate rill scripts. Or, with `--types`, run `tsc --noEmit` against the project's TypeScript extensions.

```bash
rill check script.rill             # text output
rill check --format json script.rill
rill check --fix script.rill       # auto-fix
rill check --types                 # TypeScript type-check
```

**Options:**

| Flag | Description |
|------|-------------|
| `--fix` | Apply automatic fixes |
| `--format text\|json` | Output format (default: text) |
| `--verbose` | Include rule category in JSON output |
| `--min-severity error\|warning\|info` | Severity threshold for non-zero exit (default: error) |
| `--types` | Run `tsc --noEmit` against the project's `tsconfig.json`. Locates `tsc` from `node_modules/.bin/` or `.rill/npm/node_modules/.bin/`. Requires the user's `tsconfig.json` to extend `./.rill/tsconfig.rill.json` (written by `rill init`). |

**Exit codes:**

| Code | Meaning |
|------|---------|
| 0 | No diagnostics at or above `--min-severity` (default: error) |
| 1 | Diagnostics at or above `--min-severity`, or CLI usage error |
| 2 | File not found or path is a directory |
| 3 | Parse error in source |

Diagnostics below the threshold still print so the user sees them; only the exit code is gated. Example: a file with one `info`-level advisory exits 0 by default but exits 1 under `--min-severity info`.

**Configuration:** Place `.rill-check.json` in the project root:

```json
{
  "rules": {
    "NAMING_SNAKE_CASE": "on",
    "SPACING_OPERATOR": "off"
  },
  "severity": {
    "NAMING_SNAKE_CASE": "info"
  }
}
```

Rule states: `"on"` (enabled), `"off"` (disabled), `"warn"` (downgrade to warning). `rill check` passes the `rules` map directly to `@rcrsr/rill-language-service`, which filters `"off"` rules and remaps `"warn"` rules to `warning` severity while it runs. The `severity` map sets an arbitrary severity per rule code. The rule engine exposes only one optional global severity override, not a per-rule field. So `rill check` reads the `severity` map itself and reapplies it to diagnostics by code after the engine returns. A `severity` entry for a code wins over a `"warn"`-state remap for that same code.

**Lint rules:** 40 rules across 11 categories (naming, flow, collections, loops, conditionals, closures, types, strings, anti-patterns, formatting, errors). 37 rules are active; 3 are reserved for upcoming checks and currently emit no diagnostics. Run `rill check --help` for the full list.

### rill run

Config-driven execution. The active mode (package or bundle) is determined by which config files exist in the current working directory.

**Mode detection:**

| Files present | Active mode | Behavior |
|---------------|-------------|----------|
| `rill-bundle.json` | bundle | Runs all packages via the configured harness |
| `rill-config.json` only | package | Runs the single-package entry as usual |
| Both present | bundle | Bundle mode takes precedence |
| Neither | error | `rill-config.json not found` |

```bash
rill run [project-dir] [--config <path>] [handler-args...]
```

**Package mode — module mode:** When `main` points to a script file, `rill run` executes it. Positional arguments forward as `$`.

**Package mode — handler mode:** When `main` names a handler (e.g., `"script.rill:processOrder"`), parameters come from `--param_name value` flags. Run `rill run --help` to print the parameter list.

**Bundle mode:** `rill run` invokes the harness `serve` hook, which receives all compiled packages and returns a port number when the server is ready. The built-in harness starts an HTTP server; custom harnesses can do anything.

See [CLI Reference](https://github.com/rcrsr/rill/blob/main/docs/integration-cli.md) and [Config Reference](https://github.com/rcrsr/rill/blob/main/docs/ref-config.md) for details.

### rill build

Compile a rill project into a self-contained output directory. Packages extensions via esbuild, copies entry and module files, and writes an enriched `rill-config.json` with build metadata.

**Mode detection** follows the same file-driven rules as `rill run`.

```bash
rill build [project-dir] [--output <dir>] [--flat]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--output <dir>` | Output directory (default: `build/`) |
| `--flat` | Write directly into `<output>` without a package-name subdirectory. |

**Package mode — output structure (default):**

```
build/<package-name>/
  main.rill              # entry script
  rill-config.json       # enriched with build section
  extensions/            # packaged extension JS files
  modules/               # copied module .rill files
  runtime.js             # packaged rill runtime
  run.js                 # CLI wrapper
  handler.js             # handler export for harness consumption
```

**Package mode — output structure (`--flat`):** identical contents written directly into `<output>` without the package-name level. Use when you control the output dir and don't need to compose multiple packages.

**Bundle mode — output structure:**

```
build/
  <package-a>/           # one subdirectory per bundle member package
    ...                  # same layout as single-package output
  <package-b>/
    ...
```

After building all packages, `rill build` calls the harness `postBuild` hook, which receives the list of compiled packages and their output directories.

The `build` section in the output `rill-config.json` contains a SHA-256 checksum, rill runtime version, and config version.

### rill describe

Describe rill callables as a JSON contract. Three subcommands cover the distinct surfaces a project exposes: extension surface (`project`), the project's own handler (`handler`), and the rill runtime itself (`builtins`).

```bash
rill describe project                          # all extension mounts (default)
rill describe project --mount <name>           # restrict output to a single mount
rill describe handler                          # the project's published handler
rill describe builtins                         # rill runtime callables (no config needed)
```

When no subcommand is given, `project` is assumed.

**Subcommands:**

| Subcommand | Purpose |
|------------|---------|
| `project` | Walk `project.extTree` and emit per-mount callable trees |
| `handler` | Resolve `main: "file.rill:name"`, execute the script, and emit the handler signature |
| `builtins` | Walk `ctx.functions` and `ctx.typeMethodDicts` |

**Options (project):**

| Flag | Description |
|------|-------------|
| `--mount <name>` | Limit output to a single mount |
| `--strict` | Exit 1 if any callable has `returnType: any` |
| `--stubs` | Stub unset env vars referenced as `${env.X}` in `rill-config.json` with literal `"x"` before constructing extensions. Use to enumerate callable surface before credentials are populated (e.g., for LLM-driven authoring tools). String-typed config only; numeric/bool config may still cause factory construction to fail. |
| `--config <path>` | Config file path (default: `./rill-config.json`) |

**Options (handler):**

| Flag | Description |
|------|-------------|
| `--strict` | Exit 1 if any callable has `returnType: any` |
| `--config <path>` | Config file path (default: `./rill-config.json`) |

**Options (builtins):**

| Flag | Description |
|------|-------------|
| `--strict` | Exit 1 if any callable has `returnType: any` |

**Exit codes:**

| Code | Meaning |
|------|---------|
| 0 | Contract emitted |
| 1 | Config error, unknown mount, missing handler, or `--strict` violation |

## Harness Authoring

A harness controls how a bundle is compiled and served. The built-in harness (`@rcrsr/rill-cli/builtin`) covers common HTTP serving scenarios. To write a custom harness, implement the `RillHarness` interface and export it from a package that declares `"role": "harness"` in its `rill-bundle.json` entry.

### Import

```typescript
import type { RillHarness, PostBuildContext, ServeContext } from '@rcrsr/rill-cli/harness';
```

### RillHarness interface

```typescript
interface RillHarness {
  name: string;
  postBuild?: (ctx: PostBuildContext) => Promise<void>;
  serve?: (ctx: ServeContext) => Promise<number>;
}
```

| Member | Required | Description |
|--------|----------|-------------|
| `name` | yes | Identifier used in log output |
| `postBuild` | no | Called after all packages compile; receives compiled package list |
| `serve` | no | Called by `rill run`; must return the port number when the server is ready |

### Context types

**`HarnessContext`** — base context passed to all hooks:

| Field | Type | Description |
|-------|------|-------------|
| `bundleDir` | `string` | Absolute path to the bundle root |
| `bundle` | `RillBundleConfig` | Parsed `rill-bundle.json` |
| `config` | `unknown` | Value of `config` from `rill-bundle.json`, if set |
| `logger` | `Logger` | Minimal logger (`info`, `warn`, `error`) |

**`PostBuildContext`** extends `HarnessContext` and adds:

| Field | Type | Description |
|-------|------|-------------|
| `outputDir` | `string` | Root output directory for the build |
| `packages` | `CompiledPackage[]` | All compiled packages in this run |

**`ServeContext`** extends `HarnessContext` and adds:

| Field | Type | Description |
|-------|------|-------------|
| `packages` | `CompiledPackage[]` | Compiled packages available to serve |
| `compile` | `() => Promise<CompiledPackage[]>` | Trigger a fresh build of all packages |
| `onSourceChange` | `(cb: () => void) => void` | Register a callback for file-system changes |
| `onShutdown` | `(cb: () => void) => void` | Register a cleanup callback |

**`CompiledPackage`**:

| Field | Type | Description |
|-------|------|-------------|
| `mount` | `string` | Mount name declared in `rill-bundle.json` |
| `packageName` | `string` | Package name from `rill-config.json` |
| `packageDir` | `string` | Source directory of the package |
| `buildOutput` | `string` | Output directory for this package's compiled files |

**`Logger`**:

```typescript
interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
```

### Bundle config shape (`rill-bundle.json`)

```json
{
  "name": "my-bundle",
  "version": "1.0.0",
  "harness": "@acme/my-harness",
  "config": { "port": 3000 },
  "defaultPackage": "api",
  "packages": [
    { "mount": "api",      "project": "packages/api" },
    { "mount": "frontend", "project": "packages/frontend" }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Bundle identifier |
| `version` | yes | SemVer string |
| `harness` | no | Package name of a custom harness. Omit to use the built-in harness. |
| `config` | no | Arbitrary config object forwarded to `HarnessContext.config` |
| `defaultPackage` | no | Mount name to use when no `--for` flag is given at bundle root |
| `packages` | yes | Array of `{ mount, project }` entries |

### Minimal example

```typescript
import type { RillHarness, ServeContext } from '@rcrsr/rill-cli/harness';
import { createServer } from 'http';

export const harness: RillHarness = {
  name: 'my-harness',
  async serve(ctx: ServeContext): Promise<number> {
    const port = 3000;
    const server = createServer((req, res) => {
      res.end('ok');
    });
    ctx.onShutdown(() => server.close());
    await new Promise<void>((resolve) => server.listen(port, resolve));
    return port;
  },
};
```

## Documentation

| Document | Description |
|----------|-------------|
| [CLI Reference](https://github.com/rcrsr/rill/blob/main/docs/integration-cli.md) | Full CLI documentation |
| [Language Reference](https://github.com/rcrsr/rill/blob/main/docs/ref-language.md) | Language specification |
| [Conventions](https://github.com/rcrsr/rill/blob/main/docs/guide-conventions.md) | Coding style and lint rationale |

## License

MIT
