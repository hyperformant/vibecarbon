import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../config.js';
import { runPreflight } from '../../e2e/utils/preflight.js';
import { judgeDelegation, readRegistry } from '../../e2e/utils/registry-delegation.js';

vi.mock('../../../src/lib/dns-provider.js', async (original) => ({
  ...(await original<typeof import('../../../src/lib/dns-provider.js')>()),
  getDnsProvider: async () => ({ getZones: async () => [{ name: 'threadtrace.app' }] }),
}));

/**
 * A test domain whose registration lapses keeps its zone: the DNS provider's
 * API still lists it and its nameservers still answer for it. Only the
 * registry knows the domain now points somewhere else. threadtrace.app lapsed
 * 2026-11-25 and passed every other preflight check; the run would have died
 * at DNS propagation and certificate issuance in both Scaleway scenarios.
 *
 * Only a registry answer that names other nameservers fails the check. A
 * registry that cannot be read never aborts a healthy run.
 */

const { domains } = testConfig.e2e;
const PARKED = ['dns101.registrar-servers.com', 'dns102.registrar-servers.com'];

/** What each apex's registry returned on 2026-11-25. */
const HOSTED: Record<string, string[]> = {
  hetzner: ['helium.ns.hetzner.de', 'hydrogen.ns.hetzner.com', 'oxygen.ns.hetzner.com'],
  cloudflare: ['ivan.ns.cloudflare.com', 'shaz.ns.cloudflare.com'],
  vultr: ['ns1.vultr.com', 'ns2.vultr.com'],
  scaleway: ['ns0.dom.scw.cloud', 'ns1.dom.scw.cloud'],
};

const judge = (dnsProvider: string, zone: string, nameservers: string[], expires?: string) =>
  judgeDelegation({
    dnsProvider,
    zone,
    domains,
    record: { nameservers, expires: expires ?? null },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('judgeDelegation', () => {
  it('fails a lapsed domain, naming the domain, where it points and what to do', () => {
    const r = judge('scaleway', 'threadtrace.app', PARKED);
    expect(r.delegated).toBe(false);
    expect(r.detail).toContain('threadtrace.app');
    expect(r.detail).toContain('dns101.registrar-servers.com');
    expect(r.detail).toContain('renew');
  });

  it.each(Object.entries(HOSTED))('passes an apex its provider hosts (%s)', (provider, ns) => {
    const zone = domains[provider as keyof typeof domains];
    expect(judge(provider, zone, ns).delegated).toBe(true);
  });

  it('every DNS provider in the domains map has nameservers to compare with', () => {
    for (const [provider, domain] of Object.entries(domains)) {
      expect(judge(provider, domain, PARKED).delegated, provider).toBe(false);
    }
  });

  it('judges a delegated child zone by who hosts its apex', () => {
    expect(judge('digitalocean', 'do.appcarbon.dev', HOSTED.cloudflare).delegated).toBe(true);
    expect(judge('linode', 'linode.appcarbon.dev', HOSTED.cloudflare).delegated).toBe(true);
    expect(judge('linode', 'linode.appcarbon.dev', PARKED).delegated).toBe(false);
  });

  it('does not judge a child zone whose apex is not one of ours', () => {
    expect(judge('digitalocean', 'e2e.example.com', PARKED).delegated).toBe(true);
  });

  it('compares whole names, so a lookalike host does not pass', () => {
    expect(judge('vultr', 'threvidence.com', ['ns1.vultr.com.evil.example']).delegated).toBe(false);
    expect(judge('vultr', 'threvidence.com', ['xns1.vultr.com']).delegated).toBe(false);
  });

  it('never fails on a registry that could not be read, or that names no nameservers', () => {
    const unread = judgeDelegation({
      dnsProvider: 'scaleway',
      zone: 'threadtrace.app',
      domains,
      record: null,
    });
    expect(unread.delegated).toBe(true);
    expect(judge('scaleway', 'threadtrace.app', []).delegated).toBe(true);
  });

  it('says when the registration ends', () => {
    expect(
      judge('vultr', 'threvidence.com', HOSTED.vultr, '2027-10-28T01:37:46Z').detail,
    ).toContain('2027-10-28');
  });
});

describe('readRegistry', () => {
  const answer = (routes: Record<string, unknown>) =>
    (async (url: string) => {
      const hit = Object.keys(routes).find((k) => String(url).startsWith(k));
      if (!hit) throw new Error(`unexpected request ${url}`);
      const body = routes[hit];
      return typeof body === 'number'
        ? new Response('', { status: body })
        : new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  const IANA = 'https://data.iana.org/rdap/dns.json';
  const BOOTSTRAP = { services: [[['app', 'dev'], ['https://registry.example/rdap/']]] };

  it('asks the registry IANA names for the TLD and normalizes what it says', async () => {
    const record = await readRegistry(
      'threadtrace.app',
      answer({
        [IANA]: BOOTSTRAP,
        'https://registry.example/rdap/domain/threadtrace.app': {
          nameservers: [{ ldhName: 'DNS101.registrar-servers.com.' }, { ldhName: '' }, {}],
          events: [
            { eventAction: 'registration', eventDate: '2025-11-25T00:44:13Z' },
            { eventAction: 'expiration', eventDate: '2027-11-25T00:44:13Z' },
          ],
        },
      }),
    );
    expect(record).toEqual({
      nameservers: ['dns101.registrar-servers.com'],
      expires: '2027-11-25T00:44:13Z',
    });
  });

  it.each([
    ['the bootstrap list is down', { [IANA]: 503 }],
    ['the TLD is not in the list', { [IANA]: { services: [] } }],
    ['the registry is down', { [IANA]: BOOTSTRAP, 'https://registry.example/': 500 }],
    ['nothing answers', {}],
  ])('reads nothing when %s', async (_name, routes) => {
    expect(await readRegistry('threadtrace.app', answer(routes))).toBeNull();
  });
});

describe('preflight', () => {
  it('fails a zone the provider still lists once the registry points elsewhere', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url);
      if (u.startsWith('https://data.iana.org/')) {
        return new Response(
          JSON.stringify({ services: [[['app'], ['https://registry.example/rdap/']]] }),
        );
      }
      if (u.startsWith('https://registry.example/')) {
        return new Response(
          JSON.stringify({ nameservers: PARKED.map((ldhName) => ({ ldhName })) }),
        );
      }
      return new Response('{}', { status: 200 });
    });
    const result = await runPreflight({
      needsHetzner: false,
      needsCloudflare: false,
      dnsChecks: [{ dnsProvider: 'scaleway', token: 'x', baseDomain: 'threadtrace.app' }],
    });
    const check = result.checks.find((c) => c.service === 'dns-scaleway');
    expect(check?.status).toBe('failed');
    expect(check?.detail).toContain('dns101.registrar-servers.com');
    expect(result.hasFailure).toBe(true);
  });
});
