import { describe, expect, it } from 'vitest';
import { testConfig } from '../../config.js';

/**
 * Config-shape pins for `testConfig.e2e.providers.linode` and the
 * `capacityPreferences.linode` block it draws from — the Linode analog of
 * do-reference-scenarios.test.ts (see its header for why these pins exist:
 * an edit to a provider's scenarios must trip a test, not a live e2e run).
 * Reads the `providers` registry — the selection grammar's single source
 * of truth (tests/e2e/selection.ts).
 */
describe('providers.linode (Linode opt-in scenarios)', () => {
  const linode = testConfig.e2e.providers.linode;

  it('has exactly two scenarios — compose + compose-ha (tier-parity wave 1; LinodeProvider.SUPPORTED_TIERS stops at compose-ha)', () => {
    expect(linode.scenarios).toHaveLength(2);
    expect(linode.scenarios[0]).toEqual({
      mode: 'compose',
      // Native Linode DNS (linode.appcarbon.dev) — authenticates with the
      // same LINODE_API_TOKEN as Linode compute, so an l1-only run needs no
      // Cloudflare credential.
      dnsProvider: 'linode',
      envPrefix: 'l1',
    });
    expect(linode.scenarios[1]).toEqual({
      mode: 'compose-ha',
      // Same-provider DNS so the l2 failover flip exercises the Linode
      // backend's setupHA/upsertApexAndWildcard path — the self-contained
      // default, same reasoning as Hetzner's e2.
      dnsProvider: 'linode',
      envPrefix: 'l2',
    });
    expect(linode.defaultSelection).toEqual(['compose', 'compose-ha']);
  });

  it('names its required credentials', () => {
    expect(linode.requiredEnv).toEqual([
      'LINODE_API_TOKEN',
      'LINODE_ACCESS_KEY',
      'LINODE_SECRET_KEY',
      // Required since 2026-08-13, not an override: Linode assigns each
      // ACCOUNT one storage cluster per region and it is not always the
      // documented `-1` one. Unset, buckets are created against the wrong
      // cluster and the failure reads `owned by another account`.
      'LINODE_STORAGE_REGION',
    ]);
  });

  it('displays as plain "Linode"', () => {
    expect(linode.displayName).toBe('Linode');
  });
});

describe('capacityPreferences.linode', () => {
  it('has one blanket typePair backing the compose scenario', () => {
    expect(testConfig.e2e.capacityPreferences.linode.typePairs).toEqual([
      ['g6-standard-2', 'g6-standard-4'],
    ]);
  });

  it('carries the base-price Object-Storage-supporting regions subset', () => {
    expect(testConfig.e2e.capacityPreferences.linode.regions).toEqual([
      'us-iad',
      'us-ord',
      'fr-par',
      'us-sea',
    ]);
  });
});
