/**
 * Configuration Loader for rill check (adapter layer)
 * Reads and parses `.rill-check.json`, delegating structure and rule-code
 * validation to `@rcrsr/rill-language-service`, and builds the resolved
 * config plus the per-rule severity map the overlay needs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RULES,
  createDefaultConfig,
  validateConfig,
  validateRuleCodes,
} from '@rcrsr/rill-language-service/rules';
import type {
  CheckConfig,
  DiagnosticSeverity,
  RuleState,
  ValidationError,
} from '@rcrsr/rill-language-service/rules';

// ============================================================
// CONSTANTS
// ============================================================

/** Configuration file name. */
const CONFIG_FILE_NAME = '.rill-check.json';

// ============================================================
// PUBLIC TYPES
// ============================================================

/**
 * Adapter composite returned by `loadConfig`. Carries the service config
 * plus the per-rule severity map the overlay needs, since the service's
 * `CheckConfig.severity` is a single optional global override rather than
 * a per-rule map.
 */
export interface ResolvedCheckConfig {
  readonly config: CheckConfig;
  readonly severityMap: Record<string, DiagnosticSeverity>;
}

// ============================================================
// INTERNAL TYPES
// ============================================================

interface ParsedRillCheckConfig {
  readonly rules?: Record<string, unknown> | undefined;
  readonly severity?: Record<string, unknown> | undefined;
}

// ============================================================
// HELPERS
// ============================================================

function formatValidationErrors(errors: readonly ValidationError[]): string {
  return errors.map((error) => error.message).join('; ');
}

// ============================================================
// CONFIGURATION LOADING
// ============================================================

/**
 * Load configuration from `.rill-check.json` in the specified directory.
 *
 * @param cwd - Directory to search for the configuration file
 * @returns Resolved config and severity map, or `null` if the file is absent
 * @throws Error prefixed `[RILL-C003]` for malformed JSON or a config that
 *   fails service-side structure/rule-code validation
 */
export function loadConfig(cwd: string): ResolvedCheckConfig | null {
  const configPath = join(cwd, CONFIG_FILE_NAME);

  if (!existsSync(configPath)) {
    return null;
  }

  let fileContent: string;
  try {
    fileContent = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `[RILL-C003]: failed to read configuration file (${err instanceof Error ? err.message : String(err)})`,
      { cause: err }
    );
  }

  let parsedData: unknown;
  try {
    parsedData = JSON.parse(fileContent);
  } catch (err) {
    throw new Error(
      `[RILL-C003]: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
      { cause: err }
    );
  }

  if (
    typeof parsedData !== 'object' ||
    parsedData === null ||
    Array.isArray(parsedData)
  ) {
    throw new Error('[RILL-C003]: config must be an object');
  }

  const parsed = parsedData as ParsedRillCheckConfig | null | undefined;

  const rulesErrors = validateConfig({
    rules: (parsed?.rules ?? {}) as Record<string, RuleState>,
  });
  if (rulesErrors !== null) {
    throw new Error(`[RILL-C003]: ${formatValidationErrors(rulesErrors)}`);
  }

  const severityBlock = parsed?.severity ?? {};

  const severityCodeErrors = validateRuleCodes(Object.keys(severityBlock));
  if (severityCodeErrors !== null) {
    throw new Error(
      `[RILL-C003]: ${formatValidationErrors(severityCodeErrors)}`
    );
  }

  for (const [code, value] of Object.entries(severityBlock)) {
    const severityErrors = validateConfig({
      rules: {},
      severity: value as DiagnosticSeverity,
    });
    if (severityErrors !== null) {
      throw new Error(
        `[RILL-C003]: rule ${code} has invalid severity: ${String(value)}`
      );
    }
  }

  const defaults = createDefaultConfig();
  const rules: Record<string, RuleState> = {
    ...defaults.rules,
    ...(parsed?.rules as Record<string, RuleState> | undefined),
  };

  const config: CheckConfig = { rules };

  const severityMap: Record<string, DiagnosticSeverity> = {};
  for (const rule of RULES) {
    severityMap[rule.code] = rule.defaultSeverity;
  }
  for (const [code, value] of Object.entries(severityBlock)) {
    severityMap[code] = value as DiagnosticSeverity;
  }

  return { config, severityMap };
}
