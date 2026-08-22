import { describe, expect, it } from 'vitest';
import { testConfig } from '../../config.js';

/**
 * Config-shape pins for `testConfig.e2e.providers.vultr` and the
 * `capacityPreferences.vultr` block it draws from — the Vultr analog of
 * linode-reference-scenarios.test.ts (see do-reference-scenarios.test.ts's
 * header for why these pins exist: an edit to a provider's scenarios must
 * trip a test, not a live e2e run). Reads the `providers` registry — the
 * selection grammar's single source of truth (tests/e2e/selection.ts).
 */
describe('providers.vultr (Vultr opt-in scenarios)', () => {
  const vultr = testConfig.e2e.providers.vultr;

  it('has exactly two scenarios — compose + compose-ha (tier-parity wave 1; VultrProvider.SUPPORTED_TIERS stops at compose-ha)', () => {
    expect(vultr.scenarios).toHaveLength(2);
    expect(vultr.scenarios[0]).toEqual({
      mode: 'compose',
      // Native Vultr DNS since 2026-08-12. Needed its own apex
      // (threvidence.com) because Vultr's API rejects subdomain zones, so it
      // could not reuse a 3-label delegation the way do./linode. did.
      dnsProvider: 'vultr',
      envPrefix: 'v1',
    });
    expect(vultr.scenarios[1]).toEqual({
      mode: 'compose-ha',
      // Same-provider DNS so the v2 failover flip exercises the Vultr
      // backend's setupHA/upsertApexAndWildcard path — the self-contained
      // default, same reasoning as Hetzner's e2.
      dnsProvider: 'vultr',
      envPrefix: 'v2',
    });
    expect(vultr.defaultSelection).toEqual(['compose', 'compose-ha']);
  });

  it('names its required credentials', () => {
    expect(vultr.requiredEnv).toEqual([
      'VULTR_API_TOKEN',
      'VULTR_ACCESS_KEY',
      'VULTR_SECRET_KEY',
      'VULTR_STORAGE_REGION',
    ]);
  });

  it('requires the object-storage REGION alongside the key pair (per-subscription keys are cluster-scoped)', () => {
    // The one credential-shape divergence from every sibling provider: on
    // Hetzner/DO/Linode the region is an optional override because the keys
    // are account-wide. A Vultr key pair belongs to ONE subscription, i.e.
    // ONE cluster, so nothing can infer the cluster from the keys — the
    // deploy, the preflight probe, and the sweep's bucket half all need it
    // stated. Pinned so a future "tidy up the required list" edit has to
    // confront the reason.
    expect(vultr.requiredEnv).toContain('VULTR_STORAGE_REGION');
  });

  it('displays as plain "Vultr"', () => {
    expect(vultr.displayName).toBe('Vultr');
  });
});

describe('capacityPreferences.vultr', () => {
  it('has one blanket typePair backing the compose scenario', () => {
    expect(testConfig.e2e.capacityPreferences.vultr.typePairs).toEqual([
      ['vc2-2c-4gb', 'vc2-4c-8gb'],
    ]);
  });

  it('keeps ewr then ord first so the v2 HA pair mirrors HA_REGIONS when viable', () => {
    // Compute region ids, NOT cluster slugs (ewr→ewr1, ord→chi3, sjc→sjc1,
    // lax→lax1, ams→ams1 — VultrObjectStorageProvider.COMPUTE_TO_S3). ewr
    // first (backup co-location with the usual ewr1 subscription), ord
    // second so resolveVultrCapacityPair hands v2 the product-default
    // ewr↔ord pairing (VultrProvider.HA_REGIONS / getDefaultStandbyRegion)
    // whenever ord is viable — same principle as Linode's us-iad/us-ord.
    // Plan availability FLUXES (vc2 was absent from ord on 2026-08-08,
    // present again 2026-08-19); the resolver's live plan-locations check
    // is the flux guard — if ord loses vc2 again it is skipped and the
    // pair degrades to ewr+sjc automatically.
    expect(testConfig.e2e.capacityPreferences.vultr.regions).toEqual([
      'ewr',
      'ord',
      'sjc',
      'lax',
      'ams',
    ]);
  });
});
