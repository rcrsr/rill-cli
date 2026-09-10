# Release SOP

Authoritative procedure for releasing `@rcrsr/rill-cli`. `/conduct:cut-release`
follows this file; a maintainer follows the same steps by hand. Where this file
is more specific than the skill's defaults, this file wins.

One package, one track, one tag namespace. `/conduct:cut-release X.Y.Z` cuts
the release; there is no qualifier.

| Trigger tag | Publishes | Workflow |
|-------------|-----------|----------|
| `vX.Y.Z` | `@rcrsr/rill-cli` from the repository root | `.github/workflows/release.yml` |

---

## Version scheme

The rill-cli **minor** tracks the rill **minor**. `@rcrsr/rill-cli` 0.21.x runs
on `@rcrsr/rill` 0.21.x. A rill-cli patch release moves only the patch.

- **Minor release (`0.N.0`):** cut when rill `0.N.0` is published, or when this
  package changes user-visible behaviour on its own. Every `@rcrsr/*` runtime
  range moves to `~0.N.0` in the same release (see the manifest section).
- **Patch release (`0.N.p`):** fixes on top of the current rill minor. The
  `@rcrsr/*` ranges do not move.

State the semver rationale in the release PR body under a `## Semver rationale`
heading, as the 0.20.0 release did: name each behaviour that changed for a user
of the previous version.

## Manifest to bump

- **Bump:** `package.json` (root), the `version` field only.
- **Sync command:** none. There is no workspace and no second manifest.
- **Do NOT bump:** nothing else carries a version.

The `release.yml` gate compares `${GITHUB_REF_NAME#v}` to `package.json`
`version` and refuses to publish on a mismatch, so the tag must equal the
manifest exactly.

### Lockstep `@rcrsr/*` ranges

`@rcrsr/rill`, `@rcrsr/rill-config`, `@rcrsr/rill-language-service`, and
`@rcrsr/rill-ext-datetime` are pinned with `~` to the matching rill minor. They
appear in up to three blocks of `package.json`: `dependencies`,
`peerDependencies`, and `devDependencies`. On a minor release, set every
occurrence to `~0.N.0` and run `pnpm install` so the lockfile follows.

Prefer landing that bump in its own PR before the release PR, so the release PR
carries only the version, the changelog, and any test realignment the new
engine forces. The 0.20.0 release folded the bump into the release PR instead;
that works but makes the release diff harder to review.

Before releasing a minor, confirm every lockstep package has published the new
minor:

```bash
for p in rill rill-config rill-language-service rill-ext-datetime; do
  printf '%-24s %s\n' "$p" "$(npm view @rcrsr/$p version)"
done
pnpm peers check
```

`pnpm peers check` must report no unmet `@rcrsr/rill` peer. A lockstep package
still on the previous minor declares a `~0.(N-1).0` peer and fails that check.
Do not cut the minor until it moves.

`@rcrsr/rill-dev` is **not** lockstep. It versions on its own `dev-v*` tags
upstream and is bumped whenever a new standards checker or lint rule lands, in
any PR, never as part of a release.

### Verify

```bash
node -p "require('./package.json').version"
node scripts/check-no-local-specifiers.mjs
```

The second command is what `prepublishOnly` runs. A `link:` or `file:`
specifier left over from a sibling checkout blocks the publish in CI; catch it
here first.

## Changelog to stamp

- **Stamp:** root `CHANGELOG.md` only.
- Pending heading is bracketed `## [Unreleased]`. Rename it to
  `## [X.Y.Z] - YYYY-MM-DD` and insert a fresh empty `## [Unreleased]` above it.
- The file keeps a **bottom reference-definition block** in compare-range
  style. Update both lines:

```
[Unreleased]: https://github.com/rcrsr/rill-cli/compare/vX.Y.Z...HEAD
[X.Y.Z]: https://github.com/rcrsr/rill-cli/compare/vPREV...vX.Y.Z
```

- Every entry ends with its PR link, `([#N](https://github.com/rcrsr/rill-cli/pull/N))`.
  An entry authored in the release PR itself (an upstream range bump, a test
  realignment) links the release PR number, so open the PR, then amend the
  entry with the number in a follow-up commit on the release branch.
- Use a `### Known issues` subsection under the dated heading for a defect that
  ships knowingly, with the workaround and the upstream issue link, as 0.20.0
  did for `rill check --fix`.

## Pre-flight

Run from a **fresh** install so the check exercises the ranges the release
declares, not whatever an older `node_modules` still resolves. The 0.20.0 PR
first reported green from a stale tree that still resolved 0.19.x; CI caught it.

```bash
rm -rf node_modules && pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` is the whole gate: standards, build, types, lint, format, tests,
rule tests, knip. `release.yml` runs the same command before publishing, so a
red local run is a red release.

Check the test count against the previous release. A file that fails to import
reports as one file-level failure, not as failing tests, so a suite that never
collects can read as green.

## Branch, commit, PR

- **Branch:** `release/X.Y.Z`
- **Commit subject:** `chore: release vX.Y.Z`
- **PR title:** `Release vX.Y.Z`
- **Squash-merge subject:** `chore: release vX.Y.Z (#N)`

Squash is the only merge path; merge commits and rebase merges are disabled in
the repository settings, and `main` requires linear history.

The PR body leads with the narrative summary, then `## Semver rationale`, then
the stamped changelog entries. Describe code and behaviour. Never cite
`conduct/` paths or planning identifiers (`AC-*`, `EC-*`, `FR-*`, and the rest)
in a release commit or PR body; they resolve to nothing outside this checkout.

Required contexts on `main` are `check (22)`, `check (24)`, `check (25)`. All
three must pass before the merge.

## Tag and publish

After the squash-merge lands, tag the merge commit on `main`:

```bash
git checkout main && git pull --ff-only
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

**Do NOT create the GitHub Release manually.** Pushing `vX.Y.Z` triggers
`release.yml`, which:

1. Refuses to run when the tag disagrees with `package.json`.
2. Runs `pnpm check` on Node 25.
3. Publishes to npm with provenance, treating a registry-side conflict on the
   same version as already published.
4. Creates the GitHub Release with `--generate-notes`, skipping if one exists.

Creating the release by hand collides with step 4. After pushing the tag,
report that `release.yml` will publish and cut the release, then confirm:

```bash
gh run watch --exit-status "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
npm view @rcrsr/rill-cli version
gh release view vX.Y.Z --json url --jq .url
```

## Tag pushes are not cheap metadata

Pushing `vX.Y.Z` publishes to npm. A published version cannot be replaced. If
the workflow fails after the publish step, fix forward with a patch release;
never delete and re-push a tag that already published.
