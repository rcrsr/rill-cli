/**
 * Severity Overlay (adapter layer)
 * Post-maps per-rule severity onto service diagnostics by code, applying
 * `warn`-state remap when no explicit severity-map entry exists.
 */

import type {
  Diagnostic,
  DiagnosticSeverity,
  RuleState,
} from '@rcrsr/rill-language-service/rules';

// ============================================================
// SEVERITY OVERLAY
// ============================================================

/**
 * Apply per-rule severity overrides to diagnostics emitted by the service.
 *
 * Precedence, per diagnostic code:
 * 1. A `severityMap` entry overrides the emitted severity.
 * 2. Absent a map entry, a rule whose state is `warn` remaps the emitted
 *    severity to `warning`.
 * 3. A `severityMap` override wins over `warn`-state remapping.
 *
 * Pure function: returns new diagnostics, never mutates the input array or
 * its elements, and preserves order and all non-severity fields.
 */
export function applySeverityOverlay(
  diagnostics: Diagnostic[],
  severityMap: Record<string, DiagnosticSeverity>,
  ruleStates: Record<string, RuleState>
): Diagnostic[] {
  return diagnostics.map((diagnostic) => {
    const overrideSeverity = severityMap[diagnostic.code];
    if (overrideSeverity !== undefined) {
      return { ...diagnostic, severity: overrideSeverity };
    }

    if (ruleStates[diagnostic.code] === 'warn') {
      return { ...diagnostic, severity: 'warning' as const };
    }

    return diagnostic;
  });
}
