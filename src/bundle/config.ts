import { existsSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ============================================================
// BUNDLE PACKAGE ENTRY
// ============================================================

export interface BundlePackageEntry {
  readonly mount: string;
  readonly project: string;
}

// ============================================================
// RILL BUNDLE CONFIG
// ============================================================

export interface RillBundleConfig {
  readonly $schema?: string | undefined;
  readonly name: string;
  readonly version: string;
  readonly harness?: string | undefined;
  readonly config?: Record<string, unknown> | undefined;
  readonly defaultPackage?: string | undefined;
  readonly packages: ReadonlyArray<BundlePackageEntry>;
}

export interface ResolvedRillBundleConfig extends RillBundleConfig {
  readonly config: Record<string, unknown>;
  readonly defaultPackage: string;
}

// ============================================================
// BUNDLE CONFIG ERROR
// ============================================================

export type BundleConfigErrorCode =
  | 'NOT_FOUND'
  | 'PARSE'
  | 'SCHEMA'
  | 'DUPLICATE_MOUNT'
  | 'WRITE';

export class BundleConfigError extends Error {
  readonly code: BundleConfigErrorCode;
  readonly field: string | undefined;
  override readonly cause: unknown;

  constructor(opts: {
    code: BundleConfigErrorCode;
    message: string;
    field?: string | undefined;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = 'BundleConfigError';
    this.code = opts.code;
    this.field = opts.field;
    this.cause = opts.cause;
  }
}

// ============================================================
// INTERNAL HELPERS
// ============================================================

const BUNDLE_FILE = 'rill-bundle.json';

function bundleFilePath(dir: string): string {
  return path.resolve(dir, BUNDLE_FILE);
}

function requireString(raw: unknown, field: string): string {
  if (raw === null) {
    throw new BundleConfigError({
      code: 'SCHEMA',
      field,
      message: `Field '${field}' must not be null`,
    });
  }
  if (raw === undefined) {
    throw new BundleConfigError({
      code: 'SCHEMA',
      field,
      message: `Field '${field}' is required`,
    });
  }
  if (typeof raw !== 'string') {
    throw new BundleConfigError({
      code: 'SCHEMA',
      field,
      message: `Field '${field}' must be a string`,
    });
  }
  if (raw.length === 0) {
    throw new BundleConfigError({
      code: 'SCHEMA',
      field,
      message: `Field '${field}' must not be empty`,
    });
  }
  return raw;
}

function rejectNull(raw: unknown, field: string): void {
  if (raw === null) {
    throw new BundleConfigError({
      code: 'SCHEMA',
      field,
      message: `Field '${field}' must not be null`,
    });
  }
}

function validateHarnessSpecifier(harness: string): void {
  if (
    harness.startsWith('.') ||
    harness.startsWith('/') ||
    harness.includes('..') ||
    harness.includes('\\')
  ) {
    throw new BundleConfigError({
      code: 'SCHEMA',
      field: 'harness',
      message: `Field 'harness' must be a bare npm specifier (no relative or absolute paths)`,
    });
  }
}

function validateName(name: string): void {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new BundleConfigError({
      code: 'SCHEMA',
      field: 'name',
      message: `Field 'name' contains invalid characters`,
    });
  }
}

function resolveRealPath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      // Fall back to the lexically-resolved path when the target does not
      // exist on disk (e.g. a package not yet materialized).
      return candidate;
    }
    throw err;
  }
}

function validateProjectPath(
  project: string,
  index: number,
  bundleDir: string
): void {
  const field = `packages[${index}].project`;
  const resolved = resolveRealPath(path.resolve(bundleDir, project));
  const normalizedBundleDir = resolveRealPath(path.resolve(bundleDir));
  // Ensure the resolved path starts with bundleDir (with trailing sep to
  // prevent a prefix match like /foo/bar matching /foo/barbaz).
  const prefix = normalizedBundleDir.endsWith(path.sep)
    ? normalizedBundleDir
    : normalizedBundleDir + path.sep;
  if (!resolved.startsWith(prefix) && resolved !== normalizedBundleDir) {
    throw new BundleConfigError({
      code: 'SCHEMA',
      field,
      message: `packages[${index}].project escapes the bundle directory`,
    });
  }
}

