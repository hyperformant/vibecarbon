/**
 * Contract pins for the `DNS_PROVIDERS` registry (src/lib/dns-provider.js).
 *
 * Supersedes the frozen pre-convergence characterization that pinned the
 * two-armed cloudflare-vs-hetzner ternary and its silent-Hetzner fallback.
 * That file's own header said it existed so "a later table-driven rewrite
 * can be checked against it" — this is that rewrite (2026-08-08 DNS seam
 * convergence, the dns-seam-audit plan). The
 * deliberate behavior change it sanctions: unknown/manual ids now THROW
 * instead of silently resolving to the Hetzner module — the same
 * de-defaulting applied to the compute axis (runner capacityWiring,
 * TYPE_FETCHERS). Everything else here is a pin: registry shape, module
 * naming convention, token-env lockstep with the compute registry, and the
 * same-compute-token aliasing rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cloudflareDnsModule from '../../../src/lib/cloudflare-dns.js';
import {
  DNS_PROVIDERS,
  findZoneForDomain,
  getDnsProvider,
  hasAutomatedDns,
  resolveDnsToken,
} from '../../../src/lib/dns-provider.js';
import * as hetznerDnsModule from '../../../src/lib/hetzner-dns.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DNS_PROVIDERS registry shape', () => {
  it('has exactly the six automated backends', () => {
    expect(Object.keys(DNS_PROVIDERS).sort()).toEqual([
      'cloudflare',
      'digitalocean',
      'hetzner',
      'linode',
      'scaleway',
      'vultr',
    ]);
  });

  it('every row follows the ./<id>-dns.js module naming convention', () => {
    for (const [id, row] of Object.entries(DNS_PROVIDERS)) {
      expect(row.modulePath, id).toBe(`./${id}-dns.js`);
    }
  });

  it('compute-backed rows keep tokenEnv in lockstep with the compute registry', () => {
    // The same-token rule ("native DNS needs zero extra credentials") only
    // holds while these stay byte-identical to PROVIDERS[id].TOKEN_ENV.
    for (const [id, row] of Object.entries(DNS_PROVIDERS)) {
      if (row.computeProviderId === null) continue;
      expect(row.computeProviderId, id).toBe(id);
      expect(PROVIDERS[row.computeProviderId], id).toBeDefined();
      expect(row.tokenEnv, id).toBe(PROVIDERS[row.computeProviderId].TOKEN_ENV);
    }
  });

  it('cloudflare is the only row with no compute sibling', () => {
    const standalone = Object.entries(DNS_PROVIDERS)
      .filter(([, row]) => row.computeProviderId === null)
      .map(([id]) => id);
    expect(standalone).toEqual(['cloudflare']);
    expect(DNS_PROVIDERS.cloudflare.tokenEnv).toBe('CLOUDFLARE_API_TOKEN');
  });

  it('every row carries a human-readable name', () => {
    for (const [id, row] of Object.entries(DNS_PROVIDERS)) {
      expect(typeof row.name, id).toBe('string');
      expect(row.name.length, id).toBeGreaterThan(0);
    }
  });
});

describe('getDnsProvider', () => {
  it('resolves the two pre-convergence backends to their real modules', async () => {
    expect(await getDnsProvider('cloudflare')).toBe(cloudflareDnsModule);
    expect(await getDnsProvider('hetzner')).toBe(hetznerDnsModule);
  });

  it('THROWS on manual/unknown/absent ids — the silent-Hetzner fallback is gone', () => {
    for (const bad of ['manual', undefined, null, '', 'route53']) {
      expect(() => getDnsProvider(bad as string)).toThrowError(/unknown dns provider/i);
    }
  });

  it('names the valid ids in the error so the failure is actionable', () => {
    try {
      getDnsProvider('route53');
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      for (const id of Object.keys(DNS_PROVIDERS)) {
        expect(message).toContain(id);
      }
      expect(message).toContain('manual');
    }
  });
});

describe('hasAutomatedDns', () => {
  it('is true for every registry id and false for manual/unknown/absent', () => {
    for (const id of Object.keys(DNS_PROVIDERS)) {
      expect(hasAutomatedDns(id), id).toBe(true);
    }
    expect(hasAutomatedDns('manual')).toBe(false);
    expect(hasAutomatedDns('route53')).toBe(false);
    expect(hasAutomatedDns(undefined as unknown as string)).toBe(false);
    expect(hasAutomatedDns(null as unknown as string)).toBe(false);
  });
});

describe('resolveDnsToken', () => {
  it('aliases the compute token when DNS and compute are the same cloud', () => {
    for (const id of ['hetzner', 'digitalocean', 'linode', 'vultr', 'scaleway']) {
      expect(resolveDnsToken(id, { computeProviderId: id, computeToken: 'compute-tok' }), id).toBe(
        'compute-tok',
      );
    }
  });

  it('falls back to the row tokenEnv on cross-cloud DNS', () => {
    vi.stubEnv('HETZNER_API_TOKEN', 'hz-env-tok');
    expect(
      resolveDnsToken('hetzner', { computeProviderId: 'digitalocean', computeToken: 'do-tok' }),
    ).toBe('hz-env-tok');
  });

  it('never aliases the compute token for cloudflare (no compute sibling)', () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf-env-tok');
    expect(
      resolveDnsToken('cloudflare', { computeProviderId: 'cloudflare', computeToken: 'nope' }),
    ).toBe('cf-env-tok');
  });

  it('returns null (not undefined, not a throw) when no credential is available', () => {
    vi.stubEnv('VULTR_API_TOKEN', '');
    expect(
      resolveDnsToken('vultr', { computeProviderId: 'hetzner', computeToken: 'hz-tok' }),
    ).toBeNull();
    expect(resolveDnsToken('vultr')).toBeNull();
  });

  it('throws on unknown ids like the dispatcher does', () => {
    expect(() => resolveDnsToken('route53', {})).toThrowError(/unknown dns provider/i);
    expect(() => resolveDnsToken('manual', {})).toThrowError(/unknown dns provider/i);
  });
});

describe('locateDomainBackend (which backend serves this domain TODAY)', () => {
  // Added for Scaleway's external-domain onboarding: the ownership TXT has to
  // be published wherever the domain's DNS lives now, and that is frequently a
  // backend we already drive — so the CLI can write it instead of printing
  // instructions. Registry-driven, so a sixth backend becomes a candidate host
  // with no edit here.
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  it('finds the backend holding the zone, and hands back the token it resolved', async () => {
    vi.stubEnv('DIGITALOCEAN_API_TOKEN', 'do-tok');
    fetchMock.mockResolvedValue(
      json({ domains: [{ name: 'example.com' }], links: {}, meta: { total: 1 } }),
    );

    const { locateDomainBackend } = await import('../../../src/lib/dns-provider.js');
    const hit = await locateDomainBackend('e1.example.com');

    expect(hit).toMatchObject({ providerId: 'digitalocean', token: 'do-tok' });
    expect(hit?.zone.name).toBe('example.com');
  });

  it('skips backends with no credential — an absent token is not an error', async () => {
    // Nothing stubbed: every row resolves to null and the search is a no-op.
    const { locateDomainBackend } = await import('../../../src/lib/dns-provider.js');
    expect(await locateDomainBackend('e1.example.com')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failing backend is skipped, not fatal — the search continues', async () => {
    vi.stubEnv('DIGITALOCEAN_API_TOKEN', 'revoked');
    vi.stubEnv('VULTR_API_TOKEN', 'vultr-tok');
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('digitalocean')
          ? json({ message: 'Unable to authenticate you' }, 401)
          : json({ domains: [{ domain: 'example.com' }], meta: { links: {} } }),
      ),
    );

    const { locateDomainBackend } = await import('../../../src/lib/dns-provider.js');
    const hit = await locateDomainBackend('e1.example.com');

    expect(hit?.providerId).toBe('vultr');
  });

  it('picks the MOST-SPECIFIC zone across backends, not the first one found', async () => {
    // Same rule as findZoneForDomain applies between accounts: records for a
    // delegated child are only served from the child's zone.
    vi.stubEnv('DIGITALOCEAN_API_TOKEN', 'do-tok');
    vi.stubEnv('VULTR_API_TOKEN', 'vultr-tok');
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('digitalocean')
          ? json({ domains: [{ name: 'example.com' }], links: {}, meta: { total: 1 } })
          : json({ domains: [{ domain: 'do.example.com' }], meta: { links: {} } }),
      ),
    );

    const { locateDomainBackend } = await import('../../../src/lib/dns-provider.js');
    const hit = await locateDomainBackend('e1.do.example.com');

    expect(hit?.providerId).toBe('vultr');
    expect(hit?.zone.name).toBe('do.example.com');
  });

  it('honours `exclude` — the backend a domain is being MOVED to is not its current host', async () => {
    vi.stubEnv('DIGITALOCEAN_API_TOKEN', 'do-tok');
    fetchMock.mockResolvedValue(
      json({ domains: [{ name: 'example.com' }], links: {}, meta: { total: 1 } }),
    );

    const { locateDomainBackend } = await import('../../../src/lib/dns-provider.js');
    expect(await locateDomainBackend('e1.example.com', { exclude: ['digitalocean'] })).toBeNull();
  });
});

describe('findZoneForDomain (the one zone-matching rule)', () => {
  it('requires a label boundary — bare-endsWith lookalikes never match', () => {
    const zones = [{ id: 'z', name: 'appcarbon.dev' }];
    expect(findZoneForDomain(zones, 'd1.evilappcarbon.dev')).toBeNull();
    expect(findZoneForDomain(zones, 'd1.appcarbon.dev')).toBe(zones[0]);
    expect(findZoneForDomain(zones, 'appcarbon.dev')).toBe(zones[0]);
  });

  it('picks the MOST-SPECIFIC zone regardless of listing order', () => {
    const parentFirst = [
      { id: 'parent', name: 'appcarbon.dev' },
      { id: 'child', name: 'do.appcarbon.dev' },
    ];
    const childFirst = [...parentFirst].reverse();
    expect(findZoneForDomain(parentFirst, 'd1.do.appcarbon.dev')?.id).toBe('child');
    expect(findZoneForDomain(childFirst, 'd1.do.appcarbon.dev')?.id).toBe('child');
    // A sibling of the child still resolves to the parent.
    expect(findZoneForDomain(parentFirst, 'e1.appcarbon.dev')?.id).toBe('parent');
  });

  it('tolerates trailing dots and empty inputs', () => {
    const zones = [{ id: 'z', name: 'appcarbon.dev.' }];
    expect(findZoneForDomain(zones, 'd1.appcarbon.dev.')?.id).toBe('z');
    expect(findZoneForDomain([], 'd1.appcarbon.dev')).toBeNull();
    expect(findZoneForDomain(undefined as unknown as [], 'd1.appcarbon.dev')).toBeNull();
  });
});
