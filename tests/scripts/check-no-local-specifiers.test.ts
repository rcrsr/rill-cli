/**
 * Rill CLI Tests: scripts/check-no-local-specifiers.mjs
 *
 * Spawns the script as a child process rather than importing it, since it is
 * a plain .mjs file outside the TypeScript/NodeNext module graph.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('check-no-local-specifiers', () => {
  let tempDir: string;
  const scriptPath = path.join(
    process.cwd(),
    'scripts',
    'check-no-local-specifiers.mjs'
  );

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'check-no-local-specifiers-test-')
    );
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Write a fixture package.json to the temp directory and return its path.
   */
  async function writeFixture(
    name: string,
    contents: Record<string, unknown>
  ): Promise<string> {
    const filePath = path.join(tempDir, name);
    await fs.writeFile(filePath, JSON.stringify(contents, null, 2), 'utf-8');
    return filePath;
  }

  /**
   * Execute the check script and capture exit code, stdout, and stderr.
   */
  async function execCheck(
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const env = { ...process.env };
      delete env['VITEST'];
      delete env['VITEST_WORKER_ID'];
      delete env['NODE_ENV'];
      const proc = spawn('node', [scriptPath, ...args], {
        cwd: process.cwd(),
        env,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
        });
      });
    });
  }

  it('exits 0 when all specifiers are semver ranges', async () => {
    const fixturePath = await writeFixture('all-semver.json', {
      name: 'fixture',
      version: '1.0.0',
      dependencies: {
        'some-dep': '^1.0.0',
      },
      devDependencies: {
        'some-dev-dep': '~2.0.0',
      },
      peerDependencies: {
        'some-peer-dep': '~0.19.5',
      },
      optionalDependencies: {
        'some-optional-dep': '^3.0.0',
      },
    });

    const result = await execCheck([fixturePath]);

    expect(result.exitCode).toBe(0);
  });

  it('exits 1 when dependencies contains a link: specifier', async () => {
    const fixturePath = await writeFixture('link-in-dependencies.json', {
      name: 'fixture',
      version: '1.0.0',
      dependencies: {
        'local-dep': 'link:../local-dep',
      },
    });

    const result = await execCheck([fixturePath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('dependencies');
    expect(result.stderr).toContain('local-dep');
    expect(result.stderr).toContain('link:../local-dep');
  });

  it('exits 1 when devDependencies contains a file: specifier', async () => {
    const fixturePath = await writeFixture('file-in-devDependencies.json', {
      name: 'fixture',
      version: '1.0.0',
      devDependencies: {
        'local-dev-dep': 'file:../local-dev-dep',
      },
    });

    const result = await execCheck([fixturePath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('devDependencies');
  });

  it('exits 1 when peerDependencies contains a link: specifier', async () => {
    const fixturePath = await writeFixture('link-in-peerDependencies.json', {
      name: 'fixture',
      version: '1.0.0',
      peerDependencies: {
        'local-peer-dep': 'link:../local-peer-dep',
      },
    });

    const result = await execCheck([fixturePath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('peerDependencies');
  });

  it('exits 0 without crashing when optionalDependencies is absent', async () => {
    const fixturePath = await writeFixture('no-optional.json', {
      name: 'fixture',
      version: '1.0.0',
      dependencies: {
        'some-dep': '^1.0.0',
      },
    });

    const result = await execCheck([fixturePath]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  // Guards the DEBT-2b terminal state: every dependency section resolves from
  // npm. This is the assertion that fails if a link:/file: specifier is ever
  // reintroduced into the repo's own manifest.
  it('exits 0 against the repo package.json now that every section is npm-pinned', async () => {
    const result = await execCheck([]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });
});
