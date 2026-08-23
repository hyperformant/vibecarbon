import { describe, expect, it } from 'vitest';
import { planDestroy } from '../../../../src/lib/deploy/plan/destroy-plan.js';
import { planStepNames } from '../../../../src/lib/deploy/plan/step.js';

// The destroy plan is a pure, faithful decomposition of the (now removed)
// per-tier `DESTROY_STRATEGIES[tier]` dispatch + shared `finishDestroy` tail.
// The tier-specific teardown (which reaps servers/firewalls/DNS/Pulumi stacks)
// is expressed as ONE black-box step per tier — the safety-critical, hardened
// helpers (destroyComposeTier / destroyComposeHATier / destroyK8sTier) are
// wrapped, not cracked open, mirroring how the k8s DEPLOY plan wraps deployK3s.
// The shared tail is decomposed into ordered steps so the load-bearing
// buckets-last ordering (app bucket → state bucket → backup bucket, all AFTER
// Pulumi teardown) is a first-class, snapshot-locked property of the plan.

// compose / compose-ha: no GitHub environment delete, no summary note.
// remove-stack-state sits between the teardown and the buckets: the compose
// teardown reaps via direct provider APIs (no `pulumi destroy`), so its stack
// record must be reconciled explicitly, and the effect reads the teardown's
// leak-ledger verdict — closest-possible ordering. k8s tiers need no such
// step (destroyStack runs `pulumi destroy` + `removeStack`).
const EXPECTED_COMPOSE_SEQUENCE = [
  'destroy-compose-services',
  'remove-stack-state',
  'delete-app-bucket',
  'retain-state-bucket',
  'handle-backup-bucket',
  'update-project-config',
  'cleanup-local-files',
  'finish-outro',
];

const EXPECTED_COMPOSE_HA_SEQUENCE = [
  'destroy-compose-ha',
  'remove-stack-state',
  'delete-app-bucket',
  'retain-state-bucket',
  'handle-backup-bucket',
  'update-project-config',
  'cleanup-local-files',
  'finish-outro',
];

// k8s / k8s-ha: adds the GitHub-environment delete + the deleted-resources
// summary note (the two tail steps compose tiers never ran). k8s and k8s-ha
// share ONE teardown effect — the both-cluster (primary + standby) fan-out is
// data-driven by ctx.plan.stackEnvs (see planDestroyTargets), not a distinct
// step.
const EXPECTED_K8S_SEQUENCE = [
  'destroy-k8s-infra',
  'delete-app-bucket',
  'retain-state-bucket',
  'handle-backup-bucket',
  'delete-github-env',
  'update-project-config',
  'cleanup-local-files',
  'print-summary',
  'finish-outro',
];

const EXPECTED_K8S_HA_SEQUENCE = EXPECTED_K8S_SEQUENCE;

describe('planDestroy(compose)', () => {
  it('produces the compose teardown step sequence', () => {
    expect(planStepNames(planDestroy('compose', {}))).toEqual(EXPECTED_COMPOSE_SEQUENCE);
  });

  it('starts with the tier teardown, then deletes buckets, config, local files, outro', () => {
    const [first] = planDestroy('compose', {});
    expect(first.name).toBe('destroy-compose-services');
    expect(first.effect).toBe('destroyComposeServices');
  });

  it('omits the k8s-only GitHub-env delete and summary note', () => {
    const names = planStepNames(planDestroy('compose', {}));
    expect(names).not.toContain('delete-github-env');
    expect(names).not.toContain('print-summary');
  });
});

describe('planDestroy(compose-ha)', () => {
  it('produces the compose-ha teardown step sequence', () => {
    expect(planStepNames(planDestroy('compose-ha', {}))).toEqual(EXPECTED_COMPOSE_HA_SEQUENCE);
  });

  it('uses the compose-ha teardown effect (both nodes reaped inside the black box)', () => {
    const [first] = planDestroy('compose-ha', {});
    expect(first.name).toBe('destroy-compose-ha');
    expect(first.effect).toBe('destroyComposeHa');
  });
});

describe('planDestroy(k8s)', () => {
  it('produces the k8s teardown step sequence (adds github-env + summary)', () => {
    expect(planStepNames(planDestroy('k8s', {}))).toEqual(EXPECTED_K8S_SEQUENCE);
  });

  it('wraps the Pulumi-managed teardown as one black-box step', () => {
    const [first] = planDestroy('k8s', {});
    expect(first.name).toBe('destroy-k8s-infra');
    expect(first.effect).toBe('destroyK8sInfra');
  });
});

describe('planDestroy(k8s-ha)', () => {
  it('produces the k8s-ha teardown step sequence (identical steps to k8s)', () => {
    expect(planStepNames(planDestroy('k8s-ha', {}))).toEqual(EXPECTED_K8S_HA_SEQUENCE);
  });

  it('shares the k8s teardown effect — both clusters reaped via ctx.plan.stackEnvs', () => {
    const [first] = planDestroy('k8s-ha', {});
    expect(first.effect).toBe('destroyK8sInfra');
    // The primary+standby fan-out is data-driven, so the STEP list matches k8s.
    expect(planStepNames(planDestroy('k8s-ha', {}))).toEqual(planStepNames(planDestroy('k8s', {})));
  });
});

