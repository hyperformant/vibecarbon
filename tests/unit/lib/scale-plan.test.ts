import { describe, expect, it } from 'vitest';
import { buildProgramConfig, planK8sScaleChanges } from '../../../src/lib/scale-plan.js';

// Mirrors the real k8s envConfig shape. The planner is a pure function of
// `parsed`; envConfig is accepted for signature parity with the interactive
// caller but the non-interactive branches never read it.
const envConfig = {
  deployMode: 'kubernetes',
  region: 'nbg1',
  masterServerType: 'cx23',
  supabaseServerType: 'cx23',
  workerServerType: 'cx23',
  minWorkers: 1,
  maxWorkers: 3,
};

describe('planK8sScaleChanges', () => {
  it('-yes -type resizes all three node roles', () => {
    const plan = planK8sScaleChanges({ yes: true, type: 'cpx31' }, envConfig);
    expect(plan).not.toBeNull();
    expect(plan.changes).toEqual(['masterType', 'supabaseType', 'workerType']);
    expect(plan.newValues.masterType).toBe('cpx31');
    expect(plan.newValues.supabaseType).toBe('cpx31');
    expect(plan.newValues.workerType).toBe('cpx31');
    // bounds untouched when no bounds flags passed
    expect(plan.newValues.minWorkers).toBeUndefined();
    expect(plan.newValues.maxWorkers).toBeUndefined();
  });

  it('-yes -type combined with bounds adds workerBounds', () => {
    const plan = planK8sScaleChanges(
      { yes: true, type: 'cpx31', minWorkers: 2, maxWorkers: 5 },
      envConfig,
    );
    expect(plan.changes).toEqual(['masterType', 'supabaseType', 'workerType', 'workerBounds']);
    expect(plan.newValues.workerType).toBe('cpx31');
    expect(plan.newValues.minWorkers).toBe(2);
    expect(plan.newValues.maxWorkers).toBe(5);
  });

  it('-yes with worker bounds only changes bounds', () => {
    const plan = planK8sScaleChanges({ yes: true, minWorkers: 2, maxWorkers: 5 }, envConfig);
    expect(plan.changes).toEqual(['workerBounds']);
    expect(plan.newValues.minWorkers).toBe(2);
    expect(plan.newValues.maxWorkers).toBe(5);
    // types are NOT set on the bounds-only path (stay undefined → caller
    // replays persisted values into programConfig via ??).
    expect(plan.newValues.masterType).toBeUndefined();
    expect(plan.newValues.workerType).toBeUndefined();
  });

  it('-yes with only minWorkers sets just that bound', () => {
    const plan = planK8sScaleChanges({ yes: true, minWorkers: 4 }, envConfig);
    expect(plan.changes).toEqual(['workerBounds']);
    expect(plan.newValues.minWorkers).toBe(4);
    expect(plan.newValues.maxWorkers).toBeUndefined();
  });

  it('no actionable flags -> null (interactive fallback)', () => {
    expect(planK8sScaleChanges({ yes: true }, envConfig)).toBeNull();
  });

  it('-type without -yes -> null (interactive confirm path)', () => {
    expect(planK8sScaleChanges({ type: 'cpx31' }, envConfig)).toBeNull();
  });
});

