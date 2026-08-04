# CLAUDE.md

## What this is

`@rcrsr/rill-cli` is the command-line front end for the rill scripting language:
`rill init`, `install`, `build`, `check`, `run`, `exec`, `eval`, `describe`.

It owns the CLI shell, project and bundle scaffolding, the npm extension
lifecycle, esbuild output, and error rendering. It does **not** own parsing,
evaluation, or the check rules. Those live in `@rcrsr/rill`,
`@rcrsr/rill-config`, and `@rcrsr/rill-language-service`, which arrive as pinned
peer dependencies. A defect in language behaviour belongs upstream, not here.

Single package published from the repository root, two entry points: `.` (the
CLI) and `./harness`. No `packages/` tree, no workspace.

## Layout

- `src/cli.ts` is the dispatch table; every subcommand routes through it.
  Project commands live in `src/commands/*.ts`, pipeline commands in
  `src/cli-*.ts` (`build`, `check`, `describe`, `eval`, `exec`, `run`).
- `src/run/`, `src/build/`, `src/bundle/`, `src/check-adapter/`: execution,
  esbuild output, multi-package bundles, and the language-service adapter.
- `src/harness.ts` and `src/harness/`: the published `RillHarness` interface and
  the built-in HTTP harness.
- `tests/` mirrors `src/` under vitest. `conduct/` is private planning, `demo/`
  is runnable examples, `scripts/` is repository-local tooling.

## Commands

```bash
pnpm check                       # the gate: standards, build, types, lint, format, tests, knip
pnpm test tests/cli/exec.test.ts # one file, for the inner loop
pnpm fix:format && pnpm fix:lint
```

## Rules

