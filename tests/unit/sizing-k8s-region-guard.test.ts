/**
 * sizing.js drops regions a provider cannot run Kubernetes in
 * (`Provider.k8sRegionProblem`) from the automatic region and standby picks,
 * for k8s roles only. A stub that blocks exactly the regions the unguarded
 * picks would return proves the filter, not a lucky ranking.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LinodeProvider } from '../../src/lib/providers/linode.js';
import { cheapestDefaultRegion, cheapestStandbyRegion } from '../../src/lib/sizing.js';
import { seedCatalog } from './helpers/catalog-fixtures.js';

const K8S_ROLES = ['master', 'db', 'worker'];
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

function stub(blocked: string[]) {
  class Stub extends LinodeProvider {
    static k8sRegionProblem(region: string) {
      return blocked.includes(region) ? `${region} has no VPC` : null;
    }
  }
  restores.push(seedCatalog(Stub as never, '2026-10-22/linode'));
  return Stub;
}

describe('cheapestStandbyRegion with blocked regions', () => {
  it('never returns the blocked conventional pair or the blocked cheapest partner for k8s roles', () => {
    const conventional = LinodeProvider.conventionalStandbyRegion('us-iad');
    const free = cheapestStandbyRegion(stub([]), 'us-iad', K8S_ROLES, conventional);
    const blocked = [...new Set([conventional, free])];
    const guarded = cheapestStandbyRegion(stub(blocked), 'us-iad', K8S_ROLES, conventional);
    expect(blocked).toContain(conventional);
    expect(blocked).not.toContain(guarded);
    expect(guarded).not.toBe('us-iad');
    expect(LinodeProvider.REGION_CONTINENT[guarded]).toBe('na');
  });

  it('compose roles ignore the rule', () => {
    const conventional = LinodeProvider.conventionalStandbyRegion('us-iad');
    expect(cheapestStandbyRegion(stub([conventional]), 'us-iad', ['compose'], conventional)).toBe(
      cheapestStandbyRegion(stub([]), 'us-iad', ['compose'], conventional),
    );
  });
});

describe('cheapestDefaultRegion with blocked regions', () => {
  it('never returns a blocked region for k8s roles', () => {
    const free = cheapestDefaultRegion(stub([]), K8S_ROLES);
    const guarded = cheapestDefaultRegion(stub([free]), K8S_ROLES);
    expect(guarded).not.toBe(free);
    expect(LinodeProvider.REGION_CONTINENT[guarded]).toBe('na');
  });

  it('compose roles ignore the rule', () => {
    const free = cheapestDefaultRegion(stub([]), ['compose']);
    expect(cheapestDefaultRegion(stub([free]), ['compose'])).toBe(free);
  });
});
