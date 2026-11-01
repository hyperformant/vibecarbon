/**
 * A failed `pulumi destroy` must leave a leak report an operator can act on:
 * one line per resource still in the stack's state, the provider's own
 * error, and the exact command that finishes the job.
 *
 * d4-standby, 2026-10-31 printed one line, `UNVERIFIED pulumi-stack
 * d4-standby (d4-standby): pulumi destroy failed: error: update failed`,
 * which named no resource and no cause.
 */
import { describe, expect, it } from 'vitest';
import { recordPulumiDestroyFailure } from '../../../src/destroy.js';
import {
  createLeakLedger,
  formatLeakReport,
  renderLeakReportLines,
} from '../../../src/lib/destroy/leak-ledger.js';

function makeResults() {
  return { leaks: createLeakLedger(), pulumiDestroyFailed: false };
}

function failure(remainingResources: unknown) {
  const err = new Error(
    'pulumi destroy for stack "d4-standby" failed, 2 resource(s) remain in its state: Error detaching the volumes from the droplet (614595377): 404',
  ) as Error & { remainingResources?: unknown };
  err.remainingResources = remainingResources;
  return err;
}

describe('recordPulumiDestroyFailure', () => {
  it('records one line per resource left in state, each with its own error or none', () => {
    const results = makeResults();
    recordPulumiDestroyFailure({
      error: failure([
        {
          type: 'digitalocean:index/droplet:Droplet',
          logicalName: 'db',
          name: 'p-d4-standby-db',
          id: '614595377',
          error: 'Error detaching the volumes from the droplet (614595377): 404',
        },
        {
          type: 'digitalocean:index/vpc:Vpc',
          logicalName: 'network',
          name: 'p-d4-standby-network',
          id: 'vpc-uuid',
          error: null,
        },
      ]),
      stackEnv: 'd4-standby',
      dirLabel: ' (d4-standby)',
      environment: 'd4',
      results,
      providerName: 'DigitalOcean',
    });

    expect(results.pulumiDestroyFailed).toBe(true);
    const entries = results.leaks.entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      severity: 'unverified',
      resourceClass: 'server',
      resource: 'p-d4-standby-db (id 614595377)',
    });
    expect(entries[0].reason).toMatch(/Error detaching the volumes/);
    expect(entries[1]).toMatchObject({
      resourceClass: 'network',
      resource: 'p-d4-standby-network (id vpc-uuid)',
    });
    // The VPC must not wear the Droplet's error.
    expect(entries[1].reason).not.toMatch(/Error detaching/);
    expect(entries[1].reason).toMatch(/no error of its own/);
    for (const entry of entries) {
      expect(entry.reason).toMatch(/d4-standby/);
      expect(entry.hint).toMatch(/`vibecarbon destroy d4`/);
    }

    // The report itself names them.
    const lines = renderLeakReportLines(formatLeakReport(results.leaks, { environment: 'd4' }));
    expect(lines.some((l) => l.includes('p-d4-standby-db'))).toBe(true);
    expect(lines.some((l) => l.includes('p-d4-standby-network'))).toBe(true);
  });

  it('states the cause once, on a stack line, when no resource has an error of its own', () => {
    const results = makeResults();
    recordPulumiDestroyFailure({
      error: failure([
        { type: 'digitalocean:index/droplet:Droplet', logicalName: 'db', name: 'a', id: '1' },
        { type: 'digitalocean:index/vpc:Vpc', logicalName: 'network', name: 'b', id: '2' },
      ]),
      stackEnv: 'd4-standby',
      dirLabel: ' (d4-standby)',
      environment: 'd4',
      results,
      providerName: 'DigitalOcean',
    });

    const withCause = results.leaks.entries.filter((e) => /Error detaching/.test(e.reason));
    expect(withCause).toHaveLength(1);
    expect(withCause[0]).toMatchObject({
      resourceClass: 'pulumi-stack',
      resource: 'd4-standby (d4-standby)',
    });
    expect(results.leaks.entries).toHaveLength(3);
  });

  it('falls back to the logical name when the resource has no name output', () => {
    const results = makeResults();
    recordPulumiDestroyFailure({
      error: failure([
        {
          type: 'digitalocean:index/reservedIp:ReservedIp',
          logicalName: 'ingress',
          name: null,
          id: '157.230.68.48',
        },
      ]),
      stackEnv: 'd4-standby',
      dirLabel: ' (d4-standby)',
      environment: 'd4',
      results,
      providerName: 'DigitalOcean',
    });

    expect(results.leaks.entries[0]).toMatchObject({
      resourceClass: 'floating-ip',
      resource: 'ingress (id 157.230.68.48)',
    });
  });

  it('records the whole stack as unverified when its state could not be read back', () => {
    const results = makeResults();
    recordPulumiDestroyFailure({
      error: failure(null),
      stackEnv: 'd4-standby',
      dirLabel: ' (d4-standby)',
      environment: 'd4',
      results,
      providerName: 'DigitalOcean',
    });

    expect(results.leaks.entries).toHaveLength(1);
    expect(results.leaks.entries[0]).toMatchObject({
      resourceClass: 'pulumi-stack',
      resource: 'd4-standby (d4-standby)',
    });
    expect(results.leaks.entries[0].hint).toMatch(/`vibecarbon destroy d4`/);
  });
});
