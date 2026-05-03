/**
 * Loop Convention Rules Tests
 * Verify loop convention enforcement.
 */

import { describe, it, expect } from 'vitest';
import { parse } from '@rcrsr/rill';
import { validateScript } from '../../../src/check/validator.js';
import type { CheckConfig } from '../../../src/check/types.js';

// ============================================================
// TEST HELPERS
// ============================================================

/**
 * Create a config with loop rules enabled.
 */
function createConfig(rules: Record<string, 'on' | 'off'> = {}): CheckConfig {
  return {
    rules: {
      LOOP_ACCUMULATOR: 'on',
      PREFER_DO_WHILE: 'on',
      USE_EACH: 'on',
      ...rules,
    },
    severity: {},
  };
}

/**
 * Validate source and extract diagnostic messages.
 */
function getDiagnostics(source: string, config?: CheckConfig): string[] {
  const ast = parse(source);
  const diagnostics = validateScript(ast, source, config ?? createConfig());
  return diagnostics.map((d) => d.message);
}

/**
 * Validate source and check for violations.
 */
function hasViolations(source: string, config?: CheckConfig): boolean {
  const ast = parse(source);
  const diagnostics = validateScript(ast, source, config ?? createConfig());
  return diagnostics.length > 0;
}

/**
 * Validate source and get diagnostic codes.
 */
function getCodes(source: string, config?: CheckConfig): string[] {
  const ast = parse(source);
  const diagnostics = validateScript(ast, source, config ?? createConfig());
  return diagnostics.map((d) => d.code);
}

// ============================================================
// LOOP_ACCUMULATOR TESTS
// ============================================================

describe('LOOP_ACCUMULATOR', () => {
  const config = createConfig({ PREFER_DO_WHILE: 'off', USE_EACH: 'off' });

  it('accepts $ as accumulator in while loop', () => {
    expect(hasViolations('0 -> while ($ < 5) do { $ + 1 }', config)).toBe(
      false
    );
  });

  it('accepts $ as accumulator in do-while loop', () => {
    expect(hasViolations('do { $ + 1 } while ($ < 5)', config)).toBe(false);
  });

  it('accepts captures only used within iteration', () => {
    const source = `
0 -> while ($ < 5) do {
  $ => $x
  log($x)
  $x + 1
}
    `.trim();

    expect(hasViolations(source, config)).toBe(false);
  });

  it('detects captured variable referenced in while loop condition', () => {
    const source = `
0 -> while ($x < 5) do {
  $ => $x
  $x + 1
}
    `.trim();

    const messages = getDiagnostics(source, config);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain(
      '$x captured in loop body but referenced in condition'
    );
    expect(messages[0]).toContain('reset each iteration');
  });

  it('detects captured variable referenced in do-while loop condition', () => {
    const source = `
do {
  $ => $val
  $val + 1
} while ($val < 10)
    `.trim();

    const messages = getDiagnostics(source, config);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain(
      '$val captured in loop body but referenced in condition'
    );
    expect(messages[0]).toContain('reset each iteration');
  });

  it('accepts loop without captures', () => {
    const source = `
0 -> while ($ < 5) do {
  log($)
  $ + 1
}
    `.trim();

    expect(hasViolations(source, config)).toBe(false);
  });

  it('accepts captures not referenced in condition', () => {
    const source = `
0 => $i
while ($i < 5) do {
  $ => $temp
  log($temp)
  $ + 1
}
    `.trim();

    expect(hasViolations(source, config)).toBe(false);
  });

  it('detects multiple captured variables in condition', () => {
    const source = `
0 -> while ($x < $y) do {
  $ => $x
  $ => $y
  $x + $y
}
    `.trim();

    const messages = getDiagnostics(source, config);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain(
      'captured in loop body but referenced in condition'
    );
    // Should mention both variables
    expect(messages[0]).toMatch(/\$x.*\$y|\$y.*\$x/);
  });

  it('has correct severity and code', () => {
    const source = `
0 -> while ($x < 5) do {
  $ => $x
  $x + 1
}
    `.trim();
    const ast = parse(source);
    const diagnostics = validateScript(ast, source, config);

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.code).toBe('LOOP_ACCUMULATOR');
    expect(diagnostics[0]?.severity).toBe('info');
  });
});

