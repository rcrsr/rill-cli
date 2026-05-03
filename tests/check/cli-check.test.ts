/**
 * Tests for parseCheckArgs function
 *
 * Test Coverage Matrix (maps TCs to specification requirements):
 * TC-1: --help flag returns help mode [AC-S6]
 * TC-3: Unknown flag throws error [EC-1]
 * TC-4: Missing file throws error [EC-2]
 * TC-5: --fix flag parsed correctly [IR-2]
 * TC-6: --verbose flag parsed correctly [IR-2]
 * TC-7: --format text parsed correctly [IR-2]
 * TC-8: --format json parsed correctly [IR-2]
 * TC-9: --format with invalid value throws error [EC-1]
 */

import { describe, it, expect } from 'vitest';
import { parseCheckArgs } from '../../src/cli-check.js';

describe('parseCheckArgs', () => {
  describe('help mode', () => {
    it('returns help mode when --help flag present [TC-1]', () => {
      const result = parseCheckArgs(['--help']);
      expect(result).toEqual({ mode: 'help' });
    });

    it('returns help mode when -h flag present [TC-1]', () => {
      const result = parseCheckArgs(['-h']);
      expect(result).toEqual({ mode: 'help' });
    });

    it('returns help mode when --help flag present with other args [TC-1]', () => {
      const result = parseCheckArgs(['file.rill', '--help', '--fix']);
      expect(result).toEqual({ mode: 'help' });
    });
  });

  describe('error cases', () => {
    it('throws error for unknown flag [TC-3]', () => {
      expect(() => parseCheckArgs(['--unknown', 'file.rill'])).toThrow(
        'Unknown option: --unknown'
      );
    });

    it('throws error for unknown short flag [TC-3]', () => {
      expect(() => parseCheckArgs(['-x', 'file.rill'])).toThrow(
        'Unknown option: -x'
      );
    });

    it('throws error when file argument missing [TC-4]', () => {
      expect(() => parseCheckArgs(['--fix'])).toThrow('Missing file argument');
    });

    it('throws error when only flags provided [TC-4]', () => {
      expect(() => parseCheckArgs(['--fix', '--verbose'])).toThrow(
        'Missing file argument'
      );
    });

    it('throws error when --format has no value [TC-9]', () => {
      expect(() => parseCheckArgs(['file.rill', '--format'])).toThrow(
        '--format requires argument: text or json'
      );
    });

    it('throws error when --format value is another flag [TC-9]', () => {
      expect(() => parseCheckArgs(['file.rill', '--format', '--fix'])).toThrow(
        '--format requires argument: text or json'
      );
    });

    it('throws error when --format value is invalid [TC-9]', () => {
      expect(() => parseCheckArgs(['file.rill', '--format', 'xml'])).toThrow(
        'Invalid format: xml. Expected text or json'
      );
    });
  });

  describe('check mode parsing', () => {
    it('parses file path correctly [TC-4]', () => {
      const result = parseCheckArgs(['test.rill']);
      expect(result).toEqual({
        mode: 'check',
        file: 'test.rill',
        fix: false,
        verbose: false,
        format: 'text',
        minSeverity: 'error',
      });
    });

    it('parses --fix flag correctly [TC-5]', () => {
      const result = parseCheckArgs(['test.rill', '--fix']);
      expect(result).toEqual({
        mode: 'check',
        file: 'test.rill',
        fix: true,
        verbose: false,
        format: 'text',
        minSeverity: 'error',
      });
    });

    it('parses --verbose flag correctly [TC-6]', () => {
      const result = parseCheckArgs(['test.rill', '--verbose']);
      expect(result).toEqual({
        mode: 'check',
        file: 'test.rill',
        fix: false,
        verbose: true,
        format: 'text',
        minSeverity: 'error',
      });
    });

    it('parses --format text correctly [TC-7]', () => {
      const result = parseCheckArgs(['test.rill', '--format', 'text']);
      expect(result).toEqual({
        mode: 'check',
        file: 'test.rill',
        fix: false,
        verbose: false,
        format: 'text',
        minSeverity: 'error',
      });
    });

    it('parses --format json correctly [TC-8]', () => {
      const result = parseCheckArgs(['test.rill', '--format', 'json']);
      expect(result).toEqual({
        mode: 'check',
        file: 'test.rill',
        fix: false,
        verbose: false,
        format: 'json',
        minSeverity: 'error',
      });
    });

    it('parses multiple flags together [TC-5, TC-6, TC-7]', () => {
      const result = parseCheckArgs([
        'test.rill',
        '--fix',
        '--verbose',
        '--format',
        'json',
      ]);
      expect(result).toEqual({
        mode: 'check',
        file: 'test.rill',
        fix: true,
        verbose: true,
        format: 'json',
        minSeverity: 'error',
      });
    });

    it('extracts file path when mixed with flags', () => {
      const result = parseCheckArgs(['--fix', 'test.rill', '--verbose']);
      expect(result).toEqual({
        mode: 'check',
        file: 'test.rill',
        fix: true,
        verbose: true,
        format: 'text',
        minSeverity: 'error',
      });
    });

    it('uses default format when not specified', () => {
      const result = parseCheckArgs(['test.rill']);
      expect(result).toEqual({
        mode: 'check',
        file: 'test.rill',
        fix: false,
        verbose: false,
        format: 'text',
        minSeverity: 'error',
      });
    });
  });
});
