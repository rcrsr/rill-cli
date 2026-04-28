/**
 * Tests for `viewFromRuntimeError` halt-view extraction and the
 * `formatStatus` helper used by invalid-result detection.
 */

import { describe, it, expect } from 'vitest';
import { RuntimeError, type RillValue } from '@rcrsr/rill';
import { viewFromRuntimeError } from '../../src/cli-error-from-halt.js';
import { formatStatus } from '../../src/cli-shared.js';

describe('viewFromRuntimeError', () => {
  it('returns null for plain runtime error without haltValue', () => {
    const err = new RuntimeError('RILL-R005', 'no halt here');
    expect(viewFromRuntimeError(err)).toBeNull();
  });

  it('returns null when haltValue is not invalid', () => {
    const err = new RuntimeError('RILL-R005', 'msg');
    Object.defineProperty(err, 'haltValue', {
      value: 'not-invalid' as unknown as RillValue,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    expect(viewFromRuntimeError(err)).toBeNull();
  });
});

describe('formatStatus', () => {
  it('returns empty string for valid value', () => {
    expect(formatStatus('hello' as unknown as RillValue)).toBe('');
    expect(formatStatus(42 as unknown as RillValue)).toBe('');
  });
});