// ============================================================
// PREFER_DO_WHILE TESTS
// ============================================================

describe('PREFER_DO_WHILE', () => {
  const config = createConfig({ LOOP_ACCUMULATOR: 'off', USE_EACH: 'off' });

  it('accepts do-while for retry patterns', () => {
    const source = `
do {
  attemptOperation()
} while (.contains("RETRY"))
    `.trim();

    expect(hasViolations(source, config)).toBe(false);
  });

  it('suggests do-while for while loop with retry function', () => {
    const source = `
while (true) do {
  retryOperation()
}
    `.trim();

    const messages = getDiagnostics(source, config);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain('do-while for retry patterns');
    expect(messages[0]).toContain('do { body } while (condition)');
  });

  it('suggests do-while for while loop with attempt function', () => {
    const source = `
while ($ < 3) do {
  attemptConnection()
}
    `.trim();

    const messages = getDiagnostics(source, config);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain('do-while for retry patterns');
  });

  it('accepts while loop without retry pattern', () => {
    const source = '0 -> while ($ < 5) do { $ + 1 }';
    expect(hasViolations(source, config)).toBe(false);
  });

  it('has correct severity and code', () => {
    const source = 'while (true) do { retryOp() }';
    const ast = parse(source);
    const diagnostics = validateScript(ast, source, config);

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.code).toBe('PREFER_DO_WHILE');
    expect(diagnostics[0]?.severity).toBe('info');
  });
});

// ============================================================
// USE_EACH TESTS
// ============================================================

describe('USE_EACH', () => {
  const config = createConfig({
    LOOP_ACCUMULATOR: 'off',
    PREFER_DO_WHILE: 'off',
  });

  it('accepts each for collection iteration', () => {
    expect(hasViolations('$items -> seq({ process($) })', config)).toBe(false);
  });

  it('suggests each for while loop with .len check', () => {
    const source = `
0 => $i
while ($i < $items.len) do {
  $items[$i] -> process()
  $i + 1
}
    `.trim();

    const messages = getDiagnostics(source, config);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain("Use 'seq' for collection iteration");
    expect(messages[0]).toContain('collection -> seq({ body })');
  });

  it('suggests each for while loop with array indexing', () => {
    const source = `
while ($idx < 10) do {
  $data[$idx]
}
    `.trim();

    const messages = getDiagnostics(source, config);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain("Use 'seq'");
  });

  it('accepts while loop without collection pattern', () => {
    // Simple counter without array indexing or .len
    expect(hasViolations('0 -> while ($ == 0) do { 1 }', config)).toBe(false);
  });

  it('has correct severity and code', () => {
    const source = 'while ($i < $items.len) do { $i + 1 }';
    const ast = parse(source);
    const diagnostics = validateScript(ast, source, config);

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.code).toBe('USE_EACH');
    expect(diagnostics[0]?.severity).toBe('info');
  });
});

// ============================================================
// INTEGRATION TESTS
// ============================================================

describe('Loop rules integration', () => {
  it('can detect multiple violations in same code', () => {
    const source = `
0 => $i
while ($index < $items.len) do {
  $i => $index
  $items[$index]
  $index + 1
}
    `.trim();

    const codes = getCodes(source);
    // Should detect both USE_EACH and LOOP_ACCUMULATOR
    expect(codes).toContain('USE_EACH');
    expect(codes).toContain('LOOP_ACCUMULATOR');
  });

  it('respects rule configuration', () => {
    const source = `
0 -> while ($x < 5) do {
  $ => $x
  $x + 1
}
    `.trim();

    // With LOOP_ACCUMULATOR on
    const withRule = createConfig({
      LOOP_ACCUMULATOR: 'on',
      USE_EACH: 'off',
      PREFER_DO_WHILE: 'off',
    });
    expect(hasViolations(source, withRule)).toBe(true);

    // With LOOP_ACCUMULATOR off
    const withoutRule = createConfig({
      LOOP_ACCUMULATOR: 'off',
      USE_EACH: 'off',
      PREFER_DO_WHILE: 'off',
    });
    expect(hasViolations(source, withoutRule)).toBe(false);
  });
});
