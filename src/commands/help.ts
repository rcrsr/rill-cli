import type { Writable } from 'node:stream';

const HELP_LINES: readonly string[] = [
  'Usage: rill <command> [options]',
  '',
  'Project setup',
  'bootstrap            Initialize a new rill project (.rill/npm/, rill-config.json)',
  '',
  'Extension management',
  'install <pkg>        Install an extension into .rill/npm/ and mount it',
  'uninstall <mount>    Remove a mounted extension',
  'upgrade <mount>      Update a mounted extension to a newer version',
  'list                 List installed extensions and their mount paths',
  '',
  'Build & run',
  'build                Bundle the project for production',
  'check                Validate rill-config.json and source files',
  'describe             Print callable contracts (handler signatures)',
  'eval <expr>          Evaluate a rill expression and print the result',
  'exec <file>          Execute a rill script file or stdin input',
  'run <handler>        Execute a handler against the loaded project',
  '',
  "Run 'rill help <command>' or 'rill <command> --help' for details.",
];

export function printHelp(stream: Writable = process.stdout): void {
  for (const line of HELP_LINES) {
    stream.write(line + '\n');
  }
}
