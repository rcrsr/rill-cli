/**
 * AC-11 / NFR-EXT-7: loadProject succeeds on a valid bootstrapped fixture.
 * IR-19: loadExtensions with prefix resolves extensions from .rill/npm/node_modules/.
 *
 * Verifies that calling loadProject with prefix=<projectDir>/.rill/npm resolves
 * correctly for both empty-mounts (AC-11) and non-empty-mounts (IR-19) cases.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadProject } from '@rcrsr/rill-config';

// ---------------------------------------------------------------------------
// Temp dir cleanup
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);

async function makeProjectDir(suffix: string): Promise<string> {
  const dir = path.join(tmpdir(), `rill-loadproject-${suffix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

async function bootstrapRillNpm(projectDir: string): Promise<string> {
  const prefix = path.join(projectDir, '.rill', 'npm');
  await mkdir(prefix, { recursive: true });
  await writeFile(
    path.join(prefix, 'package.json'),
    JSON.stringify({ name: 'rill-extensions', private: true }, null, 2),
    'utf-8'
  );
  return prefix;
}

// ============================================================
// AC-11: loadProject succeeds on valid bootstrapped fixture (empty mounts)
// ============================================================

describe('AC-11: loadProject succeeds on valid bootstrapped fixture (NFR-EXT-7)', () => {
  const VALID_RILL_CONFIG = JSON.stringify(
    {
      name: 'loadproject-test',
      main: 'main.rill',
      extensions: { mounts: {} },
    },
    null,
    2
  );

  it('resolves without error when called with prefix=<projectDir>/.rill/npm', async () => {
    const projectDir = await makeProjectDir('a');
    const prefix = await bootstrapRillNpm(projectDir);

    const configPath = path.join(projectDir, 'rill-config.json');
    await writeFile(configPath, VALID_RILL_CONFIG, 'utf-8');

    const result = await loadProject({
      configPath,
      rillVersion: '0.0.0-test',
      prefix,
    });

    expect(result.config).toBeDefined();
    expect((result.config as Record<string, unknown>)['name']).toBe(
      'loadproject-test'
    );

    for (const dispose of result.disposes) {
      await dispose();
    }
  });

  it('resolves non-empty mounts and loads extensions from .rill/npm/node_modules', async () => {
    const projectDir = await makeProjectDir('c');
    const prefix = await bootstrapRillNpm(projectDir);

    // Populate .rill/npm/node_modules/@rcrsr/rill-ext-datetime via symlink
    const pkgScopeDir = path.join(prefix, 'node_modules', '@rcrsr');
    await mkdir(pkgScopeDir, { recursive: true });
    const actualPkgPath = path.dirname(
      _require.resolve('@rcrsr/rill-ext-datetime/package.json')
    );
    await symlink(actualPkgPath, path.join(pkgScopeDir, 'rill-ext-datetime'));

    const configPath = path.join(projectDir, 'rill-config.json');
    await writeFile(
      configPath,
      JSON.stringify(
        {
          name: 'loadproject-ac11-test',
          main: 'main.rill',
          extensions: { mounts: { dt: '@rcrsr/rill-ext-datetime' } },
        },
        null,
        2
      ),
      'utf-8'
    );

    const result = await loadProject({
      configPath,
      rillVersion: '0.0.0-test',
      prefix,
    });

    expect(result.disposes.length).toBeGreaterThan(0);
    expect(result.extTree).toHaveProperty('dt');

    for (const dispose of result.disposes) {
      await dispose();
    }
  });
});

// ============================================================
// IR-19: loadExtensions with prefix resolves from .rill/npm/node_modules/
// ============================================================

describe('IR-19: loadProject resolves non-empty mounts via prefix (.rill/npm)', () => {
  it('loads @rcrsr/rill-ext-datetime from .rill/npm/node_modules when prefix is set', async () => {
    const projectDir = await makeProjectDir('ir19');
    const prefix = await bootstrapRillNpm(projectDir);

    // Populate .rill/npm/node_modules/@rcrsr/rill-ext-datetime via symlink
    const pkgScopeDir = path.join(prefix, 'node_modules', '@rcrsr');
    await mkdir(pkgScopeDir, { recursive: true });
    const actualPkgPath = path.dirname(
      _require.resolve('@rcrsr/rill-ext-datetime/package.json')
    );
    await symlink(actualPkgPath, path.join(pkgScopeDir, 'rill-ext-datetime'));

    const configPath = path.join(projectDir, 'rill-config.json');
    await writeFile(
      configPath,
      JSON.stringify(
        {
          name: 'loadproject-ir19-test',
          main: 'main.rill',
          extensions: { mounts: { dt: '@rcrsr/rill-ext-datetime' } },
        },
        null,
        2
      ),
      'utf-8'
    );

    // --- Act ---
    const result = await loadProject({
      configPath,
      rillVersion: '0.0.0-test',
      prefix,
    });

    // --- Assert ---
    // Extension was loaded: disposes is non-empty and extTree has dt entry
    expect(result.disposes.length).toBeGreaterThan(0);
    expect(result.extTree).toHaveProperty('dt');

    for (const dispose of result.disposes) {
      await dispose();
    }
  });
});
