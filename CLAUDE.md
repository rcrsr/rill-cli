# CLAUDE.md

`@rcrsr/rill-cli`: a single package published from the repository root, with two
entry points, `.` and `./harness`. No `packages/` tree, no workspace.
`pnpm-workspace.yaml` declares no `packages:` key; pnpm 11 reads it for the
build allowlist and supply-chain settings, which is why it exists.

## Rules

- **Do not edit `dev/`.** It is a copy of
  [rcrsr/rill](https://github.com/rcrsr/rill)`/dev`. Fix it there, then
  `dev/apply.sh ../rill-cli`. CI fails on drift and a local edit is lost on the
  next apply.
- **No internal planning identifiers in `src/`.** `rill/no-spec-id-reference`
  rejects `AC-*`, `EC-*`, `FR-*`, `UX*-*` and the rest: they point at `conduct/`
  documents that are never published. Keep the fact, drop the reference.
- **`pnpm check` is the gate.** It reaches every check. It must never delegate
  to `pnpm -r`, which excludes the root and would skip all of them.
- **Root scripts use the aggregator names**: `check:types` and `check:lint`, not
  `typecheck` and `lint` (STD-SCRIPT-8).
- **Tests are not typechecked.** `tsconfig.json` scopes `include` to `src/**/*`
  because it drives the emit, and `tsc --noEmit` honours it. Type errors in
  `tests/` go undetected; run the tests, not just the typechecker. Widening the
  scope surfaced 18 pre-existing errors, so closing it is real work.

## Recorded N/A

STD-DOC-3 requires these here with the stated condition each meets. An N/A
without a matching stated condition is a defect, not a decision.

| ID | Condition met |
|---|---|
| STD-CHK-7, STD-SCRIPT-3 | Publishes exactly one package, with no root-versus-package version split to reconcile. |
| STD-SCRIPT-7, STD-DEP-4 | The repository is a single package. |
| STD-PM-7 | Declares no workspace packages. `dev/REPO-STANDARDS.md` still words this as "no workspace file", which no pnpm-11 single-package repository can meet; raised upstream. |
| STD-DEP-3 | No tool conflicts with the current compiler major. |

§7 is **not** N/A: this repository publishes to npm, so all 7 release elements
apply and hold.

## Host settings

Not in the tree, so only `dev/check-standards.sh --remote` sees them. CI runs it
on every PR. Re-check by hand with:

```bash
gh api repos/rcrsr/rill-cli/branches/main/protection \
  --jq '{strict: .required_status_checks.strict, linear: .required_linear_history.enabled,
         contexts: [.required_status_checks.checks[].context], admins: .enforce_admins.enabled}'
gh api repos/rcrsr/rill-cli \
  --jq '{squash: .allow_squash_merge, merge: .allow_merge_commit, rebase: .allow_rebase_merge,
         wiki: .has_wiki, issues: .has_issues, delete_branch: .delete_branch_on_merge}'
```

Intent: squash-only with linear history, branches deleted on merge, wiki off,
admins included, and required contexts naming every matrix leg.

**Changing protection is read-modify-write, never a patch.**
`required_linear_history` has no sub-resource, so a `PUT` to it returns 404. It
is settable only through the full protection `PUT`, which replaces the whole
object and clears every field omitted. Read the live object, change one field,
send it back; never paste a payload recorded elsewhere, which will silently drop
whatever was added since. Send `checks`, not the deprecated `contexts`, to keep
each context pinned to its `app_id`.

A required context must already exist on `main` before it is required. Requiring
one no default-branch commit produces blocks every PR (STD-GATE-3).
