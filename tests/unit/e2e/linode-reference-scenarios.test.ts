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

  it('has exactly four scenarios — compose, compose-ha, k8s, k8s-ha (LinodeProvider.SUPPORTED_TIERS)', () => {
    expect(linode.scenarios).toHaveLength(4);
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
    expect(linode.scenarios[2]).toEqual({
      mode: 'k8s',
      dnsProvider: 'linode',
      envPrefix: 'l3',
    });
    expect(linode.scenarios[3]).toEqual({
      mode: 'k8s-ha',
      // Same-provider DNS so the l4 failover flip exercises the Linode DNS
      // backend, like d4 on DigitalOcean.
      dnsProvider: 'linode',
      envPrefix: 'l4',
    });
    expect(linode.defaultSelection).toEqual(['compose', 'compose-ha', 'k8s', 'k8s-ha']);
  });

  it('names its required credentials', () => {
    expect(linode.requiredEnv).toEqual([
      'LINODE_API_TOKEN',
      'LINODE_ACCESS_KEY',
      'LINODE_SECRET_KEY',
      // LINODE_STORAGE_REGION stays out: a deploy reads the account's cluster
      // from Linode's endpoint list, and the e2e must run that path.
    ]);
  });

  it('displays as plain "Linode"', () => {
    expect(linode.displayName).toBe('Linode');
  });
});

describe('capacityPreferences.linode', () => {
  it('scales every default Standard plan one size up (db g6-standard-1, the rest g6-standard-2)', () => {
    expect(testConfig.e2e.capacityPreferences.linode.scaleTo).toEqual({
      'g6-standard-1': 'g6-standard-2',
      'g6-standard-2': 'g6-standard-4',
    });
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
