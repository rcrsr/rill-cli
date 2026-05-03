/**
 * Tests for checkNodeVersion in src/cli-shared.ts (P1-1).
 */

import { describe, it, expect } from 'vitest';
import { checkNodeVersion, MIN_NODE_VERSION } from '../../src/cli-shared.js';

describe('checkNodeVersion (P1-1)', () => {
  it('returns null for the current runtime (CI runs on supported Node)', () => {
    expect(checkNodeVersion()).toBeNull();
  });

  it('returns null when actual >= MIN_NODE_VERSION', () => {
    expect(checkNodeVersion(MIN_NODE_VERSION)).toBeNull();
    expect(checkNodeVersion('22.16.1')).toBeNull();
    expect(checkNodeVersion('23.0.0')).toBeNull();
    expect(checkNodeVersion('100.0.0')).toBeNull();
  });

  it('returns an error message when actual < MIN_NODE_VERSION', () => {
    const msg = checkNodeVersion('22.15.0');
    expect(msg).not.toBeNull();
    expect(msg).toContain('rill requires Node >= 22.16.0');
    expect(msg).toContain('22.15.0');
  });

  it('rejects much older Node versions', () => {
    expect(checkNodeVersion('20.0.0')).not.toBeNull();
    expect(checkNodeVersion('18.0.0')).not.toBeNull();
    expect(checkNodeVersion('0.10.0')).not.toBeNull();
  });

  it('strips pre-release suffix when comparing', () => {
    expect(checkNodeVersion('22.16.0-nightly')).toBeNull();
    expect(checkNodeVersion('22.15.0-nightly')).not.toBeNull();
  });
});
