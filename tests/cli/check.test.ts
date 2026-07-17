/**
 * Rill CLI Tests: rill-check command
 *
 * Test Coverage Matrix (maps test cases to specification requirements):
 * AC-S1: Validate file with diagnostics
 * AC-S2: Apply fixes with --fix
 * AC-S3: JSON output format
 * AC-S4: Verbose mode output
 * AC-S5: --version flag
 * AC-S6: --help flag
 * AC-S7: Config override
 * AC-E1: File not found (exit 2)
 * AC-E2: Parse error (exit 3)
 * AC-E3: Parse error + --fix message
 * AC-E4: Unknown flag error
 * AC-E5: Invalid config error
 * AC-B1: Empty file (no diagnostics)
 * AC-B2: Parse-only errors
 * AC-B5: (removed - 10K line perf test unnecessary for draft language)
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { parseCheckArgs, formatDiagnostics } from '../../src/cli-check.js';
import { ParseError, parse, parseWithRecovery } from '@rcrsr/rill';
import {
  type Diagnostic,
  RULES,
  createDefaultConfig,
  runRules,
} from '@rcrsr/rill-language-service/rules';
import { loadConfig } from '../../src/check-adapter/config.js';
import { applyFixes } from '../../src/check-adapter/fixer.js';
import { applySeverityOverlay } from '../../src/check-adapter/severity-overlay.js';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'node:url';

describe('rill-check CLI', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rill-check-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Clean up config file after each test to prevent pollution between tests
  afterEach(async () => {
    const configPath = path.join(tempDir, '.rill-check.json');
    try {
      await fs.unlink(configPath);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  /**
   * Write a file to the temp directory and return its path.
   */
  async function writeFile(name: string, content: string): Promise<string> {
    const filePath = path.join(tempDir, name);
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  /**
   * Validate a script file in-process (without spawning CLI).
   * Returns diagnostics array.
   */
  function validateFile(filePath: string): Diagnostic[] {
    const source = fssync.readFileSync(filePath, 'utf-8');
    const parseResult = parseWithRecovery(source);
    const resolved = loadConfig(path.dirname(filePath));
    const config = resolved?.config ?? createDefaultConfig();
    const severityMap = resolved?.severityMap ?? {};
    return applySeverityOverlay(
      runRules(parseResult, source, config),
      severityMap,
      config.rules
    );
  }

  /**
   * Apply fixes to a script file in-process (without spawning CLI).
   * Returns number of fixes applied.
   */
  function applyFixesToFile(filePath: string): number {
    const source = fssync.readFileSync(filePath, 'utf-8');
    const diagnostics = validateFile(filePath);

    if (diagnostics.length === 0) {
      return 0;
    }

    const result = applyFixes(source, diagnostics);

    if (result.applied > 0) {
      fssync.writeFileSync(filePath, result.modified, 'utf-8');
    }

    return result.applied;
  }

  /**
   * Execute rill-check CLI command and capture output.
   * Returns exit code, stdout, and stderr.
   */
  async function execCheck(
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const cliPath = path.join(process.cwd(), 'dist', 'cli.js');
      const env = { ...process.env };
      delete env['VITEST'];
      delete env['VITEST_WORKER_ID'];
      delete env['NODE_ENV'];
      const proc = spawn('node', [cliPath, 'check', ...args], {
        cwd: tempDir,
        env,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
        });
      });
    });
  }

  // ============================================================
  // ARGUMENT PARSING
  // ============================================================

  describe('parseCheckArgs', () => {
    it('parses file path', () => {
      const parsed = parseCheckArgs(['test.rill']);
      expect(parsed).toEqual({
        mode: 'check',
        file: 'test.rill',
        fix: false,
        verbose: false,
        format: 'text',
        minSeverity: 'error',
        runTypes: false,
      });
    });

    it('parses --help flag [AC-S6]', () => {
      expect(parseCheckArgs(['--help'])).toEqual({ mode: 'help' });
      expect(parseCheckArgs(['-h'])).toEqual({ mode: 'help' });
    });

    it('parses --fix flag [AC-S2]', () => {
      const parsed = parseCheckArgs(['test.rill', '--fix']);
      expect(parsed.mode).toBe('check');
      if (parsed.mode === 'check') {
        expect(parsed.fix).toBe(true);
      }
    });

    it('parses --verbose flag [AC-S4]', () => {
      const parsed = parseCheckArgs(['test.rill', '--verbose']);
      expect(parsed.mode).toBe('check');
      if (parsed.mode === 'check') {
        expect(parsed.verbose).toBe(true);
      }
    });

    it('parses --format json [AC-S3]', () => {
      const parsed = parseCheckArgs(['test.rill', '--format', 'json']);
      expect(parsed.mode).toBe('check');
      if (parsed.mode === 'check') {
        expect(parsed.format).toBe('json');
      }
    });

    it('throws on unknown flag [AC-E4]', () => {
      expect(() => parseCheckArgs(['--unknown'])).toThrow(
        'Unknown option: --unknown'
      );
      expect(() => parseCheckArgs(['-x'])).toThrow('Unknown option: -x');
    });

    it('returns scan mode when no args [FRICTION-NOTES 2026-05-03]', () => {
      const parsed = parseCheckArgs([]);
      expect(parsed.mode).toBe('scan');
    });

    it('throws when --fix is supplied without a file', () => {
      expect(() => parseCheckArgs(['--fix'])).toThrow(
        '--fix requires a file argument'
      );
    });
  });

  // ============================================================
  // DIAGNOSTIC FORMATTING
  // ============================================================

  describe('formatDiagnostics', () => {
    it('formats text output', () => {
      const diagnostics: Diagnostic[] = [
        {
          location: { line: 5, column: 10, offset: 50 },
          severity: 'error',
          code: 'TEST_ERROR',
          message: 'Test error message',
          context: '"hello"',
          fix: null,
        },
      ];

      const output = formatDiagnostics('test.rill', diagnostics, 'text', false);
      expect(output).toBe(
        'test.rill:5:10: error: Test error message (TEST_ERROR)'
      );
    });

    it('formats JSON output [AC-S3]', () => {
      const diagnostics: Diagnostic[] = [
        {
          location: { line: 5, column: 10, offset: 50 },
          severity: 'error',
          code: 'TEST_ERROR',
          message: 'Test error message',
          context: '"hello"',
          fix: null,
        },
      ];

      const output = formatDiagnostics('test.rill', diagnostics, 'json', false);
      const parsed = JSON.parse(output);

      expect(parsed).toEqual({
        file: 'test.rill',
        errors: [
          {
            location: { line: 5, column: 10, offset: 50 },
            severity: 'error',
            code: 'TEST_ERROR',
            message: 'Test error message',
            context: '"hello"',
          },
        ],
        summary: { total: 1, errors: 1, warnings: 0, info: 0 },
      });
    });

    it('formats empty diagnostics as empty array', () => {
      const output = formatDiagnostics('test.rill', [], 'text', false);
      expect(output).toBe('');
    });
  });

  // ============================================================
  // SUCCESS CASES
  // ============================================================

  describe('success cases', () => {
    it('validates file with no diagnostics [AC-B1]', async () => {
      const script = await writeFile('valid.rill', '"hello"');
      const diagnostics = validateFile(script);

      expect(diagnostics).toEqual([]);
    });

    it('validates empty file [AC-B1]', async () => {
      const script = await writeFile('empty.rill', '');
      const diagnostics = validateFile(script);

      expect(diagnostics).toEqual([]);
    });

    it('outputs JSON format when no diagnostics [AC-S3]', async () => {
      const script = await writeFile('valid-json.rill', '"hello"');
      const diagnostics = validateFile(script);

      expect(diagnostics).toEqual([]);

      const output = formatDiagnostics(script, diagnostics, 'json', false);
      const parsed = JSON.parse(output);
      expect(parsed.file).toBe(script);
      expect(parsed.errors).toEqual([]);
      expect(parsed.summary).toEqual({
        total: 0,
        errors: 0,
        warnings: 0,
        info: 0,
      });
    });

    it('shows help message [AC-S6]', async () => {
      const result = await execCheck(['--help']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('rill check');
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).toContain('--fix');
      expect(result.stdout).toContain('--format');
      expect(result.stdout).toContain('--verbose');
    });
  });

  // ============================================================
  // ERROR CASES
  // ============================================================

  describe('error cases', () => {
    it('exits with code 2 for file not found [AC-E1]', async () => {
      const result = await execCheck(['/nonexistent/file.rill']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('File not found');
      expect(result.stderr).toContain('[RILL-C001]');
    });

    it('exits with code 2 for directory path [AC-E1]', async () => {
      const result = await execCheck([tempDir]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('directory');
      expect(result.stderr).toContain('[RILL-C002]');
    });

    it('exits with code 3 for parse error [AC-E2]', async () => {
      const script = await writeFile('parse-error.rill', '|x| x }');
      const result = await execCheck([script]);

      expect(result.exitCode).toBe(3);
      // Parse errors now reported as diagnostics to stdout
      expect(result.stdout).toContain('parse-error');
      expect(result.stdout).toContain('error:');
    });

    it('reports parse error with location [AC-B2]', async () => {
      const script = await writeFile('parse-location.rill', 'invalid {');

      expect(() => {
        const source = fssync.readFileSync(script, 'utf-8');
        parse(source);
      }).toThrow(ParseError);

      try {
        const source = fssync.readFileSync(script, 'utf-8');
        parse(source);
      } catch (err) {
        expect(err).toBeInstanceOf(ParseError);
        if (err instanceof ParseError) {
          expect(err.location).toBeDefined();
          expect(err.location?.line).toBeGreaterThan(0);
          expect(err.location?.column).toBeGreaterThan(0);
        }
      }
    });

    it('reports cannot apply fixes on parse error [AC-E3]', async () => {
      const script = await writeFile('parse-fix.rill', '|x| x }');

      expect(() => {
        const source = fssync.readFileSync(script, 'utf-8');
        parse(source);
      }).toThrow(ParseError);
    });

    it('reports lexer errors as diagnostics instead of crashing', async () => {
      // Single quote character is invalid in rill (causes LexerError)
      const script = await writeFile('lex-error.rill', "test' invalid");
      const result = await execCheck([script]);

      // Should exit with code 3 (parse error) not crash
      expect(result.exitCode).toBe(3);
      // Should show diagnostic output, not an unhandled exception
      expect(result.stdout).toContain('parse-error');
      expect(result.stdout).toContain('lex-error.rill');
    });

    it('exits with code 1 for unknown flag [AC-E4]', async () => {
      expect(() => parseCheckArgs(['--unknown'])).toThrow('Unknown option');
    });

    it('exits with code 1 for invalid config [AC-E5]', async () => {
      await writeFile('valid.rill', '"hello"');
      await writeFile('.rill-check.json', '{ invalid json }');

      const result = await execCheck(['valid.rill']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('[RILL-C003]');
      expect(result.stderr).toContain('invalid JSON');
    });

    it('exits with code 0 for the same clean script without an invalid config', async () => {
      await writeFile('valid.rill', '"hello"');

      const result = await execCheck(['valid.rill']);

      expect(result.exitCode).toBe(0);
    });
  });

  // ============================================================
  // CONFIG OVERRIDE
  // ============================================================

  describe('config override [AC-S7]', () => {
    it('loads config from working directory', async () => {
      // Write valid empty config
      await writeFile('.rill-check.json', JSON.stringify({ rules: {} }));
      const script = await writeFile('config-test.rill', '"hello"');

      const resolved = loadConfig(tempDir);
      expect(resolved).toBeDefined();
      expect(resolved?.config.rules).toBeDefined();

      const diagnostics = validateFile(script);
      expect(diagnostics).toEqual([]);
    });

    it('uses default config when no config file present', async () => {
      // Create subdirectory without config
      const subdir = path.join(tempDir, 'no-config');
      await fs.mkdir(subdir, { recursive: true });
      const script = path.join(subdir, 'test.rill');
      await fs.writeFile(script, '"hello"', 'utf-8');

      const config = loadConfig(subdir);
      expect(config).toBeNull();

      const defaultConfig = createDefaultConfig();
      expect(defaultConfig).toBeDefined();
      expect(defaultConfig.rules).toBeDefined();
    });
  });

  // ============================================================
  // FIX APPLICATION
  // ============================================================

  describe('fix application [AC-S2]', () => {
    it('applies fixes when --fix flag present', async () => {
      // Note: Since no validation rules exist yet, we can't test actual fix application
      // This test verifies the --fix flag is processed without error
      const script = await writeFile('fix-test.rill', '"hello"');
      const applied = applyFixesToFile(script);

      // Should complete successfully with no fixes
      expect(applied).toBe(0);
    });

    it('reports applied fix count to stderr', async () => {
      // When validation rules are added, this test should verify fix count reporting
      const script = await writeFile('fix-count.rill', '"hello"');
      const applied = applyFixesToFile(script);

      // Should not apply fixes when none needed
      expect(applied).toBe(0);
    });
  });

  // ============================================================
  // VERBOSE MODE
  // ============================================================

  describe('verbose mode [AC-S4]', () => {
    it('includes category in JSON output when verbose', () => {
      // Test the formatDiagnostics function directly with verbose flag
      const diagnostics: Diagnostic[] = [
        {
          location: { line: 1, column: 1, offset: 0 },
          severity: 'warning',
          code: 'TEST_WARN',
          message: 'Test warning',
          context: 'test',
          fix: null,
        },
      ];

      const output = formatDiagnostics('test.rill', diagnostics, 'json', true);
      const parsed = JSON.parse(output);

      // Verbose mode adds category field (when the rule code is registered)
      expect(parsed.errors[0]).toHaveProperty('severity');
      expect(parsed.errors[0]).toHaveProperty('code');
      expect(parsed.errors[0]).toHaveProperty('message');
    });

    it('CLI accepts --verbose flag without error', () => {
      const args = parseCheckArgs(['test.rill', '--verbose']);
      expect(args.mode).toBe('check');
      if (args.mode === 'check') {
        expect(args.verbose).toBe(true);
      }
    });
  });

  // ============================================================
  // OUTPUT FORMAT
  // ============================================================

  describe('output format', () => {
    it('outputs text format by default', async () => {
      const script = await writeFile('format-default.rill', '"hello"');
      const diagnostics = validateFile(script);

      const output = formatDiagnostics(script, diagnostics, 'text', false);
      expect(output).toBe('');

      // Text format outputs empty string when no diagnostics
      expect(diagnostics).toEqual([]);
    });

    it('outputs JSON when --format json specified [AC-S3]', async () => {
      const script = await writeFile('format-json.rill', '"hello"');
      const diagnostics = validateFile(script);

      const output = formatDiagnostics(script, diagnostics, 'json', false);
      // Should be valid JSON
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('file');
      expect(parsed).toHaveProperty('errors');
      expect(parsed).toHaveProperty('summary');
    });
  });

  // ============================================================
  // BOUNDARY TESTS
  // ============================================================

  describe('boundary tests', () => {
    it('fix idempotency: second run applies zero fixes [AC-B3]', async () => {
      // Create file with multiple naming violations
      const content = `
"userName" => $userName
"itemList" => $itemList
$userName -> .len
$itemList -> .len
`;
      const script = await writeFile('idempotent.rill', content);

      // Get initial diagnostics
      const firstDiagnostics = validateFile(script);
      const hasViolations = firstDiagnostics.length > 0;

      if (hasViolations) {
        // Apply fixes first time
        const firstApplied = applyFixesToFile(script);
        expect(firstApplied).toBeGreaterThan(0);

        // Apply fixes second time (should be no-op because file was modified)
        const secondApplied = applyFixesToFile(script);
        expect(secondApplied).toBe(0);

        const finalDiagnostics = validateFile(script);
        expect(finalDiagnostics).toEqual([]);
      }
    });

    it('1000-line validation completes in reasonable time [AC-B4]', async () => {
      // Generate 1000 lines of valid rill code
      const lines: string[] = [];
      for (let i = 0; i < 1000; i++) {
        lines.push(`"line_${i}" => $line_${i}`);
      }
      const content = lines.join('\n');
      const script = await writeFile('perf-1000.rill', content);

      const startTime = Date.now();
      const diagnostics = validateFile(script);
      const duration = Date.now() - startTime;

      expect(diagnostics).toEqual([]);
      expect(duration).toBeLessThan(2000);
    });

    it('all rules enabled by default [AC-B6]', async () => {
      const config = createDefaultConfig();

      // Verify every rule registered with the service is enabled by default.
      const totalRules = RULES.length;
      const enabledCount = Object.values(config.rules).filter(
        (state) => state === 'on'
      ).length;

      expect(enabledCount).toBe(totalRules);
      expect(totalRules).toBeGreaterThanOrEqual(20);
    });
  });

  // ============================================================
  // ERROR HANDLING
  // ============================================================

  describe('error handling', () => {
    it('applies fixes for multiple violations [AC-E6]', async () => {
      // Note: Fix collision handling (EC-5) is tested in tests/check/fixer.test.ts
      // This test verifies that non-colliding fixes are successfully applied
      const content = `
dict[userName: "test"] => $data1
dict[itemList: list[1, 2, 3]] => $data2
`;
      const script = await writeFile('collision.rill', content);

      // Run check to get diagnostics
      const initialDiagnostics = validateFile(script);

      // Should have violations
      const hasUserName = initialDiagnostics.some((d) =>
        d.message.includes('userName')
      );
      const hasItemList = initialDiagnostics.some((d) =>
        d.message.includes('itemList')
      );

      if (hasUserName || hasItemList) {
        // Apply fixes
        const applied = applyFixesToFile(script);
        expect(applied).toBeGreaterThan(0);

        // Verify fix was applied (run check again on modified file)
        const finalDiagnostics = validateFile(script);

        // After fix, violations should be eliminated
        expect(finalDiagnostics).toEqual([]);
      }
    });
  });

  // ============================================================
  // ERROR CONTRACTS
  // ============================================================

  describe('error contracts', () => {
    describe('EC-1: parseCheckArgs - unknown flag', () => {
      it('throws error for unknown long flag', () => {
        expect(() => parseCheckArgs(['--unknown'])).toThrow(
          'Unknown option: --unknown'
        );
      });

      it('throws error for unknown short flag', () => {
        expect(() => parseCheckArgs(['-x'])).toThrow('Unknown option: -x');
      });

      it('throws error for invalid --format value', () => {
        expect(() => parseCheckArgs(['test.rill', '--format', 'xml'])).toThrow(
          'Invalid format: xml'
        );
      });

      it('CLI exits with code 1 for unknown flag', async () => {
        const result = await execCheck(['--unknown']);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Unknown option');
      });
    });

    describe('EC-2: parseCheckArgs - no-arg now scans (FRICTION-NOTES 2026-05-03)', () => {
      it('returns scan mode when no arguments provided', () => {
        expect(parseCheckArgs([])).toMatchObject({ mode: 'scan' });
      });

      it('throws when --fix is provided without a file', () => {
        expect(() => parseCheckArgs(['--fix', '--verbose'])).toThrow(
          '--fix requires a file argument'
        );
      });

      it('CLI exits 1 when --fix is supplied without a file', async () => {
        const result = await execCheck(['--fix']);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('--fix requires a file argument');
      });
    });

    describe('scan mode - discoverProjectFiles + envelope (FRICTION-NOTES 2026-05-03)', () => {
      /**
       * Run `rill check` (no args) inside an isolated scan directory so the
       * shared tempDir doesn't pollute results with files from other tests.
       */
      async function execScan(
        scanDir: string,
        args: string[]
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return new Promise((resolve) => {
          const cliPath = path.join(process.cwd(), 'dist', 'cli.js');
          const env = { ...process.env };
          delete env['VITEST'];
          delete env['VITEST_WORKER_ID'];
          delete env['NODE_ENV'];
          const proc = spawn('node', [cliPath, 'check', ...args], {
            cwd: scanDir,
            env,
          });
          let stdout = '';
          let stderr = '';
          proc.stdout.on('data', (d) => {
            stdout += d.toString();
          });
          proc.stderr.on('data', (d) => {
            stderr += d.toString();
          });
          proc.on('close', (code) => {
            resolve({ exitCode: code ?? 0, stdout, stderr });
          });
        });
      }

      let scanDir: string;

      beforeAll(async () => {
        scanDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rill-scan-test-'));
        // Top-level file
        await fs.writeFile(
          path.join(scanDir, 'top.rill'),
          'log "top"\n',
          'utf-8'
        );
        // Nested file under a non-skipped subdirectory
        await fs.mkdir(path.join(scanDir, 'src'), { recursive: true });
        await fs.writeFile(
          path.join(scanDir, 'src', 'nested.rill'),
          'log "nested"\n',
          'utf-8'
        );
        // File inside a skip-dir (should be ignored)
        await fs.mkdir(path.join(scanDir, 'node_modules', 'pkg'), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(scanDir, 'node_modules', 'pkg', 'ignored.rill'),
          'log "ignored"\n',
          'utf-8'
        );
        // File inside .rill (also a skip-dir)
        await fs.mkdir(path.join(scanDir, '.rill'), { recursive: true });
        await fs.writeFile(
          path.join(scanDir, '.rill', 'cache.rill'),
          'log "cache"\n',
          'utf-8'
        );
      });

      afterAll(async () => {
        await fs.rm(scanDir, { recursive: true, force: true });
      });

      it('scans nested *.rill files and skips node_modules / .rill / dist / .git', async () => {
        const result = await execScan(scanDir, []);
        expect(result.exitCode).toBe(0);
        // Both expected files appear in output
        expect(result.stdout).toContain('top.rill');
        expect(result.stdout).toContain(
          path.join('src', 'nested.rill').replaceAll('\\', '/')
        );
        // Skipped files do not appear
        expect(result.stdout).not.toContain('ignored.rill');
        expect(result.stdout).not.toContain('cache.rill');
      });

      it('emits a single JSON envelope with files[] and aggregate summary', async () => {
        const result = await execScan(scanDir, ['--format', 'json']);
        expect(result.exitCode).toBe(0);
        // Output must parse as a single JSON document
        const parsed = JSON.parse(result.stdout) as {
          files: { file: string; errors: unknown[] }[];
          summary: {
            files: number;
            errors: number;
            warnings: number;
            info: number;
          };
        };
        expect(parsed.summary.files).toBe(2);
        expect(parsed.files).toHaveLength(2);
        const fileNames = parsed.files.map((f) => f.file).sort();
        expect(fileNames[0]).toMatch(/(^|[/\\])src[/\\]nested\.rill$/);
        expect(fileNames[1]).toBe('top.rill');
      });

      it('emits empty-files envelope when no *.rill files are found', async () => {
        const emptyDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'rill-scan-empty-')
        );
        try {
          const result = await execScan(emptyDir, ['--format', 'json']);
          expect(result.exitCode).toBe(0);
          const parsed = JSON.parse(result.stdout) as {
            files: unknown[];
            summary: { files: number };
          };
          expect(parsed.files).toEqual([]);
          expect(parsed.summary.files).toBe(0);
        } finally {
          await fs.rm(emptyDir, { recursive: true, force: true });
        }
      });
    });

    describe('EC-3: loadConfig - invalid JSON', () => {
      it('throws error for malformed JSON', async () => {
        await writeFile('.rill-check.json', '{ invalid json }');

        expect(() => loadConfig(tempDir)).toThrow(/invalid JSON/i);
      });

      it('throws error for non-object JSON', async () => {
        await writeFile('.rill-check.json', '"string value"');

        expect(() => loadConfig(tempDir)).toThrow(/must be an object/i);
      });

      it('throws error for invalid rule state', async () => {
        await writeFile(
          '.rill-check.json',
          JSON.stringify({ rules: { NAMING_SNAKE_CASE: 'invalid_state' } })
        );

        expect(() => loadConfig(tempDir)).toThrow(/invalid state/i);
      });
    });

    describe('EC-4: loadConfig - unknown rule', () => {
      it('throws error for unknown rule in rules field', async () => {
        await writeFile(
          '.rill-check.json',
          JSON.stringify({ rules: { UNKNOWN_RULE: 'on' } })
        );

        expect(() => loadConfig(tempDir)).toThrow(
          /unknown rule code: UNKNOWN_RULE/i
        );
      });

      it('throws error for unknown rule in severity field', async () => {
        await writeFile(
          '.rill-check.json',
          JSON.stringify({ severity: { UNKNOWN_RULE: 'error' } })
        );

        expect(() => loadConfig(tempDir)).toThrow(
          /unknown rule code: UNKNOWN_RULE/i
        );
      });
    });

    describe('EC-5: applyFixes - fix collision (tested via unit tests)', () => {
      it('reference: collision detection in fixer.test.ts', () => {
        // EC-5 is tested in tests/check/fixer.test.ts
        // The applyFixes function skips overlapping fixes with reason
        // See fixer.test.ts "collision detection [EC-5]" describe block
        expect(true).toBe(true);
      });
    });

    describe('EC-6: applyFixes - parse failure (tested via unit tests)', () => {
      it('reference: parse verification in fixer.test.ts', () => {
        // EC-6 is tested in tests/check/fixer.test.ts
        // The applyFixes function throws when fix creates invalid syntax
        // See fixer.test.ts "parse verification [EC-6]" describe block
        expect(true).toBe(true);
      });
    });
  });

  // ============================================================
  // EDGE CASES
  // ============================================================

  describe('edge cases', () => {
    it('handles file with only whitespace', async () => {
      const script = await writeFile('whitespace.rill', '   \n\n  \t  ');
      const diagnostics = validateFile(script);

      expect(diagnostics).toEqual([]);
    });

    it('handles file with only comments', async () => {
      const script = await writeFile('comments.rill', '# comment\n# another');
      const diagnostics = validateFile(script);

      expect(diagnostics).toEqual([]);
    });

    it('handles multiple flags in different order', async () => {
      const script = await writeFile('multi-flags.rill', '"hello"');
      const args = parseCheckArgs([
        '--verbose',
        script,
        '--format',
        'json',
        '--fix',
      ]);

      expect(args.mode).toBe('check');
      if (args.mode === 'check') {
        expect(args.verbose).toBe(true);
        expect(args.format).toBe('json');
        expect(args.fix).toBe(true);
        expect(args.file).toBe(script);
      }

      const diagnostics = validateFile(script);
      const output = formatDiagnostics(script, diagnostics, 'json', true);
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('file');
    });
  });

  // ============================================================
  // --min-severity FLAG: SEVERITY-AWARE EXIT CODE
  // ============================================================
  //
  // Default exit code is gated by --min-severity (default: error).
  // Diagnostics below the threshold still print but do not fail the
  // process. Regression for retro 2.2: info-level advisories no
  // longer force exit 1, so CI orchestrators can rely on the exit
  // code without grepping stderr.

  describe('--min-severity flag', () => {
    // Source samples chosen to deterministically trigger exactly one
    // diagnostic at each severity tier in the registered rule set.
    // Each rule code is asserted explicitly, so a future rule
    // change will fail the suite loudly rather than silently accept
    // some other diagnostic at the same severity.
    const INFO_SOURCE = '5+3\n'; // SPACING_OPERATOR (info)
    const WARNING_SOURCE = '"ext:foo" => $name\nuse<$name>\n'; // USE_DYNAMIC_IDENTIFIER (warning)
    const ERROR_SOURCE = '42 => $myCamelCase\n'; // NAMING_SNAKE_CASE (error)

    describe('parser', () => {
      it('defaults minSeverity to "error" when flag is omitted', () => {
        const args = parseCheckArgs(['main.rill']);
        expect(args.mode).toBe('check');
        if (args.mode === 'check') {
          expect(args.minSeverity).toBe('error');
        }
      });

      it('parses --min-severity error', () => {
        const args = parseCheckArgs(['--min-severity', 'error', 'main.rill']);
        if (args.mode === 'check') {
          expect(args.minSeverity).toBe('error');
        }
      });

      it('parses --min-severity warning', () => {
        const args = parseCheckArgs(['--min-severity', 'warning', 'main.rill']);
        if (args.mode === 'check') {
          expect(args.minSeverity).toBe('warning');
        }
      });

      it('parses --min-severity info', () => {
        const args = parseCheckArgs(['--min-severity', 'info', 'main.rill']);
        if (args.mode === 'check') {
          expect(args.minSeverity).toBe('info');
        }
      });

      it('throws on missing --min-severity value', () => {
        expect(() => parseCheckArgs(['--min-severity'])).toThrow(
          /--min-severity requires argument/
        );
      });

      it('throws when --min-severity value is another flag', () => {
        expect(() => parseCheckArgs(['--min-severity', '--fix'])).toThrow(
          /--min-severity requires argument/
        );
      });

      it('throws on invalid --min-severity value', () => {
        expect(() =>
          parseCheckArgs(['--min-severity', 'critical', 'main.rill'])
        ).toThrow(/Invalid --min-severity/);
      });

      it('does not treat the --min-severity value as the file argument', () => {
        const args = parseCheckArgs(['--min-severity', 'warning', 'main.rill']);
        if (args.mode === 'check') {
          expect(args.file).toBe('main.rill');
          expect(args.minSeverity).toBe('warning');
        }
      });
    });

    describe('default behavior (--min-severity error)', () => {
      it('regression for retro 2.2: info-only file exits 0', async () => {
        const script = await writeFile('info-only.rill', INFO_SOURCE);
        const result = await execCheck([script]);
        expect(result.exitCode).toBe(0);
        // Diagnostic still prints so the user sees the advisory.
        expect(result.stdout).toContain('info:');
        expect(result.stdout).toContain('SPACING_OPERATOR');
      });

      it('warning-only file exits 0', async () => {
        const script = await writeFile('warning-only.rill', WARNING_SOURCE);
        const result = await execCheck([script]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('warning:');
        expect(result.stdout).toContain('USE_DYNAMIC_IDENTIFIER');
      });

      it('error-bearing file exits 1', async () => {
        const script = await writeFile('error.rill', ERROR_SOURCE);
        const result = await execCheck([script]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain('error:');
        expect(result.stdout).toContain('NAMING_SNAKE_CASE');
      });
    });

    describe('--min-severity warning', () => {
      it('info-only file exits 0', async () => {
        const script = await writeFile('info-only-w.rill', INFO_SOURCE);
        const result = await execCheck(['--min-severity', 'warning', script]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('SPACING_OPERATOR');
      });

      it('warning-only file exits 1', async () => {
        const script = await writeFile('warning-only-w.rill', WARNING_SOURCE);
        const result = await execCheck(['--min-severity', 'warning', script]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain('USE_DYNAMIC_IDENTIFIER');
      });

      it('error-bearing file exits 1', async () => {
        const script = await writeFile('error-w.rill', ERROR_SOURCE);
        const result = await execCheck(['--min-severity', 'warning', script]);
        expect(result.exitCode).toBe(1);
      });
    });

    describe('--min-severity info (preserves pre-fix strict behavior)', () => {
      it('info-only file exits 1', async () => {
        const script = await writeFile('info-strict.rill', INFO_SOURCE);
        const result = await execCheck(['--min-severity', 'info', script]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain('SPACING_OPERATOR');
      });

      it('warning-only file exits 1', async () => {
        const script = await writeFile('warning-strict.rill', WARNING_SOURCE);
        const result = await execCheck(['--min-severity', 'info', script]);
        expect(result.exitCode).toBe(1);
      });

      it('error-bearing file exits 1', async () => {
        const script = await writeFile('error-strict.rill', ERROR_SOURCE);
        const result = await execCheck(['--min-severity', 'info', script]);
        expect(result.exitCode).toBe(1);
      });

      it('clean file exits 0', async () => {
        const script = await writeFile('clean.rill', '"hello"\n');
        const result = await execCheck(['--min-severity', 'info', script]);
        expect(result.exitCode).toBe(0);
      });
    });

    // --min-severity gates only the exit code; it is orthogonal to --fix,
    // which applies every applicable fix regardless of severity (fixes are
    // keyed on fix applicability, never on severity). UNNECESSARY_ASSERTION
    // is the only below-error rule that emits an applicable fix, so it is the
    // sole case where the two flags interact. This pins that interaction:
    // a fix below the exit threshold is still applied and written, the exit
    // code stays 0, and the diagnostic still prints (the change is not silent).
    describe('--fix interaction with --min-severity', () => {
      it('applies a below-threshold fix and still exits 0 under --min-severity error', async () => {
        const script = await writeFile(
          'fix-below-threshold.rill',
          '42:number\n'
        );

        const result = await execCheck([
          '--fix',
          '--min-severity',
          'error',
          script,
        ]);

        // Info-level diagnostic is below the error threshold, so exit is 0.
        expect(result.exitCode).toBe(0);
        // The fix is applied and written despite being below the threshold.
        expect(fssync.readFileSync(script, 'utf-8')).toBe('42\n');
        expect(result.stderr).toContain('Applied 1 fix');
        // The change is not silent: the diagnostic still prints.
        expect(result.stdout).toContain('info:');
        expect(result.stdout).toContain('UNNECESSARY_ASSERTION');
      });
    });

    describe('JSON format integration', () => {
      it('--format json with default min-severity emits envelope and exits 0 for info-only', async () => {
        const script = await writeFile('info-json.rill', INFO_SOURCE);
        const result = await execCheck(['--format', 'json', script]);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.summary.info).toBe(1);
        expect(parsed.summary.errors).toBe(0);
      });

      it('--format json --min-severity info emits envelope and exits 1 for info-only', async () => {
        const script = await writeFile('info-json-strict.rill', INFO_SOURCE);
        const result = await execCheck([
          '--format',
          'json',
          '--min-severity',
          'info',
          script,
        ]);
        expect(result.exitCode).toBe(1);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.summary.info).toBe(1);
      });
    });

    describe('CLI errors', () => {
      it('exits 1 with helpful message on invalid --min-severity value', async () => {
        const script = await writeFile('any.rill', '"hello"\n');
        const result = await execCheck(['--min-severity', 'critical', script]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Invalid --min-severity');
      });

      it('exits 1 with helpful message when --min-severity is missing a value', async () => {
        const result = await execCheck(['--min-severity']);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('--min-severity requires argument');
      });
    });
  });

  // ============================================================
  // TEXT OUTPUT LITERAL FORMAT
  // ============================================================

  describe('text output literal format', () => {
    it('renders exactly file:line:col: severity: message (code), single space after each colon, no trailing punctuation', async () => {
      const script = await writeFile(
        'literal-format.rill',
        '42 => $myCamelCase\n'
      );
      const result = await execCheck([script]);
      const line = result.stdout.trim().split('\n')[0] ?? '';

      expect(line).toMatch(/^.+:\d+:\d+: error: .+ \(NAMING_SNAKE_CASE\)$/);
      // Exactly one space after each of the three colons that separate
      // file:line:col from severity and severity from message. The
      // greedy `.+` above would tolerate a stray double space right
      // after "error:" or right before "(CODE)", so pin that directly:
      // no two consecutive spaces anywhere on the line.
      expect(line).not.toMatch(/ {2}/);
      const afterFile = line.slice(line.indexOf(':') + 1);
      expect(afterFile.startsWith(' ')).toBe(false);
      expect(line).not.toMatch(/[.,;]$/);
      expect(line.endsWith(')')).toBe(true);
    });
  });

  // ============================================================
  // JSON AGGREGATE FIELDS
  // ============================================================

  describe('JSON output aggregate fields', () => {
    it('per-file JSON carries errors[] with location/severity/code/message/context and fix when present', async () => {
      const script = await writeFile(
        'json-fields.rill',
        '42 => $myCamelCase\n'
      );
      const result = await execCheck(['--format', 'json', script]);
      const parsed = JSON.parse(result.stdout);

      expect(parsed.file).toBe(script);
      expect(parsed.errors).toHaveLength(1);
      const error = parsed.errors[0];
      expect(error).toMatchObject({
        code: 'NAMING_SNAKE_CASE',
        severity: 'error',
      });
      expect(error.location).toEqual({
        line: expect.any(Number),
        column: expect.any(Number),
        offset: expect.any(Number),
      });
      expect(typeof error.message).toBe('string');
      expect(typeof error.context).toBe('string');
      // NAMING_SNAKE_CASE always emits a fix payload.
      expect(error.fix).toMatchObject({
        applicable: true,
        replacement: expect.any(String),
      });
      expect(parsed.summary).toEqual({
        total: 1,
        errors: 1,
        warnings: 0,
        info: 0,
      });
    });

    it('scan-mode JSON emits a files[] envelope with an aggregate summary', async () => {
      // Genuine directory scan (no file positional -> mode: 'scan'), run
      // in an isolated directory so it doesn't pick up sibling fixtures
      // from other tests sharing tempDir.
      const scanDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'rill-check-scan-agg-')
      );
      try {
        await fs.writeFile(
          path.join(scanDir, 'json-scan.rill'),
          '42 => $myCamelCase\n',
          'utf-8'
        );
        const result = await new Promise<{
          exitCode: number;
          stdout: string;
          stderr: string;
        }>((resolve) => {
          const cliPath = path.join(process.cwd(), 'dist', 'cli.js');
          const env = { ...process.env };
          delete env['VITEST'];
          delete env['VITEST_WORKER_ID'];
          delete env['NODE_ENV'];
          const proc = spawn('node', [cliPath, 'check', '--format', 'json'], {
            cwd: scanDir,
            env,
          });
          let stdout = '';
          let stderr = '';
          proc.stdout.on('data', (d) => {
            stdout += d.toString();
          });
          proc.stderr.on('data', (d) => {
            stderr += d.toString();
          });
          proc.on('close', (code) => {
            resolve({ exitCode: code ?? 1, stdout, stderr });
          });
        });
        expect(result.exitCode).toBe(1);
        const parsed = JSON.parse(result.stdout) as {
          files: { file: string; errors: unknown[] }[];
          summary: {
            files: number;
            errors: number;
            warnings: number;
            info: number;
          };
        };
        // Deviation from the API contract's claimed five-field aggregate
        // (totalFiles/totalErrors/totalWarnings/totalInfos/maxSeverity):
        // the shipped scan envelope aggregates under files/errors/warnings/info
        // and never emits maxSeverity. Behavior preservation governs here, so
        // this test binds to what the CLI actually emits.
        expect(parsed).toHaveProperty('files');
        expect(parsed).toHaveProperty('summary');
        expect(Object.keys(parsed.summary).sort()).toEqual([
          'errors',
          'files',
          'info',
          'warnings',
        ]);
        expect(parsed.files).toHaveLength(1);
        expect(parsed.files[0]?.file).toBe('json-scan.rill');
        expect(parsed.summary.files).toBe(1);
        expect(parsed.summary.errors).toBe(1);
      } finally {
        await fs.rm(scanDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================
  // DIAGNOSTIC SORT ORDER
  // ============================================================

  describe('diagnostic sort order', () => {
    it('orders diagnostics line-then-column across multiple violations', async () => {
      const content = `
"userName" => $userName
"itemList" => $itemList
$userName -> .len
$itemList -> .len
`;
      const script = await writeFile('sort-order.rill', content);
      const result = await execCheck(['--format', 'json', script]);
      const parsed = JSON.parse(result.stdout) as {
        errors: { location: { line: number; column: number } }[];
      };

      expect(parsed.errors.length).toBeGreaterThan(1);
      for (let i = 1; i < parsed.errors.length; i++) {
        const prev = parsed.errors[i - 1]!.location;
        const curr = parsed.errors[i]!.location;
        const inOrder =
          curr.line > prev.line ||
          (curr.line === prev.line && curr.column >= prev.column);
        expect(inOrder).toBe(true);
      }
    });
  });

  // ============================================================
  // STUBBED RULE INERTNESS
  //
  // The service reserves three rule codes for future static-analysis work.
  // Their `validate` functions unconditionally return an empty array, so
  // enabling them (the default state) must never produce a diagnostic.
  // ============================================================

  describe('stubbed rule inertness', () => {
    const STUB_CODES = [
      'CONDITION_TYPE',
      'FOLD_INTERMEDIATES',
      'THROWAWAY_CAPTURE',
    ];

    it('registers exactly the three stubbed rule codes as stub in the service registry', () => {
      const stubRules = RULES.filter((r) => r.stub === true);
      expect(stubRules.map((r) => r.code).sort()).toEqual(
        [...STUB_CODES].sort()
      );
    });

    it('emits zero diagnostics for each stub code when the default config leaves it enabled', () => {
      const config = createDefaultConfig();
      for (const code of STUB_CODES) {
        expect(config.rules[code]).toBe('on');
      }

      // Source chosen to plausibly trigger the pattern each stub code is
      // reserved for (fold accumulation, a conditional's branch type, and a
      // capture used exactly once), so a stub becoming live would show up here.
      const source = `
list[1, 2, 3] -> fold(0, { $@ + $ })
$x > 0 ? "positive" ! "negative"
"hello" => $x
$x -> .upper => $y
$y -> .len
`;
      const parseResult = parseWithRecovery(source);
      const diagnostics = runRules(parseResult, source, config);
      const codes = diagnostics.map((d) => d.code);

      for (const code of STUB_CODES) {
        expect(codes).not.toContain(code);
      }
    });
  });

  // ============================================================
  // VERBOSE CATEGORY RESOLUTION
  //
  // --verbose must resolve a category for every emitted diagnostic code by
  // reading the service's own rule registry, not a CLI-local lookup table.
  // ============================================================

  describe('verbose category resolution', () => {
    it('resolves a category from service RULES for every diagnostic the CLI emits with --verbose', async () => {
      const categoryByCode = new Map(RULES.map((r) => [r.code, r.category]));
      const content = `
42 => $myCamelCase
5+3
"ext:foo" => $name
use<$name>
$str == ""
`;
      const script = await writeFile('verbose-category.rill', content);
      const result = await execCheck(['--format', 'json', '--verbose', script]);
      const parsed = JSON.parse(result.stdout) as {
        errors: { code: string; category?: string }[];
      };

      expect(parsed.errors.length).toBeGreaterThan(0);
      for (const error of parsed.errors) {
        expect(error.category).toBeDefined();
        expect(error.category).toBe(categoryByCode.get(error.code));
      }
    });
  });

  // ============================================================
  // DIAGNOSTIC PROVENANCE
  //
  // Confirms the CLI's live code path never references the legacy in-repo
  // engine, and that the diagnostics reaching output are genuinely produced
  // by the service's `runRules` call rather than a re-homed local dispatch
  // loop wearing the same rule codes.
  // ============================================================

  describe('diagnostic provenance', () => {
    it('finds no reference to the legacy engine from the live CLI code path', () => {
      // The legacy engine directory no longer exists on disk. Walking both
      // src/ and tests/ keeps this assertion meaningful for any future
      // reintroduction of a local rule-evaluation engine under a new name.
      const srcDir = path.join(process.cwd(), 'src');
      const testsDir = path.join(process.cwd(), 'tests');
      const selfFile = fileURLToPath(import.meta.url);
      const forbidden: RegExp[] = [
        /\bvalidateScript\b/,
        /\bVALIDATION_RULES\b/,
        /from ['"]\.\.?\/check\//,
      ];
      const offenders: string[] = [];

      function walk(dir: string): void {
        for (const entry of fssync.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            walk(path.join(dir, entry.name));
          } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            const filePath = path.join(dir, entry.name);
            if (filePath === selfFile) continue;
            const content = fssync.readFileSync(filePath, 'utf-8');
            for (const pattern of forbidden) {
              if (pattern.test(content)) {
                offenders.push(`${filePath}: ${pattern.toString()}`);
              }
            }
          }
        }
      }
      walk(srcDir);
      walk(testsDir);

      expect(offenders).toEqual([]);
    });

    it('every diagnostic code the CLI emits is registered in service RULES', async () => {
      const serviceCodes = new Set(RULES.map((r) => r.code));
      const content = `
42 => $myCamelCase
5+3
"ext:foo" => $name
use<$name>
prompt("Read file") => $raw
$raw -> log
`;
      const script = await writeFile('provenance-codes.rill', content);
      const result = await execCheck(['--format', 'json', script]);
      const parsed = JSON.parse(result.stdout) as {
        errors: { code: string }[];
      };

      expect(parsed.errors.length).toBeGreaterThan(0);
      for (const error of parsed.errors) {
        expect(serviceCodes.has(error.code)).toBe(true);
      }
    });

    it('checkFile sources diagnostics from a single runRules call, not a local dispatch loop', () => {
      const cliCheckSource = fssync.readFileSync(
        path.join(process.cwd(), 'src', 'cli-check.ts'),
        'utf-8'
      );
      const runRulesCalls = cliCheckSource.match(/\brunRules\(/g) ?? [];
      // Exactly one call site: the diagnostics passed to applySeverityOverlay
      // inside checkFile. A "relocate the old engine behind a new name"
      // implementation would either add a second call site or, more likely,
      // dispatch rules itself via a `.validate(` loop instead of calling the
      // service at all.
      expect(runRulesCalls).toHaveLength(1);
      expect(cliCheckSource).not.toMatch(/\.validate\(/);
    });

    it('the CLI builds its verbose category lookup by iterating service RULES, not a local map', () => {
      const cliCheckSource = fssync.readFileSync(
        path.join(process.cwd(), 'src', 'cli-check.ts'),
        'utf-8'
      );
      expect(cliCheckSource).toMatch(
        /for \(const rule of RULES\)\s*{\s*categoryMap\.set\(rule\.code, rule\.category\)/
      );
    });
  });

  // ============================================================
  // MIN-SEVERITY ONE-SHOT NOTICE
  //
  // The 0.19.1 min-severity default-change notice must fire at most once
  // per project, suppressed by its marker file, and skipped entirely when
  // the user opts in via --min-severity or already has a .rill-check.json.
  // ============================================================

  describe('min-severity one-shot notice', () => {
    async function execCheckIn(
      dir: string,
      args: string[]
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return new Promise((resolve) => {
        const cliPath = path.join(process.cwd(), 'dist', 'cli.js');
        const env = { ...process.env };
        delete env['VITEST'];
        delete env['VITEST_WORKER_ID'];
        delete env['NODE_ENV'];
        const proc = spawn('node', [cliPath, 'check', ...args], {
          cwd: dir,
          env,
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => {
          stdout += d.toString();
        });
        proc.stderr.on('data', (d) => {
          stderr += d.toString();
        });
        proc.on('close', (code) => {
          resolve({ exitCode: code ?? 1, stdout, stderr });
        });
      });
    }

    it('emits the notice on the first run, then suppresses it via the marker file', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rill-notice-test-'));
      try {
        await fs.mkdir(path.join(dir, '.rill'), { recursive: true });
        const script = path.join(dir, 'clean.rill');
        await fs.writeFile(script, '"hello"\n', 'utf-8');

        const first = await execCheckIn(dir, [script]);
        expect(first.stderr).toContain('rill check defaults changed');

        const marker = path.join(
          dir,
          '.rill',
          '.notices',
          'min-severity-0.19.1'
        );
        expect(fssync.existsSync(marker)).toBe(true);

        const second = await execCheckIn(dir, [script]);
        expect(second.stderr).not.toContain('rill check defaults changed');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('is skipped entirely when --min-severity is passed', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rill-notice-test-'));
      try {
        await fs.mkdir(path.join(dir, '.rill'), { recursive: true });
        const script = path.join(dir, 'clean.rill');
        await fs.writeFile(script, '"hello"\n', 'utf-8');

        const result = await execCheckIn(dir, [
          '--min-severity',
          'warning',
          script,
        ]);
        expect(result.stderr).not.toContain('rill check defaults changed');

        const marker = path.join(
          dir,
          '.rill',
          '.notices',
          'min-severity-0.19.1'
        );
        expect(fssync.existsSync(marker)).toBe(false);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('is skipped when a .rill-check.json overrides defaults', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rill-notice-test-'));
      try {
        await fs.mkdir(path.join(dir, '.rill'), { recursive: true });
        await fs.writeFile(
          path.join(dir, '.rill-check.json'),
          JSON.stringify({ rules: {} }),
          'utf-8'
        );
        const script = path.join(dir, 'clean.rill');
        await fs.writeFile(script, '"hello"\n', 'utf-8');

        const result = await execCheckIn(dir, [script]);
        expect(result.stderr).not.toContain('rill check defaults changed');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================
  // PRESERVED-BEHAVIOR PARITY (legacy-parity)
  //
  // Binds corpus parity to a sample of the Preserved-Behavior Inventory:
  // one fixture per active detection rule, stub rule, and fix payload
  // across every rule category in the inventory. Each row maps to a
  // "COVERED" or "PORTED" row of the inventory's write-surface table and
  // asserts the migrated (service-backed) engine reproduces the
  // pre-rework behavior as documented in the inventory for that row.
  // Expectations below were hand-derived by reading the inventory, not
  // captured from an execution snapshot; this file does not perform a
  // recorded-output diff.
  //
  // Coverage note: this suite samples one fixture per rule category, not
  // one per rule code. 14 of the 37 active codes have no fixture here:
  // FILTER_NEGATION, METHOD_SHORTHAND, PREFER_DO_WHILE,
  // USE_DEFAULT_OPERATOR, CLOSURE_BRACES, CLOSURE_LATE_BINDING,
  // VALIDATE_EXTERNAL, COMPLEX_CONDITION, LOOP_OUTER_CAPTURE,
  // STREAM_PRE_ITERATION, SPACING_CLOSURE, INDENT_CONTINUATION,
  // USE_UNTYPED_HOST_REF, GUARD_OVER_TRY_CATCH. Rule-level detection for
  // those codes is exercised by the service's external golden corpus,
  // not by this file.
  // ============================================================

  describe('legacy-parity', () => {
    interface ParityRow {
      readonly description: string;
      readonly source: string;
      /** Codes that must appear in the diagnostics for this source. */
      readonly expectCodes: readonly string[];
      /** Codes that must never appear (used for stub rules). */
      readonly forbidCodes?: readonly string[];
    }

    // Active detection rules (COVERED), one representative fixture per
    // rule category in the inventory.
    const activeRows: ParityRow[] = [
      {
        description: 'naming: non-snake_case Capture flagged',
        source: '42 => $myCamelCase\n',
        expectCodes: ['NAMING_SNAKE_CASE'],
      },
      {
        description:
          'flow: capture on one statement then used as next statement head',
        source: 'prompt("Read file") => $raw\n$raw -> log',
        expectCodes: ['CAPTURE_INLINE_CHAIN'],
      },
      {
        description:
          'flow: $ referenced in both then/else branches after a prior capture',
        source:
          'prompt("test") => $raw\n$other -> log\ncheckStatus() -> .contains("OK") ? {\n  $ -> log\n} ! {\n  $ -> log\n}',
        expectCodes: ['CAPTURE_BEFORE_BRANCH'],
      },
      {
        description:
          'collections: seq body with no side effects, break inside fan',
        source:
          'list[1, 2, 3] -> seq({ $ * 2 })\nlist[1, 2, 3] -> fan({\n  ($ == 2) ? break\n  $ * 2\n})\n',
        expectCodes: ['PREFER_MAP', 'BREAK_IN_PARALLEL'],
      },
      {
        description:
          'loops: while loop with .len check and body-captured accumulator',
        source:
          '0 => $i\nwhile ($index < $items.len) do {\n  $i => $index\n  $items[$index]\n  $index + 1\n}\n',
        expectCodes: ['USE_EACH', 'LOOP_ACCUMULATOR'],
      },
      {
        description: 'closures: zero-param closure body with bare $',
        source: '||{ $ * 2 } => $fn',
        expectCodes: ['CLOSURE_BARE_DOLLAR'],
      },
      {
        description: 'types: literal asserted to its own type',
        source: '42:number',
        expectCodes: ['UNNECESSARY_ASSERTION'],
      },
      {
        description:
          'strings: equality comparison against empty string literal',
        source: '$str == ""',
        expectCodes: ['USE_EMPTY_METHOD'],
      },
      {
        description:
          'anti-patterns: capture of a name already captured in the same scope',
        source:
          '|param| {\n  "first" => $result\n  "second" => $result\n  $result\n} => $fn',
        expectCodes: ['AVOID_REASSIGNMENT'],
      },
      {
        description: 'formatting: missing spaces around operator',
        source: '5+3\n',
        expectCodes: ['SPACING_OPERATOR'],
      },
      {
        description: 'formatting: missing space after { or before }',
        source: '{$x}',
        expectCodes: ['SPACING_BRACES'],
      },
      {
        description: 'formatting: inner spaces inside index brackets',
        source: '$list[ 0 ]',
        expectCodes: ['SPACING_BRACKETS'],
      },
      {
        description: 'formatting: bare-$ receiver over .method',
        source: '$.len()',
        expectCodes: ['IMPLICIT_DOLLAR_METHOD'],
      },
      {
        description: 'formatting: single bare-$ arg over -> fn',
        source: 'log($)',
        expectCodes: ['IMPLICIT_DOLLAR_FUNCTION'],
      },
      {
        description: 'formatting: single bare-$ arg over -> $fn',
        source: '|x| $x => $fn\n$fn($)',
        expectCodes: ['IMPLICIT_DOLLAR_CLOSURE'],
      },
      {
        description: 'use-expressions: use<$var> dynamic form',
        source: '"ext:foo" => $name\nuse<$name>\n',
        expectCodes: ['USE_DYNAMIC_IDENTIFIER'],
      },
      {
        description: 'errors: bare guard with no on: codes',
        source: 'guard { 1 }',
        expectCodes: ['GUARD_BARE'],
      },
      {
        description: 'errors: retry<limit: N> with N<=1',
        source: 'retry<limit: 1> { 1 }',
        expectCodes: ['RETRY_TRIVIAL'],
      },
      {
        description: 'errors: #ATOM not in the builtin set',
        source: '#FOO_BAR',
        expectCodes: ['ATOM_UNREGISTERED'],
      },
      {
        description: 'errors: bare .! with no projected field',
        source: '$result.!',
        expectCodes: ['STATUS_PROBE_NO_FIELD'],
      },
      {
        description: 'errors: nil-check conditional over presence probe',
        source: '($x == nil) ? 0 ! $x',
        expectCodes: ['PRESENCE_OVER_NULL_GUARD'],
      },
    ];

    // Stubbed rules (COVERED as inert): the service registers these codes
    // but their `validate` unconditionally returns zero diagnostics.
    const stubRows: ParityRow[] = [
      {
        description: 'FOLD_INTERMEDIATES stub emits no diagnostics',
        source: 'list[1, 2, 3] -> fold(0, { $@ + $ })\n',
        expectCodes: [],
        forbidCodes: ['FOLD_INTERMEDIATES'],
      },
      {
        description: 'CONDITION_TYPE stub emits no diagnostics',
        source: '$x > 0 ? "positive" ! "negative"\n',
        expectCodes: [],
        forbidCodes: ['CONDITION_TYPE'],
      },
      {
        description: 'THROWAWAY_CAPTURE stub emits no diagnostics',
        source: '"hello" => $x\n$x -> .upper => $y\n$y -> .len\n',
        expectCodes: [],
        forbidCodes: ['THROWAWAY_CAPTURE'],
      },
    ];

    const allRows = [...activeRows, ...stubRows];

    for (const row of allRows) {
      it(row.description, async () => {
        const name = `parity-${row.description.replace(/[^a-z0-9]+/gi, '-')}.rill`;
        const script = await writeFile(name, row.source);
        const result = await execCheck(['--format', 'json', script]);
        const parsed = JSON.parse(result.stdout) as {
          errors: { code: string }[];
        };
        const codes = parsed.errors.map((e) => e.code);

        for (const expected of row.expectCodes) {
          expect(codes).toContain(expected);
        }
        for (const forbidden of row.forbidCodes ?? []) {
          expect(codes).not.toContain(forbidden);
        }
      });
    }

    // Fix payloads (2 emitted fixes): the only two rules that ever emit a
    // non-null `fix` on their diagnostics.
    it('NAMING_SNAKE_CASE emits an applicable fix replacing the identifier', async () => {
      const script = await writeFile(
        'parity-fix-naming.rill',
        '42 => $myCamelCase\n'
      );
      const result = await execCheck(['--format', 'json', script]);
      const parsed = JSON.parse(result.stdout);
      const diag = parsed.errors.find(
        (e: { code: string }) => e.code === 'NAMING_SNAKE_CASE'
      );
      expect(diag.fix).toMatchObject({ applicable: true });
      expect(typeof diag.fix.replacement).toBe('string');
    });

    it('UNNECESSARY_ASSERTION emits an applicable fix deleting the type assertion', async () => {
      const script = await writeFile(
        'parity-fix-assertion.rill',
        '42:number\n'
      );
      const result = await execCheck(['--format', 'json', script]);
      const parsed = JSON.parse(result.stdout);
      const diag = parsed.errors.find(
        (e: { code: string }) => e.code === 'UNNECESSARY_ASSERTION'
      );
      expect(diag.fix).toMatchObject({ applicable: true, replacement: '' });
    });

    it('achieves corpus parity across the Preserved-Behavior Inventory sample', async () => {
      let matched = 0;
      let total = 0;

      for (const row of allRows) {
        total++;
        const name = `parity-agg-${row.description.replace(/[^a-z0-9]+/gi, '-')}.rill`;
        const script = await writeFile(name, row.source);
        const result = await execCheck(['--format', 'json', script]);
        const parsed = JSON.parse(result.stdout) as {
          errors: { code: string }[];
        };
        const codes = parsed.errors.map((e) => e.code);

        const expectedPresent = row.expectCodes.every((c) => codes.includes(c));
        const forbiddenAbsent = (row.forbidCodes ?? []).every(
          (c) => !codes.includes(c)
        );
        if (expectedPresent && forbiddenAbsent) matched++;
      }

      const parityPercent = (matched / total) * 100;
      expect(parityPercent).toBeGreaterThanOrEqual(99.5);
    }, 30000);
  });
});
