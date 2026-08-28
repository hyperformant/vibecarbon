/**
 * planDoK8sBackstopTargets — the DO k8s destroy backstop's target list.
 *
 * The backstop (destroyK8sTier's DO block) is THE mechanism for reserved-IP
 * release (upstream Pulumi provider defects leak it every run — see the
 * ReservedIp construction site in digitalocean-k8s.js) and the hard guarantee
 * for firewall/VPC/SSH-key cleanup. Before d4 it derived ONE cluster name from
 * the user-facing environment (`proj-e4`), which on a k8s-ha destroy names a
 * cluster that never existed — both real per-stack firewalls/VPCs
 * (`proj-e4-primary-*` / `proj-e4-standby-*`) and BOTH reserved IPs would
 * leak, billing, every destroy. This planner makes the target list follow
 * plan.stackEnvs, so HA sweeps both clusters and single-stack behavior stays
 * byte-identical.
 */
import { describe, expect, it } from 'vitest';
import { planDoK8sBackstopTargets } from '../../../src/destroy.js';

const projectConfig = { projectName: 'proj' };

describe('planDoK8sBackstopTargets', () => {
  it('single k8s: one target, names byte-identical to the pre-d4 backstop', () => {
    const targets = planDoK8sBackstopTargets({
      plan: { tier: 'k8s', stackEnvs: ['e3'] },
      envConfig: { region: 'nyc3', floatingIp: '203.0.113.7' },
      projectConfig,
    });
    expect(targets).toEqual([
      {
        stackEnv: 'e3',
        firewallName: 'proj-e3-firewall',
        sshKeyName: 'proj-e3-nyc3-key',
        floatingIp: '203.0.113.7',
        networkName: 'proj-e3-network',
      },
    ]);
  });

  it('single k8s without a persisted region: sshKeyName is null (matches old guard)', () => {
    const [t] = planDoK8sBackstopTargets({
      plan: { tier: 'k8s', stackEnvs: ['e3'] },
      envConfig: { floatingIp: '203.0.113.7' },
      projectConfig,
    });
    expect(t.sshKeyName).toBeNull();
    expect(t.floatingIp).toBe('203.0.113.7');
  });

  it('k8s-ha: two per-stack targets; shared HA key handled elsewhere (sshKeyName null)', () => {
    const targets = planDoK8sBackstopTargets({
      plan: { tier: 'k8s-ha', stackEnvs: ['e4-primary', 'e4-standby'] },
      envConfig: {
        region: 'nyc3',
        ha: {
          primary: { stack: 'e4-primary', floatingIp: '203.0.113.10', region: 'nyc3' },
          standby: { stack: 'e4-standby', floatingIp: '203.0.113.20', region: 'sfo3' },
        },
      },
      projectConfig,
    });
    expect(targets).toEqual([
      {
        stackEnv: 'e4-primary',
        firewallName: 'proj-e4-primary-firewall',
        sshKeyName: null,
        floatingIp: '203.0.113.10',
        networkName: 'proj-e4-primary-network',
      },
      {
        stackEnv: 'e4-standby',
        firewallName: 'proj-e4-standby-firewall',
        sshKeyName: null,
        floatingIp: '203.0.113.20',
        networkName: 'proj-e4-standby-network',
      },
    ]);
  });

  it('k8s-ha after a failover role swap: floatingIp follows the STACK, not the role', () => {
    // failover persists the swap under ha.{primary,standby}.stack — the
    // stack identity ('e4-standby') keeps its own reserved IP regardless of
    // which role currently points at it.
    const targets = planDoK8sBackstopTargets({
      plan: { tier: 'k8s-ha', stackEnvs: ['e4-primary', 'e4-standby'] },
      envConfig: {
        ha: {
          primary: { stack: 'e4-standby', floatingIp: '203.0.113.20' },
          standby: { stack: 'e4-primary', floatingIp: '203.0.113.10' },
        },
      },
      projectConfig,
    });
    expect(targets.find((t) => t.stackEnv === 'e4-primary')?.floatingIp).toBe('203.0.113.10');
    expect(targets.find((t) => t.stackEnv === 'e4-standby')?.floatingIp).toBe('203.0.113.20');
  });

  it('k8s-ha with a pre-swap config lacking .stack: falls back to role-suffix mapping', () => {
    const targets = planDoK8sBackstopTargets({
      plan: { tier: 'k8s-ha', stackEnvs: ['e4-primary', 'e4-standby'] },
      envConfig: {
        ha: {
          primary: { floatingIp: '203.0.113.10' },
          standby: { floatingIp: '203.0.113.20' },
        },
      },
      projectConfig,
    });
    expect(targets.find((t) => t.stackEnv === 'e4-primary')?.floatingIp).toBe('203.0.113.10');
    expect(targets.find((t) => t.stackEnv === 'e4-standby')?.floatingIp).toBe('203.0.113.20');
  });

  it('missing floatingIp yields null (backstop skips the release, never throws)', () => {
    const [t] = planDoK8sBackstopTargets({
      plan: { tier: 'k8s', stackEnvs: ['e3'] },
      envConfig: { region: 'nyc3' },
      projectConfig,
    });
    expect(t.floatingIp).toBeNull();
  });
});
