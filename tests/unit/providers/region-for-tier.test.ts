import { afterEach, describe, expect, it, vi } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { assertRegionSupportedForTier, regionsForTier } from '../../../src/lib/providers/index.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Linode k8s region rule', () => {
  it.each(['k8s', 'k8s-ha'])('%s refuses a region without a VPC, naming it', (tier) => {
    for (const [city, region] of [
      ['Newark', 'us-east'],
      ['Atlanta', 'us-southeast'],
    ]) {
      expect(() => assertRegionSupportedForTier(LinodeProvider, tier, region)).toThrow(
        `Kubernetes on Linode does not run in ${city} (${region}): Linode has no VPC there for the cluster's private network. Use us-iad, us-ord or another region.`,
      );
    }
  });

  it('k8s-ha refuses a VPC-less standby as well as a VPC-less primary', () => {
    expect(() =>
      assertRegionSupportedForTier(LinodeProvider, 'k8s-ha', 'us-iad', 'us-east'),
    ).toThrow(/does not run in Newark \(us-east\)/);
  });

  it.each(['compose', 'compose-ha'])('%s may use any region', (tier) => {
    expect(() =>
      assertRegionSupportedForTier(LinodeProvider, tier, 'us-east', 'us-southeast'),
    ).not.toThrow();
  });

  it('accepts VPC regions and skips unset ones', () => {
    expect(() =>
      assertRegionSupportedForTier(LinodeProvider, 'k8s-ha', 'us-iad', null),
    ).not.toThrow();
    expect(() => assertRegionSupportedForTier(LinodeProvider, 'k8s', undefined)).not.toThrow();
  });

  it('other providers have no k8s-less regions', () => {
    expect(() =>
      assertRegionSupportedForTier(HetznerProvider, 'k8s-ha', 'nbg1', 'fsn1'),
    ).not.toThrow();
  });

  it('region lists omit the two regions for k8s tiers only', () => {
    for (const tier of ['k8s', 'k8s-ha']) {
      const ids = Object.keys(regionsForTier(LinodeProvider, tier, LinodeProvider.REGIONS));
      expect(ids).not.toContain('us-east');
      expect(ids).not.toContain('us-southeast');
      expect(ids).toContain('us-iad');
      expect(ids.length).toBe(Object.keys(LinodeProvider.REGIONS).length - 2);
    }
    expect(regionsForTier(LinodeProvider, 'compose', LinodeProvider.REGIONS)).toBe(
      LinodeProvider.REGIONS,
    );
  });
});
