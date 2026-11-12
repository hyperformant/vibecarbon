/**
 * The temp-dir census, end to end: real vitest runs with this repo's
 * global-setup.
 *
 * - A file that leaves a temp dir fails with the census's message, a clean one
 *   passes, and both files' temp roots are gone afterwards.
 * - A run that reuses one worker for several files (isolate: false) fails
 *   fast: the reused worker's os.tmpdir() no longer points at the file's own
 *   temp root, so the census would look at an empty dir and pass anything.
 * - A census that cannot finish (a test removed its own temp dir) still fails
 *   the file with a message and removes the file's temp root.
 * - A tracked temp dir that cannot be removed (a test locked it) fails the
 *   file with a message, and the census still runs after it.
 *
 * Each run's root is a temp dir with its own config (only the setup file), so
 * it never reads the repo's vitest.config.ts or its test globs.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** Make every dir under `dir` writable again, so it can be removed. */
function unlockAll(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    chmodSync(p, 0o700);
    unlockAll(p);
  }
}

/**
 * Run vitest on `files` (name to source) with the repo's global-setup and
 * `testOptions` merged into the config. Returns the exit status, the output,
 * and what the run left in its own os.tmpdir().
 */
function runVitest(files: Record<string, string>, testOptions: Record<string, unknown> = {}) {
  const root = createTempDir('vc-census-run-');
  // Where the run's own temp roots go: the child's os.tmpdir().
  const outerTmp = createTempDir('vc-census-outer-');
  const config = {
    globals: true,
    include: ['*.test.mjs'],
    setupFiles: [join(REPO_ROOT, 'tests/setup/global-setup.ts')],
    ...testOptions,
  };
  writeFileSync(
    join(root, 'vitest.config.mjs'),
    `export default { test: ${JSON.stringify(config)} };\n`,
  );
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);

  const run = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--root',
      root,
      '--config',
      join(root, 'vitest.config.mjs'),
    ],
    {
      cwd: root,
      encoding: 'utf-8',
      env: { ...process.env, TMPDIR: outerTmp, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' },
      timeout: 120_000,
    },
  );
  return {
    status: run.status,
    out: `${run.stdout}\n${run.stderr}`,
    left: readdirSync(outerTmp),
    outerTmp,
  };
}

const CLEAN = "it('makes nothing', () => { expect(1).toBe(1); });\n";

describe('the temp-dir census on a real vitest run', () => {
  it('fails a file that leaves a temp dir, passes a clean one, and removes both roots', () => {
    const run = runVitest({
      'leaky.test.mjs':
        "import { mkdtempSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\n" +
        "it('makes a temp dir and keeps it', () => { mkdtempSync(join(tmpdir(), 'vc-leaky-')); });\n",
      'clean.test.mjs': CLEAN,
    });

    expect(run.status).toBe(1);
    expect(run.out).toMatch(/this file's tests left vc-leaky-\w+ in the temp dir \(removed now\)/);
    expect(run.out).toMatch(/leaky\.test\.mjs/);
    expect(run.out).toMatch(/1 passed/);
    // Each file's root (vc-test-*) is removed, the failing one's too.
    expect(run.left).toEqual([]);
  }, 120_000);

  it('fails fast when one worker runs several files, and leaves no root behind', () => {
    const run = runVitest(
      { 'a.test.mjs': CLEAN, 'b.test.mjs': CLEAN },
      { isolate: false, maxWorkers: 1, fileParallelism: false },
    );

    expect(run.status).toBe(1);
    expect(run.out).toMatch(
      /the temp census needs each test file in its own worker process, but os\.tmpdir\(\) is \S+ here, not this file's \S+: the worker was reused \(isolate: false\)/,
    );
    expect(run.left).toEqual([]);
  }, 120_000);

  it('fails a file whose census cannot finish, and still removes its root', () => {
    const run = runVitest({
      'gone.test.mjs':
        "import { rmSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\n" +
        "it('removes its own temp dir', () => { rmSync(tmpdir(), { recursive: true }); });\n",
    });

    expect(run.status).toBe(1);
    expect(run.out).toMatch(/the temp census could not finish \(ENOENT/);
    expect(run.left).toEqual([]);
  }, 120_000);

  it.skipIf(isRoot)(
    'fails a file whose temp dirs cannot be removed, and still runs the census',
    () => {
      const run = runVitest({
        'locked.test.mjs':
          "import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\n" +
          `import { createTempDir } from ${JSON.stringify(join(REPO_ROOT, 'tests/_shared/temp-dir.ts'))};\n` +
          "it('locks a dir it made', () => {\n  const d = createTempDir('vc-locked-');\n" +
          "  mkdirSync(join(d, 'locked'));\n  writeFileSync(join(d, 'locked', 'f'), '');\n" +
          "  chmodSync(join(d, 'locked'), 0o500);\n});\n",
      });
      try {
        expect(run.status).toBe(1);
        expect(run.out).toMatch(
          /the temp dirs this file's tests made could not all be removed \(EACCES/,
        );
        // The census ran after it (and could not remove the locked dir either).
        expect(run.out).toMatch(/the temp census could not finish \(EACCES/);
      } finally {
        unlockAll(run.outerTmp);
      }
    },
    120_000,
  );
});
