# CLAUDE.md

Repository-specific rules for `@rcrsr/rill-cli`, and the conformance record
required by [`dev/REPO-STANDARDS.md`](dev/REPO-STANDARDS.md) STD-DOC-3.

## What this repository is

A single package, `@rcrsr/rill-cli`, published from the repository root. Two
entry points: `.` (the CLI) and `./harness` (the test harness). There is no
`packages/` tree and no workspace.

`pnpm-workspace.yaml` exists but declares no `packages:` key. pnpm 11 reads it
for settings regardless, and it is where the build allowlist, the
minimum-release-age policy, and the trust policy now live.

## Rules

- **Do not edit `dev/`.** It is a plain copy of
  [rcrsr/rill](https://github.com/rcrsr/rill)`/dev`, placed by `dev/apply.sh`.
  Fix an asset in `rill` and re-propagate with `dev/apply.sh ../rill-cli`. CI
  clones `rill` and runs `dev/apply.sh --check .`, so a local edit fails the
  build and is lost on the next apply.
- **No internal planning identifiers in `src/`.** `rill/no-spec-id-reference`
  rejects `AC-*`, `EC-*`, `FR-*`, `NFR-*`, `IC-*`, `IR-*`, `UX*-*` and the rest
  in shipped source. They point at documents under `conduct/` that are never
  published. Keep the fact the comment states and drop the reference.
- **`pnpm check` is the gate.** It reaches the standards check, build,
  typecheck, lint, format, tests, the lint-rule unit tests, and knip. It
  deliberately does not delegate to `pnpm -r`, which excludes the workspace
  root and would skip every one of them.
- **Root scripts use the aggregator vocabulary.** `check:types`, not
  `typecheck`; `check:lint`, not `lint`. This repository's one package is its
  root, so it takes the root names (STD-SCRIPT-8).

## Known gaps

Tracked work, not deviations. Neither is recorded as an N/A because no stated
condition covers them.

- **Tests are not typechecked.** `tsconfig.json` scopes `include` to
  `src/**/*` because it drives the emit (`rootDir` is `./src`, and tests must
  never land in `dist/`). `tsc --noEmit` honours that include, so type errors
  in `tests/` go undetected even though lint covers the directory. Measured
  2026-07-31 with a widened config: **18 errors across 11 test files**, none in
  `src/`. `dev/REPO-STANDARDS.md` §3 records the same gap in `rill`. Closing it
  needs a second tsconfig with `rootDir` widened to `.` plus those 18 fixes.
- **rill enables 16 lint rules this repository does not.** `eqeqeq`,
  `no-shadow`, four `import/*`, seven `vitest/*`, and three `promise/*`.
  STD-LINT-5 governs the plugin set (identical) and STD-LINT-9 governs shared
  rules (identical severity), so neither element requires these. Measured
  2026-07-31: adopting them costs **5 findings** — 2 `no-shadow` (benign
  shadowing in `src/run/runner.ts` and `tests/build/build.test.ts`) and 3
  `vitest/no-commented-out-tests`, all three false positives on section-header
  comments containing the word `describe(`.

## Conformance record

Measured against `dev/REPO-STANDARDS.md` on 2026-07-31.

### Recorded N/A

Each names the element ID and the stated condition it meets. An N/A claimed
without a matching stated condition is a defect, not a decision.

| ID | Stated condition it meets |
|---|---|
| STD-CHK-7 | "The repository publishes exactly one package and has no root-versus-package version split to reconcile." One publishable package, published from the root; the tag-versus-manifest gate in `release.yml` is the only version assertion there is to make. |
| STD-SCRIPT-3 | Same condition as STD-CHK-7. No `check:versions` / `fix:versions` because there are no two versions to reconcile. |
| STD-SCRIPT-7 | "The repository is a single package." No `packages/` tree, so there is no package vocabulary distinct from the root vocabulary. |
| STD-PM-7 | No workspace packages are declared. `pnpm-workspace.yaml` exists for the §8/§9 settings but carries no `packages:` key, so there are no globs that could go dead. The checker states the condition this way; `dev/REPO-STANDARDS.md` still words it as "no workspace file", which no pnpm-11 single-package repository can meet, because STD-PM-6, STD-SUP-3 and STD-SUP-5 all require that file. Raised upstream. |
| STD-DEP-4 | "The repository is a single package." One manifest, so `vitest` is declared once and there is no per-package consistency to hold. |

Section 7 (Release workflow) is **not** N/A: this repository publishes
`@rcrsr/rill-cli` to npm, so all 7 elements apply and all 7 hold.

### Verified by hand

Elements `dev/check-standards.sh` reports as `--`. Each was checked manually;
this is what was found.

| ID | Finding |
|---|---|
| STD-CI-2 | **Holds.** Matrix is `['22', '24', '25']` in all five ecosystem repositories. |
| STD-REL-2 | **Holds.** The publish gate is a `TAG_VERSION` versus `PKG_VERSION` comparison in `release.yml` that exits 1 on disagreement, before anything is published. The checker reports this as `--` because the comparison is spelled per repository. |
| STD-GATE-2 | **Holds after a host change.** Required contexts must name every matrix leg: `check (22)`, `check (24)`, `check (25)`, plus `Repository standards`. See the pending change below. |
| STD-GATE-3 | **Holds.** The required contexts are the `check` matrix legs, which run the full suite, and `Repository standards`. Neither is a path-filter or gating job; this repository has no gating job, because STD-CI-7 removed the path filters outright. |
| STD-SET-1 | **Holds.** Squash-only, matching rill: `allow_merge_commit=false`, `allow_rebase_merge=false`, `allow_squash_merge=true`. |
| STD-SET-3 | **Holds.** Issues are enabled. This is not a downstream mirror; it files its own issues. |
| STD-SCRIPT-8 | **Holds.** Root exposes `check:*` / `fix:*` aggregators and bare `build`, `test`, `check`, `bootstrap`. No bare `typecheck` or `lint` at root. `test:rules` and `test:watch` are `<verb>:<target>` under the `test` verb. |
| STD-LINT-1 | **Holds.** oxlint + oxfmt, the same pair as every ecosystem repository. |
| STD-LINT-3 | **Holds, newly.** `conduct/` exists, so the element applies. `rill/no-spec-id-reference` is now enabled for `src/**/*.{ts,tsx}`; 121 identifiers across 15 files were removed to make it pass. |
| STD-LINT-5 | **Holds.** Plugin set is `typescript, oxc, import, vitest, promise, unicorn`, byte-identical to rill's, including the plugins reporting zero. |
| STD-LINT-6 | **Holds.** The two disabled rules carry measured counts and reasons in `.oxlintrc.json`; the rules evaluated and *not* disabled are recorded there too. |
| STD-LINT-9 | **Was FAIL, now holds.** `typescript/no-explicit-any` was `warn` here and `error` in rill. Set to `error`; the tree already carried zero `any`, so it cost nothing. This is the exact case STD-LINT-9 names and the checker cannot see it. |
| STD-PM-2 | **Was FAIL, now holds.** This repository pinned `pnpm@10.33.2`; rill pins `pnpm@11.18.0`. Now identical, hash included. Note that `rill-agent` (10.33.2) and `rill-ext` (11.11.0) are still off the reference; that is their non-conformance, not this repository's. |
| STD-PM-6 | **Holds.** pnpm 11 no longer reads `pnpm.onlyBuiltDependencies` from `package.json`. The allowlist is `allowBuilds` in `pnpm-workspace.yaml`, which is the location the pinned major expects. Verified in effect: `pnpm install` runs the `esbuild` and `lefthook` postinstall scripts. |
| STD-SUP-2 | **Holds.** Same assertion as STD-REL-3, which the checker decides: `pnpm publish --provenance` plus a `repository` field in the manifest. |
| STD-PROC-1 | **Holds after a host change.** Ten `area:*` labels derived from this repository's own structure, not copied from rill's (which would create `area:lexer` and `area:parser` for code that does not exist here). Sync with `.github/scripts/sync-labels.sh`. |
| STD-PROC-4 | **Holds.** `.github/workflows/issue-labels.yml` reads issue state through a GraphQL query at execution time, never from `context.payload.issue`. The reasoning, including the three upstream issues that stuck when it read the payload, is inline at the query. |
| STD-PROC-7 | **Holds.** `.github/scripts/sync-labels.sh`. Idempotent: `gh label create --force` upserts, so re-running only corrects colour and description drift. |
| STD-DEP-1 | **Was FAIL, now holds.** This repository lagged rill on four shared tools: `oxlint ^1.73.0`, `oxfmt ^0.58.0`, `knip ^6.25.0`, `@types/node ^26.1.1`. All four bumped to rill's ranges. |
| STD-DEP-2 | **Holds.** `typescript ^7.0.2` across the ecosystem. |
| STD-DEP-3 | **N/A by measurement, not by condition.** No tool in this tree conflicts with TypeScript 7, so there is no nested override to scope. The stated condition is "No tool conflicts with the current compiler major", which holds. |
| STD-DEP-5 | **Holds.** Peer ranges `~0.20.0` for `@rcrsr/rill`, `@rcrsr/rill-config` and `@rcrsr/rill-language-service`; all three are published at 0.20.0. |

### Host settings

Not in the tree. `bash dev/check-standards.sh --remote` is the only thing that
sees them, and CI runs it on every PR.

Re-check them by hand with:

```bash
gh api repos/rcrsr/rill-cli/branches/main/protection \
  --jq '{strict: .required_status_checks.strict,
         contexts: .required_status_checks.contexts,
         linear: .required_linear_history.enabled}'

gh api repos/rcrsr/rill-cli \
  --jq '{squash: .allow_squash_merge, merge: .allow_merge_commit,
         rebase: .allow_rebase_merge, wiki: .has_wiki,
         issues: .has_issues, delete_branch: .delete_branch_on_merge}'

gh api repos/rcrsr/rill-cli/dependency-graph/sbom --jq '.sbom.name'
```

Required status contexts must name **every** leg of the CI matrix by exact
name (`check (22)`, `check (24)`, `check (25)`) plus `Repository standards`.
A gating job must never be the required context: a skipped job reports
*skipped*, which never satisfies a required check (STD-GATE-3).

### Outstanding host changes

Three elements still FAIL under `--remote`. All three are host settings, none
is fixable from the tree:

```bash
# STD-SET-2 and STD-GATE-6
gh api -X PATCH repos/rcrsr/rill-cli -F has_wiki=false -F delete_branch_on_merge=true

# STD-GATE-5. merge_commit and rebase are already disabled; only the
# protection rule is missing.
gh api -X PUT repos/rcrsr/rill-cli/branches/main/protection/required_linear_history
```

And, **only after this branch is on `main`**, add `Repository standards` to the
required contexts. Adding it while the workflow exists on no default-branch
commit is the STD-GATE-3 deadlock arriving from the other direction: the
context never reports and every PR blocks.

```bash
gh api -X PATCH repos/rcrsr/rill-cli/branches/main/protection/required_status_checks \
  -F strict=true \
  -f 'contexts[]=check (22)' -f 'contexts[]=check (24)' \
  -f 'contexts[]=check (25)' -f 'contexts[]=Repository standards'
```
