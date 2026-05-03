/**
 * rill list: Display all installed extension mounts.
 *
 * Constraints (FR-EXT-7, UXI-EXT-7, UXT-EXT-12):
 * - Pre-check: rill-config.json exists (EC-22)
 * - --json mode: also requires .rill/npm/package.json (EC-23)
 * - Output rows equal Object.keys(extensions.mounts).length (NFR-EXT-8)
 * - File I/O < 500ms (NFR-EXT-4)
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolvePrefix } from './prefix.js';
import { readConfigSnapshot, ConfigNotFoundError } from './config-edit.js';
import {
  extractPackageName,
  isLocalPath,
  isLocalFilePath,
} from './mount-derive.js';

// ============================================================
// HELP TEXT
// ============================================================

const USAGE = `\
Usage: rill list [--json]

List all extension mounts registered in rill-config.json.

Options:
  --json   Output as JSON array
  --help   Show this help message
`;

// ============================================================
// COLUMN WIDTHS (UXT-EXT-12)
// ============================================================

// Verbatim header from spec: 'MOUNT      PACKAGE                          VERSION   SOURCE'
// Derived widths: MOUNT=11, PACKAGE=33, VERSION=10
const COL_MOUNT_MIN = 11;
const COL_PACKAGE_MIN = 33;
const COL_VERSION_MIN = 10;

// ============================================================
// TYPES
// ============================================================

interface MountRow {
  mount: string;
  specifier: string;
  version: string | null; // null for local-path in JSON; 'n/a' or 'unknown' in human
  source: 'registry' | 'local' | 'local-file';
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Try to read the installed version from node_modules/<pkgName>/package.json.
 * Returns the version string on success, 'unknown' on any failure (EC-25).
 */
function readInstalledVersion(prefix: string, pkgName: string): string {
  const pkgJsonPath = path.join(
    prefix,
    'node_modules',
    pkgName,
    'package.json'
  );
  try {
    const text = fs.readFileSync(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(text) as { version?: string };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Pad a string to the given minimum width (left-aligned).
 * If the value exceeds minWidth, returns value as-is (column expands).
 */
function padCol(value: string, minWidth: number): string {
  return value.length >= minWidth
    ? value
    : value + ' '.repeat(minWidth - value.length);
}

// ============================================================
// IMPLEMENTATION
// ============================================================

/**
 * List all extension mounts from rill-config.json.
 *
 * Implements FR-EXT-7, UXT-EXT-12, UXI-EXT-7, EC-22..EC-25.
 */
export async function run(argv: string[]): Promise<number> {
  // ---- Argument parsing ----
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: false,
  });

  if (values['help'] === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const jsonMode = values['json'] === true;
  const projectDir = process.cwd();
  const prefix = resolvePrefix(projectDir);

  // ---- Step 1: Read config snapshot (EC-22) ----
  let snapshot: Awaited<ReturnType<typeof readConfigSnapshot>>;
  try {
    snapshot = await readConfigSnapshot(projectDir);
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      process.stderr.write("Run 'rill bootstrap' first\n");
      return 1;
    }
    throw err;
  }

  // ---- Step 2: --json mode requires .rill/npm/ (EC-23) ----
  if (jsonMode) {
    const prefixPkgJson = path.join(prefix, 'package.json');
    if (!fs.existsSync(prefixPkgJson)) {
      process.stderr.write("Run 'rill bootstrap' first\n");
      return 1;
    }
  }

  // ---- Step 3: Build mount entries preserving insertion order ----
  const mounts = snapshot.parsed.extensions?.mounts ?? {};
  const mountEntries = Object.entries(mounts);

  const rows: MountRow[] = mountEntries.map(([mount, specifier]) => {
    const local = isLocalPath(specifier);
    const localFile = isLocalFilePath(specifier);
    const source: MountRow['source'] = localFile
      ? 'local-file'
      : local
        ? 'local'
        : 'registry';

    let version: string | null;
    if (local) {
      // Local-path (file or dir): no installed version to read (EC-25 / UXC-EXT-2)
      version = null;
    } else {
      const pkgName = extractPackageName(specifier);
      const installed = readInstalledVersion(prefix, pkgName);
      version = installed; // 'unknown' on read failure (EC-25)
    }

    return { mount, specifier, version, source };
  });

  // ---- Step 4/5: Empty mounts handling (EC-24) ----
  if (jsonMode) {
    if (rows.length === 0) {
      process.stdout.write('[]\n');
      return 0;
    }

    // UXI-EXT-7: serialize with 2-space indent + trailing newline
    // [ASSUMPTION] JSON indent: 2-space chosen to match spec example (UXI-EXT-7)
    // [ASSUMPTION] Unreadable registry package.json -> "unknown" string (not null)
    //   for consistency with human mode output. Spec does not pin the JSON value.
    const jsonRows = rows.map(({ mount, specifier, version, source }) => ({
      mount,
      specifier,
      version: source === 'local' || source === 'local-file' ? null : version,
      source,
    }));
    process.stdout.write(JSON.stringify(jsonRows, null, 2) + '\n');
    return 0;
  }

  // ---- Human mode ----
  // Compute column widths: at least the verbatim header widths, expand if data is wider.
  // [ASSUMPTION] Column widths: use verbatim header widths as defaults; expand when
  //   any data row entry (plus 2-space separator) would exceed the header width.
  //   This satisfies UXT-EXT-12 verbatim and UXC-EXT-2 auto-expand requirement.
  let mountWidth = COL_MOUNT_MIN;
  let packageWidth = COL_PACKAGE_MIN;
  let versionWidth = COL_VERSION_MIN;

  for (const row of rows) {
    const pkg =
      row.source === 'registry'
        ? extractPackageName(row.specifier)
        : row.specifier;
    const ver = row.version === null ? 'n/a' : row.version;
    if (row.mount.length + 2 > mountWidth) mountWidth = row.mount.length + 2;
    if (pkg.length + 2 > packageWidth) packageWidth = pkg.length + 2;
    if (ver.length + 2 > versionWidth) versionWidth = ver.length + 2;
    if (row.source.length + 2 > 12) {
      // SOURCE column is the last; no fixed width but ensure source label fits
    }
  }

  const header = `${padCol('MOUNT', mountWidth)}${padCol('PACKAGE', packageWidth)}${padCol('VERSION', versionWidth)}SOURCE`;
  process.stdout.write(header + '\n');

  if (rows.length === 0) {
    // EC-24: empty mounts — header + footer only
    process.stdout.write('0 extensions installed.\n');
    return 0;
  }

  for (const row of rows) {
    const pkg =
      row.source === 'registry'
        ? extractPackageName(row.specifier)
        : row.specifier;
    const ver = row.version === null ? 'n/a' : row.version;
    const line = `${padCol(row.mount, mountWidth)}${padCol(pkg, packageWidth)}${padCol(ver, versionWidth)}${row.source}`;
    process.stdout.write(line + '\n');
  }

  process.stdout.write(`${rows.length} extensions installed.\n`);
  return 0;
}
