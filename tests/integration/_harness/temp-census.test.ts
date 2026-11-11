/**
 * The temp-dir census, end to end: a real vitest run with this repo's
 * global-setup, on one test file that leaves a temp dir behind and one that
 * leaves nothing. The leaky file fails with the census's message, the clean
 * one passes, and both files' temp roots are gone afterwards.
 *
 * The run's root is a temp dir with its own config (only the setup file), so
 * it never reads the repo's vitest.config.ts or its test globs.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

describe('the temp-dir census on a real vitest run', () => {
  it('fails a file that leaves a temp dir, passes a clean one, and removes both roots', () => {
    const root = createTempDir('vc-census-run-');
    // Where the run's own temp roots go: the child's os.tmpdir().
    const outerTmp = createTempDir('vc-census-outer-');
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      `export default { test: { globals: true, include: ['*.test.mjs'], setupFiles: [${JSON.stringify(
        join(REPO_ROOT, 'tests/setup/global-setup.ts'),
      )}] } };\n`,
    );
    writeFileSync(
      join(root, 'leaky.test.mjs'),
      "import { mkdtempSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\n" +
        "it('makes a temp dir and keeps it', () => { mkdtempSync(join(tmpdir(), 'vc-leaky-')); });\n",
    );
    writeFileSync(
      join(root, 'clean.test.mjs'),
      "it('makes nothing', () => { expect(1).toBe(1); });\n",
    );

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
    const out = `${run.stdout}\n${run.stderr}`;

    expect(run.status).toBe(1);
    expect(out).toMatch(/this file's tests left vc-leaky-\w+ in the temp dir \(removed now\)/);
    expect(out).toMatch(/leaky\.test\.mjs/);
    expect(out).toMatch(/1 passed/);
    // Each file's root (vc-test-*) is removed, the failing one's too.
    expect(readdirSync(outerTmp)).toEqual([]);
  }, 120_000);
});
