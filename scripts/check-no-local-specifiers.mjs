#!/usr/bin/env node
/**
 * Fails when package.json dependency sections contain link:/file: specifiers.
 *
 * Intended for prepublishOnly only. link:/file: specifiers are expected during
 * local development (see README/CLAUDE notes on the workspace linking setup);
 * this guard exists to stop a publish from shipping them.
 *
 * Usage:
 *   node scripts/check-no-local-specifiers.mjs [packageJsonPath]
 *
 * Exit codes:
 *   0 - no link:/file: specifiers found
 *   1 - one or more link:/file: specifiers found (printed to stderr)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

const LOCAL_SPECIFIER_PATTERN = /^(link:|file:)/;

function main(argv) {
  const packageJsonPath = argv[0] ?? path.join(process.cwd(), 'package.json');

  const raw = fs.readFileSync(packageJsonPath, 'utf-8');
  const pkg = JSON.parse(raw);

  const violations = [];

  for (const section of SECTIONS) {
    const deps = pkg[section];
    if (!deps || typeof deps !== 'object') {
      continue;
    }

    for (const [name, specifier] of Object.entries(deps)) {
      if (
        typeof specifier === 'string' &&
        LOCAL_SPECIFIER_PATTERN.test(specifier)
      ) {
        violations.push({ section, name, specifier });
      }
    }
  }

  if (violations.length > 0) {
    for (const { section, name, specifier } of violations) {
      process.stderr.write(`${section}.${name}: ${specifier}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
}

main(process.argv.slice(2));
