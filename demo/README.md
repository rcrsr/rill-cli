# rill-cli demos

Three runnable rill packages exercising the 0.19.0 CLI: a happy path, a
parse-time error, and a runtime halt with an atom code.

Each demo is a directory containing `rill-config.json` (with a `main`
field pointing to the entry script) and one `.rill` source file.
`rill run <dir>` discovers the config, parses the script, and executes
it.

## Prerequisites

```bash
pnpm install
pnpm run build      # produces dist/cli.js (and other dist artifacts)
```

## Demos

| # | Folder              | Command                                       | Expected outcome                                                  |
| - | ------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| 1 | `01-happy-path`     | `node dist/cli.js run demo/01-happy-path`     | exit `0`, prints `28`                                             |
| 2 | `02-init-error`     | `node dist/cli.js run demo/02-init-error`     | exit `1`, parse error envelope (unclosed `{`)                     |
| 3 | `03-runtime-error`  | `node dist/cli.js run demo/03-runtime-error`  | exit `1`, atom-coded halt envelope (`#RILL_R038`, type mismatch)  |

### 1. Happy path

Pipes a literal list through three of the new 0.19.0 collection
operators (`filter`, `fan`, `fold`) and returns a scalar.

```rill
list[1, 2, 3, 4, 5]
  -> filter({ $ > 1 })
  -> fan({ $ * 2 })
  -> fold(0, { $@ + $ })
```

Filters out `1`, doubles the rest to `[4, 6, 8, 10]`, folds them with
`+` starting at `0`, returns `28`.

### 2. Initialization error

Truncated source — the closure body opens with `{` but never closes:

```rill
list[1, 2, 3] -> seq({ $ * 2
```

`rill run` surfaces this through the parse error envelope before any
execution starts. `rill check demo/02-init-error/main.rill` reports the
same diagnostic in CI-friendly form (exit code `3`).

### 3. Runtime error

Triggers a runtime halt with an atom code via the type-cast pipe:

```rill
"not a number" -> number
```

The cast fails at runtime and surfaces through the new 0.19.0 error
envelope: atom header, source location, provider, source highlight.
Try `--trace` to see the trace chain:

```bash
node dist/cli.js run demo/03-runtime-error --trace
```

Wrap the cast in `guard<on: list[#TYPE_MISMATCH]> { ... }` to recover
from the halt; the script then returns the recovered invalid as a
normal value (use `--show-recovered` to see the caught frames).

## Static check on all demos

```bash
node dist/cli.js check demo/01-happy-path/main.rill     # clean
node dist/cli.js check demo/02-init-error/main.rill     # parse error
node dist/cli.js check demo/03-runtime-error/main.rill  # clean (runtime, not static)
```