describe('buildProgramConfig', () => {
  // Fixture captured from the pre-refactor inline literal (scale.js ~1158-1195)
  // for a single-cluster k8s scale that bumps every role to cpx31.
  it('produces the k8s programConfig byte-for-byte (single cluster, type bump)', () => {
    const out = buildProgramConfig({
      projectName: 'acme',
      environment: 'prod',
      sshPublicKey: 'ssh-ed25519 AAAA... deploy',
      allowedCidrs: ['203.0.113.5/32'],
      existingSshKeyId: undefined,
      location: 'nbg1',
      newValues: { masterType: 'cpx31', supabaseType: 'cpx31', workerType: 'cpx31' },
      currentMasterType: 'cx23',
      currentSupabaseType: 'cx23',
      currentWorkerType: 'cx23',
      persistedMinWorkers: 1,
      persistedMaxWorkers: 3,
      k3sVersion: 'v1.30.0+k3s1',
      labels: { 'managed-by': 'vibecarbon', 'os-flavor': 'k3s' },
      apiToken: 'tok-123',
    });
    expect(out).toEqual({
      projectName: 'acme',
      environment: 'prod',
      sshPublicKey: 'ssh-ed25519 AAAA... deploy',
      allowedSshIps: ['203.0.113.5/32'],
      allowedK8sApiIps: ['203.0.113.5/32'],
      existingSshKeyId: undefined,
      location: 'nbg1',
      masterServerType: 'cpx31',
      supabaseServerType: 'cpx31',
      workerServerType: 'cpx31',
      minWorkers: 1,
      maxWorkers: 3,
      k3sVersion: 'v1.30.0+k3s1',
      labels: { 'managed-by': 'vibecarbon', 'os-flavor': 'k3s' },
      apiToken: 'tok-123',
    });
  });

  // Fixture for a k8s-ha standby cluster: existingSshKeyId is a shared-key id,
  // a US region maps to its own network zone, and only worker bounds change so
  // the type fields replay the persisted values.
  it('produces the k8s-ha programConfig byte-for-byte (standby, bounds only)', () => {
    const out = buildProgramConfig({
      projectName: 'acme',
      environment: 'prod-standby',
      sshPublicKey: 'ssh-ed25519 BBBB... ha',
      allowedCidrs: ['203.0.113.5/32', '198.51.100.7/32'],
      existingSshKeyId: '987654',
      location: 'ash',
      newValues: { minWorkers: 2, maxWorkers: 6 },
      currentMasterType: 'cpx21',
      currentSupabaseType: 'cpx21',
      currentWorkerType: 'cpx21',
      persistedMinWorkers: 1,
      persistedMaxWorkers: 3,
      k3sVersion: 'v1.30.0+k3s1',
      labels: { 'managed-by': 'vibecarbon', 'os-flavor': 'k3s' },
      apiToken: 'tok-123',
    });
    expect(out).toEqual({
      projectName: 'acme',
      environment: 'prod-standby',
      sshPublicKey: 'ssh-ed25519 BBBB... ha',
      allowedSshIps: ['203.0.113.5/32', '198.51.100.7/32'],
      allowedK8sApiIps: ['203.0.113.5/32', '198.51.100.7/32'],
      existingSshKeyId: '987654',
      location: 'ash',
      masterServerType: 'cpx21',
      supabaseServerType: 'cpx21',
      workerServerType: 'cpx21',
      minWorkers: 2,
      maxWorkers: 6,
      k3sVersion: 'v1.30.0+k3s1',
      labels: { 'managed-by': 'vibecarbon', 'os-flavor': 'k3s' },
      apiToken: 'tok-123',
    });
  });

  it('falls back to DEFAULT_WORKER_MIN/MAX when neither newValues nor persisted set', () => {
    const out = buildProgramConfig({
      projectName: 'acme',
      environment: 'prod',
      sshPublicKey: 'k',
      allowedCidrs: [],
      existingSshKeyId: undefined,
      location: 'fsn1',
      newValues: {},
      currentMasterType: 'cx23',
      currentSupabaseType: 'cx23',
      currentWorkerType: 'cx23',
      persistedMinWorkers: undefined,
      persistedMaxWorkers: undefined,
      k3sVersion: 'v1.30.0+k3s1',
      labels: { 'managed-by': 'vibecarbon', 'os-flavor': 'k3s' },
      apiToken: 't',
    });
    expect(out.minWorkers).toBe(1);
    expect(out.maxWorkers).toBe(3);
    // networkZone is no longer a programConfig field (CD1): it's derived
    // inside the Pulumi program from `location`, not computed here and
    // passed through. See tests/unit/iac/hetzner-k8s-network-zone.test.ts
    // for the location→zone mapping coverage (including the 2026-07-10
    // regression: deploy and scale must derive the same zone) — that
    // coverage moved with the code from deploy/utils.js to
    // iac/programs/hetzner-k8s.js.
    expect(out).not.toHaveProperty('networkZone');
  });
});
