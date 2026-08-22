import { describe, expect, it } from 'vitest';
import { probeZoneAuthoritative, type SoaProbeDeps } from '../../e2e/utils/preflight.js';

/**
 * `probeZoneAuthoritative` closes the gap between "the provider's API can see
 * this zone" and "the provider's nameservers answer for it".
 *
 * The concrete failure it exists to catch: Linode only serves DNS for accounts
 * holding at least one active Linode. With zero instances, the zone reads
 * `"status": "active"` over the API while every ns1-5.linode.com returns
 * REFUSED — so an API-only preflight passes and the run dies ~20 minutes later
 * at ACME.
 *
 * The asymmetry below is deliberate and is the whole design: only an explicit
 * REFUSED/SERVFAIL fails. Every inconclusive state stays passing, because a
 * DNS blip must never abort a healthy matrix.
 */

function deps(over: Partial<SoaProbeDeps> = {}): SoaProbeDeps {
  return {
    resolveNs: async () => ['ns1.example.net'],
    resolveAddr: async () => ['192.0.2.1'],
    soaFrom: async () => ({ primary: 'ns1.example.net' }),
    ...over,
  };
}

function dnsErr(code: string): Error & { code: string } {
  return Object.assign(new Error(`quer${code}`), { code });
}

describe('probeZoneAuthoritative', () => {
  it('passes when the delegated nameserver answers with an SOA', async () => {
    const r = await probeZoneAuthoritative('do.appcarbon.dev', deps());
    expect(r.served).toBe(true);
    expect(r.detail).toContain('ns1.example.net');
  });

  it('FAILS on REFUSED — the Linode no-active-instance gate', async () => {
    const r = await probeZoneAuthoritative('linode.appcarbon.dev', {
      ...deps({ soaFrom: async () => Promise.reject(dnsErr('REFUSED')) }),
    });
    expect(r.served).toBe(false);
    // The detail must name the zone and the code: this string is what an
    // operator sees instead of a 20-minute ACME timeout.
    expect(r.detail).toContain('REFUSED');
    expect(r.detail).toContain('linode.appcarbon.dev');
  });

  it('FAILS on SERVFAIL — a broken delegation is equally unusable', async () => {
    const r = await probeZoneAuthoritative('linode.appcarbon.dev', {
      ...deps({ soaFrom: async () => Promise.reject(dnsErr('SERVFAIL')) }),
    });
    expect(r.served).toBe(false);
    expect(r.detail).toContain('SERVFAIL');
  });

  it('does NOT fail on a timeout — a blip is not a verdict', async () => {
    const r = await probeZoneAuthoritative('do.appcarbon.dev', {
      ...deps({ soaFrom: async () => Promise.reject(dnsErr('ETIMEOUT')) }),
    });
    expect(r.served).toBe(true);
    expect(r.detail).toContain('inconclusive');
  });

  it('does NOT fail when the zone has no NS records yet', async () => {
    // Fresh delegation that has not propagated — retrying later is correct,
    // aborting the matrix is not.
    const r = await probeZoneAuthoritative('new.appcarbon.dev', {
      ...deps({ resolveNs: async () => [] }),
    });
    expect(r.served).toBe(true);
    expect(r.detail).toContain('no NS records');
  });

  it('does NOT fail when the NS lookup itself errors', async () => {
    const r = await probeZoneAuthoritative('do.appcarbon.dev', {
      ...deps({ resolveNs: async () => Promise.reject(dnsErr('ENOTFOUND')) }),
    });
    expect(r.served).toBe(true);
    expect(r.detail).toContain('inconclusive');
  });

  it('does NOT fail when the nameserver hostname will not resolve', async () => {
    const r = await probeZoneAuthoritative('do.appcarbon.dev', {
      ...deps({ resolveAddr: async () => Promise.reject(dnsErr('ENOTFOUND')) }),
    });
    expect(r.served).toBe(true);
    expect(r.detail).toContain('unresolvable');
  });

  it('queries the FIRST delegated nameserver, by address, for the matched zone', async () => {
    // Pins the wiring: REFUSED is an account-level gate, so one nameserver is
    // sufficient and the query must go to the delegated server's IP — not to
    // the ambient recursive resolver, which would cache right past the gate.
    const seen: Array<[string, string]> = [];
    await probeZoneAuthoritative('linode.appcarbon.dev', {
      ...deps({
        resolveNs: async () => ['ns1.linode.com', 'ns2.linode.com'],
        resolveAddr: async (host) =>
          host === 'ns1.linode.com' ? ['198.51.100.7'] : ['203.0.113.9'],
        soaFrom: async (ip, zone) => {
          seen.push([ip, zone]);
          return {};
        },
      }),
    });
    expect(seen).toEqual([['198.51.100.7', 'linode.appcarbon.dev']]);
  });
});
