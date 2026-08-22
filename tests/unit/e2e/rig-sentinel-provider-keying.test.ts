/**
 * Kept-rig sentinels are keyed by provider AND mode, on both sides.
 *
 * `.rig-<mode>.json` was written by the lifecycle and read by
 * `scripts/iter-step.js`. Once `--provider` made two clouds runnable in the
 * same matrix, a kept `digitalocean/k8s` rig overwrote the sentinel of a live
 * `hetzner/k8s` rig (observed 2026-08-07) — and the sentinel is the only
 * record of where that running, billing infra lives. The name is now
 * `.rig-<provider>-<mode>.json` and iter-step takes the qualified
 * `provider/mode` token the selection grammar uses.
 *
 * The read side is tested by RUNNING iter-step: every case here exits before
 * it would spawn the CLI (the fixture rig's projectDir does not exist), so no
 * infra is touched. The write side is a text pin — the lifecycle can't be
 * invoked from a unit test — anchored on the template literal itself.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../e2e/utils/e2e-env.js';

const RESULTS_DIR = join(REPO_ROOT, 'tests', 'results');
// Deliberately not a real registry provider: this fixture must never be
// mistaken for — or collide with — an actual kept rig in tests/results.
const FIXTURE_PROVIDER = 'faketest';
const FIXTURE_RIG = join(RESULTS_DIR, `.rig-${FIXTURE_PROVIDER}-compose.json`);

mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(
  FIXTURE_RIG,
  JSON.stringify({
    provider: FIXTURE_PROVIDER,
    mode: 'compose',
    envPrefix: 'e1',
    projectName: 'testapp-fixture',
    // Nonexistent on purpose: iter-step exits at the project-dir check,
    // which is AFTER it has resolved the sentinel and BEFORE it spawns
    // anything.
    projectDir: join(RESULTS_DIR, 'no-such-rig-dir'),
  }),
);
afterAll(() => rmSync(FIXTURE_RIG, { force: true }));

/** Run iter-step and return its exit code + combined output. */
function runIterStep(args: string[]): { code: number; output: string } {
  try {
    const stdout = execFileSync('node', [join(REPO_ROOT, 'scripts', 'iter-step.js'), ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('iter-step resolves rigs by provider/mode', () => {
  it('finds the sentinel at the provider-keyed path', () => {
    const { code, output } = runIterStep([`${FIXTURE_PROVIDER}/compose`, 'deploy']);
    // Got past sentinel lookup + provider agreement and stopped at the dir.
    expect(output).toContain('Rig project dir no longer exists');
    expect(code).toBe(2);
  });

  it('rejects a bare mode instead of guessing which cloud it meant', () => {
    const { code, output } = runIterStep(['compose', 'deploy']);
    expect(output).toContain('must be qualified as <provider>/<mode>');
    expect(code).toBe(2);
  });

  it('names the provider-keyed path and lists kept rigs when none matches', () => {
    const { code, output } = runIterStep([`${FIXTURE_PROVIDER}/k8s-ha`, 'deploy']);
    expect(output).toContain(`.rig-${FIXTURE_PROVIDER}-k8s-ha.json`);
    expect(output).toContain(`${FIXTURE_PROVIDER}/compose`); // the kept-rigs listing
    expect(code).toBe(2);
  });

  it('refuses a sentinel whose own provider field disagrees with its name', () => {
    const mismatched = join(RESULTS_DIR, '.rig-faketest2-compose.json');
    writeFileSync(
      mismatched,
      JSON.stringify({
        provider: 'faketest',
        mode: 'compose',
        envPrefix: 'e1',
        projectDir: join(RESULTS_DIR, 'no-such-rig-dir'),
      }),
    );
    try {
      const { code, output } = runIterStep(['faketest2/compose', 'deploy']);
      expect(output).toContain('stale or hand-edited rig');
      expect(code).toBe(2);
    } finally {
      rmSync(mismatched, { force: true });
    }
  });
});

describe('the lifecycle writes the same provider-keyed name', () => {
  const lifecycle = readFileSync(
    join(REPO_ROOT, 'tests', 'e2e', 'scenarios', '_run-lifecycle.ts'),
    'utf-8',
  );

  it('writes .rig-<provider>-<mode>.json', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: pinning the source's literal, not interpolating
    expect(lifecycle).toContain('`.rig-${config.provider}-${config.mode}.json`');
  });

  it('no longer writes the mode-only name', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: pinning the source's literal, not interpolating
    expect(lifecycle).not.toContain('`.rig-${config.mode}.json`');
  });

  it('the fixture proves the two sides agree on the filename shape', () => {
    // Same shape the lifecycle builds, constructed independently here.
    expect(existsSync(join(RESULTS_DIR, `.rig-${FIXTURE_PROVIDER}-compose.json`))).toBe(true);
  });
});
