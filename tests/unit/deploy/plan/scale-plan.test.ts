import { describe, expect, it } from 'vitest';
import { planScale } from '../../../../src/lib/deploy/plan/scale-plan.js';
import { planStepNames } from '../../../../src/lib/deploy/plan/step.js';

// The scale plan is a pure, faithful decomposition of the (now removed)
// per-tier `SCALE_STRATEGIES[tier]` dispatch (scaleCompose / scaleK8s). Both
// compose tiers already ran ONE shared code path that branches on
// `isHATier(tier)` purely on ctx data (how many target servers, parallel vs
// sequential fan-out) — so compose and compose-ha share ONE step list here,
// exactly mirroring how planDestroy's k8s/k8s-ha share one teardown effect.
// Same reasoning for k8s / k8s-ha (fan-out over the standby cluster is driven
// by ctx.isHA, not by a distinct plan shape).
//
// The per-server blue-green replace-and-restore pipeline (backup, create,
// wait, setup, copy-files, logins, build, pull, compose-up, restore, DNS,
// recreate-services, backup-cron, destroy-old) is COHESIVE and internally
// fanned out (parallel for HA, sequential otherwise) with try/catch cleanup
// that deletes the new server on ANY failure — cracking it into barrier-
// synchronized steps across servers would change failure/cleanup semantics,
// so (mirroring the deployK3s / destroy-tier black-box precedent) it stays
// ONE step ('scale-servers') whose effect owns the fan-out.
const EXPECTED_COMPOSE_SEQUENCE = [
  'register-ssh-key',
  'scale-servers',
  'update-project-config',
  'finish-outro',
];

const EXPECTED_K8S_SEQUENCE = [
  'apply-scale-changes',
  // HA-only belt (item I-1), when-gated to ctx.isHA — present in BOTH the k8s
  // and k8s-ha static plans (the plan shape is shared; HA is a run-time gate).
  're-establish-ha-tunnel',
  'verify-ready',
  'update-project-config',
  'finish-outro',
];

describe('planScale(compose)', () => {
  it('produces the compose scale step sequence', () => {
    expect(planStepNames(planScale('compose', {}))).toEqual(EXPECTED_COMPOSE_SEQUENCE);
  });

  it('starts with the ssh-key registration, then the server-replacement fan-out', () => {
    const [first, second] = planScale('compose', {});
    expect(first).toEqual({ name: 'register-ssh-key', effect: 'scaleRegisterSshKey' });
    expect(second).toEqual({ name: 'scale-servers', effect: 'scaleServers' });
  });
});

describe('planScale(compose-ha)', () => {
  it('shares the compose step sequence — the primary/standby fan-out is ctx-driven', () => {
    expect(planStepNames(planScale('compose-ha', {}))).toEqual(EXPECTED_COMPOSE_SEQUENCE);
    expect(planStepNames(planScale('compose-ha', {}))).toEqual(
      planStepNames(planScale('compose', {})),
    );
  });

  it('uses the SAME scale-servers effect as compose (fan-out lives inside the effect)', () => {
    const composeHa = planScale('compose-ha', {});
    const compose = planScale('compose', {});
    expect(composeHa.find((s) => s.name === 'scale-servers').effect).toBe(
      compose.find((s) => s.name === 'scale-servers').effect,
    );
  });
});

describe('planScale(k8s)', () => {
  it('produces the k8s scale step sequence', () => {
    expect(planStepNames(planScale('k8s', {}))).toEqual(EXPECTED_K8S_SEQUENCE);
  });

  it('wraps Pulumi apply + cluster-autoscaler re-patch as one black-box step', () => {
    const [first] = planScale('k8s', {});
    expect(first).toEqual({ name: 'apply-scale-changes', effect: 'scaleApplyK8sChanges' });
  });
});

describe('planScale(k8s-ha)', () => {
  it('shares the k8s teardown sequence — the standby cluster fan-out is ctx-driven', () => {
    expect(planStepNames(planScale('k8s-ha', {}))).toEqual(planStepNames(planScale('k8s', {})));
  });

  it('shares the k8s apply-scale-changes effect (isHA gates the standby fan-out internally)', () => {
    const k8sHa = planScale('k8s-ha', {});
    const k8s = planScale('k8s', {});
    expect(k8sHa.find((s) => s.name === 'apply-scale-changes').effect).toBe(
      k8s.find((s) => s.name === 'apply-scale-changes').effect,
    );
  });
});

describe('planScale — purity + validity', () => {
  it('is pure: repeated calls produce structurally identical plans', () => {
    for (const tier of ['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const) {
      const shape = () =>
        planScale(tier, {}).map((s) => ({
          name: s.name,
          effect: s.effect,
          gated: typeof s.when === 'function',
        }));
      expect(shape()).toEqual(shape());
    }
  });

  it('every step references an effect that exists in the scale registry', async () => {
    const { SCALE_EFFECTS } = await import('../../../../src/scale.js');
    for (const tier of ['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const) {
      for (const step of planScale(tier, {})) {
        expect(typeof SCALE_EFFECTS[step.effect]).toBe('function');
      }
    }
  });

  it('throws for an unknown tier', () => {
    expect(() => planScale('nope', {})).toThrow('planScale: unknown/unsupported tier nope');
  });
});
