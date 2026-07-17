/**
 * Severity Overlay Tests
 * Verifies per-rule severity precedence: a `severityMap` entry overrides the
 * emitted severity by code, a `warn`-state rule remaps to `warning` absent a
 * map entry, a map entry wins over `warn`-state remapping, and the overlay
 * is pure (does not mutate input, preserves order and non-severity fields).
 */

import { describe, it, expect } from 'vitest';
import { parseWithRecovery } from '@rcrsr/rill';
import type { ParseResult } from '@rcrsr/rill';
import {
  RULES,
  createDefaultConfig,
  runRules,
} from '@rcrsr/rill-language-service/rules';
import type {
  Diagnostic,
  DiagnosticSeverity,
  RuleState,
} from '@rcrsr/rill-language-service/rules';
import { applySeverityOverlay } from '../../src/check-adapter/severity-overlay.js';

// ============================================================
// TEST FIXTURES
// ============================================================

const SEVERITIES: readonly DiagnosticSeverity[] = ['error', 'warning', 'info'];

/**
 * Build a minimal diagnostic for a given code and severity. Location and
 * message content are arbitrary; the overlay never reads them.
 */
function createDiagnostic(
  code: string,
  severity: DiagnosticSeverity,
  overrides: Partial<Diagnostic> = {}
): Diagnostic {
  return {
    code,
    message: `sample message for ${code}`,
    severity,
    location: { line: 1, column: 1, offset: 0 },
    context: 'sample context line',
    fix: null,
    ...overrides,
  };
}

// ============================================================
// 3 STATES x 3 SEVERITIES TABLE
// ============================================================

describe('applySeverityOverlay severity table', () => {
  // The "on" and "warn" rows exercise the overlay directly: a diagnostic for
  // a rule in that state, with a severityMap entry set to each of the three
  // severities. Per the precedence contract (a severityMap entry always
  // overrides the emitted severity, and that override wins over any
  // warn-state remap), all six cells resolve to the map's severity.
  //
  // These six cells are derived from the documented precedence contract, not
  // captured by executing the pre-rework engine (that engine could not be
  // imported for this task; see Implementation Notes).
  describe.each(['on', 'warn'] as const)(
    'rule state: %s',
    (state: RuleState) => {
      it.each(SEVERITIES)(
        'severityMap entry of %s overrides the emitted severity',
        (mapSeverity) => {
          const diagnostics = [createDiagnostic('SOME_RULE', 'error')];
          const severityMap = { SOME_RULE: mapSeverity };
          const ruleStates = { SOME_RULE: state };

          const result = applySeverityOverlay(
            diagnostics,
            severityMap,
            ruleStates
          );

          expect(result[0]?.severity).toBe(mapSeverity);
        }
      );
    }
  );

  // The "off" row is not exercisable at the overlay: production never calls
  // applySeverityOverlay with diagnostics from an off-state rule, because
  // runRules filters off-state rules before dispatching validate() (skipped
  // pre-call, not post-filtered by the overlay). Fabricating an overlay-level
  // "off" diagnostic would assert behavior the overlay never actually
  // performs. Instead, these three cells verify the off state's true
  // behavior at its real boundary: runRules emits zero diagnostics for an
  // off-state rule regardless of what severity its map entry names, using a
  // real parse and the full rule registry.
  describe('rule state: off', () => {
    const source = '1 => $myVar';

    it.each(SEVERITIES)(
      'a rule set to off emits no diagnostics from runRules regardless of a %s severityMap entry',
      (mapSeverity) => {
        const parsed: ParseResult = parseWithRecovery(source);
        expect(parsed.errors).toHaveLength(0);

        const rules: Record<string, RuleState> = {};
        for (const rule of RULES) {
          rules[rule.code] = 'off';
        }

        const diagnostics = runRules(parsed, source, { rules });
        expect(diagnostics).toHaveLength(0);

        // Since runRules produced no diagnostics for the off rule, the
        // overlay (fed an empty array, as it is in production for this
        // case) trivially returns an empty array too, independent of what
        // the map entry would have said.
        const overlaid = applySeverityOverlay(
          diagnostics,
          { NAMING_SNAKE_CASE: mapSeverity },
          rules
        );
        expect(overlaid).toHaveLength(0);
      }
    );
  });
});

// ============================================================
// WARN-STATE REMAP (NO MAP ENTRY)
// ============================================================

