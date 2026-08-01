# Contributing to rill-cli

Thanks for your interest in rill-cli. This guide covers setup, the change process, and the standards a pull request must meet before review.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Security reports follow the [Security Policy](SECURITY.md) instead of the process below.

## Before you write code

**Open an issue first for anything non-trivial.** Bug fixes and typo corrections can go straight to a pull request. Everything else starts as an issue so the design gets settled before you invest in an implementation.

Use the templates under `.github/ISSUE_TEMPLATE/`. Pick the one that matches: bug, feature, chore, security, or idea. The full taxonomy, including what each `area:*` label covers, lives in the header of [`.github/labeler.yml`](.github/labeler.yml).

**Follow the agreed design.** If you find a reason to depart from it while implementing, say so in the issue or the pull request description. An unflagged deviation costs a review cycle and sometimes a rewrite. A flagged one usually just updates the plan.

**Security work follows the [Security Policy](SECURITY.md).** Its [threat model](SECURITY.md#threat-model) covers what counts as a vulnerability here, from npm argument injection to path traversal, and what belongs to [rcrsr/rill](https://github.com/rcrsr/rill) instead.

Report a vulnerability in a published release privately through the [Security tab](https://github.com/rcrsr/rill-cli/security/advisories/new), not as a public issue. Hardening work on unreleased code uses the Security issue template.

## Setup

rill-cli uses Node and pnpm. The required versions live in `package.json`, under `engines` and `packageManager`. Corepack reads the latter and installs the right pnpm for you, so do not install pnpm globally.

```bash
corepack enable
git clone https://github.com/rcrsr/rill-cli.git
cd rill-cli
pnpm bootstrap
```

`pnpm bootstrap` checks that your Node and pnpm satisfy `engines`, fails with the fix if they do not, installs against the committed lockfile, and builds. It is idempotent and it is the same command in every repository in the ecosystem.

`pnpm install` runs `lefthook install`, which registers the git hooks described below.

## Repository layout

This is a single package, `@rcrsr/rill-cli`, published from the repository root. Two entry points are exported: `.` (the CLI) and `./harness` (the test harness).

| Path | Purpose |
|------|---------|
| `src/cli.ts`, `src/cli-exec.ts` | Command dispatch, flag parsing, exit codes |
| `src/run/` | Script execution, extension resolution, halt diagnostics |
| `src/build/` | `rill build`: bundling and config rewriting |
| `src/bundle/` | `rill bundle` and bundle-mode serve |
| `src/commands/` | Extension lifecycle: install, uninstall, upgrade, list |
| `src/check-adapter/` | `rill check`, delegating to the language service |
| `src/harness/` | The published test harness |
| `dev/` | Shared assets copied from [rcrsr/rill](https://github.com/rcrsr/rill); see below |

The language runtime, the extensions, the agent framework, and the config library live in separate repositories under the same organization.

## Commands

```bash
pnpm bootstrap         # Toolchain preconditions, install, build
pnpm check             # Everything below, in one command
pnpm test              # Test suite
pnpm check:types       # Type validation only
pnpm check:lint        # Lint only
pnpm check:format      # Formatting check
pnpm check:deps        # Unused dependencies and exports
pnpm check:standards   # Repository standards conformance
pnpm fix:lint          # Auto-fix lint
pnpm fix:format        # Auto-format
```

`pnpm check` reaches every one of them. It deliberately does not delegate to `pnpm -r`, which excludes the workspace root and would skip the lot.

## `dev/` is a copy, not source

`dev/` holds the shared repository standards, the conformance checker, the bootstrap script, and the custom lint rules. It is a plain copy of [rcrsr/rill](https://github.com/rcrsr/rill)'s `dev/`, placed by `dev/apply.sh`.

**Do not edit it here.** Fix it in `rill` and re-propagate:

```bash
# from a rill checkout
dev/apply.sh ../rill-cli
```

CI clones `rill` and runs `dev/apply.sh --check .`, so a local edit fails the build.

`dev/REPO-STANDARDS.md` is the conformance index every repository in the ecosystem is measured against. `pnpm check:standards` enforces the elements readable from a checkout; CI adds `--remote` for the branch-protection and repository-settings elements. Elements it reports as `--` were not checked and still apply.

## The bar for a pull request

**`pnpm check` must pass locally before you request review.** This is the single most common reason a pull request stalls. Do not rely on CI to find a broken build for you.

Two failure modes worth calling out, because neither is obvious:

1. **`tsconfig.json` limits `include` to `src/**/*`.** Type errors in test files do not surface in `pnpm check:types`. Run the tests as well as the typechecker. This is a known gap, recorded in `dev/REPO-STANDARDS.md` §3, not a settled decision.
2. **A test file that fails to import reports as a file-level failure, not as failing tests.** A suite that never collects can read as "no failures" at a glance. Confirm your tests actually execute and that the count is what you expect.

Other expectations:

- **Wire the feature end to end.** Code that nothing calls is not a reviewable increment. If a change spans several pull requests, the first one still needs a working path through it, even if narrow.
- **Export new public API from `src/cli.ts` or `src/harness.ts`.** Consumers cannot reach deep paths; `exports` in `package.json` lists both entry points and nothing else.
- **Carry no internal planning identifiers in `src/`.** `rill/no-spec-id-reference` rejects `AC-*`, `EC-*`, `FR-*`, `UXT-*` and the rest in shipped source: they point at documents that are never published. Keep the fact the comment states and drop the reference.
- **Let the formatter handle style.** `oxfmt` runs on commit, before lint, so a formatter pass can never undo a lint fix. Do not hand-format, and do not fight it.

## Tests

### Write tests that could fail

A test that passes before your implementation exists is measuring something else. Before opening a pull request, check that each new test fails for the right reason when the change is reverted.

This matters most for tests of the happy path. "The install succeeds" often passes against untouched default behaviour and demonstrates nothing.

### Test the adversarial case

For anything that gates, filters, validates, or enforces, cover the bypass rather than only the intended use:

- **Every input form reaches the same rule.** If a flag can be spelled several ways, or a specifier resolved through several paths, test all of them. A path that skips enforcement is a bypass, not an edge case.
- **Defaults fail closed.** Test what happens with no config, no matching mount, and unrecognised input. An unhandled shape must not silently pass through.
- **Subprocess arguments stay arguments.** Every value handed to npm goes in its own argv element. Test that a specifier shaped like a flag is not read as one.
- **Paths stay inside their root.** Mount paths, bundle entries, and config writes are all user-supplied. Test the traversal case.
- **Exit codes are asserted, not assumed.** A command that prints an error and exits 0 is a defect this suite should catch.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) with an area scope:

```
feat(bundle): resolve harness roles before the npm install
fix(extensions): keep the range when upgrade rolls back
ci: pin every action to a commit SHA
chore: release vX.Y.Z
```

Write the subject as a description of the change. State what the code does now, not how many files you touched.

`lefthook` runs formatting then lint with auto-fix before each commit, and typecheck and the full test suite before each push. Skip with `LEFTHOOK=0` only when you have a specific reason.

## Pull requests

1. Branch from `main`. Name it for the work, for example `fix/upgrade-range` or `docs/contributing-guide`.
2. Keep it scoped to one concern. A large feature splits into a sequence of pull requests, agreed in the issue.
3. Describe the change in terms of source files, exported APIs, and behaviour. Link the issue it implements.
4. Area labels apply automatically from the paths you touched, via `.github/labeler.yml`.
5. CI runs the full check across every Node version in the matrix in `.github/workflows/ci.yml`, plus the standards job. All must pass.

Expect review comments to cite specific lines and to include the command or grep that verifies the claim. Reply in the same register. If you disagree with a finding, say why and show the evidence.

## Releases

Maintainers publish `@rcrsr/rill-cli` by tagging a release commit on `main`. The release workflow refuses to publish when the tag disagrees with `package.json`, so the version bump and the tag land together.

The `@rcrsr/*` dependencies are pinned in lockstep to the matching rill minor. Dependabot is configured not to bump them for that reason; the compatibility workflow tests against their latest publish daily instead.

Contributors do not need to bump versions in a pull request.

## License

rill-cli is MIT licensed. By contributing, you agree that your contributions are licensed under the same terms. See [LICENSE](LICENSE).
