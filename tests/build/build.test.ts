import { describe, it, expect, afterEach } from 'vitest';
import { rm, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAgent } from '../../src/build/build.js';
import { BuildError } from '../../src/build/build.js';

// ============================================================
// MINIMAL FIXTURE
// ============================================================

const MINIMAL_RILL_CONFIG = {
  name: 'test-agent',
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
 * Create a minimal agent fixture in a temp directory using rill-config.json.
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

describe('buildAgent success cases', () => {
  // ----------------------------------------------------------
  // AC-18: Build produces enriched rill-config.json with build section
  // ----------------------------------------------------------
  it('produces enriched rill-config.json with build section [AC-18]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildAgent(projectDir, { outputDir });

    // outputPath points to the agent dir (build/agent-name/)
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

    const result = await buildAgent(projectDir, { outputDir });

    expect(result.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  // ----------------------------------------------------------
  // AC-20: rill-config.json build.checksum matches result.checksum
  // ----------------------------------------------------------
  it('rill-config.json build.checksum matches result.checksum [AC-20]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildAgent(projectDir, { outputDir });

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

    const result = await buildAgent(projectDir, { outputDir });

    expect(existsSync(path.join(result.outputPath, 'handlers.js'))).toBe(false);
  });

  // ----------------------------------------------------------
  // AC-22: entry.rill copied to agent dir (flat, no agents/ subdir)
  // ----------------------------------------------------------
  it('copies entry.rill to <outputDir>/<agent-name>/main.rill [AC-22]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildAgent(projectDir, { outputDir });

    // outputPath is the agent dir itself
    const entryPath = path.join(result.outputPath, 'main.rill');
    expect(existsSync(entryPath)).toBe(true);

    const content = await readFile(entryPath, 'utf-8');
    expect(content).toBe(MINIMAL_RILL_SCRIPT);
  });

  // ----------------------------------------------------------
  // AC-18: Output rill-config.json preserves original main field
  // ----------------------------------------------------------
  it('writes rill-config.json to <agent-name>/ with original main field preserved [AC-18]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildAgent(projectDir, { outputDir });

    const rillConfigPath = path.join(result.outputPath, 'rill-config.json');
    expect(existsSync(rillConfigPath)).toBe(true);

    const raw = await readFile(rillConfigPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['main']).toBe('main.rill:run');
  });

  // ----------------------------------------------------------
  // AC-26: outputPath points to agent dir inside custom outputDir
  // ----------------------------------------------------------
  it('outputPath points to agent dir inside custom outputDir [AC-26]', async () => {
    const { projectDir } = await makeProjectFixture();
    const customOutputDir = await makeTmpDir();

    const result = await buildAgent(projectDir, {
      outputDir: customOutputDir,
    });

    expect(result.outputPath).toBe(path.join(customOutputDir, 'test-agent'));
    expect(existsSync(path.join(result.outputPath, 'rill-config.json'))).toBe(
      true
    );
    expect(existsSync(path.join(result.outputPath, 'main.rill'))).toBe(true);
  });

  // ----------------------------------------------------------
  // Flat layout: no bundle.json, no agents/ subdirectory, no handlers.js
  // ----------------------------------------------------------
  it('produces no bundle.json and no agents/ subdirectory [flat-structure]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    const result = await buildAgent(projectDir, { outputDir });

    expect(existsSync(path.join(outputDir, 'bundle.json'))).toBe(false);
    expect(existsSync(path.join(outputDir, 'agents'))).toBe(false);
    // Agent files live directly under outputDir/agent-name/
    expect(existsSync(result.outputPath)).toBe(true);
  });

  // ----------------------------------------------------------
  // AC-28: Same source built twice produces identical checksums
  // ----------------------------------------------------------
  it('same source built twice produces identical checksums [AC-28]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();
    const outputDir2 = await makeTmpDir();

    const result1 = await buildAgent(projectDir, { outputDir });
    const result2 = await buildAgent(projectDir, { outputDir: outputDir2 });

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
          name: 'ext-agent',
          version: '0.1.0',
          main: 'main.rill:run',
          extensions: { mounts: { myExt: './my-ext.ts' } },
        },
        null,
        2
      ),
      'utf-8'
    );

    const result = await buildAgent(projectDir, { outputDir });

    // Compiled extension file must exist inside agent dir
    const compiledPath = path.join(result.outputPath, 'extensions', 'myExt.js');
    expect(existsSync(compiledPath)).toBe(true);

    // Output rill-config.json must have rewritten mount path
    const rillConfigPath = path.join(result.outputPath, 'rill-config.json');
    const raw = await readFile(rillConfigPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ext = parsed['extensions'] as Record<string, unknown>;
    const mounts = ext['mounts'] as Record<string, string>;
    expect(mounts['myExt']).toBe('./extensions/myExt.js');
  });

  // ----------------------------------------------------------
  // AC-29: No Dockerfile, .zip, deployment artifacts in output
  // ----------------------------------------------------------
  it('produces no Dockerfile, .zip, or deployment artifacts [AC-29]', async () => {
    const { projectDir, outputDir } = await makeProjectFixture();

    await buildAgent(projectDir, { outputDir });

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

    const result = await buildAgent(projectDir, { outputDir });

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

describe('buildAgent error cases', () => {
  // ----------------------------------------------------------
  // AC-47: rill-config.json not found → BuildError('validation')
  // ----------------------------------------------------------
  it('throws BuildError phase validation when rill-config.json is missing [AC-47]', async () => {
    const outputDir = await makeTmpDir();
    const nonExistentDir = path.join(outputDir, 'does-not-exist');

    await expect(buildAgent(nonExistentDir, { outputDir })).rejects.toSatisfy(
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

    await expect(buildAgent(projectDir, { outputDir })).rejects.toSatisfy(
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

    await expect(buildAgent(projectDir, { outputDir })).rejects.toSatisfy(
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

    await expect(buildAgent(projectDir, { outputDir })).rejects.toSatisfy(
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

    await expect(buildAgent(projectDir, { outputDir })).rejects.toSatisfy(
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
          buildAgent(projectDir, { outputDir: blockedOutputDir })
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

describe('buildAgent boundary conditions', () => {
  // ----------------------------------------------------------
  // Name defaults to directory basename when not in config
  // ----------------------------------------------------------
  it('uses directory basename as agent name when name field absent', async () => {
    const projectDir = await makeTmpDir();
    const outputDir = await makeTmpDir();
    const dirName = path.basename(projectDir);

    await writeFile(
      path.join(projectDir, 'rill-config.json'),
      JSON.stringify({ version: '0.1.0', main: 'main.rill:run' }),
      'utf-8'
    );
    await writeFile(path.join(projectDir, 'main.rill'), `"hello"`, 'utf-8');

    const result = await buildAgent(projectDir, { outputDir });

    // Agent dir is named after the project directory
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
          name: 'multi-ext-agent',
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

    const result = await buildAgent(projectDir, { outputDir });

    const extensionsDir = path.join(result.outputPath, 'extensions');
    expect(existsSync(path.join(extensionsDir, 'extAlpha.js'))).toBe(true);
    expect(existsSync(path.join(extensionsDir, 'extBeta.js'))).toBe(true);
    expect(existsSync(path.join(extensionsDir, 'extGamma.js'))).toBe(true);
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

    await expect(buildAgent(projectDir, { outputDir })).rejects.toSatisfy(
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
