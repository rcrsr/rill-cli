#!/usr/bin/env node
/**
 * Unified rill CLI entry point.
 * Parses argv[0] as the subcommand name and dispatches to the matching handler.
 * With no subcommand, prints UXT-EXT-11 help and exits 0.
 *
 * Constraints:
 * - Dispatch overhead < 100ms before subcommand body executes (NFR-EXT-5).
 * - `rill help <cmd>` and `rill <cmd> --help` produce equivalent output (FR-EXT-8).
 * - Unknown subcommand: exit 1, error message names the subcommand, prints help hint.
 */

import { parseArgs } from 'node:util';
import { printHelp } from './commands/help.js';
import { CLI_VERSION, VERSION, checkNodeVersion } from './cli-shared.js';
import { run as bootstrapRun } from './commands/bootstrap.js';
import { run as installRun } from './commands/install.js';
import { run as uninstallRun } from './commands/uninstall.js';
import { run as upgradeRun } from './commands/upgrade.js';
import { run as listRun } from './commands/list.js';
import { main as buildMain } from './cli-build.js';
import { main as checkMain } from './cli-check.js';
import { main as describeMain } from './cli-describe.js';
import { main as evalMain } from './cli-eval.js';
import { main as execMain } from './cli-exec.js';
import { main as runMain } from './cli-run.js';

// ============================================================
// DISPATCH TABLE
// ============================================================

type CommandHandler = (argv: string[]) => Promise<number>;

const PHASE2_COMMANDS: Record<string, CommandHandler> = {
  bootstrap: bootstrapRun,
  install: installRun,
  uninstall: uninstallRun,
  upgrade: upgradeRun,
  list: listRun,
};

const PHASE3_COMMANDS: Record<string, CommandHandler> = {
  build: buildMain,
  check: checkMain,
  describe: describeMain,
  eval: evalMain,
  exec: execMain,
  run: runMain,
};

// ============================================================
// MAIN
// ============================================================

/**
 * Unified rill CLI entry point.
 * @param argv - Raw command-line arguments (typically process.argv.slice(2))
 * @returns Exit code (0 = success, 1 = error)
 */
export async function main(argv: string[]): Promise<number> {
  // Fail fast on unsupported Node versions before any subcommand work.
  // engines.node in package.json is the source of truth for the minimum.
  const nodeError = checkNodeVersion();
  if (nodeError !== null) {
    process.stderr.write(`${nodeError}\n`);
    return 1;
  }

  // Extract positionals and named flags
  const { positionals } = parseArgs({
    args: argv,
    strict: false,
    allowPositionals: true,
  });

  const subcommand = positionals[0];

  // --version / -v is a single CLI-wide flag handled by the dispatcher,
  // regardless of whether a subcommand follows.
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`rill-cli ${CLI_VERSION} (runtime ${VERSION})\n`);
    return 0;
  }

  // No subcommand → show top-level help.
  // `rill <cmd> --help` and `rill help <cmd>` still produce identical output (FR-EXT-8).
  if (subcommand === undefined) {
    printHelp(process.stdout);
    return 0;
  }

  // `rill help` and `rill help <cmd>`
  if (subcommand === 'help') {
    const helpTarget = positionals[1];
    if (helpTarget === undefined) {
      printHelp(process.stdout);
      return 0;
    }
    // rill help <cmd> → equivalent to rill <cmd> --help (FR-EXT-8)
    return dispatchSubcommand(helpTarget, ['--help']);
  }

  return dispatchSubcommand(subcommand, argv.slice(1));
}

/**
 * Look up and invoke a subcommand handler.
 * @param name - Subcommand name
 * @param subArgv - Arguments passed to the subcommand
 * @returns Exit code
 */
function dispatchSubcommand(name: string, subArgv: string[]): Promise<number> {
  const phase2Handler = PHASE2_COMMANDS[name];
  if (phase2Handler !== undefined) {
    return phase2Handler(subArgv);
  }

  const phase3Handler = PHASE3_COMMANDS[name];
  if (phase3Handler !== undefined) {
    return phase3Handler(subArgv);
  }

  process.stderr.write(
    `Unknown command: ${name}. Run 'rill --help' for available commands.\n`
  );
  return Promise.resolve(1);
}

// ============================================================
// ENTRY
// ============================================================

// Guard against running during tests (matches repo convention)
const shouldRunMain =
  process.env['NODE_ENV'] !== 'test' &&
  !process.env['VITEST'] &&
  !process.env['VITEST_WORKER_ID'];

if (shouldRunMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Fatal: ${msg}\n`);
      process.exit(1);
    });
}
