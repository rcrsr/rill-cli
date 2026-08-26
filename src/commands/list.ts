/**
 * rill list: Display all installed extension mounts.
 *
 * Constraints:
 * - Pre-check: rill-config.json exists
 * - --json mode: also requires .rill/npm/package.json
 * - Output rows equal Object.keys(extensions.mounts).length
 * - File I/O < 500ms
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolvePrefix } from './prefix.js';
import {
  readConfigSnapshot,
  readInstalledPackageVersion,
  ConfigNotFoundError,
} from './config-edit.js';
import {
  extractPackageName,
  isLocalPath,
  looksLikeLocalFilePath,
} from './mount-derive.js';
import {
  findBundleRoot,
  readBundleConfig,
  BundleConfigError,
  type ResolvedRillBundleConfig,
} from '../bundle/config.js';

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
// COLUMN WIDTHS
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
 * Returns the version string on success, 'unknown' on any failure.
 */
function readInstalledVersion(prefix: string, pkgName: string): string {
  return readInstalledPackageVersion(prefix, pkgName) ?? 'unknown';
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

/**
 * Build MountRow entries from a mounts record, preserving insertion order.
 * Reads installed versions from `prefix` for registry specifiers.
 */
function buildRows(prefix: string, mounts: Record<string, string>): MountRow[] {
  return Object.entries(mounts).map(([mount, specifier]) => {
    const local = isLocalPath(specifier);
    const localFile = looksLikeLocalFilePath(specifier);
    const source: MountRow['source'] = localFile
      ? 'local-file'
      : local
        ? 'local'
        : 'registry';

    let version: string | null;
    if (local) {
      // Local-path (file or dir): no installed version to read
      version = null;
    } else {
      const pkgName = extractPackageName(specifier);
      const installed = readInstalledVersion(prefix, pkgName);
      version = installed; // 'unknown' on read failure
    }

    return { mount, specifier, version, source };
  });
}

/**
 * Render the verbatim 4-column human-mode table for a set of
 * rows: column-width computation, header, data rows, and the
 * "N extensions installed." / "0 extensions installed." footer.
 */
function renderTable(rows: MountRow[]): string {
  // Compute column widths: at least the verbatim header widths, expand if data is wider.
  // [ASSUMPTION] Column widths: use verbatim header widths as defaults; expand when
  //   any data row entry (plus 2-space separator) would exceed the header width.
  //   This keeps the header row verbatim and still auto-expands for wide data.
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
  }

  const header = `${padCol('MOUNT', mountWidth)}${padCol('PACKAGE', packageWidth)}${padCol('VERSION', versionWidth)}SOURCE`;
  let out = header + '\n';

  if (rows.length === 0) {
    // empty mounts — header + footer only
    out += '0 extensions installed.\n';
    return out;
  }

  for (const row of rows) {
    const pkg =
      row.source === 'registry'
        ? extractPackageName(row.specifier)
        : row.specifier;
    const ver = row.version === null ? 'n/a' : row.version;
    const line = `${padCol(row.mount, mountWidth)}${padCol(pkg, packageWidth)}${padCol(ver, versionWidth)}${row.source}`;
    out += line + '\n';
  }

  out += `${rows.length} extensions installed.\n`;
  return out;
}

// ============================================================
// BUNDLE MODE
// ============================================================

async function runBundleMode(
  bundleRoot: string,
  jsonMode: boolean
): Promise<number> {
  let bundle: ResolvedRillBundleConfig;
  try {
    bundle = await readBundleConfig(bundleRoot);
  } catch (err) {
    if (err instanceof BundleConfigError) {
      process.stderr.write(`✗ ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const bundlePrefix = path.join(bundleRoot, '.rill', 'npm');
  const harnessVersion =
    bundle.harness !== undefined
      ? readInstalledVersion(bundlePrefix, bundle.harness)
      : undefined;

  const packageRows: Array<{
    mount: string;
    project: string;
    rows: MountRow[];
  }> = [];

  for (const pkg of bundle.packages) {
    const pkgDir = path.resolve(bundleRoot, pkg.project);
    const pkgPrefix = resolvePrefix(pkgDir);

    let mounts: Record<string, string>;
    try {
      const pkgSnapshot = await readConfigSnapshot(pkgDir);
      mounts = pkgSnapshot.parsed.extensions?.mounts ?? {};
    } catch (err) {
      if (err instanceof ConfigNotFoundError) {
        mounts = {};
      } else {
        throw err;
      }
    }

    packageRows.push({
      mount: pkg.mount,
      project: pkg.project,
      rows: buildRows(pkgPrefix, mounts),
    });
  }

  if (jsonMode) {
    const jsonPayload = {
      harness:
        bundle.harness !== undefined
          ? { name: bundle.harness, version: harnessVersion ?? 'unknown' }
          : null,
      packages: packageRows.map(({ mount, project, rows }) => ({
        mount,
        project,
        extensions: rows.map(({ mount: m, specifier, version, source }) => ({
          mount: m,
          specifier,
          version:
            source === 'local' || source === 'local-file' ? null : version,
          source,
        })),
      })),
    };
    process.stdout.write(JSON.stringify(jsonPayload, null, 2) + '\n');
    return 0;
  }

  let out =
    bundle.harness !== undefined
      ? `Harness: ${bundle.harness} (${harnessVersion ?? 'unknown'})\n`
      : 'Harness: (none)\n';
  out += '\n';

  for (const { mount, project, rows } of packageRows) {
    out += `[${mount}] ${project}\n`;
    out += renderTable(rows);
    out += '\n';
  }

  process.stdout.write(out);
  return 0;
}

// ============================================================
// IMPLEMENTATION
// ============================================================

/**
 * List all extension mounts from rill-config.json, as the verbatim 4-column
 * human table or as --json. Pre-checks the config and, in --json mode, the
 * .rill/npm/ prefix; empty mounts render header and footer only.
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

  // ---- Bundle mode ----
  const bundleRoot = findBundleRoot(projectDir);
  if (bundleRoot !== null) {
    return runBundleMode(bundleRoot, jsonMode);
  }

  // ---- Package mode ----
  const prefix = resolvePrefix(projectDir);

  // ---- Step 1: Read config snapshot ----
  let snapshot: Awaited<ReturnType<typeof readConfigSnapshot>>;
  try {
    snapshot = await readConfigSnapshot(projectDir);
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      process.stderr.write("Run 'rill init' first\n");
      return 1;
    }
    throw err;
  }

  // ---- Step 2: --json mode requires .rill/npm/ ----
  if (jsonMode) {
    const prefixPkgJson = path.join(prefix, 'package.json');
    if (!fs.existsSync(prefixPkgJson)) {
      process.stderr.write("Run 'rill init' first\n");
      return 1;
    }
  }

  // ---- Step 3: Build mount entries preserving insertion order ----
  const mounts = snapshot.parsed.extensions?.mounts ?? {};
  const rows: MountRow[] = buildRows(prefix, mounts);

  // ---- Step 4/5: Empty mounts handling ----
  if (jsonMode) {
    if (rows.length === 0) {
      process.stdout.write('[]\n');
      return 0;
    }

    // serialize with 2-space indent + trailing newline
    // [ASSUMPTION] JSON indent: 2-space chosen to match spec example
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
  process.stdout.write(renderTable(rows));
  return 0;
}
