/**
 * A CLI child a test spawns writes its state into the test file's
 * VIBECARBON_HOME (tests/setup/global-setup.ts), never into ~/.vibecarbon.
 *
 * `deploy prod` refused outside a project still opens its deploy log, so it
 * is the cheapest real writer: 751 of these logs had piled up in one
 * developer's ~/.vibecarbon/logs from not-in-project.test.ts alone. The
 * child gets a fresh HOME as well, so a path still built from the home dir
 * shows up there instead of going unseen.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../_shared/source-files.js';
import { cleanupTempDir, createTempDir } from '../../../_shared/temp-dir.js';

const CLI = join(REPO_ROOT, 'src', 'cli.js');
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) cleanupTempDir(d);
});

describe('VIBECARBON_HOME in CLI children', () => {
  it('takes the deploy log, and the home dir gets nothing', () => {
    const vcHome = process.env.VIBECARBON_HOME as string;
    expect(vcHome).toBeTruthy();
    const home = createTempDir('vc-home-probe-');
    const cwd = createTempDir('vc-not-a-project-');
    dirs.push(home, cwd);
    const logsBefore = existsSync(join(vcHome, 'logs')) ? readdirSync(join(vcHome, 'logs')) : [];

    const r = spawnSync(process.execPath, [CLI, 'deploy', 'prod'], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(r.status).not.toBe(0);
    const logsAfter = readdirSync(join(vcHome, 'logs'));
    const added = logsAfter.filter((f) => !logsBefore.includes(f));
    expect(added.some((f) => /^prod-.*\.log$/.test(f))).toBe(true);
    expect(existsSync(join(home, '.vibecarbon'))).toBe(false);
  });
});
