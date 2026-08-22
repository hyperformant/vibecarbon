/**
 * Stack-state cleanup census — every tier's destroy plan must reconcile
 * Pulumi state with the teardown it just performed.
 *
 * The class (e2e run 32309395314, vultr compose restore, 2026-08-19):
 * a destroy path that reaps Pulumi-provisioned resources out-of-band and
 * leaves the stack state describing them, in a backend that persists across
 * destroys (717d49e7). Every tier provisions via `upStack`
 * (compose: effects/index.js; compose-ha: effects/compose-ha.js;
 * k8s/k8s-ha: k8s/k3s.js + iac/converge-cluster.js), so every tier's
 * destroy needs a stack-cleanup member:
 *   - k8s tiers: destroyStack inside `destroy-k8s-infra` runs
 *     `pulumi destroy` + `removeStack` (pinned by
 *     tests/unit/iac/destroy-stack-partial-detection.test.ts);
 *   - compose tiers: the `remove-stack-state` step (removeStackState,
 *     pinned by tests/unit/destroy/remove-stack-state-effect.test.ts).
 *
 * Walking TIERS (not a hand-list) drafts future tiers into the audited set:
 * a new tier whose plan lacks a recognized stack-cleanup step fails here
 * until it declares one.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import { DESTROY_EFFECTS } from '../../../src/destroy.js';
import { planDestroy } from '../../../src/lib/deploy/plan/destroy-plan.js';
import { pulumiStackEnvs, TIERS } from '../../../src/lib/deploy/tier-registry.js';

// The effects known to reconcile Pulumi stack state, and the proof for each.
const STACK_CLEANUP_EFFECTS = new Set([
  // destroyStack: `pulumi destroy` + workspace.removeStack, per stackEnv.
  'destroyK8sInfra',
  // removeStackState: state-only removal after the out-of-band API reap.
  'removePulumiStackState',
]);

describe('stack-state cleanup census (every tier reconciles Pulumi state at destroy)', () => {
  it.each(TIERS)('tier %s plans a stack-cleanup step', (tier) => {
    const effects = planDestroy(tier, {}).map((step) => step.effect);
    const cleanup = effects.filter((e) => STACK_CLEANUP_EFFECTS.has(e));
    expect(
      cleanup,
      `tier "${tier}" destroy plan has no stack-cleanup step — its deploy writes Pulumi ` +
        'stacks (upStack), and a retained state bucket makes an unreconciled stack fail ' +
        'the next re-deploy on providers whose refresh cannot prune deleted resources',
    ).not.toHaveLength(0);
  });

  it('every stack-cleanup effect named here resolves in DESTROY_EFFECTS', () => {
    for (const effect of STACK_CLEANUP_EFFECTS) {
      expect(DESTROY_EFFECTS[effect], `effect "${effect}" missing from registry`).toBeTypeOf(
        'function',
      );
    }
  });

  // pulumiStackEnvs is the single source for WHICH stacks a tier's destroy
  // must reconcile. It must tell the truth about what the DEPLOY creates:
  // compose-ha's provision fan-out calls upStack(`${environment}-primary`)
  // and upStack(`${environment}-standby`) (src/lib/deploy/effects/
  // compose-ha.js), exactly like k8s-ha's per-cluster converge — the old
  // "only k8s-ha is two-stack" answer left compose-ha's second stack
  // invisible to every consumer.
  it.each([
    ['compose', ['e1']],
    ['compose-ha', ['e1-primary', 'e1-standby']],
    ['k8s', ['e1']],
    ['k8s-ha', ['e1-primary', 'e1-standby']],
  ])('pulumiStackEnvs(%s) names the stacks the deploy actually creates', (tier, expected) => {
    expect(pulumiStackEnvs(tier, 'e1')).toEqual(expected);
  });
});