- **Do not patch `node_modules/@rcrsr/rill-dev`.** The standards checker, the
  standards index, and the custom lint rules ship as that devDependency. Nothing
  checks for drift any more, so a local edit is simply lost on the next install
  while every other repository keeps the old behaviour. Fix it in
  [rcrsr/rill](https://github.com/rcrsr/rill) under `packages/dev/`, publish from
  a `dev-v*` tag, then bump the dependency here.
- **New public API is exported from `src/cli.ts` or `src/harness.ts`.**
  `exports` lists those two entry points and nothing else, so a deep path is
  unreachable for consumers.
- **No internal planning identifiers in `src/`.** `rill/no-spec-id-reference`
  rejects `AC-*`, `EC-*`, `FR-*`, `UX*-*` and the rest: they point at `conduct/`
  documents that are never published. Keep the fact, drop the reference.
- **`pnpm check` is the gate.** It reaches every check. It must never delegate
  to `pnpm -r`, which excludes the root and would skip all of them.
- **Root scripts use the aggregator names**: `check:types` and `check:lint`, not
  `typecheck` and `lint` (STD-SCRIPT-8).
- **Never bump the `@rcrsr/*` versions in a change.** They are pinned in
  lockstep to the matching rill minor, which is why dependabot skips them.
  `@rcrsr/rill-dev` is the exception: it carries no runtime code, versions on
  its own `dev-v*` tags, and dependabot does propose it.
- **Conventional Commits with an area scope**, e.g. `fix(bundle): ...`. Add the
  entry to `## [Unreleased]` in `CHANGELOG.md` with its PR link. `CONTRIBUTING.md`
  has the full bar for a pull request.

## Gotchas

- **Tests are not typechecked.** `tsconfig.json` scopes `include` to `src/**/*`
  because it drives the emit, and `tsc --noEmit` honours it. Run `pnpm test`,
  not just the typechecker.
- **A test file that fails to import reports as one file-level failure**, not as
  failing tests, so a suite that never collects can read as green. Check the
  test count is what you expect.
- **`link:`/`file:` specifiers never get committed.** They are a local
  convenience for a sibling checkout; `prepublishOnly` blocks a publish carrying
  them, but nothing blocks the commit.
- **`pnpm-workspace.yaml` exists without a `packages:` key.** pnpm 11 reads it
  for the build allowlist and the supply-chain settings, which is the only
  reason it is there. It does not make this a workspace.

## Repository standards

Conformance bookkeeping, kept here because `REPO-STANDARDS.md` requires it. Read
the index at `node_modules/@rcrsr/rill-dev/REPO-STANDARDS.md`. Not needed for
ordinary work.

STD-DOC-3 requires every N/A recorded here with the condition it meets. An N/A
without a matching stated condition is a defect, not a decision.

| ID | Condition met |
|---|---|
| STD-CHK-7, STD-SCRIPT-3, STD-SCRIPT-7, STD-DEP-4 | Publishes exactly one package from the root, with no second version to reconcile. |
| STD-PM-7 | Declares no workspace packages. The standard words the condition as "no workspace file", which no pnpm-11 single-package repository can meet; raised upstream. |
| STD-DEP-3 | No tool conflicts with the current compiler major. |

### Lint rule enablement

`rill/no-spec-id-reference` is **on**, scoped to `src/**/*.{ts,tsx}`: `conduct/`
is a private planning directory whose identifiers are unresolvable to anyone
reading the published package. `tests/` is out of scope because nothing there
ships.

`rill/no-duplicate-error-id` is **off**. It keys on `RuntimeError` construction,
and this repository only narrows with `instanceof RuntimeError` and imports the
type; it never constructs one, so the rule has nothing to match. This is a
recorded decision, not an oversight. Do not enable it to match an example
config.

### CI checks the tree; a maintainer checks the host

CI runs `pnpm exec rill-check-standards` with **no `--remote` and no token**.

A pull request cannot change host state, so gating merges on it turns every open
PR red for a reason no author can fix. `GITHUB_TOKEN` could not decide those
elements anyway: the administrative fields are omitted from the repository
object it reads and `branches/*/protection` answers 404, so §1 and §13 report
unchecked with the flag and without it. Do not re-add it.

Host settings are checked by hand, from a maintainer's authenticated shell:

```bash
pnpm exec rill-check-standards --remote
```

Last run on 2026-08-01, under `@rcrsr/rill-dev` 0.1.0: `CONFORMANT  58 checked,
58 passed, 23 not machine-checkable`, against 52/52/21 for the tree-only run.
The tree-only run under 0.2.0 is 63/63/14; the host half is unchanged, so the
`--remote` run is due a re-run only to restate its own count. Intent: squash-only
with linear history, branches deleted on merge, wiki off, admins included, and
required contexts naming every matrix leg. Re-check the raw settings with:

```bash
gh api repos/rcrsr/rill-cli/branches/main/protection \
  --jq '{strict: .required_status_checks.strict, linear: .required_linear_history.enabled,
         contexts: [.required_status_checks.checks[].context], admins: .enforce_admins.enabled}'
gh api repos/rcrsr/rill-cli \
  --jq '{squash: .allow_squash_merge, merge: .allow_merge_commit, rebase: .allow_rebase_merge,
         wiki: .has_wiki, issues: .has_issues, delete_branch: .delete_branch_on_merge}'
```

STD-GATE-2 and STD-GATE-3 report `--` even with `--remote`, because matrix leg
names and what a job actually does are per-repository judgements. Both verified
by hand on 2026-08-01 and both hold: the required contexts are `check (22)`,
`check (24)`, `check (25)`, matching the `node-version` matrix exactly, and the
`check` job runs `pnpm run check`, which is the whole check set. The
`Repository standards` job is deliberately not a required context; the same
`check:standards` runs inside the required `check` job.

**Changing protection is read-modify-write, never a patch.** The full protection
`PUT` is the only way to set `required_linear_history`, and it replaces the whole
object, clearing every field omitted. Read the live object, change one field,
send it back; never paste a payload recorded elsewhere. Send `checks`, not the
deprecated `contexts`, to keep each context pinned to its `app_id`.

Add a required context only after `main` already produces it. Requiring a
context no default-branch commit produces blocks every PR (STD-GATE-3).
