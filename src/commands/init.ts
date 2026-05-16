/**
 * rill init: Dispatcher for rill project initialization subcommands.
 *
 * Routes to bundle-init or package-init based on the first positional argument.
 * When no subcommand is given, scaffolds a single-package rill project at cwd,
 * producing the same artifacts as `rill bootstrap`.
 */

import { parseArgs } from 'node:util';
import { run as bundleInitRun } from './bundle-init.js';
import { run as packageInitRun } from './package-init.js';
import { scaffoldSinglePackage } from './bootstrap.js';

// ============================================================
// HELP TEXT
// ============================================================

const USAGE = `\
Usage: rill init [subcommand] [options]

Initialize a rill project at the current directory, or scaffold a bundle/package.

Subcommands:
  bundle [name]    Scaffold a rill bundle. Creates rill-bundle.json, .rill/npm/,
                   and packages/ at cwd. Name defaults to cwd basename when omitted.
  package <name>   Scaffold a rill package. When run inside a bundle, the package
                   is created in <bundleRoot>/packages/<name>/ and appended to
                   rill-bundle.json. Otherwise scaffolds at <cwd>/<name>/.

Bare form:
  rill init        Scaffold a single-package project at cwd. Equivalent to
                   'rill bootstrap'. Supports --force and --reset flags.

Options (bare form only):
  --force     Overwrite rill-config.json. .rill/npm/ contents are preserved.
  --reset     Wipe .rill/npm/ entirely and rewrite all scaffolded files.
  --help, -h  Show this help message
`;

// ============================================================
// DISPATCHER
// ============================================================

/**
 * Dispatch `rill init` subcommands: bundle, package, or bare single-package scaffold.
 */
export async function run(argv: string[]): Promise<number> {
  const subcommand = argv[0];

  if (subcommand === 'bundle') {
    return bundleInitRun(argv.slice(1));
  }

  if (subcommand === 'package') {
    return packageInitRun(argv.slice(1));
  }

  if (subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }

  // Bare `rill init` — single-package scaffold. Parse --force, --reset, --help flags.
  const { values } = parseArgs({
    args: argv,
    options: {
      force: { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: false,
  });

  if (values['help'] === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const force = values['force'] === true;
  const reset = values['reset'] === true;

  if (force && reset) {
    process.stderr.write(
      'error: --force and --reset are mutually exclusive. ' +
        'Use --force to overwrite rill-config.json only, ' +
        'or --reset to wipe .rill/npm/ and rewrite all files.\n'
    );
    return 1;
  }

  return scaffoldSinglePackage(process.cwd(), force, reset);
}
