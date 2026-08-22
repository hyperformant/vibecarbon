import { describe, expect, it } from 'vitest';
import { detectScenario } from '../../../src/failover.js';
import { DNS_PROVIDERS } from '../../../src/lib/dns-provider.js';

/**
 * DNS-seam convergence (2026-08-08): scenario detection collapsed from
 * per-provider strings (ha_cloudflare / ha_hetzner_dns) to one `ha_dns` for
 * ANY registered backend with a persisted zone — which backend flips is a
 * strategy detail (failover.js dnsStrategyFor), not a scenario. The persisted
 * shape is the unified `dns: { provider, zoneId }`.
 */
describe('detectScenario', () => {
  it('returns ha_dns for EVERY registered DNS backend with a persisted zone', () => {
    for (const id of Object.keys(DNS_PROVIDERS)) {
      expect(
        detectScenario({ ha: { enabled: true }, dns: { provider: id, zoneId: 'zone123' } }),
        id,
      ).toBe('ha_dns');
    }
  });

  it('returns ha_dns when ha is boolean true (legacy shape)', () => {
    expect(detectScenario({ ha: true, dns: { provider: 'cloudflare', zoneId: 'zone123' } })).toBe(
      'ha_dns',
    );
  });

  it('returns ha_manual when the provider is set but the zoneId is missing', () => {
    expect(detectScenario({ ha: { enabled: true }, dns: { provider: 'hetzner' } })).toBe(
      'ha_manual',
    );
    expect(detectScenario({ ha: { enabled: true }, dns: { provider: 'cloudflare' } })).toBe(
      'ha_manual',
    );
  });

  it('returns ha_manual for manual/absent/unknown DNS (never a silent flip attempt)', () => {
    expect(detectScenario({ ha: { enabled: true } })).toBe('ha_manual');
    expect(detectScenario({ ha: { enabled: true }, dns: {} })).toBe('ha_manual');
    expect(detectScenario({ ha: { enabled: true }, dns: { provider: 'manual' } })).toBe(
      'ha_manual',
    );
    // Unknown provider ids degrade to manual instructions rather than
    // throwing or (worse, the pre-convergence hazard) flipping via the
    // wrong cloud's API.
    expect(
      detectScenario({ ha: { enabled: true }, dns: { provider: 'route53', zoneId: 'z' } }),
    ).toBe('ha_manual');
  });

  it('returns single_server when no HA configured', () => {
    expect(detectScenario({})).toBe('single_server');
    expect(detectScenario({ ha: false })).toBe('single_server');
    expect(detectScenario({ ha: { enabled: false } })).toBe('single_server');
  });
});
