/**
 * Unit tests for mount-derive.ts helpers: deriveMount and isLocalPath.
 */

import { describe, it, expect } from 'vitest';
import { deriveMount, isLocalPath } from '../../src/commands/mount-derive.js';

// ============================================================
// isLocalPath
// ============================================================

describe('isLocalPath', () => {
  it('returns true for ./ relative path', () => {
    expect(isLocalPath('./my-ext')).toBe(true);
  });

  it('returns true for ../ relative path', () => {
    expect(isLocalPath('../sibling')).toBe(true);
  });

  it('returns true for absolute path starting with /', () => {
    expect(isLocalPath('/home/user/ext')).toBe(true);
  });

  it('returns false for a plain npm package name', () => {
    expect(isLocalPath('some-package')).toBe(false);
  });

  it('returns false for a scoped npm package', () => {
    expect(isLocalPath('@scope/package')).toBe(false);
  });

  it('returns false for rill-ext prefixed package', () => {
    expect(isLocalPath('rill-ext-foo')).toBe(false);
  });
});

// ============================================================
// deriveMount
// ============================================================

describe('deriveMount', () => {
  describe('--as override', () => {
    it('returns asOverride when supplied, ignoring specifier', () => {
      expect(deriveMount('rill-ext-foo', 'my-override')).toBe('my-override');
    });

    it('returns asOverride even when specifier is empty', () => {
      expect(deriveMount('', 'forced')).toBe('forced');
    });

    it('returns asOverride when specifier is a local path', () => {
      expect(deriveMount('./local-ext', 'custom')).toBe('custom');
    });
  });

  describe('EC-26: empty specifier without override throws', () => {
    it('throws Error with exact message for empty specifier', () => {
      expect(() => deriveMount('')).toThrow('Cannot derive mount path from: ');
    });

    it('thrown error is an Error instance', () => {
      expect(() => deriveMount('')).toThrow(Error);
    });
  });

  describe('local path branch (./  ../  /)', () => {
    it('returns basename for ./ path', () => {
      expect(deriveMount('./my-extension')).toBe('my-extension');
    });

    it('returns basename for ../ path', () => {
      expect(deriveMount('../sibling-ext')).toBe('sibling-ext');
    });

    it('returns basename for absolute path', () => {
      expect(deriveMount('/home/user/projects/my-ext')).toBe('my-ext');
    });

    it('returns last path segment for nested local path', () => {
      expect(deriveMount('./packages/foo-ext')).toBe('foo-ext');
    });
  });

  describe('registry scoped rill-ext pattern (@scope/rill-ext-<name>)', () => {
    it('extracts capture group from @acme/rill-ext-foo', () => {
      expect(deriveMount('@acme/rill-ext-foo')).toBe('foo');
    });

    it('extracts capture group with hyphen from @scope/rill-ext-my-tool', () => {
      expect(deriveMount('@scope/rill-ext-my-tool')).toBe('my-tool');
    });

    it('extracts multi-segment capture from @org/rill-ext-data-loader', () => {
      expect(deriveMount('@org/rill-ext-data-loader')).toBe('data-loader');
    });
  });

  describe('plain rill-ext pattern (rill-ext-<name>)', () => {
    it('extracts capture group from rill-ext-simple', () => {
      expect(deriveMount('rill-ext-simple')).toBe('simple');
    });

    it('extracts capture group with hyphen from rill-ext-my-plugin', () => {
      expect(deriveMount('rill-ext-my-plugin')).toBe('my-plugin');
    });
  });

  describe('scoped package without rill-ext prefix (@scope/name)', () => {
    it('returns the last segment for @acme/some-package', () => {
      expect(deriveMount('@acme/some-package')).toBe('some-package');
    });

    it('returns last segment for @my-org/tool', () => {
      expect(deriveMount('@my-org/tool')).toBe('tool');
    });
  });

  describe('plain unscoped package name', () => {
    it('returns specifier as-is for plain package name', () => {
      expect(deriveMount('my-package')).toBe('my-package');
    });

    it('returns specifier as-is for single word', () => {
      expect(deriveMount('lodash')).toBe('lodash');
    });
  });
});
