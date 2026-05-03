import path from 'node:path';

/**
 * Returns true when specifier is a local-path source.
 *
 * A specifier is local-path iff it begins with './', '../', or '/'.
 * Mirrors the private isLocalExtension function at src/build/build.ts:254.
 */
export function isLocalPath(specifier: string): boolean {
  return (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    path.isAbsolute(specifier)
  );
}

/**
 * Extract the bare package name from a registry specifier or mount value.
 *
 * Strips the trailing version qualifier — the part after the last '@' that is
 * NOT in the leading scope position. The leading '@' on scoped packages
 * (`@scope/...`) is preserved.
 *
 * Examples:
 *   "@rcrsr/rill-ext-datetime"       -> "@rcrsr/rill-ext-datetime"
 *   "@rcrsr/rill-ext-datetime@0.19.0"-> "@rcrsr/rill-ext-datetime"
 *   "@rcrsr/rill-ext-datetime@^0.19.0"-> "@rcrsr/rill-ext-datetime"
 *   "my-pkg@^1.0.0"                  -> "my-pkg"
 *   "my-pkg"                         -> "my-pkg"
 */
export function extractPackageName(specifier: string): string {
  const atIndex = specifier.indexOf('@', 1);
  if (atIndex === -1) {
    return specifier;
  }
  return specifier.slice(0, atIndex);
}

/** Single-file extension extensions that `rill install ./foo.ts --as bar` accepts. */
const LOCAL_FILE_EXTS = ['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx'];

/**
 * Returns true when specifier is a local path pointing at a single source file
 * (ts/js/mjs/cjs/tsx/jsx). Single-file local paths bypass npm and are recorded
 * verbatim in rill-config.json.
 */
export function isLocalFilePath(specifier: string): boolean {
  if (!isLocalPath(specifier)) return false;
  const lower = specifier.toLowerCase();
  return LOCAL_FILE_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * Derive mount path from a package specifier or local path.
 *
 * Algorithm (FR-EXT-2/3/4):
 * - If asOverride supplied: return asOverride.
 * - If specifier is empty: throw Error.
 * - If specifier is a local path (./  ../  /): return basename of path.
 * - Else if specifier matches /^@[^/]+\/rill-ext-(.+)$/: return capture group.
 * - Else if specifier matches /^rill-ext-(.+)$/: return capture group.
 * - Else if scoped (@scope/name): return name (last segment).
 * - Else: return specifier as-is.
 */
export function deriveMount(specifier: string, asOverride?: string): string {
  if (asOverride !== undefined) {
    return asOverride;
  }

  if (specifier.length === 0) {
    throw new Error(`Cannot derive mount path from: ${specifier}`);
  }

  if (isLocalPath(specifier)) {
    return path.basename(specifier);
  }

  const scopedRillExt = /^@[^/]+\/rill-ext-(.+)$/.exec(specifier);
  if (scopedRillExt !== null) {
    return scopedRillExt[1] as string;
  }

  const plainRillExt = /^rill-ext-(.+)$/.exec(specifier);
  if (plainRillExt !== null) {
    return plainRillExt[1] as string;
  }

  const lastSlash = specifier.lastIndexOf('/');
  if (lastSlash !== -1) {
    return specifier.slice(lastSlash + 1);
  }

  return specifier;
}
