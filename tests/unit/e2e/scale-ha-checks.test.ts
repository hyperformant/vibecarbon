/**
 * The e2e k8s-ha checks on the replication firewall rule (checks/scale-ha.ts):
 *
 *   - verify-scale: replication, each side's firewall read, and (inline-rule
 *     providers) no firewall change in the scale's own per-resource markers;
 *   - verify-failover and reconverge-deploy: each side's firewall read.
 *
 * k8s-ha runs them; k8s, compose and compose-ha run none. Every failure names
 * the stack and the expected peer address.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  checkReplicationFirewalls,
  checkScaleUpsLeftFirewalls,
  runHaFirewallChecks,
  runScaleHaChecks,
} from '../../e2e/checks/scale-ha.js';
import type { VerificationResult } from '../../e2e/scenarios/types.js';

const pass = (checkName: string): VerificationResult => ({ checkName, status: 'pass' });
const NON_HA_MODES = ['k8s', 'compose', 'compose-ha'];

describe('runScaleHaChecks', () => {
  const spies = () => ({
    replication: vi.fn(async () => [pass('replication_streaming')]),
    firewalls: vi.fn(async () => [pass('replication_firewall:e-primary')]),
    scaleUps: vi.fn(() => [pass('scale_firewall_unchanged:e-primary')]),
  });

  it('runs replication, the firewall read and the scale markers for k8s-ha on an inline-rule provider', async () => {
    const s = spies();
    const out = await runScaleHaChecks({ mode: 'k8s-ha', inlineFirewallRules: true, ...s });
    expect(s.replication).toHaveBeenCalledTimes(1);
    expect(s.firewalls).toHaveBeenCalledTimes(1);
    expect(s.scaleUps).toHaveBeenCalledTimes(1);
    expect(out.map((r) => r.checkName)).toEqual([
      'replication_streaming',
      'replication_firewall:e-primary',
      'scale_firewall_unchanged:e-primary',
    ]);
  });

  it('skips the scale markers on a provider whose program declares no rule (REST-only, Vultr)', async () => {
    const s = spies();
    const out = await runScaleHaChecks({ mode: 'k8s-ha', inlineFirewallRules: false, ...s });
    expect(s.replication).toHaveBeenCalledTimes(1);
    expect(s.firewalls).toHaveBeenCalledTimes(1);
    expect(s.scaleUps).not.toHaveBeenCalled();
    expect(out.map((r) => r.checkName)).toEqual([
      'replication_streaming',
      'replication_firewall:e-primary',
    ]);
  });

  it.each(NON_HA_MODES.flatMap((mode) => [true, false].map((inline) => [mode, inline] as const)))(
    'runs none for %s (inline rules: %s)',
    async (mode, inlineFirewallRules) => {
      const s = spies();
      expect(await runScaleHaChecks({ mode, inlineFirewallRules, ...s })).toEqual([]);
      expect(s.replication).not.toHaveBeenCalled();
      expect(s.firewalls).not.toHaveBeenCalled();
      expect(s.scaleUps).not.toHaveBeenCalled();
    },
  );
});

describe('runHaFirewallChecks (verify-failover, reconverge-deploy)', () => {
  it('reads the firewalls for k8s-ha', async () => {
    const firewalls = vi.fn(async () => [pass('replication_firewall:e-standby')]);
    const out = await runHaFirewallChecks({ mode: 'k8s-ha', firewalls });
    expect(firewalls).toHaveBeenCalledTimes(1);
    expect(out.map((r) => r.checkName)).toEqual(['replication_firewall:e-standby']);
  });

  it.each(NON_HA_MODES)('reads none for %s', async (mode) => {
    const firewalls = vi.fn(async () => [pass('x')]);
    expect(await runHaFirewallChecks({ mode, firewalls })).toEqual([]);
    expect(firewalls).not.toHaveBeenCalled();
  });
});

// After a failover: the e-primary stack plays standby. Firewalls follow stacks.
const swapped = {
  ha: {
    primary: { stack: 'e-standby', dbIp: '203.0.113.20' },
    standby: { stack: 'e-primary', dbIp: '203.0.113.10' },
  },
};

describe('checkReplicationFirewalls', () => {
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
      envConfig: swapped,
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
      envConfig: swapped,
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
      envConfig: swapped,
    });
    expect(noProvider.map((r) => r.status)).toEqual(['fail', 'fail']);
    const missing = await checkReplicationFirewalls({
      provider: {
        findFirewallByName: async () => null,
        buildReplicationFirewallRules: () => null,
      },
      projectName: 'p',
      envName: 'e',
      envConfig: swapped,
    });
    expect(missing.map((r) => r.status)).toEqual(['fail', 'fail']);
  });
});

describe('checkScaleUpsLeftFirewalls', () => {
  const unswapped = {
    ha: {
      primary: { stack: 'e-primary', dbIp: '203.0.113.10' },
      standby: { stack: 'e-standby', dbIp: '203.0.113.20' },
    },
  };
  // What a k8s-ha scale's ups print with VIBECARBON_PERF=1: each side's up
  // timer, its first engine event, and one line per resource it changed.
  const scaleOutput = (extra: string[] = []) =>
    [
      'Applying infra changes via Pulumi (primary: nbg1)...',
      '[perf] scale.k8s.e-primary.upStack.resource.firstEvent 812ms',
      '[perf] scale.k8s.e-primary.upStack.resource.Server.master 64012ms',
      '[perf] scale.k8s.e-primary.upStack.resource.Server.db 70331ms',
      '[perf] scale.k8s.e-primary.upStack 98000ms',
      '[perf] scale.k8s.e-standby.upStack.resource.Droplet.db 51000ms',
      '[perf] scale.k8s.e-standby.upStack 77000ms',
      ...extra,
    ].join('\n');

  it('passes both sides when their ups changed servers only', () => {
    const out = checkScaleUpsLeftFirewalls({
      output: scaleOutput(),
      envName: 'e',
      envConfig: unswapped,
    });
    expect(out.map((r) => [r.checkName, r.status])).toEqual([
      ['scale_firewall_unchanged:e-primary', 'pass'],
      ['scale_firewall_unchanged:e-standby', 'pass'],
    ]);
  });

  it('fails the side whose up changed its firewall, naming the stack and the peer it should declare', () => {
    const out = checkScaleUpsLeftFirewalls({
      output: scaleOutput(['[perf] scale.k8s.e-standby.upStack.resource.Firewall.firewall 2210ms']),
      envName: 'e',
      envConfig: unswapped,
    });
    expect(out.map((r) => r.status)).toEqual(['pass', 'fail']);
    expect(out[1].errorMessage).toContain('e-standby');
    expect(out[1].errorMessage).toContain('203.0.113.10');
    expect(out[1].errorMessage).toContain('Firewall.firewall');
  });

  it('a security group counts as a firewall resource too', () => {
    const out = checkScaleUpsLeftFirewalls({
      output: scaleOutput([
        '[perf] scale.k8s.e-primary.upStack.resource.SecurityGroup.firewall 900ms',
      ]),
      envName: 'e',
      envConfig: unswapped,
    });
    expect(out.map((r) => r.status)).toEqual(['fail', 'pass']);
    expect(out[0].errorMessage).toContain('203.0.113.20');
  });

  it('reads the stacks from the record after a failover swapped the roles', () => {
    const out = checkScaleUpsLeftFirewalls({
      output: scaleOutput(['[perf] scale.k8s.e-primary.upStack.resource.Firewall.firewall 1ms']),
      envName: 'e',
      envConfig: swapped,
    });
    // ha.primary is the e-standby stack now; its peer is e-primary's node.
    expect(out.map((r) => [r.checkName, r.status])).toEqual([
      ['scale_firewall_unchanged:e-standby', 'pass'],
      ['scale_firewall_unchanged:e-primary', 'fail'],
    ]);
    expect(out[1].errorMessage).toContain('203.0.113.20');
  });

  it('fails a side whose up left no marker: perf off, or no up ran, so nothing was read', () => {
    const out = checkScaleUpsLeftFirewalls({
      output: '[perf] scale.k8s.e-primary.upStack 98000ms',
      envName: 'e',
      envConfig: unswapped,
    });
    expect(out.map((r) => r.status)).toEqual(['pass', 'fail']);
    expect(out[1].errorMessage).toContain('scale.k8s.e-standby.upStack');
    expect(out[1].errorMessage).toContain('203.0.113.10');
  });

  it('fails a side whose peer has no recorded address, or a bad one', () => {
    const out = checkScaleUpsLeftFirewalls({
      output: scaleOutput(),
      envName: 'e',
      envConfig: {
        ha: {
          primary: { stack: 'e-primary', dbIp: 'not-an-ip' },
          standby: { stack: 'e-standby' },
        },
      },
    });
    expect(out.map((r) => r.status)).toEqual(['fail', 'fail']);
    expect(out[0].errorMessage).toContain('e-primary');
    expect(out[1].errorMessage).toContain('not-an-ip');
  });
});

describe('lifecycle wiring', () => {
  const src = async () => {
    const { readRepoFile } = await import('../../_shared/source-files.js');
    return readRepoFile('tests/e2e/scenarios/_run-lifecycle.ts');
  };
  const between = (text: string, from: string, to: string) => {
    const start = text.indexOf(from);
    const end = text.indexOf(to, start);
    expect(start, `${from} is in the lifecycle`).toBeGreaterThan(-1);
    expect(end, `${to} follows ${from}`).toBeGreaterThan(start);
    return text.slice(start, end);
  };

  it('one firewall read for all three steps, built on checkReplicationFirewalls', async () => {
    const read = between(await src(), 'const readReplicationFirewalls = ', '\n  };\n');
    expect(read).toContain('checkReplicationFirewalls(');
    expect(read).toContain('readEnvConfig(');
  });

  it('verify-scale runs replication, the firewall read and the scale markers', async () => {
    const step = between(await src(), "name: 'verify-scale'", "name: 'backup'");
    expect(step).toContain('runScaleHaChecks(');
    expect(step).toContain('runReplicationChecks(');
    expect(step).toContain('firewalls: readReplicationFirewalls');
    expect(step).toContain('checkScaleUpsLeftFirewalls(');
    // Inline rules: the provider's program declares them, so its ups are read.
    expect(step).toMatch(
      /inlineFirewallRules:\s*!getProviderClass\([^)]*\)\s*\.K8S_OPERATOR_RULES_AFTER_UP,/,
    );
  });

  it('verify-failover reads the firewalls in the post-failover branch', async () => {
    const branch = between(
      await src(),
      '} else if (isPostFailoverVerify(stepName)) {',
      "} else if (stepName === 'verify-deploy' || stepName === 'verify-restore') {",
    );
    expect(branch).toContain('runHaFirewallChecks(');
    expect(branch).toContain('firewalls: readReplicationFirewalls');
  });

  it('reconverge-deploy reads the firewalls after its redeploy', async () => {
    const step = between(await src(), "name: 'reconverge-deploy'", '// 14. Failback');
    const redeploy = step.indexOf('deployScenario(');
    const read = step.indexOf('runHaFirewallChecks(');
    expect(redeploy).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(redeploy);
    expect(step).toContain('firewalls: readReplicationFirewalls');
  });
});
