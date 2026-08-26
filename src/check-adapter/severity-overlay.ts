/**
 * Severity Overlay (adapter layer)
 * Post-maps per-rule severity onto service diagnostics by code.
 */

import type {
  Diagnostic,
  DiagnosticSeverity,
} from '@rcrsr/rill-language-service/rules';

// ============================================================
// SEVERITY OVERLAY
// ============================================================

/**
 * Apply per-rule severity overrides to diagnostics emitted by the service.
 *
 * Precedence, per diagnostic code: a `severityMap` entry overrides the
 * emitted severity; absent a map entry, the emitted severity passes through
 * unchanged.
 *
 * Pure function: returns new diagnostics, never mutates the input array or
 * its elements, and preserves order and all non-severity fields.
 */
export function applySeverityOverlay(
  diagnostics: Diagnostic[],
  severityMap: Record<string, DiagnosticSeverity>
): Diagnostic[] {
  return diagnostics.map((diagnostic) => {
    const overrideSeverity = severityMap[diagnostic.code];
    if (overrideSeverity !== undefined) {
      return { ...diagnostic, severity: overrideSeverity };
    }

    return diagnostic;
  });
}
