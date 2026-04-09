import { describe, it, expect, afterEach } from 'vitest';
import { rm, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPackage } from '../../src/build/build.js';
import { BuildError } from '../../src/build/build.js';

// ============================================================
// MINIMAL FIXTURE
// ============================================================

const MINIMAL_RILL_CONFIG = {
  name: 'test-package',
  version: '0.1.0',
  main: 'main.rill:run',
};

const MINIMAL_RILL_SCRIPT = `"hello world"`;

// ============================================================
// TEMP DIR HELPERS
// ============================================================

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rill-build-test-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Create a minimal package fixture in a temp directory using rill-config.json.
 * Returns the project directory path and the output dir path.
 */
async function makeProjectFixture(
  overrides: Partial<typeof MINIMAL_RILL_CONFIG> = {},
  extraFiles: Record<string, string> = {}
): Promise<{ projectDir: string; outputDir: string }> {
  const projectDir = await makeTmpDir();
  const outputDir = await makeTmpDir();

  const rillConfig = { ...MINIMAL_RILL_CONFIG, ...overrides };
  await writeFile(
    path.join(projectDir, 'rill-config.json'),
    JSON.stringify(rillConfig, null, 2),
    'utf-8'
  );
  await writeFile(
    path.join(projectDir, 'main.rill'),
    MINIMAL_RILL_SCRIPT,
    'utf-8'
  );

  for (const [filename, content] of Object.entries(extraFiles)) {
    await writeFile(path.join(projectDir, filename), content, 'utf-8');
  }

  return { projectDir, outputDir };
}

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ============================================================
// SUCCESS CASES
// ============================================================

