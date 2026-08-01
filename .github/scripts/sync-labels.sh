#!/usr/bin/env bash
# Creates or updates the rill-cli label taxonomy (the label axes only).
# Types (Bug/Feature/Chore/Security/Idea) and Priority are native org-level
# GitHub fields, not labels, and are configured in org settings, not here.
# See dev/REPO-STANDARDS.md STD-PROC-7.
#
# The areas below are this repository's own, derived from its structure. They
# deliberately differ from rill's: copying that list would create labels for a
# lexer and a parser this repository does not contain.
#
# One signal per axis; label text is the load-bearing distinction (WCAG 1.4.1).
# area:* uniform blue; on-hold gray (parked); needs-triage yellow (pending).
#
# Usage: .github/scripts/sync-labels.sh            (defaults to rcrsr/rill-cli)
#        REPO=owner/name .github/scripts/sync-labels.sh
#
# Idempotent: `gh label create --force` upserts, so re-running only updates
# color/description drift. Requires: gh, authenticated with repo scope.
set -euo pipefail

REPO="${REPO:-rcrsr/rill-cli}"

AREA_COLOR="1d76db"   # blue, uniform across every area
HOLD_COLOR="d2dae1"   # gray, parked/inactive
TRIAGE_COLOR="fbca04" # yellow, pending/triage

declare -a AREAS=(
  "area:cli|command dispatch, flag parsing, exit codes, help output"
  "area:run|script execution: runner, extension resolution, halt diagnostics"
  "area:build|rill build: bundling, config rewriting, esbuild integration"
  "area:bundle|rill bundle and bundle-mode serve"
  "area:extensions|install/uninstall/upgrade/list, npm spawn, rill-config edits"
  "area:check|rill check and the language-service adapter"
  "area:errors|error enrichment, formatting, explain, halt views"
  "area:harness|the published test harness"
  "area:docs|documentation content and the demo project"
  "area:dx|CI, toolchain, lint rules, test helpers, root config"
)

for entry in "${AREAS[@]}"; do
  name="${entry%%|*}"
  desc="${entry#*|}"
  gh label create "$name" --repo "$REPO" --color "$AREA_COLOR" --description "$desc" --force
done

gh label create "on-hold" --repo "$REPO" --color "$HOLD_COLOR" \
  --description "Shaped work deliberately parked; not low priority, not blocked-by a specific issue" --force

gh label create "needs-triage" --repo "$REPO" --color "$TRIAGE_COLOR" \
  --description "Enforcer-managed: missing an area label or an Issue Type. Never hand-apply." --force

echo "Label taxonomy synced to $REPO."
