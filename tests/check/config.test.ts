/**
 * Configuration Loader Tests
 * Tests for .rill-check.json loading and validation via the check adapter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/check-adapter/config.js';
import { RULES } from '@rcrsr/rill-language-service/rules';

// ============================================================
// TEST FIXTURES
// ============================================================

const TEST_DIR = join(process.cwd(), 'tests', 'fixtures', 'check-config');
const CONFIG_FILE = '.rill-check.json';

/**
 * Create test directory and configuration file.
 */
function setupTestConfig(config: unknown): string {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }

  const configPath = join(TEST_DIR, CONFIG_FILE);
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return TEST_DIR;
}

/**
 * Write a raw (possibly malformed) string as the configuration file.
 */
function setupRawConfig(raw: string): string {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }

  const configPath = join(TEST_DIR, CONFIG_FILE);
  writeFileSync(configPath, raw, 'utf-8');
  return TEST_DIR;
}

/**
 * Clean up test directory after each test.
 */
function cleanupTestConfig(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// ============================================================
// FILE NOT FOUND
// ============================================================

describe('loadConfig - file not found', () => {
  beforeEach(() => {
    cleanupTestConfig();
  });

  it('returns null when config file does not exist', () => {
    const result = loadConfig(TEST_DIR);
    expect(result).toBeNull();
  });

  it('returns null for non-existent directory', () => {
    const result = loadConfig('/nonexistent/directory');
    expect(result).toBeNull();
  });
});

// ============================================================
// VALID CONFIGURATION
// ============================================================

describe('loadConfig - valid configuration', () => {
  afterEach(() => {
    cleanupTestConfig();
  });

  it('loads empty configuration file', () => {
    setupTestConfig({});
    const result = loadConfig(TEST_DIR);

    expect(result).not.toBeNull();
    expect(result?.config.rules).toBeDefined();
    expect(result?.severityMap).toBeDefined();
  });

  it('loads configuration with rules field', () => {
    setupTestConfig({
      rules: {},
    });

    const result = loadConfig(TEST_DIR);
    expect(result).not.toBeNull();
  });

  it('loads configuration with severity field', () => {
    setupTestConfig({
      severity: {},
    });

    const result = loadConfig(TEST_DIR);
    expect(result).not.toBeNull();
  });

  it('loads configuration with both fields', () => {
    setupTestConfig({
      rules: {},
      severity: {},
    });

    const result = loadConfig(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result?.config.rules).toBeDefined();
    expect(result?.severityMap).toBeDefined();
  });

  it('merges rules over service defaults', () => {
    setupTestConfig({
      rules: { NAMING_SNAKE_CASE: 'off' },
    });

    const result = loadConfig(TEST_DIR);

    expect(result).not.toBeNull();
    expect(result?.config.rules.NAMING_SNAKE_CASE).toBe('off');
    // Every other known rule falls back to the service default ('on').
    const otherCodes = RULES.map((rule) => rule.code).filter(
      (code) => code !== 'NAMING_SNAKE_CASE'
    );
    for (const code of otherCodes) {
      expect(result?.config.rules[code]).toBe('on');
    }
  });

  it('builds severityMap containing only user-listed codes', () => {
    setupTestConfig({
      severity: { NAMING_SNAKE_CASE: 'info' },
    });

    const result = loadConfig(TEST_DIR);

    expect(result).not.toBeNull();
    expect(result?.severityMap.NAMING_SNAKE_CASE).toBe('info');
    expect(Object.keys(result?.severityMap ?? {})).toEqual([
      'NAMING_SNAKE_CASE',
    ]);
  });

  it('preserves checkerMode unset', () => {
    setupTestConfig({});

    const result = loadConfig(TEST_DIR);

    expect(result).not.toBeNull();
    expect(result?.config.checkerMode).toBeUndefined();
  });

  it('validates all 40 rule codes with mixed states and stubs included', () => {
    const rules: Record<string, string> = {};
    for (const [index, rule] of RULES.entries()) {
      rules[rule.code] =
        index % 3 === 0 ? 'off' : index % 3 === 1 ? 'warn' : 'on';
    }

    setupTestConfig({ rules });

    const result = loadConfig(TEST_DIR);

    expect(result).not.toBeNull();
    expect(Object.keys(result?.config.rules ?? {}).length).toBe(RULES.length);
    for (const rule of RULES) {
      expect(result?.config.rules[rule.code]).toBe(rules[rule.code]);
    }
  });
});

// ============================================================
// MALFORMED JSON
// ============================================================

describe('loadConfig - malformed JSON', () => {
  afterEach(() => {
    cleanupTestConfig();
  });

  it('throws an Error prefixed [RILL-C003] for malformed JSON', () => {
    setupRawConfig('{ invalid json }');

    expect(() => loadConfig(TEST_DIR)).toThrow('[RILL-C003]');
    expect(() => loadConfig(TEST_DIR)).toThrow(/invalid JSON/);
  });
});

// ============================================================
// TOP-LEVEL SHAPE REGRESSION GUARD
// ============================================================

describe('loadConfig - top-level shape guard', () => {
  afterEach(() => {
    cleanupTestConfig();
  });

  it.each([
    ['array', [1, 2, 3]],
    ['null', null],
    ['string', 'not an object'],
    ['number', 42],
    ['boolean', true],
  ])('rejects top-level %s JSON with [RILL-C003]', (_label, value) => {
    setupTestConfig(value);

    expect(() => loadConfig(TEST_DIR)).toThrow('[RILL-C003]');
    expect(() => loadConfig(TEST_DIR)).toThrow(/must be an object/);
  });
});

// ============================================================
// SERVICE-DELEGATED VALIDATION FAILURES (rules block)
// ============================================================

describe('loadConfig - rules block validation failures', () => {
  afterEach(() => {
    cleanupTestConfig();
  });

  it('throws [RILL-C003] when the rules block is not an object', () => {
    setupTestConfig({ rules: 'invalid' });

    expect(() => loadConfig(TEST_DIR)).toThrow('[RILL-C003]');
    expect(() => loadConfig(TEST_DIR)).toThrow(/rules must be an object/);
  });

  it('throws [RILL-C003] for an unknown rule code in the rules block', () => {
    setupTestConfig({ rules: { UNKNOWN_RULE: 'on' } });

    expect(() => loadConfig(TEST_DIR)).toThrow('[RILL-C003]');
    expect(() => loadConfig(TEST_DIR)).toThrow(
      /unknown rule code: UNKNOWN_RULE/
    );
  });

  it('throws [RILL-C003] for an invalid rule state in the rules block', () => {
    setupTestConfig({ rules: { NAMING_SNAKE_CASE: 'invalid_state' } });

    expect(() => loadConfig(TEST_DIR)).toThrow('[RILL-C003]');
    expect(() => loadConfig(TEST_DIR)).toThrow(
      /NAMING_SNAKE_CASE has invalid state/
    );
  });
});

// ============================================================
// SERVICE-DELEGATED VALIDATION FAILURES (severity block)
// ============================================================

describe('loadConfig - severity block validation failures', () => {
  afterEach(() => {
    cleanupTestConfig();
  });

  it('throws [RILL-C003] for an unknown rule code in the severity block', () => {
    setupTestConfig({ severity: { UNKNOWN_RULE: 'error' } });

    expect(() => loadConfig(TEST_DIR)).toThrow('[RILL-C003]');
    expect(() => loadConfig(TEST_DIR)).toThrow(
      /unknown rule code: UNKNOWN_RULE/
    );
  });

  it('throws [RILL-C003] for multiple unknown rule codes in the severity block', () => {
    setupTestConfig({
      severity: { UNKNOWN_ONE: 'error', UNKNOWN_TWO: 'warning' },
    });

    expect(() => loadConfig(TEST_DIR)).toThrow('[RILL-C003]');
    expect(() => loadConfig(TEST_DIR)).toThrow(/unknown rule code/);
  });

  it('throws [RILL-C003] for an invalid severity value on a known rule code (adapter-formatted message)', () => {
    setupTestConfig({ severity: { NAMING_SNAKE_CASE: 'critical' } });

    expect(() => loadConfig(TEST_DIR)).toThrow('[RILL-C003]');
    expect(() => loadConfig(TEST_DIR)).toThrow(
      /rule NAMING_SNAKE_CASE has invalid severity: critical/
    );
  });

  it('throws [RILL-C003] when the severity block is a string', () => {
    setupTestConfig({ severity: 'invalid' });

    expect(() => loadConfig(TEST_DIR)).toThrow('[RILL-C003]');
    expect(() => loadConfig(TEST_DIR)).toThrow(/severity must be an object/);
  });

  it('throws [RILL-C003] when the severity block is an array', () => {
    setupTestConfig({ severity: ['error'] });

    expect(() => loadConfig(TEST_DIR)).toThrow('[RILL-C003]');
    expect(() => loadConfig(TEST_DIR)).toThrow(/severity must be an object/);
  });

  it('throws [RILL-C003] when the severity block is a number', () => {
    setupTestConfig({ severity: 42 });

    expect(() => loadConfig(TEST_DIR)).toThrow('[RILL-C003]');
    expect(() => loadConfig(TEST_DIR)).toThrow(/severity must be an object/);
  });

  it('treats a null severity block as absent and produces an empty severityMap', () => {
    setupTestConfig({ severity: null });

    const result = loadConfig(TEST_DIR);

    expect(result).not.toBeNull();
    expect(result?.severityMap).toEqual({});
  });
});
