/**
 * Tests for the 0.19.0 halt envelope: atom header, trace block,
 * JSON shape additions, atomOnly mode.
 */

import { describe, it, expect } from 'vitest';
import {
  formatError,
  type EnrichedError,
  type FormatOptions,
} from '../../src/cli-error-formatter.js';
import type { HaltView } from '../../src/cli-error-from-halt.js';

const baseOpts: FormatOptions = {
  format: 'human',
  verbose: false,
  includeCallStack: false,
  maxCallStackDepth: 10,
};

const haltTimeout: HaltView = {
  atom: '#TIMEOUT',
  message: 'upstream request timed out after 30s',
  provider: 'http',
  trace: [
    { site: 'script.rill:12:5', kind: 'host', fn: 'http.get', wrapped: {} },
    { site: 'script.rill:12:5', kind: 'access', fn: '->', wrapped: {} },
  ],
  raw: {},
};

describe('halt envelope - human format', () => {
  it('renders unified header with halt message and metadata footer', () => {
    const error: EnrichedError = {
      errorId: 'RILL-R007',
      message: 'upstream timed out',
      span: {
        start: { line: 12, column: 5, offset: 0 },
        end: { line: 12, column: 13, offset: 0 },
      },
      halt: haltTimeout,
    };
    const out = formatError(error, baseOpts);
    expect(out).toContain(
      'error:http[RILL-R007#TIMEOUT]: upstream request timed out after 30s'
    );
    // Location is derived from the first trace frame's site, not the span.
    expect(out).toContain('  --> script.rill:12:5');
  });

  it('omits atom from header when atom is the underscore form of error id', () => {
    const halt: HaltView = {
      atom: '#RILL_R038',
      message: 'cannot convert string to number',
      provider: 'runtime',
      trace: [],
      raw: {},
    };
    const error: EnrichedError = {
      errorId: 'RILL-R038',
      message: '',
      halt,
    };
    const out = formatError(error, baseOpts);
    expect(out).toContain(
      'error:runtime[RILL-R038]: cannot convert string to number'
    );
    expect(out).not.toContain('#RILL_R038');
  });

  it('substitutes filePath for <script> sites in trace frames', () => {
    const halt: HaltView = {
      ...haltTimeout,
      trace: [
        { site: '<script>:12:5', kind: 'host', fn: 'http.get', wrapped: {} },
        { site: '<script>:12:5', kind: 'access', fn: '->', wrapped: {} },
      ],
    };
    const error: EnrichedError = {
      errorId: 'RILL-R007',
      message: 'upstream timed out',
      halt,
      filePath: 'scripts/main.rill',
    };
    const out = formatError(error, baseOpts);
    expect(out).toContain('  --> scripts/main.rill:12:5');
    expect(out).toContain('1. scripts/main.rill:12:5');
    expect(out).not.toContain('<script>');
  });

  it('renders trace block when 2+ frames present (auto default)', () => {
    const error: EnrichedError = {
      errorId: 'RILL-R007',
      message: '',
      halt: haltTimeout,
    };
    const out = formatError(error, baseOpts);
    expect(out).toContain('= trace:');
    expect(out).toContain('1. script.rill:12:5');
    expect(out).toContain('2. script.rill:12:5');
  });

  it('omits trace block when --no-trace (trace=never)', () => {
    const error: EnrichedError = {
      errorId: 'RILL-R007',
      message: '',
      halt: haltTimeout,
    };
    const out = formatError(error, { ...baseOpts, trace: 'never' });
    expect(out).not.toContain('= trace:');
  });

  it('renders trace even with single frame when trace=always', () => {
    const halt: HaltView = {
      ...haltTimeout,
      trace: [{ site: 'a:1:1', kind: 'host', fn: 'fn', wrapped: {} }],
    };
    const error: EnrichedError = {
      errorId: 'RILL-R007',
      message: '',
      halt,
    };
    const out = formatError(error, { ...baseOpts, trace: 'always' });
    expect(out).toContain('= trace:');
    expect(out).toContain('1. a:1:1');
  });

  it('renders wrap frame with wrapped payload', () => {
    const halt: HaltView = {
      atom: '#TIMEOUT',
      message: 'wrapped',
      provider: null,
      trace: [
        { site: 'a:1:1', kind: 'host', fn: 'origin', wrapped: {} },
        {
          site: 'b:2:1',
          kind: 'wrap',
          fn: 'error',
          wrapped: { code: '#TIMEOUT', message: 'orig' },
        },
      ],
      raw: {},
    };
    const error: EnrichedError = {
      errorId: 'RILL-R007',
      message: '',
      halt,
    };
    const out = formatError(error, baseOpts);
    expect(out).toContain('2. b:2:1');
    expect(out).toContain('wrapped:');
    expect(out).toContain('"#TIMEOUT"');
  });

  it('falls back to legacy header when halt is absent', () => {
    const error: EnrichedError = {
      errorId: 'RILL-R005',
      message: 'undefined variable',
    };
    const out = formatError(error, baseOpts);
    expect(out).toContain('error[RILL-R005]: undefined variable');
    expect(out).not.toContain('#');
  });
});

describe('halt envelope - JSON format', () => {
  it('adds atom, provider, trace, raw fields', () => {
    const error: EnrichedError = {
      errorId: 'RILL-R007',
      message: 'upstream timed out',
      halt: haltTimeout,
    };
    const out = formatError(error, { ...baseOpts, format: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed.atom).toBe('#TIMEOUT');
    expect(parsed.provider).toBe('http');
    expect(parsed.trace).toHaveLength(2);
    expect(parsed.trace[0]).toMatchObject({
      site: 'script.rill:12:5',
      kind: 'host',
      fn: 'http.get',
    });
    expect(parsed.errorId).toBe('RILL-R007');
  });

  it('atomOnly emits only atom and errorId', () => {
    const error: EnrichedError = {
      errorId: 'RILL-R007',
      message: 'upstream timed out',
      halt: haltTimeout,
    };
    const out = formatError(error, {
      ...baseOpts,
      format: 'json',
      atomOnly: true,
    });
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed).sort()).toEqual(['atom', 'errorId']);
    expect(parsed.atom).toBe('#TIMEOUT');
    expect(parsed.errorId).toBe('RILL-R007');
  });

  it('omits halt fields when halt is absent', () => {
    const error: EnrichedError = {
      errorId: 'RILL-R005',
      message: 'undefined variable',
    };
    const out = formatError(error, { ...baseOpts, format: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed.atom).toBeUndefined();
    expect(parsed.trace).toBeUndefined();
    expect(parsed.provider).toBeUndefined();
  });

  it('emits wrap frame wrapped payload only on wrap kind', () => {
    const halt: HaltView = {
      atom: '#TIMEOUT',
      message: 'm',
      provider: null,
      trace: [
        { site: 'a:1:1', kind: 'host', fn: 'h', wrapped: { ignored: 'x' } },
        {
          site: 'b:2:1',
          kind: 'wrap',
          fn: 'error',
          wrapped: { code: '#X' },
        },
      ],
      raw: {},
    };
    const error: EnrichedError = {
      errorId: 'RILL-R007',
      message: '',
      halt,
    };
    const out = formatError(error, { ...baseOpts, format: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed.trace[0].wrapped).toBeUndefined();
    expect(parsed.trace[1].wrapped).toEqual({ code: '#X' });
  });
});
