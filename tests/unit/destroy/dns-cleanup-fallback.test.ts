import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DNS cleanup for deploys that died BEFORE the end-of-deploy persist —
 * observed live 2026-08-08 (d1 vs the DigitalOcean droplet-creation outage):
 * the warm-up had already written apex+wildcard A records at the 0.0.0.0
 * placeholder, the deploy failed at provisioning, and destroy printed NO DNS
 * lines at all — `envConfig.dns` never got persisted, so the converged
 * cleanup had nothing to key on, and even with config the ownership filter
 * would refuse 0.0.0.0 (no servers ever existed to own it).
 *
 * Two rules under test, both in destroy.js's cleanupDnsRecords:
 *  1. The 0.0.0.0 warm-up sentinel is ALWAYS ours to reap (it is never a
 *     legitimate serving target) — folded into the ownership filter.
 *  2. When the nested `dns: { provider, zoneId }` block is missing, fall
 *     back to the pre-deploy flat `dnsProvider` binding + zone discovery by
 *     domain (label-boundary match, never bare endsWith).
 */

const fetchWithRetryMock = vi.fn();

vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { cleanupDnsRecords } from '../../../src/destroy.js';

function resp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeResults() {
  const leaks: unknown[] = [];
  return {
    dns: [] as string[],
    healthChecks: [] as string[],
    leaks: {
      leak: (entry: unknown) => leaks.push(entry),
      // Ownership-preserved records are FYI entries, not leaks (see
      // leak-ledger.js `foreign`).
      foreign: (entry: unknown) => leaks.push(entry),
      entries: leaks,
    },
  };
}

const noopSpinner = { start: () => {}, stop: () => {}, message: () => {} };

beforeEach(() => {
  fetchWithRetryMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function deletedRecordIds(): string[] {
  // Matches both wire shapes: cloudflare `/dns_records/<id>` and
  // digitalocean `/records/<id>`.
  return fetchWithRetryMock.mock.calls
    .filter(([, options]) => ((options as { method?: string })?.method ?? 'GET') === 'DELETE')
    .map(([url]) => String(url).match(/records\/([^/?]+)$/)?.[1])
    .filter((id): id is string => Boolean(id));
}

describe('cleanupDnsRecords — 0.0.0.0 warm-up sentinel', () => {
  it('reaps placeholder records with NO servers persisted, preserving foreign targets', async () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf-token');
    fetchWithRetryMock.mockImplementation((url: string, options?: { method?: string }) => {
      const method = options?.method ?? 'GET';
      if (method === 'DELETE') return Promise.resolve(resp({ success: true }));
      if (String(url).includes('/dns_records?')) {
        const name = String(url).match(/[?&]name=([^&]+)/)?.[1] || '';
        const isWildcard = name.startsWith('*.');
        // Apex: our placeholder. Wildcard: someone else's record — preserved.
        const result = isWildcard
          ? [{ id: 'wc-foreign', name, type: 'A', content: '9.9.9.9' }]
          : [{ id: 'root-placeholder', name, type: 'A', content: '0.0.0.0' }];
        return Promise.resolve(resp({ result }));
      }
      if (String(url).includes('/healthchecks')) return Promise.resolve(resp({ result: [] }));
      throw new Error(`Unexpected fetchWithRetry call: ${method} ${url}`);
    });

    const results = makeResults();
    await cleanupDnsRecords({
      envConfig: {
        domain: 'd1.do.appcarbon.dev',
        provider: 'hetzner',
        dns: { provider: 'cloudflare', zoneId: 'zone-1' },
        servers: [],
      },
      ownedIps: [],
      providerToken: 'hz-token',
      s: noopSpinner,
      results,
    });

    expect(deletedRecordIds()).toEqual(['root-placeholder']);
    expect(results.dns).toEqual(['d1.do.appcarbon.dev']);
  });
});

describe('cleanupDnsRecords — flat-binding fallback (deploy died pre-persist)', () => {
  it('discovers the zone from the flat dnsProvider and reaps the placeholder pair', async () => {
    fetchWithRetryMock.mockImplementation((url: string, options?: { method?: string }) => {
      const method = options?.method ?? 'GET';
      const u = String(url);
      if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
      if (u.includes('/v2/domains?') || /\/v2\/domains\?/.test(u)) {
        return Promise.resolve(
          resp({ domains: [{ name: 'appcarbon.dev' }, { name: 'do.appcarbon.dev' }], links: {} }),
        );
      }
      if (u.includes('/v2/domains/do.appcarbon.dev/records')) {
        return Promise.resolve(
          resp({
            domain_records: [
              { id: 11, name: 'd1', type: 'A', data: '0.0.0.0' },
              { id: 12, name: '*.d1', type: 'A', data: '0.0.0.0' },
            ],
            links: {},
          }),
        );
      }
      throw new Error(`Unexpected fetchWithRetry call: ${method} ${u}`);
    });

    const results = makeResults();
    await cleanupDnsRecords({
      envConfig: {
        domain: 'd1.do.appcarbon.dev',
        provider: 'digitalocean',
        dnsProvider: 'digitalocean', // pre-deploy flat binding — nested dns never persisted
        servers: [],
      },
      ownedIps: [],
      providerToken: 'do-token',
      s: noopSpinner,
      results,
    });

    // The account holds BOTH the parent and the delegated child zone — the
    // records must be looked up in the child (most-specific match), never
    // in whichever zone the API listed first.
    expect(deletedRecordIds().sort()).toEqual(['11', '12']);
    expect(results.dns).toEqual(['d1.do.appcarbon.dev']);
  });

  it('zone discovery requires a label boundary — no bare endsWith matches', async () => {
    fetchWithRetryMock.mockImplementation((url: string, options?: { method?: string }) => {
      const u = String(url);
      if (/\/v2\/domains\?/.test(u)) {
        return Promise.resolve(resp({ domains: [{ name: 'appcarbon.dev' }], links: {} }));
      }
      throw new Error(`Unexpected fetchWithRetry call: ${options?.method ?? 'GET'} ${u}`);
    });

    const results = makeResults();
    await cleanupDnsRecords({
      envConfig: {
        // endsWith('appcarbon.dev') is true but the label boundary is not —
        // deleting here would reach into a stranger's zone.
        domain: 'd1.evilappcarbon.dev',
        provider: 'digitalocean',
        dnsProvider: 'digitalocean',
        servers: [],
      },
      ownedIps: [],
      providerToken: 'do-token',
      s: noopSpinner,
      results,
    });

    const recordCalls = fetchWithRetryMock.mock.calls.filter(([url]) =>
      String(url).includes('/records'),
    );
    expect(recordCalls).toEqual([]);
    expect(results.dns).toEqual([]);
  });

  it('does nothing (zero API calls) when neither nested nor flat provider exists', async () => {
    const results = makeResults();
    await cleanupDnsRecords({
      envConfig: { domain: 'd1.do.appcarbon.dev', provider: 'hetzner', servers: [] },
      ownedIps: ['1.2.3.4'],
      providerToken: 'hz-token',
      s: noopSpinner,
      results,
    });
    expect(fetchWithRetryMock.mock.calls).toEqual([]);
  });
});