// ============================================================
// readRawBundleJson
// ============================================================

const ROOT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  '$schema',
  'name',
  'version',
  'harness',
  'config',
  'defaultPackage',
  'packages',
]);

const PACKAGE_ENTRY_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'mount',
  'project',
]);

/**
 * Reads and parses the bundle config file at `bundleDir`, returning both the
 * parsed object and the raw text. The raw text is load-bearing for callers
 * that need to preserve formatting details such as a trailing newline.
 */
export async function readRawBundleJson(
  bundleDir: string
): Promise<{ parsed: Record<string, unknown>; text: string }> {
  const filePath = bundleFilePath(bundleDir);

  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new BundleConfigError({
        code: 'NOT_FOUND',
        message: `Bundle config not found: ${filePath}`,
        cause: err,
      });
    }
    throw err;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new BundleConfigError({
      code: 'PARSE',
      message: `Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BundleConfigError({
      code: 'SCHEMA',
      field: '(root)',
      message: `${BUNDLE_FILE} must be a JSON object`,
    });
  }

  return { parsed: raw as Record<string, unknown>, text };
}

// ============================================================
// readBundleConfig
// ============================================================

export async function readBundleConfig(
  bundleDir: string
): Promise<ResolvedRillBundleConfig> {
  const { parsed: obj } = await readRawBundleJson(bundleDir);

  // Reject unknown root keys
  for (const key of Object.keys(obj)) {
    if (!ROOT_ALLOWED_KEYS.has(key)) {
      throw new BundleConfigError({
        code: 'SCHEMA',
        field: key,
        message: `Unknown field '${key}' in ${BUNDLE_FILE}`,
      });
    }
  }

  // Validate name
  const name = requireString(obj['name'], 'name');
  validateName(name);

  // Validate version
  const version = requireString(obj['version'], 'version');

  // Validate harness (optional but reject null)
  rejectNull(obj['harness'], 'harness');
  const harness =
    obj['harness'] !== undefined
      ? requireString(obj['harness'], 'harness')
      : undefined;
  if (harness !== undefined) {
    validateHarnessSpecifier(harness);
  }

  // Validate config (optional but reject null)
  rejectNull(obj['config'], 'config');
  let config: Record<string, unknown> | undefined;
  if (obj['config'] !== undefined) {
    if (
      typeof obj['config'] !== 'object' ||
      obj['config'] === null ||
      Array.isArray(obj['config'])
    ) {
      throw new BundleConfigError({
        code: 'SCHEMA',
        field: 'config',
        message: `Field 'config' must be an object`,
      });
    }
    config = obj['config'] as Record<string, unknown>;
  } else {
    config = {};
  }

  // Validate defaultPackage (optional but reject null)
  rejectNull(obj['defaultPackage'], 'defaultPackage');
  const defaultPackageRaw =
    obj['defaultPackage'] !== undefined
      ? requireString(obj['defaultPackage'], 'defaultPackage')
      : undefined;

  // Validate $schema (optional, pass through)
  const $schema =
    typeof obj['$schema'] === 'string' ? obj['$schema'] : undefined;

  // Validate packages
  if (obj['packages'] === undefined || obj['packages'] === null) {
    throw new BundleConfigError({
      code: 'SCHEMA',
      field: 'packages',
      message: `Field 'packages' is required`,
    });
  }
  if (!Array.isArray(obj['packages'])) {
    throw new BundleConfigError({
      code: 'SCHEMA',
      field: 'packages',
      message: `Field 'packages' must be an array`,
    });
  }
  if (obj['packages'].length === 0) {
    throw new BundleConfigError({
      code: 'SCHEMA',
      field: 'packages',
      message: `Field 'packages' must contain at least one entry`,
    });
  }

  const mounts = new Set<string>();
  const packages: BundlePackageEntry[] = [];

  for (let i = 0; i < obj['packages'].length; i++) {
    const entry = obj['packages'][i] as unknown;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new BundleConfigError({
        code: 'SCHEMA',
        field: `packages[${i}]`,
        message: `packages[${i}] must be an object`,
      });
    }
    const entryObj = entry as Record<string, unknown>;

    for (const key of Object.keys(entryObj)) {
      if (!PACKAGE_ENTRY_ALLOWED_KEYS.has(key)) {
        throw new BundleConfigError({
          code: 'SCHEMA',
          field: `packages[${i}].${key}`,
          message: `Unknown field '${key}' in packages[${i}]`,
        });
      }
    }

    const mount = requireString(entryObj['mount'], `packages[${i}].mount`);
    const project = requireString(
      entryObj['project'],
      `packages[${i}].project`
    );

    if (mounts.has(mount)) {
      throw new BundleConfigError({
        code: 'DUPLICATE_MOUNT',
        field: `packages[${i}].mount`,
        message: `Duplicate mount '${mount}' at packages[${i}]`,
      });
    }
    mounts.add(mount);

    validateProjectPath(project, i, bundleDir);

    packages.push({ mount, project });
  }

  // Validate defaultPackage references an existing mount
  if (defaultPackageRaw !== undefined && !mounts.has(defaultPackageRaw)) {
    throw new BundleConfigError({
      code: 'SCHEMA',
      field: 'defaultPackage',
      message: `defaultPackage '${defaultPackageRaw}' does not match any package mount`,
    });
  }

  // Default defaultPackage to packages[0].mount when absent
  const firstPackage = packages[0];
  if (firstPackage === undefined) {
    // Already checked above (packages.length === 0), but satisfies the compiler.
    throw new BundleConfigError({
      code: 'SCHEMA',
      field: 'packages',
      message: `Field 'packages' must contain at least one entry`,
    });
  }
  const defaultPackage = defaultPackageRaw ?? firstPackage.mount;

  const result: ResolvedRillBundleConfig = {
    name,
    version,
    packages,
    defaultPackage,
    config,
    ...(harness !== undefined ? { harness } : {}),
    ...($schema !== undefined ? { $schema } : {}),
  };

  return result;
}

// ============================================================
// detectBundleAtCwd
// ============================================================

export function detectBundleAtCwd(cwd: string): boolean {
  return existsSync(bundleFilePath(cwd));
}

// ============================================================
// findBundleRoot
// ============================================================

export function findBundleRoot(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(current, BUNDLE_FILE))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root
      return null;
    }
    current = parent;
  }
}

// ============================================================
// writeBundleHarness
// ============================================================

export async function writeBundleHarness(
  bundleDir: string,
  harnessName: string | null
): Promise<void> {
  const filePath = bundleFilePath(bundleDir);

  // Read the existing raw text to preserve formatting conventions
  let parsed: Record<string, unknown>;
  let rawText: string;
  try {
    ({ parsed, text: rawText } = await readRawBundleJson(bundleDir));
  } catch (err) {
    if (err instanceof BundleConfigError) {
      throw err;
    }
    throw new BundleConfigError({
      code: 'WRITE',
      message: `Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }

  const obj = { ...parsed };

  if (harnessName === null) {
    delete obj['harness'];
  } else {
    obj['harness'] = harnessName;
  }

  const trailingNewline = rawText.endsWith('\n');
  const serialized =
    JSON.stringify(obj, null, 2) + (trailingNewline ? '\n' : '');

  try {
    await writeFile(filePath, serialized, 'utf8');
  } catch (err) {
    throw new BundleConfigError({
      code: 'WRITE',
      message: `Failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }
}
