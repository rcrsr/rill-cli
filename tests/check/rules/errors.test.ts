/**
 * Error-Handling Rules Tests
 * Coverage for the 0.19.0 error-handling lint rules.
 */

import { describe, it, expect } from 'vitest';
import { parse } from '@rcrsr/rill';
import { validateScript } from '../../../src/check/validator.js';
import type { CheckConfig } from '../../../src/check/types.js';

const ALL_OFF: Record<string, 'on' | 'off'> = {
  GUARD_BARE: 'off',
  RETRY_TRIVIAL: 'off',
  ATOM_UNREGISTERED: 'off',
  STATUS_PROBE_NO_FIELD: 'off',
  PRESENCE_OVER_NULL_GUARD: 'off',
  GUARD_OVER_TRY_CATCH: 'off',
};

function createConfig(only: string): CheckConfig {
  return {
    rules: { ...ALL_OFF, [only]: 'on' },
    severity: {},
  };
}

function getCodes(source: string, only: string): string[] {
  const ast = parse(source);
  const diagnostics = validateScript(ast, source, createConfig(only));
  return diagnostics.map((d) => d.code);
}

function getMessages(source: string, only: string): string[] {
  const ast = parse(source);
  const diagnostics = validateScript(ast, source, createConfig(only));
  return diagnostics.map((d) => d.message);
}

describe('GUARD_BARE', () => {
  it('warns on bare guard with no onCodes', () => {
    expect(getCodes('guard { 1 }', 'GUARD_BARE')).toContain('GUARD_BARE');
  });

  it('accepts guard with explicit onCodes', () => {
    expect(
      getCodes('guard<on: list[#TIMEOUT]> { 1 }', 'GUARD_BARE')
    ).not.toContain('GUARD_BARE');
  });

  it('returns info severity', () => {
    const ast = parse('guard { 1 }');
    const diagnostics = validateScript(
      ast,
      'guard { 1 }',
      createConfig('GUARD_BARE')
    );
    expect(diagnostics[0]?.severity).toBe('info');
  });
});

describe('RETRY_TRIVIAL', () => {
  it('warns on retry<limit: 1>', () => {
    expect(getCodes('retry<limit: 1> { 1 }', 'RETRY_TRIVIAL')).toContain(
      'RETRY_TRIVIAL'
    );
  });

  it('accepts retry<limit: 3>', () => {
    expect(getCodes('retry<limit: 3> { 1 }', 'RETRY_TRIVIAL')).not.toContain(
      'RETRY_TRIVIAL'
    );
  });

  it('mentions the attempt count in the message', () => {
    const messages = getMessages('retry<limit: 1> { 1 }', 'RETRY_TRIVIAL');
    expect(messages[0]).toContain('retry<limit: 1>');
  });
});

describe('ATOM_UNREGISTERED', () => {
  it('accepts builtin atoms', () => {
    expect(getCodes('#TIMEOUT', 'ATOM_UNREGISTERED')).not.toContain(
      'ATOM_UNREGISTERED'
    );
    expect(getCodes('#NOT_FOUND', 'ATOM_UNREGISTERED')).not.toContain(
      'ATOM_UNREGISTERED'
    );
    expect(getCodes('#ok', 'ATOM_UNREGISTERED')).not.toContain(
      'ATOM_UNREGISTERED'
    );
  });

  it('warns on unknown atoms', () => {
    expect(getCodes('#FOO_BAR', 'ATOM_UNREGISTERED')).toContain(
      'ATOM_UNREGISTERED'
    );
  });
});

describe('STATUS_PROBE_NO_FIELD', () => {
  it('warns on bare .!', () => {
    expect(getCodes('$result.!', 'STATUS_PROBE_NO_FIELD')).toContain(
      'STATUS_PROBE_NO_FIELD'
    );
  });

  it('accepts .!code projection', () => {
    expect(getCodes('$result.!code', 'STATUS_PROBE_NO_FIELD')).not.toContain(
      'STATUS_PROBE_NO_FIELD'
    );
  });

  it('accepts .?field presence probe', () => {
    expect(getCodes('$result.?code', 'STATUS_PROBE_NO_FIELD')).not.toContain(
      'STATUS_PROBE_NO_FIELD'
    );
  });
});

describe('PRESENCE_OVER_NULL_GUARD', () => {
  it('warns on ($x == nil) ternary', () => {
    expect(
      getCodes('($x == nil) ? 0 ! $x', 'PRESENCE_OVER_NULL_GUARD')
    ).toContain('PRESENCE_OVER_NULL_GUARD');
  });

  it('warns on ($x != nil) ternary', () => {
    expect(
      getCodes('($x != nil) ? $x ! 0', 'PRESENCE_OVER_NULL_GUARD')
    ).toContain('PRESENCE_OVER_NULL_GUARD');
  });

  it('does not fire on non-nil comparisons', () => {
    expect(
      getCodes('($x == 0) ? 1 ! $x', 'PRESENCE_OVER_NULL_GUARD')
    ).not.toContain('PRESENCE_OVER_NULL_GUARD');
  });

  it('does not fire on plain conditionals', () => {
    expect(getCodes('$x ? 1 ! 0', 'PRESENCE_OVER_NULL_GUARD')).not.toContain(
      'PRESENCE_OVER_NULL_GUARD'
    );
  });
});

describe('GUARD_OVER_TRY_CATCH', () => {
  it('warns when condition probes status', () => {
    expect(
      getCodes('($result.!code == #TIMEOUT) ? 0 ! 1', 'GUARD_OVER_TRY_CATCH')
    ).toContain('GUARD_OVER_TRY_CATCH');
  });

  it('warns on bare .! in condition', () => {
    expect(getCodes('$result.! ? 1 ! 0', 'GUARD_OVER_TRY_CATCH')).toContain(
      'GUARD_OVER_TRY_CATCH'
    );
  });

  it('does not fire on conditionals without status probes', () => {
    expect(getCodes('$x ? 1 ! 0', 'GUARD_OVER_TRY_CATCH')).not.toContain(
      'GUARD_OVER_TRY_CATCH'
    );
  });
});
