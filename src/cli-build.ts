#!/usr/bin/env node
import { buildAgent } from './build/build.js';
import { detectHelpVersionFlag, VERSION, CLI_VERSION } from './cli-shared.js';

const HELP_TEXT = `Usage: rill-build [options] [project-dir]

Arguments:
  project-dir               Directory containing rill-config.json (default: cwd)

Options:
  --output <dir>            Output directory (default: build/)
  -h, --help                Show this help message
  -v, --version             Show version information
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const helpVersion = detectHelpVersionFlag(args);
  if (helpVersion !== null) {
    if (helpVersion.mode === 'help') {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    }
    if (helpVersion.mode === 'version') {
      process.stdout.write(`rill-build ${CLI_VERSION} (rill ${VERSION})\n`);
      process.exit(0);
    }
  }

  // Reject unknown flags
  const knownFlags = new Set(['--output', '--help', '-h', '--version', '-v']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg && arg.startsWith('-')) {
      if (!knownFlags.has(arg)) {
        process.stderr.write(`Error: Unknown option: ${arg}\n`);
        process.exit(1);
      }
      // Skip --output value, validating it exists and is not a flag
      if (arg === '--output') {
        const next = args[i + 1];
        if (next === undefined || next.startsWith('-')) {
          process.stderr.write(`Error: --output requires a value\n`);
          process.exit(1);
        }
        i++;
      }
    }
  }

  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output') {
      i++; // skip value
    } else if (arg && !arg.startsWith('-')) {
      positionals.push(arg);
    }
  }

  const projectDir =
    positionals[0] !== undefined && positionals[0] !== ''
      ? positionals[0]
      : process.cwd();

  const outputIdx = args.indexOf('--output');
  const outputDir =
    outputIdx !== -1 &&
    args[outputIdx + 1] !== undefined &&
    !args[outputIdx + 1]!.startsWith('-')
      ? args[outputIdx + 1]
      : undefined;

  try {
    const result = await buildAgent(projectDir, {
      ...(outputDir !== undefined ? { outputDir } : {}),
    });
    process.stdout.write(`${result.outputPath}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }
}

const shouldRunMain =
  process.env['NODE_ENV'] !== 'test' &&
  !process.env['VITEST'] &&
  !process.env['VITEST_WORKER_ID'];

if (shouldRunMain) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal: ${msg}\n`);
    process.exit(1);
  });
}