describe('buildPackage success cases', () => {
  // ----------------------------------------------------------
  // AC-18: Build produces enriched rill-config.json with build section
  // ----------------------------------------------------------
  it('produces enriched rill-config.json with build section [AC-18]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildPackage(projectDir, { outputDir });

    // outputPath points to the package dir (build/package-name/)
    const rillConfigPath = path.join(result.outputPath, 'rill-config.json');
    expect(existsSync(rillConfigPath)).toBe(true);

    const raw = await readFile(rillConfigPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const build = parsed['build'] as Record<string, unknown>;
    expect(typeof build['checksum']).toBe('string');
    expect(typeof build['rillVersion']).toBe('string');
    expect(build['configVersion']).toBe('3');
    expect(build['built']).toBeUndefined();
  });

  // ----------------------------------------------------------
  // AC-20: checksum is sha256:<hex>
  // ----------------------------------------------------------
  it('returns sha256 checksum in format sha256:<hex> [AC-20]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildPackage(projectDir, { outputDir });

    expect(result.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  // ----------------------------------------------------------
  // AC-20: rill-config.json build.checksum matches result.checksum
  // ----------------------------------------------------------
  it('rill-config.json build.checksum matches result.checksum [AC-20]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildPackage(projectDir, { outputDir });

    const raw = await readFile(
      path.join(result.outputPath, 'rill-config.json'),
      'utf-8'
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const build = parsed['build'] as Record<string, unknown>;
    expect(build['checksum']).toBe(result.checksum);
  });

  // ----------------------------------------------------------
  // Output is a plain rill project — no handlers.js
  // ----------------------------------------------------------
  it('does not generate handlers.js (plain rill project output)', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildPackage(projectDir, { outputDir });

    expect(existsSync(path.join(result.outputPath, 'handlers.js'))).toBe(false);
  });

  // ----------------------------------------------------------
  // AC-22: entry.rill copied to package dir (flat, no packages/ subdir)
  // ----------------------------------------------------------
  it('copies entry.rill to <outputDir>/<package-name>/main.rill [AC-22]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildPackage(projectDir, { outputDir });

    // outputPath is the package dir itself
    const entryPath = path.join(result.outputPath, 'main.rill');
    expect(existsSync(entryPath)).toBe(true);

    const content = await readFile(entryPath, 'utf-8');
    expect(content).toBe(MINIMAL_RILL_SCRIPT);
  });

  // ----------------------------------------------------------
  // AC-18: Output rill-config.json preserves original main field
  // ----------------------------------------------------------
  it('writes rill-config.json to <package-name>/ with original main field preserved [AC-18]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildPackage(projectDir, { outputDir });

    const rillConfigPath = path.join(result.outputPath, 'rill-config.json');
    expect(existsSync(rillConfigPath)).toBe(true);

    const raw = await readFile(rillConfigPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['main']).toBe('main.rill:run');
  });

  // ----------------------------------------------------------
  // AC-26: outputPath points to package dir inside custom outputDir
  // ----------------------------------------------------------
  it('outputPath points to package dir inside custom outputDir [AC-26]', async () => {
    const { projectDir } = await makeProjectFixture();
    const customOutputDir = await makeTmpDir();

    const result = await buildPackage(projectDir, {
      outputDir: customOutputDir,
    });

    expect(result.outputPath).toBe(path.join(customOutputDir, 'test-package'));
    expect(existsSync(path.join(result.outputPath, 'rill-config.json'))).toBe(
      true
    );
    expect(existsSync(path.join(result.outputPath, 'main.rill'))).toBe(true);
  });

  // ----------------------------------------------------------
  // Flat layout: no bundle.json, no packages/ subdirectory, no handlers.js
  // ----------------------------------------------------------
  it('produces no bundle.json and no packages/ subdirectory [flat-structure]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildPackage(projectDir, { outputDir });

    expect(existsSync(path.join(outputDir, 'bundle.json'))).toBe(false);
    expect(existsSync(path.join(outputDir, 'packages'))).toBe(false);
    // Package files live directly under outputDir/package-name/
    expect(existsSync(result.outputPath)).toBe(true);
  });

  // ----------------------------------------------------------
  // AC-28: Same source built twice produces identical checksums
  // ----------------------------------------------------------
  it('same source built twice produces identical checksums [AC-28]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();
    const outputDir2 = await makeTmpDir();

    const result1 = await buildPackage(projectDir, { outputDir });
    const result2 = await buildPackage(projectDir, { outputDir: outputDir2 });

    expect(result1.checksum).toBe(result2.checksum);
  });

  // ----------------------------------------------------------
  // AC-18: Local TS extension compiled and mount path rewritten
  // ----------------------------------------------------------
  it('compiles local TS extension and rewrites mount path in rill-config.json [AC-18]', async () => {
    const projectDir = await makeTmpDir();
    const outputDir = await makeTmpDir();

    // Write a minimal valid rill extension (must export extensionManifest with
    // a factory returning { value: ... } as required by the rill-config loader)
    const extensionSrc = `
export const extensionManifest = {
  name: 'my-ext',
  version: '0.1.0',
  exports: {},
  factory: async () => ({ value: {} }),
};
`;
    await writeFile(path.join(projectDir, 'my-ext.ts'), extensionSrc, 'utf-8');
    await writeFile(
      path.join(projectDir, 'main.rill'),
      MINIMAL_RILL_SCRIPT,
      'utf-8'
    );
    await writeFile(
      path.join(projectDir, 'rill-config.json'),
      JSON.stringify(
        {
          name: 'ext-package',
          version: '0.1.0',
          main: 'main.rill:run',
          extensions: { mounts: { myExt: './my-ext.ts' } },
        },
        null,
        2
      ),
      'utf-8'
    );

    const result = await buildPackage(projectDir, { outputDir });

    // Compiled extension file must exist, named by package identity (basename) + version
    const compiledPath = path.join(
      result.outputPath,
      'extensions',
      'my-ext@0.1.0.js'
    );
    expect(existsSync(compiledPath)).toBe(true);

    // Output rill-config.json must have rewritten mount path (identity-based name + version)
    const rillConfigPath = path.join(result.outputPath, 'rill-config.json');
    const raw = await readFile(rillConfigPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ext = parsed['extensions'] as Record<string, unknown>;
    const mounts = ext['mounts'] as Record<string, string>;
    expect(mounts['myExt']).toBe('./extensions/my-ext@0.1.0.js');
  });

  // ----------------------------------------------------------
  // AC-29: No Dockerfile, .zip, deployment artifacts in output
  // ----------------------------------------------------------
  it('produces no Dockerfile, .zip, or deployment artifacts [AC-29]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    await buildPackage(projectDir, { outputDir });

    expect(existsSync(path.join(outputDir, 'Dockerfile'))).toBe(false);
    // Walk output dir and assert no .zip files
    const entries = await (async function walk(dir: string): Promise<string[]> {
      const { readdir } = await import('node:fs/promises');
      const items = await readdir(dir, { withFileTypes: true });
      const results: string[] = [];
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          results.push(...(await walk(full)));
        } else {
          results.push(full);
        }
      }
      return results;
    })(outputDir);

    const zipFiles = entries.filter((f) => f.endsWith('.zip'));
    expect(zipFiles).toHaveLength(0);

    const dockerFiles = entries.filter(
      (f) => path.basename(f) === 'Dockerfile' || f.endsWith('.dockerfile')
    );
    expect(dockerFiles).toHaveLength(0);
  });

  // ----------------------------------------------------------
  // Verify rillVersion in build section is a non-empty string
  // ----------------------------------------------------------
  it('rill-config.json build.rillVersion is a non-empty string', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildPackage(projectDir, { outputDir });

    const raw = await readFile(
      path.join(result.outputPath, 'rill-config.json'),
      'utf-8'
    );
    const build = (JSON.parse(raw) as Record<string, unknown>)[
      'build'
    ] as Record<string, unknown>;
    expect(typeof build['rillVersion']).toBe('string');
    expect((build['rillVersion'] as string).length).toBeGreaterThan(0);
  });
});

