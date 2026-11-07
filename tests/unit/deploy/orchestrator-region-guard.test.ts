/**
 * The orchestrator's entry guard refuses a region the tier cannot run in
 * before any provider or Pulumi work: the guard function throws, and in the
 * entry function it is called ahead of the first provider-touching step.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertDeployRegion } from '../../../src/lib/deploy/orchestrator.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';

describe('assertDeployRegion', () => {
  it('refuses a Linode k8s deploy to a VPC-less region', () => {
    expect(() => assertDeployRegion(LinodeProvider, 'k8s', { region: 'us-east' })).toThrow(
      "Kubernetes on Linode does not run in Newark (us-east): Linode has no VPC there for the cluster's private network. Use us-iad, us-ord or another region.",
    );
  });

  it('refuses a k8s-ha deploy whose standby is VPC-less', () => {
    expect(() =>
      assertDeployRegion(LinodeProvider, 'k8s-ha', {
        region: 'us-iad',
        secondaryRegion: 'us-southeast',
      }),
    ).toThrow(/does not run in Atlanta \(us-southeast\)/);
  });

  it('lets compose and VPC regions through, and other providers', () => {
    expect(() =>
      assertDeployRegion(LinodeProvider, 'compose', { region: 'us-east' }),
    ).not.toThrow();
    expect(() =>
      assertDeployRegion(LinodeProvider, 'k8s-ha', {
        region: 'us-iad',
        secondaryRegion: 'us-ord',
      }),
    ).not.toThrow();
    expect(() => assertDeployRegion(HetznerProvider, 'k8s', { region: 'nbg1' })).not.toThrow();
  });

  it('is called in the entry function before the first provider-touching step', () => {
    const src = readFileSync(
      join(import.meta.dirname, '../../../src/lib/deploy/orchestrator.js'),
      'utf8',
    );
    const guard = src.indexOf('assertDeployRegion(providerFor(config)');
    const firstProviderWork = src.indexOf('ensureOperatorIpAccess({');
    expect(guard).toBeGreaterThan(0);
    expect(firstProviderWork).toBeGreaterThan(guard);
  });
});
