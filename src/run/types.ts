/**
 * Type definitions for rill-run.
 */

// ============================================================
// CLI TYPES
// ============================================================

/**
 * Parsed CLI options from process.argv.
 */
export interface RunCliOptions {
  readonly scriptPath?: string | undefined;
  readonly scriptArgs: string[];
  readonly config: string;
  readonly format: 'human' | 'json' | 'compact';
  readonly verbose: boolean;
  readonly maxStackDepth: number;
  readonly explain?: string | undefined;
  readonly createBindings?: string | undefined;
  readonly trace?: 'auto' | 'always' | 'never';
  readonly showRecovered?: boolean;
  readonly atomOnly?: boolean;
}