// ============================================================
// ERROR CASES
// ============================================================

describe('buildPackage error cases', () => {
  // ----------------------------------------------------------
  // AC-47: rill-config.json not found → BuildError('validation')
  // ----------------------------------------------------------
  it('throws BuildError phase validation when rill-config.json is missing [AC-47]', async () => {
    const outputDir = await makeTmpDir();
    const nonExistentDir = path.join(outputDir, 'does-not-exist');

    await expect(buildPackage(nonExistentDir, { outputDir })).rejects.toSatisfy(
      (e: unknown) => {
        return (
          e instanceof BuildError &&
          e.phase === 'validation' &&
          e.message.includes('rill-config.json not found')
        );
      }
    );
  });

  // ----------------------------------------------------------
  // AC-48: Malformed rill-config.json → BuildError('validation') with parse detail
  // ----------------------------------------------------------
  it('throws BuildError phase validation when rill-config.json is malformed JSON [AC-48]', async () => {
    const projectDir = await makeTmpDir();
    const outputDir = await makeTmpDir();

    await writeFile(
      path.join(projectDir, 'rill-config.json'),
      '{ this is not valid json }',
      'utf-8'
    );

    await expect(buildPackage(projectDir, { outputDir })).rejects.toSatisfy(
      (e: unknown) => {
        return (
          e instanceof BuildError &&
          e.phase === 'validation' &&
          e.message.includes('Failed to parse rill-config.json')
        );
      }
    );
  });

  // ----------------------------------------------------------
  // Entry .rill file not found → BuildError('compilation')
  // ----------------------------------------------------------
  it('throws BuildError phase compilation when entry.rill is missing', async () => {
    const projectDir = await makeTmpDir();
    const outputDir = await makeTmpDir();

    // Write config but NOT the .rill file
    await writeFile(
      path.join(projectDir, 'rill-config.json'),
      JSON.stringify({ name: 'test', version: '0.1.0', main: 'main.rill:run' }),
      'utf-8'
    );

    await expect(buildPackage(projectDir, { outputDir })).rejects.toSatisfy(
      (e: unknown) => {
        return (
          e instanceof BuildError &&
          e.phase === 'compilation' &&
          e.message.includes('Entry file not found')
        );
      }
    );
  });

  // ----------------------------------------------------------
  // Local extension source missing → BuildError('compilation')
  // ----------------------------------------------------------
  it('throws BuildError phase compilation when local extension source is missing', async () => {
    const projectDir = await makeTmpDir();
    const outputDir = await makeTmpDir();

    await writeFile(
      path.join(projectDir, 'rill-config.json'),
      JSON.stringify({
        name: 'test',
        version: '0.1.0',
        main: 'main.rill:run',
        extensions: { mounts: { myExt: './missing-ext.ts' } },
      }),
      'utf-8'
    );
    await writeFile(path.join(projectDir, 'main.rill'), `"hello"`, 'utf-8');

    await expect(buildPackage(projectDir, { outputDir })).rejects.toSatisfy(
      (e: unknown) => {
        return (
          e instanceof BuildError &&
          e.phase === 'compilation' &&
          e.message.includes('Extension source not found')
        );
      }
    );
  });

  // ----------------------------------------------------------
  // AC-49: loadProject() dry-run failure deletes output and throws
  // ----------------------------------------------------------
  it('throws BuildError when npm extension cannot be resolved [AC-49]', async () => {
    const projectDir = await makeTmpDir();
    const outputDir = await makeTmpDir();

    // Write a config that references a non-existent npm extension
    await writeFile(
      path.join(projectDir, 'rill-config.json'),
      JSON.stringify({
        name: 'test',
        version: '0.1.0',
        main: 'main.rill:run',
        extensions: {
          mounts: { badExt: '@non-existent-pkg/does-not-exist-xyz123' },
        },
      }),
      'utf-8'
    );
    await writeFile(path.join(projectDir, 'main.rill'), `"hello"`, 'utf-8');

    await expect(buildPackage(projectDir, { outputDir })).rejects.toSatisfy(
      (e: unknown) => {
        return (
          e instanceof BuildError &&
          e.phase === 'compilation' &&
          e.message.includes('@non-existent-pkg/does-not-exist-xyz123')
        );
      }
    );
  });

  // ----------------------------------------------------------
  // AC-34/EC-15: Output not writable → BuildError phase 'bundling'
  // ----------------------------------------------------------
  it.skipIf(process.platform === 'win32')(
    'throws BuildError phase bundling when output dir is not writable [AC-34/EC-15]',
    async () => {
      const { projectDir } = await makeProjectFixture();

      // Make a read-only parent directory so mkdir on the outputDir path fails.
      const readOnlyParent = await makeTmpDir();
      const blockedOutputDir = path.join(readOnlyParent, 'output');

      // chmod 000 prevents the process from creating subdirectories inside.
      await import('node:fs/promises').then(({ chmod }) =>
        chmod(readOnlyParent, 0o000)
      );

      try {
        await expect(
          buildPackage(projectDir, { outputDir: blockedOutputDir })
        ).rejects.toSatisfy((e: unknown) => {
          return e instanceof BuildError && e.phase === 'bundling';
        });
      } finally {
        // Restore permissions so afterEach cleanup can remove the dir.
        await import('node:fs/promises').then(({ chmod }) =>
          chmod(readOnlyParent, 0o755)
        );
      }
    }
  );
});