describe('applySeverityOverlay warn-state remap', () => {
  it('remaps emitted severity to warning when the rule state is warn and no map entry exists', () => {
    const diagnostics = [createDiagnostic('SOME_RULE', 'error')];
    const result = applySeverityOverlay(diagnostics, {}, { SOME_RULE: 'warn' });

    expect(result[0]?.severity).toBe('warning');
  });

  it('leaves the emitted severity unchanged when the rule state is on and no map entry exists', () => {
    const diagnostics = [createDiagnostic('SOME_RULE', 'error')];
    const result = applySeverityOverlay(diagnostics, {}, { SOME_RULE: 'on' });

    expect(result[0]?.severity).toBe('error');
  });

  it('leaves the emitted severity unchanged when the code has no ruleStates entry at all', () => {
    const diagnostics = [createDiagnostic('SOME_RULE', 'info')];
    const result = applySeverityOverlay(diagnostics, {}, {});

    expect(result[0]?.severity).toBe('info');
  });
});

// ============================================================
// MAP OVERRIDE WINS OVER WARN-STATE REMAP
// ============================================================

describe('applySeverityOverlay precedence: map override over warn-state remap', () => {
  it('applies the severityMap entry instead of the warn-state warning remap', () => {
    const diagnostics = [createDiagnostic('SOME_RULE', 'error')];
    const result = applySeverityOverlay(
      diagnostics,
      { SOME_RULE: 'info' },
      { SOME_RULE: 'warn' }
    );

    expect(result[0]?.severity).toBe('info');
  });
});

// ============================================================
// CONFIG INTEGRATION: ALL RULES OFF PRODUCES ZERO DIAGNOSTICS
// ============================================================

describe('all-rules-off configuration', () => {
  it('produces zero diagnostics from runRules when every rule is set to off', () => {
    const source = '1 => $myVar';
    const parsed: ParseResult = parseWithRecovery(source);
    expect(parsed.errors).toHaveLength(0);

    const defaultConfig = createDefaultConfig();
    const baselineDiagnostics = runRules(parsed, source, defaultConfig);
    expect(baselineDiagnostics.length).toBeGreaterThan(0);

    const rules: Record<string, RuleState> = {};
    for (const rule of RULES) {
      rules[rule.code] = 'off';
    }
    const offDiagnostics = runRules(parsed, source, { rules });

    expect(offDiagnostics).toHaveLength(0);
  });
});

// ============================================================
// PURITY AND ORDER PRESERVATION
// ============================================================

describe('applySeverityOverlay purity', () => {
  it('does not mutate the input diagnostics array or its elements', () => {
    const diagnostics = [
      createDiagnostic('RULE_A', 'error'),
      createDiagnostic('RULE_B', 'info'),
    ];
    const snapshot = diagnostics.map((d) => ({ ...d }));

    applySeverityOverlay(
      diagnostics,
      { RULE_A: 'warning' },
      { RULE_B: 'warn' }
    );

    expect(diagnostics).toEqual(snapshot);
  });

  it('returns a new array distinct from the input', () => {
    const diagnostics = [createDiagnostic('RULE_A', 'error')];
    const result = applySeverityOverlay(diagnostics, {}, {});

    expect(result).not.toBe(diagnostics);
  });

  it('preserves diagnostic order across mixed map, warn, and passthrough codes', () => {
    const diagnostics = [
      createDiagnostic('RULE_A', 'error'),
      createDiagnostic('RULE_B', 'error'),
      createDiagnostic('RULE_C', 'error'),
    ];

    const result = applySeverityOverlay(
      diagnostics,
      { RULE_A: 'info' },
      { RULE_B: 'warn' }
    );

    expect(result.map((d) => d.code)).toEqual(['RULE_A', 'RULE_B', 'RULE_C']);
    expect(result.map((d) => d.severity)).toEqual(['info', 'warning', 'error']);
  });

  it('preserves all non-severity fields on each diagnostic', () => {
    const fix = {
      description: 'sample fix',
      applicable: true,
      range: {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 5, offset: 4 },
      },
      replacement: 'replaced',
    };
    const diagnostics = [createDiagnostic('RULE_A', 'error', { fix })];

    const result = applySeverityOverlay(diagnostics, { RULE_A: 'warning' }, {});

    expect(result[0]).toEqual({
      ...diagnostics[0],
      severity: 'warning',
    });
  });

  it('returns an equivalent-but-unchanged diagnostic when no map entry or warn state applies', () => {
    const diagnostic = createDiagnostic('RULE_A', 'error');
    const result = applySeverityOverlay([diagnostic], {}, { RULE_A: 'on' });

    expect(result[0]).toEqual(diagnostic);
  });
});
