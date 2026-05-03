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
| `rill bootstrap` | Initialize a new rill project (.rill/npm/, rill-config.json) |
| `rill install <pkg>` | Install an extension into .rill/npm/ and mount it |
| `rill uninstall <mount>` | Remove a mounted extension |
| `rill upgrade <mount>` | Update a mounted extension to a newer version |
| `rill list` | List installed extensions and their mount paths |
| `rill build` | Bundle the project for production |
| `rill check` | Validate rill-config.json and source files |
| `rill describe` | Print callable contracts (handler signatures) |
| `rill eval <expr>` | Evaluate a rill expression and print the result |
| `rill exec <file>` | Execute a rill script file or stdin input |
| `rill run [project-dir]` | Execute the project entry from rill-config.json |

Run `rill help <command>` or `rill <command> --help` for details.

## Install

```bash
npm install -g @rcrsr/rill-cli
```

Or as a project dependency (`@rcrsr/rill` and `@rcrsr/rill-config` are declared as both runtime and peer dependencies, and will deduplicate with your project's installed versions):

```bash
npm install @rcrsr/rill-cli
```

## Quickstart

```bash
rill bootstrap                      # initialize project + .rill/npm/
rill install @rcrsr/rill-ext-datetime  # add an extension
rill list                           # show installed extensions
rill build                          # bundle for production
rill run                            # execute the project
```

## Subcommands

### rill bootstrap

Initialize a new rill project. Creates `.rill/npm/` and a starter `rill-config.json` in the current directory.

```bash
rill bootstrap
rill bootstrap --force              # overwrite existing config
```

**Options:**

| Flag | Description |
|------|-------------|
| `--force` | Overwrite existing `rill-config.json` and `.rill/npm/` |

### rill install

Install an extension into `.rill/npm/` and register it as a mount in `rill-config.json`.

```bash
rill install @rcrsr/rill-ext-datetime          # install from npm
rill install @rcrsr/rill-ext-datetime --as dt  # custom mount name
rill install ./local-ext                       # install from local path
```

**Options:**

| Flag | Description |
|------|-------------|
| `--as <mount>` | Mount name to use (default: derived from package name) |
| `--pin` | Pin to the exact installed version (no caret prefix) |
| `--exact` | Alias for `--pin` |
| `--range <semver>` | Specify a custom semver range |

Local-path installs (e.g., `./local-ext`) symlink the directory, so source edits propagate without reinstalling. They cannot be upgraded with `rill upgrade`.

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

Lint and validate rill scripts.

```bash
rill check script.rill             # text output
rill check --format json script.rill
rill check --fix script.rill       # auto-fix
```

**Options:**

| Flag | Description |
|------|-------------|
| `--fix` | Apply automatic fixes |
| `--format text\|json` | Output format (default: text) |
| `--verbose` | Include rule category in JSON output |
| `--min-severity error\|warning\|info` | Severity threshold for non-zero exit (default: error) |

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
  }
}
```

Rule states: `"on"` (enabled), `"off"` (disabled), `"warn"` (downgrade to warning).

**Lint rules:** 40 rules across 11 categories (naming, flow, collections, loops, conditionals, closures, types, strings, anti-patterns, formatting, errors). Run `rill check --help` for the full list.

### rill run

Config-driven execution. Loads extensions and settings from `rill-config.json`, then runs a script or named handler.

```bash
rill run [project-dir] [--config <path>] [handler-args...]
```

**Module mode:** When `main` points to a script file, `rill run` executes it. Positional arguments forward as `$`.

**Handler mode:** When `main` names a handler (e.g., `"script.rill:processOrder"`), parameters come from `--param_name value` flags. Run `rill run --help` to print the parameter list.

See [CLI Reference](https://github.com/rcrsr/rill/blob/main/docs/integration-cli.md) and [Config Reference](https://github.com/rcrsr/rill/blob/main/docs/ref-config.md) for details.

### rill build

Compile a rill project into a self-contained output directory. Bundles extensions via esbuild, copies entry and module files, and writes an enriched `rill-config.json` with build metadata.

```bash
rill build [project-dir] [--output <dir>]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--output <dir>` | Output directory (default: `build/`) |

**Output structure:**

```
build/<package-name>/
  main.rill              # entry script
  rill-config.json       # enriched with build section
  extensions/            # bundled extension JS files
  modules/               # copied module .rill files
  runtime.js             # bundled rill runtime
  run.js                 # CLI wrapper
  handler.js             # handler export for harness consumption
```

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

## Documentation

| Document | Description |
|----------|-------------|
| [CLI Reference](https://github.com/rcrsr/rill/blob/main/docs/integration-cli.md) | Full CLI documentation |
| [Language Reference](https://github.com/rcrsr/rill/blob/main/docs/ref-language.md) | Language specification |
| [Conventions](https://github.com/rcrsr/rill/blob/main/docs/guide-conventions.md) | Coding style and lint rationale |

## License

MIT
