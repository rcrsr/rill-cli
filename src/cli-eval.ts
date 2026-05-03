/**
 * Rill CLI - Evaluate rill expressions
 *
 * Usage:
 *   rill-eval '"hello".len'
 *   rill-eval --help
 *   rill-eval --version
 */

import {
  createRuntimeContext,
  execute,
  isInvalid,
  parse,
  toNative,
  type ExecutionResult,
} from '@rcrsr/rill';
import {
  determineExitCode,
  formatStatus,
  VERSION,
  CLI_VERSION,
  detectHelpVersionFlag,
} from './cli-shared.js';

/**
 * Parse command-line arguments into structured command
 */
function parseArgs(
  argv: string[]
):
  | { mode: 'exec'; file: string; args: string[] }
  | { mode: 'eval'; expression: string }
  | { mode: 'help' | 'version' } {
  // Check for --help and --version in any position (supports -h/-v shorthands)
  const helpVersionFlag = detectHelpVersionFlag(argv);
  if (helpVersionFlag !== null) {
    return helpVersionFlag;
  }

  // Check for unknown flags (anything starting with -)
  const knownFlags = new Set(['--help', '-h', '--version', '-v']);
  for (const arg of argv) {
    if (arg.startsWith('-') && arg !== '-' && !knownFlags.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  // If no arguments, default to help
  if (argv.length === 0) {
    return { mode: 'help' };
  }

  // First positional arg determines mode
  const firstArg = argv[0]!;

  // Eval mode: direct expression
  return { mode: 'eval', expression: firstArg };
}

/**
 * Evaluate a Rill expression without file context
 */
export async function evaluateExpression(
  expression: string
): Promise<ExecutionResult> {
  const ctx = createRuntimeContext({
    callbacks: {
      onLog: (msg) => console.log(msg),
    },
  });

  // Set pipeValue to empty list (Rill has no null concept per language spec)
  ctx.pipeValue = [];

  const ast = parse(expression);
  return execute(ast, ctx);
}

/**
 * Display help information
 */
function showHelp(): void {
  process.stdout.write(`Rill Expression Evaluator

Usage:
  rill eval <expression>      Evaluate a Rill expression
  rill eval -h, --help        Show this help message
  rill eval -v, --version     Show version information

Examples:
  rill eval '"hello".len'
  rill eval '5 + 3'
  rill eval '[1, 2, 3] -> map |x|($x * 2)'\n`);
}

/**
 * Display version information
 */
function showVersion(): void {
  process.stdout.write(`rill-eval ${CLI_VERSION} (rill ${VERSION})\n`);
}

/**
 * Entry point for rill-eval binary
 */
export async function main(argv: string[]): Promise<number> {
  try {
    const command = parseArgs(argv);

    if (command.mode === 'help') {
      showHelp();
      return 0;
    }

    if (command.mode === 'version') {
      showVersion();
      return 0;
    }

    if (command.mode === 'eval') {
      const result = await evaluateExpression(command.expression);

      if (isInvalid(result.result)) {
        process.stderr.write(formatStatus(result.result) + '\n');
        return 1;
      }

      const nativeResult = toNative(result.result);
      const { code, message } = determineExitCode(nativeResult.value);

      if (message !== undefined) {
        console.log(message);
      } else {
        console.log(JSON.stringify(nativeResult, null, 2));
      }
      return code;
    }

    // Unreachable - exec mode not supported in rill-eval
    console.error('Unexpected command mode');
    return 1;
  } catch (err) {
    process.stderr.write(
      (err instanceof Error ? err.message : String(err)) + '\n'
    );
    return 1;
  }
}