// ============================================================
// BOUNDARY CONDITIONS
// ============================================================

describe('buildPackage boundary conditions', () => {
  // ----------------------------------------------------------
  // Name defaults to directory basename when not in config
  // ----------------------------------------------------------
  it('uses directory basename as package name when name field absent', async () => {
    const projectDir = await makeTmpDir();
    const outputDir = await makeTmpDir();
    const dirName = path.basename(projectDir);

    await writeFile(
      path.join(projectDir, 'rill-config.json'),
      JSON.stringify({ version: '0.1.0', main: 'main.rill:run' }),
      'utf-8'
    );
    await writeFile(path.join(projectDir, 'main.rill'), `"hello"`, 'utf-8');

    const result = await buildPackage(projectDir, { outputDir });

    // Package dir is named after the project directory
    expect(path.basename(result.outputPath)).toBe(dirName);
  });

  // ----------------------------------------------------------
  // AC-49: 3+ local TS extensions all produce compiled JS
  // ----------------------------------------------------------
  it('compiles 3 local TS extensions and all produce JS output files [AC-49]', async () => {
    const projectDir = await makeTmpDir();
    const outputDir = await makeTmpDir();

    const extensionSrc = (name: string) => `
export const extensionManifest = {
  name: '${name}',
  version: '0.1.0',
  exports: {},
  factory: async () => ({ value: {} }),
};
`;

    await writeFile(
      path.join(projectDir, 'ext-alpha.ts'),
      extensionSrc('ext-alpha'),
      'utf-8'
    );
    await writeFile(
      path.join(projectDir, 'ext-beta.ts'),
      extensionSrc('ext-beta'),
      'utf-8'
    );
    await writeFile(
      path.join(projectDir, 'ext-gamma.ts'),
      extensionSrc('ext-gamma'),
      'utf-8'
    );
    await writeFile(
      path.join(projectDir, 'main.rill'),
      MINIMAL_RILL_SCRIPT,
      'utf-8'
    );
    await writeFile(
      path.join(projectDir, 'rill-config.json'),
      JSON.stringify(
        {
          name: 'multi-ext-package',
          version: '0.1.0',
          main: 'main.rill:run',
          extensions: {
            mounts: {
              extAlpha: './ext-alpha.ts',
              extBeta: './ext-beta.ts',
              extGamma: './ext-gamma.ts',
            },
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    const result = await buildPackage(projectDir, { outputDir });

    const extensionsDir = path.join(result.outputPath, 'extensions');
    expect(existsSync(path.join(extensionsDir, 'ext-alpha@0.1.0.js'))).toBe(
      true
    );
    expect(existsSync(path.join(extensionsDir, 'ext-beta@0.1.0.js'))).toBe(
      true
    );
    expect(existsSync(path.join(extensionsDir, 'ext-gamma@0.1.0.js'))).toBe(
      true
    );
  });

  // ----------------------------------------------------------
  // Two aliases mounting the same local source share one .js file
  // ----------------------------------------------------------
  it('deduplicates extensions when two aliases mount the same source', async () => {
    const projectDir = await makeTmpDir();
    const outputDir = await makeTmpDir();

    const extensionSrc = `
export const extensionManifest = {
  name: 'shared-ext',
  version: '0.1.0',
  exports: {},
  factory: async () => ({ value: {} }),
};
`;
    await writeFile(path.join(projectDir, 'shared.ts'), extensionSrc, 'utf-8');
    await writeFile(
      path.join(projectDir, 'main.rill'),
      MINIMAL_RILL_SCRIPT,
      'utf-8'
    );
    await writeFile(
      path.join(projectDir, 'rill-config.json'),
      JSON.stringify(
        {
          name: 'dedup-package',
          version: '0.1.0',
          main: 'main.rill:run',
          extensions: {
            mounts: {
              aliasA: './shared.ts',
              aliasB: './shared.ts',
            },
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    const result = await buildPackage(projectDir, { outputDir });

    // Only one .js file should exist for the shared source
    const extensionsDir = path.join(result.outputPath, 'extensions');
    const files = readdirSync(extensionsDir);
    expect(files).toEqual(['shared@0.1.0.js']);

    // Both aliases must point to the same file in rill-config.json
    const rillConfigPath = path.join(result.outputPath, 'rill-config.json');
    const raw = await readFile(rillConfigPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ext = parsed['extensions'] as Record<string, unknown>;
    const mounts = ext['mounts'] as Record<string, string>;
    expect(mounts['aliasA']).toBe('./extensions/shared@0.1.0.js');
    expect(mounts['aliasB']).toBe('./extensions/shared@0.1.0.js');
  });

  // ----------------------------------------------------------
  // Version required — throws when absent
  // ----------------------------------------------------------
  it('throws BuildError when version field is absent', async () => {
    const projectDir = await makeTmpDir();
    const outputDir = await makeTmpDir();

    await writeFile(
      path.join(projectDir, 'rill-config.json'),
      JSON.stringify({ name: 'test', main: 'main.rill:run' }),
      'utf-8'
    );
    await writeFile(path.join(projectDir, 'main.rill'), `"hello"`, 'utf-8');

    await expect(buildPackage(projectDir, { outputDir })).rejects.toSatisfy(
      (e: unknown) => {
        return (
          e instanceof BuildError &&
          e.phase === 'validation' &&
          e.message.includes("missing required 'version' field")
        );
      }
    );
  });
});

// ============================================================
// VERSION SANITIZATION AND COLLISION DETECTION
// ============================================================

describe('buildPackage version sanitization and collision detection', () => {
  // ----------------------------------------------------------
  // Path traversal in version string → throws with clear message
  // ----------------------------------------------------------
  it('throws when extension version contains path traversal characters', async () => {
    const projectDir = await makeTmpDir();
    const outputDir = await makeTmpDir();

    // resolveExtensionVersion reads the version from rill-config.json for local
    // extensions. A malicious version in that field must be rejected before it is
    // used as a filename component.
    const extensionSrc = `
export const extensionManifest = {
  name: 'bad-ext',
  version: '0.1.0',
  exports: {},
  factory: async () => ({ value: {} }),
};
`;
    await writeFile(path.join(projectDir, 'bad-ext.ts'), extensionSrc, 'utf-8');
    await writeFile(
      path.join(projectDir, 'main.rill'),
      MINIMAL_RILL_SCRIPT,
      'utf-8'
    );
    await writeFile(
      path.join(projectDir, 'rill-config.json'),
      JSON.stringify({
        name: 'traversal-test',
        version: '../../malicious',
        main: 'main.rill:run',
        extensions: { mounts: { badExt: './bad-ext.ts' } },
      }),
      'utf-8'
    );

    await expect(buildPackage(projectDir, { outputDir })).rejects.toThrow(
      'Invalid extension version'
    );
  });

  // ----------------------------------------------------------
  // Same-basename extensions at different paths use stable hash suffix
  // ----------------------------------------------------------
  it('disambiguates same-basename extensions with a stable hash suffix', async () => {
    const projectDir = await makeTmpDir();
    const outputDir = await makeTmpDir();

    const extSrc = (name: string) => `
export const extensionManifest = {
  name: '${name}',
  version: '0.1.0',
  exports: {},
  factory: async () => ({ value: {} }),
};
`;

    // Two extensions with the same basename 'ext' but in different subdirectories.
    const { mkdir: mkdirNode } = await import('node:fs/promises');
    await mkdirNode(path.join(projectDir, 'foo'), { recursive: true });
    await mkdirNode(path.join(projectDir, 'bar'), { recursive: true });
    await writeFile(
      path.join(projectDir, 'foo', 'ext.ts'),
      extSrc('ext-foo'),
      'utf-8'
    );
    await writeFile(
      path.join(projectDir, 'bar', 'ext.ts'),
      extSrc('ext-bar'),
      'utf-8'
    );
    await writeFile(
      path.join(projectDir, 'main.rill'),
      MINIMAL_RILL_SCRIPT,
      'utf-8'
    );
    await writeFile(
      path.join(projectDir, 'rill-config.json'),
      JSON.stringify({
        name: 'collision-test',
        version: '0.1.0',
        main: 'main.rill:run',
        extensions: {
          mounts: {
            extFoo: './foo/ext.ts',
            extBar: './bar/ext.ts',
          },
        },
      }),
      'utf-8'
    );

    const result = await buildPackage(projectDir, { outputDir });

    const extensionsDir = path.join(result.outputPath, 'extensions');
    const files = readdirSync(extensionsDir).sort();

    // Both files must exist and be distinct (hash suffix applied to the collision).
    expect(files).toHaveLength(2);
    // Both must end with @0.1.0.js and contain 'ext' in the stem.
    expect(files.every((f) => f.endsWith('@0.1.0.js'))).toBe(true);
    expect(files[0]).not.toBe(files[1]);

    // Build is deterministic: running again must produce identical filenames.
    const outputDir2 = await makeTmpDir();
    const result2 = await buildPackage(projectDir, { outputDir: outputDir2 });
    const extensionsDir2 = path.join(result2.outputPath, 'extensions');
    const files2 = readdirSync(extensionsDir2).sort();
    expect(files2).toEqual(files);
  });
});

// ============================================================
// HANDLER LIFECYCLE CONTRACT
// ============================================================

describe('handler lifecycle contract', () => {
  // ----------------------------------------------------------
  // handler.js contains the four lifecycle named exports
  // ----------------------------------------------------------
  it('handler.js contains lifecycle exports', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildPackage(projectDir, { outputDir });

    const handlerJs = await readFile(
      path.join(result.outputPath, 'handler.js'),
      'utf-8'
    );
    expect(handlerJs).toContain('export function describe()');
    expect(handlerJs).toContain('export async function init(');
    expect(handlerJs).toContain('export async function execute(');
    expect(handlerJs).toContain('export async function dispose(');
  });

  // ----------------------------------------------------------
  // runtime.js is a pure export module — no top-level execution
  // ----------------------------------------------------------
  it('runtime.js does not execute at import time', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildPackage(projectDir, { outputDir });

    const runtimeJs = await readFile(
      path.join(result.outputPath, 'runtime.js'),
      'utf-8'
    );
    expect(runtimeJs).not.toContain('await loadProject');
    expect(runtimeJs).toContain('export {');
  });

  // ----------------------------------------------------------
  // run.js uses the handler lifecycle (init/execute/dispose)
  // ----------------------------------------------------------
  it('run.js uses handler lifecycle', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildPackage(projectDir, { outputDir });

    const runJs = await readFile(
      path.join(result.outputPath, 'run.js'),
      'utf-8'
    );
    expect(runJs).toContain(`from './handler.js'`);
    expect(runJs).toContain('await init(');
    expect(runJs).toContain('await execute(');
    expect(runJs).toContain('await dispose(');
  });

  // ----------------------------------------------------------
  // describe() returns introspection data when handler has params
  // ----------------------------------------------------------
  it('describe() returns introspection data for handler with params', async () => {
    const { projectDir, outputDir } = await makeProjectFixture(
      {},
      {
        'main.rill':
          '|greeting: string, name: string| { $greeting + " " + $name } => $run',
      }
    );

    const result = await buildPackage(projectDir, { outputDir });

    const handlerJs = await readFile(
      path.join(result.outputPath, 'handler.js'),
      'utf-8'
    );
    expect(handlerJs).toContain('"params"');
    expect(handlerJs).toContain('greeting');
    expect(handlerJs).toContain('name');
  });

  // ----------------------------------------------------------
  // execute() drains streams with onChunk callback
  // ----------------------------------------------------------
  it('execute() calls onChunk incrementally for stream results and returns streamed: true', async () => {
    const { projectDir, outputDir } = await makeProjectFixture(
      {},
      {
        'main.rill': `|| {
  "a" -> yield
  "b" -> yield
  "c" -> yield
  3
}:stream(string):number => $run`,
      }
    );

    const result = await buildPackage(projectDir, { outputDir });

    const handlerPath = path.join(result.outputPath, 'handler.js');
    const handler = (await import(handlerPath)) as {
      init: (ctx?: Record<string, unknown>) => Promise<void>;
      execute: (
        req?: Record<string, unknown>,
        ctx?: Record<string, unknown>
      ) => Promise<{
        state: string;
        result: unknown;
        streamed: boolean;
      }>;
      dispose: () => Promise<void>;
    };

    const savedCwd = process.cwd();
    await handler.init({});
    try {
      const chunks: unknown[] = [];
      const withChunk = await handler.execute(
        { params: {} },
        {
          onChunk: (v: unknown) => {
            chunks.push(v);
          },
        }
      );
      expect(chunks).toEqual(['a', 'b', 'c']);
      expect(withChunk.streamed).toBe(true);
      expect(withChunk.result).toBeUndefined();
    } finally {
      await handler.dispose();
      process.chdir(savedCwd);
    }
  });

  // ----------------------------------------------------------
  // execute() collects stream chunks into array without onChunk
  // ----------------------------------------------------------
  it('execute() returns collected chunk array when onChunk is not provided', async () => {
    const { projectDir, outputDir } = await makeProjectFixture(
      {},
      {
        'main.rill': `|| {
  "x" -> yield
  "y" -> yield
  2
}:stream(string):number => $run`,
      }
    );

    const result = await buildPackage(projectDir, { outputDir });

    const handlerPath = path.join(result.outputPath, 'handler.js');
    const handler = (await import(handlerPath)) as {
      init: (ctx?: Record<string, unknown>) => Promise<void>;
      execute: (
        req?: Record<string, unknown>,
        ctx?: Record<string, unknown>
      ) => Promise<{
        state: string;
        result: unknown;
        streamed: boolean;
      }>;
      dispose: () => Promise<void>;
    };

    const savedCwd = process.cwd();
    await handler.init({});
    try {
      const withoutChunk = await handler.execute({ params: {} }, {});
      expect(withoutChunk.result).toEqual(['x', 'y']);
      expect(withoutChunk.streamed).toBe(false);
    } finally {
      await handler.dispose();
      process.chdir(savedCwd);
    }
  });

  // ----------------------------------------------------------
  // describe() returns null when main field has no handler name
  // ----------------------------------------------------------
  it('describe() returns null when no handler name in main field', async () => {
    const { projectDir, outputDir } = await makeProjectFixture({
      main: 'main.rill',
    });

    const result = await buildPackage(projectDir, { outputDir });

    const handlerJs = await readFile(
      path.join(result.outputPath, 'handler.js'),
      'utf-8'
    );
    expect(handlerJs).toContain('return null;');
  });
});
