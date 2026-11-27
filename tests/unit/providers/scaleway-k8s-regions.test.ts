import { describe, expect, it } from 'vitest';
import { assertRegionSupportedForTier } from '../../../src/lib/providers/index.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';

// RC8: Scaleway runs Kubernetes in every zone it lists. Block storage is the
// part that could differ by zone, and nothing says it does, so no zone is
// refused. If a real run fails on a zone's block storage, this is the pin to
// change, with the zone and the reason (fr-par-2 and nl-ams-2 are the first
// suspects).
describe('Scaleway k8s regions', () => {
  const zones = Object.keys(ScalewayProvider.REGIONS);

  it('lists four zones', () => {
    expect(zones).toEqual(['fr-par-1', 'fr-par-2', 'nl-ams-1', 'nl-ams-2']);
  });

  it.each(zones)('%s has no k8s region problem', (zone) => {
    expect(ScalewayProvider.k8sRegionProblem(zone)).toBeNull();
  });

  it.each(['k8s', 'k8s-ha'])('%s is accepted in every zone, as primary and as standby', (tier) => {
    for (const zone of zones) {
      expect(() => assertRegionSupportedForTier(ScalewayProvider, tier, zone), zone).not.toThrow();
    }
  });
});
