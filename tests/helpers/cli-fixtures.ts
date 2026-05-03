import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function captureOutput(): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (chunk: string) => {
    stdout.push(chunk);
    return true;
  };
  (process.stderr.write as unknown) = (chunk: string) => {
    stderr.push(chunk);
    return true;
  };
  return {
    stdout,
    stderr,
    restore: () => {
      (process.stdout.write as unknown) = origOut;
      (process.stderr.write as unknown) = origErr;
    },
  };
}

export function bootstrapProject(
  dir: string,
  mounts: Record<string, string> = {}
): void {
  const rillNpm = path.join(dir, '.rill', 'npm');
  fs.mkdirSync(rillNpm, { recursive: true });
  fs.writeFileSync(
    path.join(rillNpm, 'package.json'),
    '{"name":"rill-extensions","private":true}\n',
    'utf8'
  );
  const config = {
    name: path.basename(dir),
    main: 'main.rill',
    extensions: { mounts },
  };
  fs.writeFileSync(
    path.join(dir, 'rill-config.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf8'
  );
}