describe('planDestroy — buckets-last safety ordering', () => {
  for (const tier of ['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const) {
    it(`deletes buckets AFTER the tier teardown, state bucket after app bucket (${tier})`, () => {
      const names = planStepNames(planDestroy(tier, {}));
      const idx = (n: string) => names.indexOf(n);
      // The tier teardown (which, for k8s, runs `pulumi destroy` against the
      // state-bucket backend) is step 0.
      expect(idx('delete-app-bucket')).toBeGreaterThan(0);
      // State bucket (the Pulumi backend) is deleted AFTER the app bucket and
      // AFTER the tier teardown — never yanks its own backend mid-destroy.
      expect(idx('retain-state-bucket')).toBeGreaterThan(idx('delete-app-bucket'));
      // Backup bucket handled after the state bucket (preserved by default).
      expect(idx('handle-backup-bucket')).toBeGreaterThan(idx('retain-state-bucket'));
      // Config removal + local cleanup + outro come last.
      expect(idx('finish-outro')).toBe(names.length - 1);
      expect(idx('update-project-config')).toBeGreaterThan(idx('handle-backup-bucket'));
      expect(idx('cleanup-local-files')).toBeGreaterThan(idx('update-project-config'));
    });
  }
});

describe('planDestroy — retain-state-bucket is unconditional', () => {
  // This step used to be `delete-state-bucket`, gated on
  // `!ctx.results.pulumiDestroyFailed` (M3 Task 9f round 1): the state bucket
  // holds the ONLY evidence a retry can use to find what is still deployed, and
  // deleting it in the same run whose teardown could not verify its own
  // `pulumi destroy` destroyed the evidence alongside the failure.
  //
  // Destroy now keeps the bucket in every case (retainStateBucket), which is
  // strictly safer than the gate was, so the condition has nothing left to
  // protect. A `when` reappearing here would mean deletion came back with it.
  for (const tier of ['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const) {
    it(`${tier}: retain-state-bucket is present and ungated`, () => {
      const step = planDestroy(tier, {}).find((s) => s.name === 'retain-state-bucket');
      expect(step, 'the step must exist on every tier').toBeDefined();
      expect(step?.when).toBeUndefined();
    });

    it(`${tier}: no deletion step for the state bucket survives anywhere in the plan`, () => {
      const names = planDestroy(tier, {}).map((s) => s.name);
      expect(names).not.toContain('delete-state-bucket');
    });
  }
});

describe('planDestroy — update-project-config gating design (M3 Task 9f fix round 2)', () => {
  // Unlike delete-state-bucket, update-project-config's gate lives INSIDE the
  // effect (updateProjectConfigEffect in destroy.js checks
  // ctx.results.pulumiDestroyFailed itself), not as a plan-level `when`. This
  // is deliberate: the round-2 fix must also emit an operator-facing message
  // explaining WHY the environment entry was kept ("push/log an
  // issue-adjacent line telling the operator") — a bare `when`-skip only logs
  // a generic step-name line to stderr via runPlan, with no room for that
  // context. The step therefore runs unconditionally at the PLAN level for
  // every tier (this describe block just pins that it stays that way); the
  // keep-vs-delete decision and its test coverage live at the effect level —
  // see tests/unit/destroy/update-project-config-effect.test.ts.
  for (const tier of ['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const) {
    it(`${tier}: update-project-config carries NO plan-level \`when\` gate`, () => {
      const step = planDestroy(tier, {}).find((s) => s.name === 'update-project-config');
      expect(step).toBeDefined();
      expect(step?.when).toBeUndefined();
    });
  }
});

describe('planDestroy — purity + validity', () => {
  it('is pure: repeated calls produce structurally identical plans', () => {
    for (const tier of ['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const) {
      const shape = () =>
        planDestroy(tier, {}).map((s) => ({
          name: s.name,
          effect: s.effect,
          gated: typeof s.when === 'function',
        }));
      expect(shape()).toEqual(shape());
    }
  });

  it('every step references an effect that exists in the destroy registry', async () => {
    const { DESTROY_EFFECTS } = await import('../../../../src/destroy.js');
    for (const tier of ['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const) {
      for (const step of planDestroy(tier, {})) {
        expect(typeof DESTROY_EFFECTS[step.effect]).toBe('function');
      }
    }
  });

  it('throws for an unknown tier', () => {
    expect(() => planDestroy('nope', {})).toThrow('planDestroy: unknown/unsupported tier nope');
  });
});

describe('planDestroy(unrecorded)', () => {
  // Deploy never reached provisioning: no tier teardown to run, no buckets
  // recorded, nothing remote to reap — but the local env entry must still be
  // removed and the operator must get a completion, not a stack trace.
  it('plans ONLY local cleanup — no remote teardown, no bucket deletes', () => {
    const steps = planDestroy('unrecorded', {}).map((s) => s.name);
    expect(steps).toEqual(['update-project-config', 'cleanup-local-files', 'finish-outro']);
  });
});
