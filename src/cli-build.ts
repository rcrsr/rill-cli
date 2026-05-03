import { buildPackage } from './build/build.js';
import { detectHelpVersionFlag } from './cli-shared.js';

const HELP_TEXT = `Usage: rill build [options] [project-dir]

Arguments:
  project-dir               Directory containing rill-config.json (default: cwd)

Options:
  --output <dir>            Output directory (default: build/)
  -h, --help                Show this help message
`;

export async function main(argv: string[]): Promise<number> {
  const helpVersion = detectHelpVersionFlag(argv);
  if (helpVersion !== null && helpVersion.mode === 'help') {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  // Reject unknown flags
  const knownFlags = new Set(['--output', '--help', '-h']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg && arg.startsWith('-')) {
      if (!knownFlags.has(arg)) {
        process.stderr.write(`Error: Unknown option: ${arg}\n`);
        return 1;
      }
      // Skip --output value, validating it exists and is not a flag
      if (arg === '--output') {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          process.stderr.write(`Error: --output requires a value\n`);
          return 1;
        }
        i++;
      }
    }
  }

  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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

  const outputIdx = argv.indexOf('--output');
  const outputDir =
    outputIdx !== -1 &&
    argv[outputIdx + 1] !== undefined &&
    !argv[outputIdx + 1]!.startsWith('-')
      ? argv[outputIdx + 1]
      : undefined;

  try {
    const result = await buildPackage(projectDir, {
      ...(outputDir !== undefined ? { outputDir } : {}),
    });
    process.stdout.write(`${result.outputPath}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    return 1;
  }

  return 0;
}
