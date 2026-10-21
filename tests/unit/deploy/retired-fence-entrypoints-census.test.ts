/**
 * Every HA entry point re-applies the retirement fence (HA-correctness Task 6, R7).
 *
 * The fence is self-enforcing only once it is on the node, and an old primary
 * that was unreachable during the failover gets it from whichever command next
 * reaches it. So `status`, `failover` and the deploy orchestrator each call
 * `reconcileRetiredFence` for HA tiers, and failover calls it again once the
 * role swap is saved (the moment the old primary becomes the retired side).
 *
 * The fence is cleared in exactly two places, both after the retired side has
 * been rebuilt as a proven replica: the compose reconverge's finalize and the
 * k8s-ha deploy after its streaming gate. Anywhere else would re-open the
 * window this closes. And a deploy refuses while a failover journal is set, on
 * every HA tier: its final save rebuilds `ha` and would drop the journal.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertNoFailoverInFlight } from '../../../src/lib/deploy/failover-guard.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf-8');

/** Source with comments stripped, so a commented-out call does not count. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const calls = (src: string, fn: string) => (src.match(new RegExp(`\\b${fn}\\(`, 'g')) ?? []).length;

/** The body of `async function <name>(` up to the next top-level function. */
function fnBody(src: string, name: string) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) return '';
  const next = src.slice(start + 1).search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

describe('reconcileRetiredFence runs at every HA entry point', () => {
  it('status calls it for each HA environment', () => {
    const src = code('src/status.js');
    expect(calls(src, 'reconcileRetiredFence')).toBeGreaterThanOrEqual(1);
  });

  it('the deploy orchestrator calls it in executeDeployment for HA tiers', () => {
    const body = fnBody(code('src/lib/deploy/orchestrator.js'), 'executeDeployment');
    expect(calls(body, 'reconcileRetiredFence')).toBeGreaterThanOrEqual(1);
  });

  it('failover calls it at entry (run) and again after the swap, on both tiers', () => {
    const failover = code('src/failover.js');
    expect(calls(fnBody(failover, 'run'), 'reconcileRetiredFence')).toBeGreaterThanOrEqual(1);
    const k8s = fnBody(failover, 'failoverHA');
    expect(k8s.indexOf('reconcileRetired(')).toBeGreaterThan(k8s.indexOf('swapRoles('));
    const compose = fnBody(code('src/lib/deploy/compose/ha.js'), 'failoverComposeHA');
    expect(compose.indexOf('reconcileRetired(')).toBeGreaterThan(compose.indexOf('swapRoles('));
  });

  it('the compose reconverge keeps the retired node fenced until its reseed', () => {
    const effects = code('src/lib/deploy/effects/compose-ha.js');
    expect(calls(fnBody(effects, 'reconvergeStandbyStack'), 'fenceRetiredNode')).toBe(1);
  });
});

describe('the fence is cleared only once the retired side is a proven replica', () => {
  const callers = [
    'src/status.js',
    'src/failover.js',
    'src/restore.js',
    'src/scale.js',
    'src/lib/deploy/compose/ha.js',
    'src/lib/deploy/effects/compose-ha.js',
    'src/lib/deploy/effects/k8s-ha.js',
    'src/lib/deploy/orchestrator.js',
  ];

  it('clearRetiredFence is called from haFinalizeConfig only, and the k8s-ha deploy through finishK8sRetiredFence', () => {
    const where: string[] = [];
    for (const rel of callers) {
      const n = calls(code(rel), 'clearRetiredFence');
      if (n > 0) where.push(`${rel}:${n}`);
    }
    expect(where).toEqual(['src/lib/deploy/effects/compose-ha.js:1']);
    const effects = code('src/lib/deploy/effects/compose-ha.js');
    expect(calls(fnBody(effects, 'haFinalizeConfig'), 'clearRetiredFence')).toBe(1);
    // k8s: once in executeDeployment, before its final save.
    const body = fnBody(code('src/lib/deploy/orchestrator.js'), 'executeDeployment');
    expect(calls(body, 'finishK8sRetiredFence')).toBe(1);
    expect(body.indexOf('finishK8sRetiredFence(')).toBeLessThan(
      body.indexOf('saveProjectConfig(clearDestroyedRecord('),
    );
  });
});

describe('deploy refuses while a failover journal is set, on every HA tier', () => {
  it('assertNoFailoverInFlight throws naming vibecarbon failover', () => {
    for (const deployMode of ['compose-ha', 'kubernetes']) {
      expect(() =>
        assertNoFailoverInFlight({
          environment: 'prod',
          envConfig: { deployMode, ha: { failoverInFlight: { id: 'x', target: 'standby' } } },
        }),
      ).toThrow(/a failover is still in flight .*run vibecarbon failover prod to finish it/);
    }
    expect(() =>
      assertNoFailoverInFlight({ environment: 'prod', envConfig: { ha: { enabled: true } } }),
    ).not.toThrow();
  });

  it('executeDeployment calls it for HA tiers, before reconcileRetiredFence', () => {
    const body = fnBody(code('src/lib/deploy/orchestrator.js'), 'executeDeployment');
    const refuse = body.indexOf('assertNoFailoverInFlight(');
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(body.indexOf('reconcileRetiredFence('));
  });

  it('the compose reconverge planner uses the same rule', () => {
    const src = code('src/lib/deploy/compose/ha-role-swap.js');
    const start = src.indexOf('export function planComposeHaReconverge(');
    const body = src.slice(start, src.indexOf('\nexport ', start + 1));
    expect(calls(body, 'assertNoFailoverInFlight')).toBe(1);
  });
});
