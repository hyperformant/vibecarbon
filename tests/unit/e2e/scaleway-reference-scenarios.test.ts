import { describe, expect, it } from 'vitest';
import { testConfig } from '../../config.js';

/**
 * Config-shape pins for `testConfig.e2e.providers.scaleway` and the
 * `capacityPreferences.scaleway` block it draws from — the Scaleway analog
 * of vultr-reference-scenarios.test.ts (see do-reference-scenarios.test.ts's
 * header for why these pins exist: an edit to a provider's scenarios must
 * trip a test, not a live e2e run). Reads the `providers` registry — the
 * selection grammar's single source of truth (tests/e2e/selection.ts).
 */
describe('providers.scaleway (Scaleway opt-in scenarios)', () => {
  const scaleway = testConfig.e2e.providers.scaleway;

  it('has exactly two scenarios — compose + compose-ha (tier-parity wave 1; ScalewayProvider.SUPPORTED_TIERS stops at compose-ha)', () => {
    expect(scaleway.scenarios).toHaveLength(2);
    expect(scaleway.scenarios[0]).toEqual({
      mode: 'compose',
      dnsProvider: 'scaleway',
      envPrefix: 's1',
    });
    expect(scaleway.scenarios[1]).toEqual({
      mode: 'compose-ha',
      // Same-provider DNS so the s2 failover flip exercises the Scaleway
      // backend's setupHA/upsertApexAndWildcard path — the self-contained
      // default, same reasoning as Hetzner's e2.
      dnsProvider: 'scaleway',
      envPrefix: 's2',
    });
    expect(scaleway.defaultSelection).toEqual(['compose', 'compose-ha']);
  });

  it('names its required credentials — the full triple, nothing else', () => {
    expect(scaleway.requiredEnv).toEqual([
      'SCALEWAY_SECRET_KEY',
      'SCALEWAY_ACCESS_KEY',
      'SCALEWAY_DEFAULT_PROJECT_ID',
    ]);
  });

  it('requires the project id and access key alongside the secret key (the Pulumi triple)', () => {
    // The credential-shape divergence from every sibling: not a second
    // storage credential (the SAME IAM pair signs S3) but two REQUIRED
    // companions — the Pulumi provider demands all three, and
    // ScalewayProvider.buildIacEnv fails deploy-start naming a missing
    // one. SCALEWAY_DEFAULT_PROJECT_ID additionally carries the isolation
    // doctrine: it must name a DEDICATED Scaleway Project, because SSH
    // keys are Project-scoped and re-applied to every instance at boot.
    expect(scaleway.requiredEnv).toContain('SCALEWAY_ACCESS_KEY');
    expect(scaleway.requiredEnv).toContain('SCALEWAY_DEFAULT_PROJECT_ID');
    // And deliberately NO separate object-storage keys.
    expect(scaleway.requiredEnv.some((v) => /OBJECT_STORAGE|SPACES|^S3_/.test(v))).toBe(false);
  });

  it('displays as plain "Scaleway"', () => {
    expect(scaleway.displayName).toBe('Scaleway');
  });
});

describe('capacityPreferences.scaleway', () => {
  it('has one blanket typePair backing the compose scenario — the 2c/4G baseline, not DEV1', () => {
    // BASIC3-X2C-4G is the apples-to-apples 2-vCPU/4GB baseline (cx23 /
    // s-2vcpu-4gb / g6-standard-2 / vc2-2c-4gb). DEV1-M is cheaper but has
    // THREE vCPUs — a positioning problem for the perf table, not just a
    // spec mismatch (audit).
    expect(testConfig.e2e.capacityPreferences.scaleway.typePairs).toEqual([
      ['BASIC3-X2C-4G', 'BASIC3-X4C-8G'],
    ]);
  });

  it('carries only ZONES that offer both pair members AND the DEV1-M fallback', () => {
    // Zones, not regions — Scaleway's Instance API is zone-scoped, and NO
    // type exists in all ten zones (live per-zone catalog 2026-08-09).
    // fr-par-3 / nl-ams-3 / pl-waw-* / it-mil-1 are deliberately absent:
    // BASIC3 or the DEV1 fallback is missing there, and it-mil's S3 region
    // has ONEZONE_IA only.
    // ORDER IS LOAD-BEARING: the first two viable zones become s2's HA pair
    // (resolveScalewayCapacityPair), and fr-par-1+nl-ams-1 mirrors
    // ScalewayProvider.HA_REGIONS / getDefaultStandbyRegion's cross-country
    // pairing — fr-par-2 second would hand s2 a same-city pair.
    expect(testConfig.e2e.capacityPreferences.scaleway.regions).toEqual([
      'fr-par-1',
      'nl-ams-1',
      'fr-par-2',
      'nl-ams-2',
    ]);
    expect(testConfig.e2e.capacityPreferences.scaleway.regions).not.toContain('fr-par-3');
    expect(testConfig.e2e.capacityPreferences.scaleway.regions).not.toContain('it-mil-1');
  });
});
