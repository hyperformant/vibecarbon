/**
 * verify-scale's k8s-ha checks: replication plus each side's firewall rule.
 * A non-HA mode runs neither; the firewall read names the stack and the
 * expected peer address when the rule is gone.
 */
import { describe, expect, it, vi } from 'vitest';
import { checkReplicationFirewalls, runScaleHaChecks } from '../../e2e/checks/scale-ha.js';
import type { VerificationResult } from '../../e2e/scenarios/types.js';

const pass = (checkName: string): VerificationResult => ({ checkName, status: 'pass' });

describe('runScaleHaChecks', () => {
  it('runs replication and firewall checks for k8s-ha', async () => {
    const replication = vi.fn(async () => [pass('replication_streaming')]);
    const firewalls = vi.fn(async () => [pass('replication_firewall:e-primary')]);
    const out = await runScaleHaChecks({ mode: 'k8s-ha', replication, firewalls });
    expect(replication).toHaveBeenCalledTimes(1);
    expect(firewalls).toHaveBeenCalledTimes(1);
    expect(out.map((r) => r.checkName)).toEqual([
      'replication_streaming',
      'replication_firewall:e-primary',
    ]);
  });

  it.each(['k8s', 'compose', 'compose-ha'])('runs neither for %s', async (mode) => {
    const replication = vi.fn(async () => []);
    const firewalls = vi.fn(async () => []);
    expect(await runScaleHaChecks({ mode, replication, firewalls })).toEqual([]);
    expect(replication).not.toHaveBeenCalled();
    expect(firewalls).not.toHaveBeenCalled();
  });
});

describe('checkReplicationFirewalls', () => {
  // After a failover: the e-primary stack plays standby. Firewalls follow stacks.
  const envConfig = {
    ha: {
      primary: { stack: 'e-standby', dbIp: '203.0.113.20' },
      standby: { stack: 'e-primary', dbIp: '203.0.113.10' },
    },
  };

  it('reads each stack firewall against the other stack dbIp and passes on null', async () => {
    const seen: [string, string][] = [];
    const provider = {
      findFirewallByName: async (name: string) => ({ id: name }),
      buildReplicationFirewallRules: (fw: object, ip: string) => {
        seen.push([(fw as { id: string }).id, ip]);
        return null;
      },
    };
    const out = await checkReplicationFirewalls({
      provider,
      projectName: 'p',
      envName: 'e',
      envConfig,
    });
    expect(out.every((r) => r.status === 'pass')).toBe(true);
    expect(seen).toEqual([
      ['p-e-standby-firewall', '203.0.113.10'],
      ['p-e-primary-firewall', '203.0.113.20'],
    ]);
  });

  it('fails naming the stack and the expected peer address when the rule is gone', async () => {
    const provider = {
      findFirewallByName: async (name: string) => ({ id: name }),
      buildReplicationFirewallRules: () => [{}],
    };
    const out = await checkReplicationFirewalls({
      provider,
      projectName: 'p',
      envName: 'e',
      envConfig,
    });
    expect(out.map((r) => r.status)).toEqual(['fail', 'fail']);
    expect(out[0].errorMessage).toContain('e-standby');
    expect(out[0].errorMessage).toContain('203.0.113.10');
  });

  it('fails when the peer has no recorded address, no provider, or no firewall', async () => {
    const noPeer = await checkReplicationFirewalls({
      provider: null,
      projectName: 'p',
      envName: 'e',
      envConfig: { ha: { primary: { stack: 'e-primary' }, standby: { stack: 'e-standby' } } },
    });
    expect(noPeer.map((r) => r.status)).toEqual(['fail', 'fail']);
    const noProvider = await checkReplicationFirewalls({
      provider: null,
      projectName: 'p',
      envName: 'e',
      envConfig,
    });
    expect(noProvider.map((r) => r.status)).toEqual(['fail', 'fail']);
    const missing = await checkReplicationFirewalls({
      provider: {
        findFirewallByName: async () => null,
        buildReplicationFirewallRules: () => null,
      },
      projectName: 'p',
      envName: 'e',
      envConfig,
    });
    expect(missing.map((r) => r.status)).toEqual(['fail', 'fail']);
  });
});

describe('verify-scale wiring', () => {
  it('calls runScaleHaChecks inside the verify-scale step', async () => {
    const { readRepoFile } = await import('../../_shared/source-files.js');
    const src = readRepoFile('tests/e2e/scenarios/_run-lifecycle.ts');
    const step = src.slice(src.indexOf("name: 'verify-scale'"), src.indexOf("name: 'backup'"));
    expect(step).toContain('runScaleHaChecks(');
    expect(step).toContain('checkReplicationFirewalls(');
    expect(step).toContain('runReplicationChecks(');
  });
});
