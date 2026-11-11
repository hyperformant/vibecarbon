/**
 * The exit sweep (src/lib/temp-dir.js) on real processes: a temp dir still
 * live when the process exits is removed, on each way a vibecarbon process
 * ends. A Ctrl-C is the one that matters most: cli.js answers SIGINT with
 * process.exit(130) at once, so no finally block runs, and a deploy killed
 * mid-plan used to leave its bundle (the app's .env) behind.
 *
 * Each child loads the real cli.js (its SIGINT handler) and temp-dir.js, makes
 * a temp dir holding a file, prints the dir, then ends one way. The children
 * inherit this file's TMPDIR, so the census sees anything they leave.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const url = (rel: string) => pathToFileURL(join(REPO_ROOT, rel)).href;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** Run a child whose body runs after a temp dir `dir` holding `.env` exists. */
function child(body: string, { onDir }: { onDir?: (proc: ReturnType<typeof spawn>) => void } = {}) {
  const scripts = createTempDir('vc-exit-sweep-script-');
  const script = join(scripts, 'child.mjs');
  writeFileSync(
    script,
    [
      `await import(${JSON.stringify(url('src/cli.js'))});`,
      `const { makeTempDir } = await import(${JSON.stringify(url('src/lib/temp-dir.js'))});`,
      "const { chmodSync, mkdirSync, writeFileSync } = await import('node:fs');",
      "const { join } = await import('node:path');",
      "const dir = makeTempDir('vc-deploy-bundle-');",
      "writeFileSync(join(dir, '.env'), 'SECRET=not-a-real-secret\\n');",
      body,
      '',
    ].join('\n'),
  );
  return new Promise<{ code: number | null; dir: string; stderr: string }>((done, fail) => {
    const proc = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let told = false;
    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!told && stdout.includes('\n')) {
        told = true;
        onDir?.(proc);
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    proc.on('error', fail);
    proc.on('close', (code) => done({ code, dir: stdout.split('\n')[0], stderr }));
  });
}

describe('the exit sweep on real processes', () => {
  it('a Ctrl-C through the CLI handler (exit 130, no finally) removes a live dir', async () => {
    const r = await child('console.log(dir);\nsetInterval(() => {}, 1000);', {
      onDir: (proc) => proc.kill('SIGINT'),
    });
    expect(r.code).toBe(130);
    expect(r.dir).toMatch(/vc-deploy-bundle-/);
    expect(existsSync(r.dir)).toBe(false);
  }, 30_000);

  it('a failure exit (cli.js exits 1 after printing the error) removes a live dir', async () => {
    const r = await child('console.log(dir);\nprocess.exit(1);');
    expect(r.code).toBe(1);
    expect(existsSync(r.dir)).toBe(false);
  }, 30_000);

  it('a natural end removes a live dir', async () => {
    const r = await child('console.log(dir);');
    expect(r.code).toBe(0);
    expect(existsSync(r.dir)).toBe(false);
  }, 30_000);

  it.skipIf(isRoot)(
    'a dir it cannot remove is named on stderr',
    async () => {
      const r = await child(
        [
          "const locked = join(dir, 'locked');",
          'mkdirSync(locked);',
          "writeFileSync(join(locked, 'f'), '');",
          'chmodSync(locked, 0o500);',
          'console.log(dir);',
        ].join('\n'),
      );
      try {
        expect(r.code).toBe(0);
        expect(existsSync(r.dir)).toBe(true);
        expect(r.stderr).toContain(r.dir);
        expect(r.stderr).toMatch(/could not remove its temp dir/);
      } finally {
        chmodSync(join(r.dir, 'locked'), 0o700);
        rmSync(r.dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
