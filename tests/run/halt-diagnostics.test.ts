/**
 * Verifies rill-run surfaces rich diagnostic detail on a runtime halt.
 *
 * Pins the contract that human, --verbose, --trace, --format json,
 * --format compact, and --atom-only output all carry the underlying
 * atom, message, and origin site. None of them collapse to a bare
 * "runtime halt" placeholder.
 *
 * Coverage is split across two surfaces:
 *
 * 1. Module mode (runScript directly): a guard-recovered #RILL_R038
 *    threading through `+` re-halt mirrors demo/03-runtime-error.
 *
 * 2. Handler mode (rill-run binary): handler-form main fields invoke
 *    the closure via invokeCallable, which throws RuntimeHaltSignal
 *    rather than RuntimeError. Tests spawn dist/cli-run.js against
 *    fixtures under tests/fixtures/run/ to cover this code path,
 *    which previously emitted bare "runtime halt" regardless of flags.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runScript } from '../../src/run/runner.js';
import type { RunCliOptions } from '../../src/run/types.js';
import type { RillConfigFile } from '@rcrsr/rill-config';

// ============================================================
// MODULE MODE: runScript helper (operates on synthetic temp file)
// ============================================================

const HALT_SCRIPT = [
  'guard { "not a number" -> number } => $inv',
  '',
  '42 => $some_other',
  '',
  '$inv + $some_other => $result',
].join('\n');

function makeOpts(overrides: Partial<RunCliOptions>): RunCliOptions {
  return {
    scriptPath: '/tmp/test.rill',
    scriptArgs: [],
    config: './rill-config.json',
    format: 'human',
    verbose: false,
    maxStackDepth: 10,
    ...overrides,
  };
}

async function runHalt(optsOverrides: Partial<RunCliOptions> = {}) {
  const scriptPath = path.join(os.tmpdir(), `rill-halt-${Date.now()}.rill`);
  fs.writeFileSync(scriptPath, HALT_SCRIPT, 'utf-8');
  try {
    const config: RillConfigFile = { modules: {} };
    return await runScript(
      makeOpts({ scriptPath, ...optsOverrides }),
      config,
      {},
      []
    );
  } finally {
    fs.unlinkSync(scriptPath);
  }
}

// ============================================================
// HANDLER MODE: spawnSync against dist/cli-run.js
// ============================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const RILL_RUN_BINARY = path.join(PROJECT_ROOT, 'dist', 'cli-run.js');
const FIXTURES = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'run');

function spawnRillRun(
  fixtureDir: string,
  args: string[] = []
): { exitCode: number; stdout: string; stderr: string } {
  // Strip Vitest env vars so the entry guard (shouldRunMain) activates in
  // the child. The guard skips main() when VITEST or VITEST_WORKER_ID are
  // set, and the child inherits those from the test runner without this strip.
  const env = { ...process.env };
  delete env['VITEST'];
  delete env['VITEST_WORKER_ID'];
  delete env['NODE_ENV'];

  const result = spawnSync(process.execPath, [RILL_RUN_BINARY, ...args], {
    cwd: fixtureDir,
    encoding: 'utf-8',
    env,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const TYPE_ASSERTION = path.join(FIXTURES, 'halt-type-assertion');
const EXPLICIT_ERROR = path.join(FIXTURES, 'halt-explicit-error');
const DIVIDE_BY_ZERO = path.join(FIXTURES, 'halt-divide-by-zero');
const PARSE_ERROR = path.join(FIXTURES, 'halt-parse-error');
const HANDLER_NOT_FOUND = path.join(FIXTURES, 'halt-handler-not-found');

// ============================================================
// MODULE-MODE TESTS
// ============================================================

describe('rill-run halt output (module mode)', () => {
  it('exits 1 for the type-cast halt scenario', async () => {
    const result = await runHalt();
    expect(result.exitCode).toBe(1);
    expect(result.errorOutput).toBeDefined();
  });

  it('does not collapse to a bare "runtime halt" placeholder', async () => {
    const result = await runHalt();
    expect(result.errorOutput?.trim()).not.toBe('runtime halt');
    expect(result.errorOutput?.toLowerCase()).not.toMatch(
      /^\s*runtime halt\s*$/
    );
  });

  describe('human format (default)', () => {
    it('includes the error envelope header with atom and provider', async () => {
      const result = await runHalt({ format: 'human' });
      expect(result.errorOutput).toContain('RILL-R038');
      expect(result.errorOutput).toContain('runtime');
    });

    it('includes the underlying error message', async () => {
      const result = await runHalt({ format: 'human' });
      expect(result.errorOutput).toContain(
        'cannot convert string "not a number" to number'
      );
    });

    it('includes an origin site arrow with file:line:column', async () => {
      const result = await runHalt({ format: 'human' });
      expect(result.errorOutput).toMatch(/-->\s+\S+:\d+:\d+/);
    });

    it('includes a source snippet with caret', async () => {
      const result = await runHalt({ format: 'human' });
      expect(result.errorOutput).toMatch(/\d+ \| /);
      expect(result.errorOutput).toContain('^');
    });
  });

  describe('--trace always', () => {
    it('renders a numbered trace block with all frames', async () => {
      const result = await runHalt({ format: 'human', trace: 'always' });
      expect(result.errorOutput).toContain('= trace:');
      expect(result.errorOutput).toMatch(/1\.\s+\S+:\d+:\d+/);
      expect(result.errorOutput).toMatch(/2\.\s+\S+:\d+:\d+/);
    });
  });

  describe('--verbose', () => {
    it('still surfaces atom and message rather than degrading output', async () => {
      const result = await runHalt({ format: 'human', verbose: true });
      expect(result.errorOutput).toContain('RILL-R038');
      expect(result.errorOutput).toContain('cannot convert');
    });
  });

  describe('--format json', () => {
    it('emits a structured envelope with errorId, atom, provider, and trace', async () => {
      const result = await runHalt({ format: 'json' });
      expect(result.errorOutput).toBeDefined();
      const parsed = JSON.parse(result.errorOutput!);
      expect(parsed.errorId).toBe('RILL-R038');
      expect(parsed.atom).toBe('#RILL_R038');
      expect(parsed.provider).toBe('runtime');
      expect(parsed.message).toContain('cannot convert');
      expect(Array.isArray(parsed.trace)).toBe(true);
      expect(parsed.trace.length).toBeGreaterThan(0);
      expect(parsed.trace[0]).toHaveProperty('site');
      expect(parsed.trace[0]).toHaveProperty('kind');
      expect(parsed.trace[0]).toHaveProperty('fn');
    });
  });

  describe('--format compact', () => {
    it('emits diagnostic content rather than a bare placeholder', async () => {
      const result = await runHalt({ format: 'compact' });
      expect(result.errorOutput?.trim()).not.toBe('runtime halt');
      expect(result.errorOutput).toContain('RILL-R038');
    });
  });

  describe('--atom-only with json', () => {
    it('emits a structured atom-only envelope, not a bare placeholder', async () => {
      const result = await runHalt({ format: 'json', atomOnly: true });
      expect(result.errorOutput).toBeDefined();
      const parsed = JSON.parse(result.errorOutput!);
      expect(parsed.atom).toBe('#RILL_R038');
      expect(parsed.errorId).toBe('RILL-R038');
    });
  });
});

// ============================================================
// HANDLER-MODE TESTS (regression for retro 2.1)
// ============================================================
//
// Before the fix, every handler-mode halt printed bare "runtime halt"
// regardless of flags because invokeCallable throws RuntimeHaltSignal
// (an Error subclass with message="runtime halt"), not the RillError
// instances handler-mode catches were checking for. These tests pin
// the contract that a) the bare placeholder never appears alone and
// b) every flag combination produces structured diagnostic content.

describe('rill-run halt output (handler mode)', () => {
  describe('type-assertion halt (#TYPE_MISMATCH)', () => {
    it('exits 1 with rich envelope on default format', () => {
      const result = spawnRillRun(TYPE_ASSERTION);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).not.toBe('runtime halt');
      expect(result.stderr).toContain('#TYPE_MISMATCH');
      expect(result.stderr).toContain('expected number, got string');
      expect(result.stderr).toMatch(/-->\s+\S+:\d+:\d+/);
      expect(result.stderr).toContain('^');
    });

    it('--verbose preserves atom and message', () => {
      const result = spawnRillRun(TYPE_ASSERTION, ['--verbose']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).not.toBe('runtime halt');
      expect(result.stderr).toContain('#TYPE_MISMATCH');
      expect(result.stderr).toContain('expected number');
    });

    it('--trace always renders numbered trace block', () => {
      const result = spawnRillRun(TYPE_ASSERTION, ['--trace']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('= trace:');
      expect(result.stderr).toMatch(/1\.\s+\S+/);
    });

    it('--format compact still surfaces atom', () => {
      const result = spawnRillRun(TYPE_ASSERTION, ['--format', 'compact']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).not.toBe('runtime halt');
      expect(result.stderr).toContain('#TYPE_MISMATCH');
    });

    it('--format json emits a parseable structured envelope', () => {
      const result = spawnRillRun(TYPE_ASSERTION, ['--format', 'json']);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stderr);
      expect(parsed.atom).toBe('#TYPE_MISMATCH');
      expect(parsed.provider).toBe('runtime');
      expect(parsed.message).toContain('expected number');
      expect(Array.isArray(parsed.trace)).toBe(true);
      expect(parsed.trace.length).toBeGreaterThan(0);
      expect(parsed.trace[0]).toHaveProperty('site');
      expect(parsed.trace[0]).toHaveProperty('kind');
    });

    it('--atom-only with json emits compact atom envelope', () => {
      const result = spawnRillRun(TYPE_ASSERTION, [
        '--format',
        'json',
        '--atom-only',
      ]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stderr);
      expect(parsed.atom).toBe('#TYPE_MISMATCH');
    });

    it('--max-stack-depth 50 still includes diagnostic content', () => {
      const result = spawnRillRun(TYPE_ASSERTION, ['--max-stack-depth', '50']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).not.toBe('runtime halt');
      expect(result.stderr).toContain('#TYPE_MISMATCH');
    });

    it('combined flags do not collapse output', () => {
      const result = spawnRillRun(TYPE_ASSERTION, [
        '--verbose',
        '--trace',
        '--format',
        'json',
      ]);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stderr);
      expect(parsed.atom).toBe('#TYPE_MISMATCH');
      expect(parsed.message).toContain('expected number');
    });
  });

  describe('explicit error halt (#RILL_R016)', () => {
    it('exits 1 with the user-supplied error message in human format', () => {
      const result = spawnRillRun(EXPLICIT_ERROR);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).not.toBe('runtime halt');
      expect(result.stderr).toContain('#RILL_R016');
      expect(result.stderr).toContain('deliberate halt for diagnostic test');
      expect(result.stderr).toMatch(/-->\s+\S+:\d+:\d+/);
    });

    it('--format json includes user message in envelope', () => {
      const result = spawnRillRun(EXPLICIT_ERROR, ['--format', 'json']);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stderr);
      expect(parsed.atom).toBe('#RILL_R016');
      expect(parsed.message).toContain('deliberate halt');
    });
  });

  describe('divide-by-zero halt (#RILL_R002)', () => {
    it('exits 1 with division message and source snippet', () => {
      const result = spawnRillRun(DIVIDE_BY_ZERO);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).not.toBe('runtime halt');
      expect(result.stderr).toContain('#RILL_R002');
      expect(result.stderr.toLowerCase()).toContain('division by zero');
      expect(result.stderr).toMatch(/\d+ \| /);
      expect(result.stderr).toContain('^');
    });

    it('--format json carries the division atom', () => {
      const result = spawnRillRun(DIVIDE_BY_ZERO, ['--format', 'json']);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stderr);
      expect(parsed.atom).toBe('#RILL_R002');
    });
  });

  describe('parse error during closure-defining script', () => {
    it('exits 1 with an enriched parse error envelope (not "runtime halt")', () => {
      const result = spawnRillRun(PARSE_ERROR);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).not.toBe('runtime halt');
      expect(result.stderr).toMatch(/RILL-[A-Z]\d+/);
    });
  });

  describe('handler not found in script', () => {
    it('exits 1 with a clear "Handler not found" message', () => {
      const result = spawnRillRun(HANDLER_NOT_FOUND);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Handler not found');
      expect(result.stderr).toContain('nonexistent_handler');
    });
  });

  describe('regression guard for retro 2.1', () => {
    // The original bug: every halt collapsed to bare "runtime halt"
    // regardless of flags. These assertions enumerate the same flag
    // combinations the retro tested.
    const flagCombos = [
      [],
      ['--verbose'],
      ['--trace'],
      ['--format', 'json'],
      ['--format', 'compact'],
      ['--atom-only'],
      ['--max-stack-depth', '50'],
      ['--verbose', '--trace', '--format', 'json'],
    ];

    for (const flags of flagCombos) {
      const label = flags.length > 0 ? flags.join(' ') : '(default)';
      it(`stderr is never bare "runtime halt" with flags: ${label}`, () => {
        const result = spawnRillRun(TYPE_ASSERTION, flags);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.trim()).not.toBe('runtime halt');
        expect(result.stderr.toLowerCase()).not.toMatch(/^\s*runtime halt\s*$/);
        // Stderr must be substantially longer than the placeholder string
        // ("runtime halt" is 12 chars) — any rich envelope exceeds 50.
        expect(result.stderr.length).toBeGreaterThan(50);
      });
    }
  });
});
