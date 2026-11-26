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

  it('has exactly four scenarios, compose, compose-ha, k8s, k8s-ha (VultrProvider.SUPPORTED_TIERS)', () => {
    expect(vultr.scenarios).toHaveLength(4);
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
      // backend's setupHA/upsertApexAndWildcard path, the self-contained
      // default, same reasoning as Hetzner's e2.
      dnsProvider: 'vultr',
      envPrefix: 'v2',
    });
    expect(vultr.scenarios[2]).toEqual({
      mode: 'k8s',
      dnsProvider: 'vultr',
      envPrefix: 'v3',
    });
    expect(vultr.scenarios[3]).toEqual({
      mode: 'k8s-ha',
      // Same-provider DNS so the v4 failover flip exercises the Vultr DNS
      // backend, like l4 on Linode.
      dnsProvider: 'vultr',
      envPrefix: 'v4',
    });
    // compose-ha runs only when named (2026-11-25).
    expect(vultr.defaultSelection).toEqual(['compose', 'k8s', 'k8s-ha']);
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
  it('scales every default plan one size up (db vc2-1c-2gb, the rest vc2-2c-4gb, and their vhf fallbacks)', () => {
    expect(testConfig.e2e.capacityPreferences.vultr.scaleTo).toEqual({
      'vc2-1c-2gb': 'vc2-2c-4gb',
      'vc2-2c-4gb': 'vc2-4c-8gb',
      'vhf-2c-4gb': 'vhf-3c-8gb',
    });
  });

  it('keeps ewr first, co-located with the usual ewr1 storage subscription', () => {
    // Compute region ids, NOT cluster slugs (ewr→ewr1, ord→chi3, sjc→sjc1,
    // lax→lax1, ams→ams1 — VultrObjectStorageProvider.COMPUTE_TO_S3). The
    // list orders the primary only: the v2 and v4 standbys go where a
    // customer's deploy puts them (getDefaultStandbyRegion). Plan
    // availability FLUXES (vc2 was absent from ord on 2026-08-08, present
    // again 2026-08-19); the resolver's live check skips a primary region
    // that loses it. sjc stays for compose: the resolver skips it for k8s,
    // which Vultr does not run there (no NVMe block storage).
    expect(testConfig.e2e.capacityPreferences.vultr.regions).toEqual([
      'ewr',
      'ord',
      'sjc',
      'lax',
      'ams',
    ]);
  });
});
