/**
 * Severity Overlay Tests
 * Verifies per-rule severity precedence: a `severityMap` entry overrides the
 * emitted severity by code, a `warn`-state rule remaps to `warning` absent a
 * map entry, a map entry wins over `warn`-state remapping, and the overlay
 * is pure (does not mutate input, preserves order and non-severity fields).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
import { loadConfig } from '../../src/check-adapter/config.js';

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
  const TABLE_DIR = join(
    process.cwd(),
    'tests',
    'fixtures',
    'severity-overlay-table'
  );

  /** Triggers exactly one NAMING_SNAKE_CASE diagnostic. */
  const TABLE_SOURCE = '42 => $myCamelCase\n';
  const TABLE_CODE = 'NAMING_SNAKE_CASE';

  /**
   * Severity the engine emits for TABLE_CODE in each state, captured from
   * @rcrsr/rill-language-service@0.19.6 rather than assumed: the rule's
   * defaultSeverity is `error`, and runRules resolves a warn-state rule to
   * `warning` itself before the overlay runs.
   */
  const EMITTED_BY_STATE: Record<'on' | 'warn', DiagnosticSeverity> = {
    on: 'error',
    warn: 'warning',
  };

  beforeEach(() => {
    if (existsSync(TABLE_DIR)) {
      rmSync(TABLE_DIR, { recursive: true, force: true });
    }
    mkdirSync(TABLE_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TABLE_DIR, { recursive: true, force: true });
  });

  // The "on" and "warn" rows drive the real production path from a real
  // `.rill-check.json`: loadConfig -> runRules -> applySeverityOverlay, on a
  // real rule code. Each cell pins the engine's emitted severity *before* the
  // overlay as well as the resolved severity after, so a change in engine
  // behavior fails here instead of being silently absorbed by the overlay.
  // Per the precedence contract an explicit severity entry wins over both the
  // rule's default severity and the warn-state remap, so all six cells
  // resolve to the configured severity.
  describe.each(['on', 'warn'] as const)('rule state: %s', (state) => {
    it.each(SEVERITIES)(
      'severity entry of %s overrides the severity the engine emitted',
      (mapSeverity) => {
        writeFileSync(
          join(TABLE_DIR, '.rill-check.json'),
          JSON.stringify({
            rules: { [TABLE_CODE]: state },
            severity: { [TABLE_CODE]: mapSeverity },
          }),
          'utf-8'
        );

        const resolved = loadConfig(TABLE_DIR);
        expect(resolved?.severityMap).toEqual({ [TABLE_CODE]: mapSeverity });

        const parsed: ParseResult = parseWithRecovery(TABLE_SOURCE);
        expect(parsed.errors).toHaveLength(0);

        const emitted = runRules(
          parsed,
          TABLE_SOURCE,
          resolved?.config ?? createDefaultConfig()
        );
        expect(emitted.find((d) => d.code === TABLE_CODE)?.severity).toBe(
          EMITTED_BY_STATE[state]
        );

        const overlaid = applySeverityOverlay(
          emitted,
          resolved?.severityMap ?? {},
          resolved?.config.rules ?? {}
        );

        expect(overlaid.find((d) => d.code === TABLE_CODE)?.severity).toBe(
          mapSeverity
        );
      }
    );
  });

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

// ============================================================
// PRODUCTION PATH INTEGRATION: loadConfig -> runRules -> applySeverityOverlay
// ============================================================

describe('production path: warn-state remap without a severity override', () => {
  const TEST_DIR = join(
    process.cwd(),
    'tests',
    'fixtures',
    'severity-overlay-integration'
  );

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // Drives the real loadConfig -> runRules -> applySeverityOverlay path. The
  // load-bearing assertion is the sparse-severityMap check: a dense map (the
  // pre-fix behavior) forces an override entry for every code and stomps the
  // service's `warning` back to the rule's `error` default. runRules already
  // resolves warn-state severity itself, so the overlay's warn branch is a
  // no-op here and this test is not coverage for that branch in isolation.
  it('remaps a warn-state rule to warning severity when the config sets no explicit severity override', () => {
    writeFileSync(
      join(TEST_DIR, '.rill-check.json'),
      JSON.stringify({ rules: { NAMING_SNAKE_CASE: 'warn' } }, null, 2),
      'utf-8'
    );

    const resolvedConfig = loadConfig(TEST_DIR);
    expect(resolvedConfig).not.toBeNull();
    expect(resolvedConfig?.severityMap.NAMING_SNAKE_CASE).toBeUndefined();

    const source = '42 => $myCamelCase\n';
    const parsed: ParseResult = parseWithRecovery(source);
    expect(parsed.errors).toHaveLength(0);

    const emitted = runRules(
      parsed,
      source,
      resolvedConfig?.config ?? createDefaultConfig()
    );
    const emittedDiagnostic = emitted.find(
      (d) => d.code === 'NAMING_SNAKE_CASE'
    );
    expect(emittedDiagnostic).toBeDefined();
    expect(emittedDiagnostic?.severity).toBe('warning');

    const overlaid = applySeverityOverlay(
      emitted,
      resolvedConfig?.severityMap ?? {},
      resolvedConfig?.config.rules ?? {}
    );
    const overlaidDiagnostic = overlaid.find(
      (d) => d.code === 'NAMING_SNAKE_CASE'
    );
    expect(overlaidDiagnostic).toBeDefined();
    expect(overlaidDiagnostic?.severity).toBe('warning');
  });
});
