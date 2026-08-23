import { describe, expect, it } from 'vitest';
import { planDestroyTargets } from '../../../src/destroy.js';

const projectConfig = { projectName: 'myapp' };

describe('planDestroyTargets', () => {
  it('k8s single: one stack env, cluster name derived, hasPulumiStack true', () => {
    const plan = planDestroyTargets({ deployMode: 'kubernetes' }, projectConfig, 'e1');
    expect(plan.tier).toBe('k8s');
    expect(plan.stackEnvs).toEqual(['e1']);
    expect(plan.hasPulumiStack).toBe(true);
    expect(plan.clusterNames).toEqual(['myapp-e1']);
  });

  it('k8s-ha: primary+standby stack envs and cluster names', () => {
    const plan = planDestroyTargets(
      { deployMode: 'kubernetes', ha: { enabled: true } },
      projectConfig,
      'e1',
    );
    expect(plan.tier).toBe('k8s-ha');
    expect(plan.stackEnvs).toEqual(['e1-primary', 'e1-standby']);
    expect(plan.hasPulumiStack).toBe(true);
    expect(plan.clusterNames).toEqual(['myapp-e1-primary', 'myapp-e1-standby']);
  });

  it('compose: no pulumi k8s stack, single-cluster derivation, no ha', () => {
    const plan = planDestroyTargets({ deployMode: 'compose' }, projectConfig, 'e1');
    expect(plan.tier).toBe('compose');
    expect(plan.hasPulumiStack).toBe(false);
    expect(plan.stackEnvs).toEqual(['e1']);
    expect(plan.clusterNames).toEqual(['myapp-e1']);
  });

  it('compose-ha: HA compose tier, TWO stack envs (primary+standby), no pulumi k8s stack', () => {
    // The provision fan-out really does write two stacks —
    // upStack(`${environment}-primary`) / upStack(`${environment}-standby`)
    // in lib/deploy/effects/compose-ha.js — and remove-stack-state must
    // reconcile both. The old single-env answer left the second stack
    // invisible to every stackEnvs consumer.
    const plan = planDestroyTargets({ deployMode: 'compose-ha' }, projectConfig, 'e1');
    expect(plan.tier).toBe('compose-ha');
    expect(plan.hasPulumiStack).toBe(false);
    expect(plan.stackEnvs).toEqual(['e1-primary', 'e1-standby']);
  });

  it('ownedIps: collects defined server IPs and drops blanks', () => {
    const envConfig = {
      deployMode: 'kubernetes',
      servers: [{ ip: '1.2.3.4' }, { ip: '5.6.7.8' }, { ip: undefined }, {}],
    };
    const plan = planDestroyTargets(envConfig, projectConfig, 'prod');
    expect(plan.ownedIps).toEqual(['1.2.3.4', '5.6.7.8']);
  });

  it('ownedIps: empty array when no servers', () => {
    const plan = planDestroyTargets({ deployMode: 'compose' }, projectConfig, 'e1');
    expect(plan.ownedIps).toEqual([]);
  });

  // M3 Task 9f — k8s DNS records point at the cluster's floating/reserved
  // ingress IP, not any server's own IP. Without folding it into ownedIps,
  // every k8s destroy's DNS delete saw the floating IP as "unowned" and
  // preserved the record (both Hetzner and DO — see the task brief's live
  // evidence). Single k8s persists `envConfig.floatingIp`.
  it('ownedIps: includes envConfig.floatingIp for single k8s', () => {
    const envConfig = {
      deployMode: 'kubernetes',
      servers: [{ ip: '1.2.3.4' }],
      floatingIp: '5.6.7.8',
    };
    const plan = planDestroyTargets(envConfig, projectConfig, 'prod');
    expect(plan.ownedIps).toEqual(['1.2.3.4', '5.6.7.8']);
  });

  // k8s-ha persists one floating IP per cluster under ha.primary/standby
  // (orchestrator.js) instead of a flat envConfig.floatingIp.
  it('ownedIps: includes both ha.primary.floatingIp and ha.standby.floatingIp for k8s-ha', () => {
    const envConfig = {
      deployMode: 'kubernetes',
      ha: {
        enabled: true,
        primary: { floatingIp: '9.9.9.1' },
        standby: { floatingIp: '9.9.9.2' },
      },
      servers: [{ ip: '1.2.3.4' }, { ip: '1.2.3.5' }],
    };
    const plan = planDestroyTargets(envConfig, projectConfig, 'prod');
    expect(plan.ownedIps).toEqual(['1.2.3.4', '1.2.3.5', '9.9.9.1', '9.9.9.2']);
  });

  it('ownedIps: omits floatingIp entirely when absent (compose tiers unaffected)', () => {
    const envConfig = { deployMode: 'compose', servers: [{ ip: '1.2.3.4' }] };
    const plan = planDestroyTargets(envConfig, projectConfig, 'prod');
    expect(plan.ownedIps).toEqual(['1.2.3.4']);
  });

  it('throws on unknown deployMode (delegates to resolveTier)', () => {
    expect(() => planDestroyTargets({ deployMode: 'nope' }, projectConfig, 'e1')).toThrow();
  });

  // A deploy that dies before its first skeleton save leaves an env entry
  // with NO deployMode. DO run 32670715722: destroy crashed at planning
  // ("Unknown deployMode: undefined") and teardown never ran. A garbled
  // RECORDED mode stays a loud throw (above) — only the deploy-never-started
  // shape degrades to local-cleanup-only.
  it('UNDEFINED deployMode (deploy never reached provisioning) plans local cleanup, not a crash', () => {
    const plan = planDestroyTargets({}, projectConfig, 'e1');
    expect(plan.tier).toBe('unrecorded');
    expect(plan.stackEnvs).toEqual([]);
    expect(plan.hasPulumiStack).toBe(false);
    expect(plan.clusterNames).toEqual([]);
    expect(plan.ownedIps).toEqual([]);
  });
});
