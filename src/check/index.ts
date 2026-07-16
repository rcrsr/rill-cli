/**
 * Check Module - Static Analysis for rill
 * Public API for rill-check tool.
 */

// ============================================================
// PUBLIC TYPES
// ============================================================
export type { Severity, Diagnostic } from './types.js';

// ============================================================
// RULE REGISTRY
// ============================================================
export { VALIDATION_RULES } from './rules/index.js';

// ============================================================
// CONFIGURATION
// ============================================================
export { loadConfig, createDefaultConfig } from './config.js';

// ============================================================
// VALIDATION
// ============================================================
export { validateScript } from './validator.js';

// ============================================================
// FIX APPLICATION
// ============================================================
export { applyFixes } from './fixer.js';
