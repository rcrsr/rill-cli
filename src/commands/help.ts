import type { Writable } from 'node:stream';

const HELP_LINES: readonly string[] = [
  'Usage: rill <command> [options]',
  '',
  'Project setup',
  'init                 Initialize a rill project, package, or bundle',
  '',
  'Extension management',
  'install <pkg>        Install an extension into .rill/npm/ and mount it',
  'uninstall <mount>    Remove a mounted extension',
  'upgrade <mount>      Update a mounted extension to a newer version',
  'list                 List installed extensions and their mount paths',
  '',
  'Build & run',
  'build                Bundle the project or bundle for production',
  'check                Validate rill-config.json and source files',
  'describe             Print callable contracts (handler signatures)',
  'eval <expr>          Evaluate a rill expression and print the result',
  'exec <file>          Execute a rill script file or stdin input',
  'run [project-dir]    Execute the project entry, or serve a bundle',
  '',
  "Run 'rill help <command>' or 'rill <command> --help' for details.",
];

export function printHelp(stream: Writable = process.stdout): void {
  for (const line of HELP_LINES) {
    stream.write(line + '\n');
  }
}
