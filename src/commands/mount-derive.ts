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
