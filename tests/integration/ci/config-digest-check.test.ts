/**
 * Executes the "Check the pushed image is the smoke-tested one" step of
 * .github/workflows/native-multiarch-image.yml exactly as written, under bash
 * with the step's SMOKED/PUSHED inputs. The step is the only thing between a
 * pushed digest and the merge, so it must fail closed: a missing digest on
 * either side, or two different ones, exits non-zero; only two equal,
 * non-empty digests pass. (Static pins live in
 * tests/unit/deploy/workflow-platforms.test.ts.)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

type Step = { name?: string; run?: string };
const wf = loadYaml(
  readFileSync(join(process.cwd(), '.github/workflows/native-multiarch-image.yml'), 'utf8'),
) as { jobs: { build: { steps: Step[] } } };
const script = wf.jobs.build.steps.find(
  (s) => s.name === 'Check the pushed image is the smoke-tested one',
)?.run;

function check(SMOKED: string, PUSHED: string) {
  return spawnSync('bash', ['-c', script ?? 'exit 99'], {
    env: { PATH: process.env.PATH, SMOKED, PUSHED },
    encoding: 'utf8',
  });
}

const A = 'sha256:aaaa';
const B = 'sha256:bbbb';

describe('config digest check step', () => {
  it('is found in the workflow', () => {
    expect(script).toBeTruthy();
  });

  it('both digests missing: fails (two empty strings must not compare equal)', () => {
    const r = check('', '');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('smoke build reported no image config digest');
  });

  it('only the pushed digest missing: fails', () => {
    const r = check(A, '');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('push build reported no image config digest');
  });

  it('only the smoked digest missing: fails', () => {
    expect(check('', A).status).not.toBe(0);
  });

  it('different digests: fails', () => {
    const r = check(A, B);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('is not the smoke-tested');
  });

  it('equal digests: passes', () => {
    expect(check(A, A).status).toBe(0);
  });
});
