/**
 * M3 Task 9f fix round 1 — the caller-side half of loud partial detection.
 *
 * `destroyStack` (lib/iac/index.js) cannot tell a legitimately-empty destroy
 * (idempotent re-run / never deployed) apart from the reproduced DO
 * incident's actual mechanism (createOrSelectStack silently creating a
 * fresh, empty WRONG stack because it couldn't find the real one) — both
 * shapes resolve with `resourceCount: 0` from that function's own vantage
 * point. Only the caller can tell them apart, because only the caller holds
 * envConfig: if this environment has recorded real infrastructure, a
 * resourceCount of 0 is the incident, not a legitimate no-op.
 *
 * These tests exercise `recordPulumiDestroyOutcome` directly — this is the
 * one piece of `destroyK8sTier` (itself not exported/unit-testable) with a
 * decision worth pinning in isolation, and the one place that actually
 * catches the incident shape.
 */
import { describe, expect, it } from 'vitest';
import { recordPulumiDestroyOutcome } from '../../../src/destroy.js';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';

function makeResults() {
  return {
    servers: [],
    firewalls: [],
    sshKeys: [],
    leaks: createLeakLedger(),
    pulumiDestroyFailed: false,
  };
}

describe('recordPulumiDestroyOutcome', () => {
  // The reproduced incident shape: destroy resolved with resourceCount: 0,
  // but this environment was genuinely deployed (servers on record) —
  // exactly what the two live DO destroys looked like from envConfig's side.
  it('records an UNVERIFIED pulumi-stack verdict and sets pulumiDestroyFailed when resourceCount is 0 but servers are recorded', () => {
    const results = makeResults();
    const envConfig = { servers: [{ ip: '1.2.3.4' }] };

    const verified = recordPulumiDestroyOutcome({
      destroyResult: { destroyed: true, resourceCount: 0 },
      envConfig,
      stackEnv: 'prod',
      dirLabel: '',
      results,
      providerName: 'DigitalOcean',
    });

    expect(verified).toBe(false);
    expect(results.pulumiDestroyFailed).toBe(true);
    expect(results.leaks.entries).toHaveLength(1);
    // UNVERIFIED, not `leak`: we do not know that anything survived — we know
    // we cannot prove it didn't. Either way the exit code goes non-zero.
    expect(results.leaks.entries[0].severity).toBe('unverified');
    expect(results.leaks.entries[0].resourceClass).toBe('pulumi-stack');
    expect(results.leaks.entries[0].resource).toBe('prod');
    expect(results.leaks.entries[0].reason).toMatch(/empty stack/i);
    expect(results.leaks.entries[0].hint).toContain('DigitalOcean');
    expect(results.leaks.exitCode()).toBe(2);
    // Must NOT claim the "(all via Pulumi)" success shorthand for an
    // unverified outcome.
    expect(results.servers).toEqual([]);
    expect(results.firewalls).toEqual([]);
    expect(results.sshKeys).toEqual([]);
  });

  it('records an unverified verdict when resourceCount is 0 but only a single-k8s floatingIp is recorded (no servers array yet)', () => {
    const results = makeResults();
    const envConfig = { servers: [], floatingIp: '5.6.7.8' };

    const verified = recordPulumiDestroyOutcome({
      destroyResult: { destroyed: true, resourceCount: 0 },
      envConfig,
      stackEnv: 'prod',
      dirLabel: '',
      results,
      providerName: 'DigitalOcean',
    });

    expect(verified).toBe(false);
    expect(results.pulumiDestroyFailed).toBe(true);
  });

  it('records an unverified verdict when resourceCount is 0 but a k8s-ha primary/standby floatingIp is recorded', () => {
    const results = makeResults();
    const envConfig = { servers: [], ha: { primary: { floatingIp: '9.9.9.1' } } };

    const verified = recordPulumiDestroyOutcome({
      destroyResult: { destroyed: true, resourceCount: 0 },
      envConfig,
      stackEnv: 'prod-primary',
      dirLabel: ' (prod-primary)',
      results,
      providerName: 'Hetzner Cloud',
    });

    expect(verified).toBe(false);
    expect(results.pulumiDestroyFailed).toBe(true);
    expect(results.leaks.entries[0].resource).toContain('(prod-primary)');
  });

  // Legitimate no-op: nothing in envConfig suggests this env was ever
  // deployed (or it already was, cleanly, on a prior run) — resourceCount:0
  // is expected and must NOT be flagged.
  it('records the "(all via Pulumi)" success shorthand when resourceCount is 0 and no infra is recorded (legitimate no-op)', () => {
    const results = makeResults();
    const envConfig = { servers: [] };

    const verified = recordPulumiDestroyOutcome({
      destroyResult: { destroyed: true, resourceCount: 0 },
      envConfig,
      stackEnv: 'prod',
      dirLabel: '',
      results,
      providerName: 'DigitalOcean',
    });

    expect(verified).toBe(true);
    expect(results.pulumiDestroyFailed).toBe(false);
    expect(results.leaks.entries).toEqual([]);
    expect(results.servers).toEqual(['(all via Pulumi)']);
    expect(results.firewalls).toEqual(['(all via Pulumi)']);
    expect(results.sshKeys).toEqual(['(all via Pulumi)']);
  });

  // The normal, healthy path: real deletions recorded, servers on file too.
  it('records success when resourceCount is nonzero, regardless of recorded infra', () => {
    const results = makeResults();
    const envConfig = { servers: [{ ip: '1.2.3.4' }] };

    const verified = recordPulumiDestroyOutcome({
      destroyResult: { destroyed: true, resourceCount: 4 },
      envConfig,
      stackEnv: 'prod',
      dirLabel: '',
      results,
      providerName: 'DigitalOcean',
    });

    expect(verified).toBe(true);
    expect(results.pulumiDestroyFailed).toBe(false);
    expect(results.leaks.entries).toEqual([]);
  });

  // destroyResult can be undefined/null in principle (defensive) — must not
  // throw, and must not treat a missing result as a suspicious zero.
  it('does not throw and treats a missing/undefined destroyResult as success (defensive)', () => {
    const results = makeResults();
    const envConfig = { servers: [{ ip: '1.2.3.4' }] };

    const verified = recordPulumiDestroyOutcome({
      destroyResult: undefined,
      envConfig,
      stackEnv: 'prod',
      dirLabel: '',
      results,
      providerName: 'DigitalOcean',
    });

    expect(verified).toBe(true);
    expect(results.pulumiDestroyFailed).toBe(false);
  });
});
