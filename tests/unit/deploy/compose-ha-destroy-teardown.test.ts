/**
 * C10b — destroyComposeHA's three duplicate teardown primitives (a
 * deleteFirewallByName twin, a server DELETE+poll loop, and an unpaginated
 * ssh-key list+delete) converge onto the HetznerProvider instance methods
 * C10a put on the class. These tests exercise `destroyComposeHA` end to end
 * against a mocked `fetchWithRetry` (shared by both ha.js's own calls and
 * the provider's) to prove the wiring actually delegates, and pin the one
 * sanctioned behavior change: the ssh-key delete now goes through
 * `?name=<exact>` instead of listing every key unfiltered/unpaginated and
 * matching client-side (the latent leak this fixes — RCA-mirror of
 * destroy's 2026-04-27 firewall pagination fix).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetryMock = vi.fn();

vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { destroyComposeHA } from '../../../src/lib/deploy/compose/ha.js';

const BASE = 'https://api.hetzner.cloud/v1';
const TOKEN = 'test-token';

type Resp = { ok: boolean; status: number; json: () => Promise<unknown> };

function resp(body: unknown, status = 200): Resp {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Records of `fetchWithRetry(url, init)` calls as `[method, url]` tuples. */
function calls(): Array<[string, string]> {
  return fetchWithRetryMock.mock.calls.map((c) => [
    ((c[1] as { method?: string })?.method ?? 'GET') as string,
    c[0] as string,
  ]);
}

// Both servers already known via envConfig (matches resolveHaServers' "both
// present" path), so no lookup is needed for the PERMANENT pair — the test
// stays focused on the three converging teardown primitives.
const envConfig = {
  servers: [
    { id: 101, ip: '1.1.1.1', providerServerName: 'proj-e2-primary' },
    { id: 102, ip: '2.2.2.2', providerServerName: 'proj-e2-standby' },
  ],
};

// resolveHaServers still probes the rest of the lifecycle name family up front
// — the bare compose name and every `-new` twin `scale` can leave behind (see
// lib/destroy/server-naming.js). They resolve to nothing here; the four
// responses just have to be consumed before the teardown's own calls begin.
const DISCOVERY_NAMES = ['proj-e2', 'proj-e2-new', 'proj-e2-primary-new', 'proj-e2-standby-new'];
const DISCOVERY_CALLS: Array<[string, string]> = DISCOVERY_NAMES.map((name) => [
  'GET',
  `${BASE}/servers?name=${name}`,
]);

function mockDiscovery() {
  for (const _ of DISCOVERY_NAMES) fetchWithRetryMock.mockResolvedValueOnce(resp({ servers: [] }));
}

describe('destroyComposeHA — teardown converges onto HetznerProvider methods (C10b)', () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deletes both servers, all 3 firewall names, and the ssh key via provider methods — in order', async () => {
    const fetchSpy = vi.fn(); // deleteServer's post-DELETE poll probe — never reached (both DELETEs return 404)
    vi.stubGlobal('fetch', fetchSpy);

    mockDiscovery();
    fetchWithRetryMock
      .mockResolvedValueOnce(resp({}, 404)) // DELETE /servers/101 (already gone)
      .mockResolvedValueOnce(resp({}, 404)) // DELETE /servers/102 (already gone)
      .mockResolvedValueOnce(resp({ firewalls: [] })) // GET firewalls?name=...-primary-firewall
      .mockResolvedValueOnce(resp({ firewalls: [] })) // GET firewalls?name=...-standby-firewall
      .mockResolvedValueOnce(resp({ firewalls: [] })) // GET firewalls?name=...-firewall
      .mockResolvedValueOnce(resp({ ssh_keys: [] })); // GET ssh_keys?name=proj-e2-key

    await destroyComposeHA({
      projectName: 'proj',
      environment: 'e2',
      envConfig,
      providerToken: TOKEN,
      onProgress: () => {},
    });

    expect(calls()).toEqual([
      ...DISCOVERY_CALLS,
      ['DELETE', `${BASE}/servers/101`],
      ['DELETE', `${BASE}/servers/102`],
      ['GET', `${BASE}/firewalls?name=proj-e2-primary-firewall`],
      ['GET', `${BASE}/firewalls?name=proj-e2-standby-firewall`],
      ['GET', `${BASE}/firewalls?name=proj-e2-firewall`],
      ['GET', `${BASE}/ssh_keys?name=proj-e2-key`],
    ]);
    // 404 DELETEs mean "already gone" — deleteServer's waitUntilGone poll is
    // skipped entirely.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SANCTIONED DEVIATION #2 — finds and deletes the shared ssh key by exact ?name= match', async () => {
    mockDiscovery();
    fetchWithRetryMock
      .mockResolvedValueOnce(resp({}, 404)) // DELETE /servers/101
      .mockResolvedValueOnce(resp({}, 404)) // DELETE /servers/102
      .mockResolvedValueOnce(resp({ firewalls: [] }))
      .mockResolvedValueOnce(resp({ firewalls: [] }))
      .mockResolvedValueOnce(resp({ firewalls: [] }))
      .mockResolvedValueOnce(resp({ ssh_keys: [{ id: 999, name: 'proj-e2-key' }] })) // found by name
      .mockResolvedValueOnce(resp({}, 204)); // DELETE /ssh_keys/999

    await destroyComposeHA({
      projectName: 'proj',
      environment: 'e2',
      envConfig,
      providerToken: TOKEN,
      onProgress: () => {},
    });

    const all = calls();
    // The list call is filtered server-side by name (not the old unfiltered
    // `GET /ssh_keys` that then matched client-side) — a 25+ key project no
    // longer hides the shared key past page 1.
    expect(all).toContainEqual(['GET', `${BASE}/ssh_keys?name=proj-e2-key`]);
    expect(all).toContainEqual(['DELETE', `${BASE}/ssh_keys/999`]);
  });

  // Best-effort is kept — one refusal must not strand the rest of the teardown
  // — but the settlement is no longer DISCARDED. `allSettled` plus a caller
  // that never inspected the results is exactly how a compose-ha destroy
  // reported success over a still-running server and exited 0 (2026-07-22).
  it('does not throw when a server DELETE fails, and REPORTS the survivor as a leak', async () => {
    vi.stubGlobal('fetch', vi.fn());

    mockDiscovery();
    fetchWithRetryMock
      .mockResolvedValueOnce(resp({ error: { message: 'locked', code: 'locked' } }, 423)) // DELETE /servers/101 fails
      .mockResolvedValueOnce(resp({}, 404)) // DELETE /servers/102 fine
      .mockResolvedValueOnce(resp({ firewalls: [] }))
      .mockResolvedValueOnce(resp({ firewalls: [] }))
      .mockResolvedValueOnce(resp({ firewalls: [] }))
      .mockResolvedValueOnce(resp({ ssh_keys: [] }));

    const result = await destroyComposeHA({
      projectName: 'proj',
      environment: 'e2',
      envConfig,
      providerToken: TOKEN,
      onProgress: () => {},
    });

    // The teardown still RAN to completion (firewalls + ssh key were attempted
    // after the failed server delete — see the mock sequence above).
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(DISCOVERY_CALLS.length + 6);
    expect(result.leaks).toHaveLength(1);
    expect(result.leaks[0]).toMatchObject({ resourceClass: 'server' });
    expect(result.leaks[0].resource).toContain('101');
    expect(result.leaks[0].reason).toMatch(/locked/);
  });

  it('returns no leaks when every delete succeeds (clean teardown stays clean)', async () => {
    vi.stubGlobal('fetch', vi.fn());

    mockDiscovery();
    fetchWithRetryMock
      .mockResolvedValueOnce(resp({}, 404)) // DELETE /servers/101
      .mockResolvedValueOnce(resp({}, 404)) // DELETE /servers/102
      .mockResolvedValueOnce(resp({ firewalls: [] }))
      .mockResolvedValueOnce(resp({ firewalls: [] }))
      .mockResolvedValueOnce(resp({ firewalls: [] }))
      .mockResolvedValueOnce(resp({ ssh_keys: [] }));

    const result = await destroyComposeHA({
      projectName: 'proj',
      environment: 'e2',
      envConfig,
      providerToken: TOKEN,
      onProgress: () => {},
    });

    expect(result.leaks).toEqual([]);
  });
});

/**
 * M3 Task 9i fix round 1 — the reviewer found this call site had the exact
 * same root-only defect as destroy.js's two sites (see
 * tests/unit/lib/delete-apex-and-wildcard.test.ts for the shared
 * `deleteApexAndWildcard` helper's own unit coverage). destroyComposeHA's
 * SSH-key delete and DNS delete run concurrently (a single
 * `Promise.allSettled`), and root vs wildcard delete concurrently too
 * (inside `deleteApexAndWildcard`), so this mocks by URL/method instead of
 * a fixed call sequence — exact interleaving across those three concurrent
 * legs isn't something a test should pin.
 */
describe('destroyComposeHA — Cloudflare DNS root+wildcard pair (M3 Task 9i fix round 1)', () => {
  const cfEnvConfig = {
    ...envConfig,
    domain: 'e2.example.com',
    // Unified persisted shape (DNS-seam convergence): { provider, zoneId }.
    dns: { provider: 'cloudflare', zoneId: 'zone-9i' },
  };

  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    // The converged teardown resolves the DNS token itself (env-first via
    // resolveDnsToken) — there is no cloudflareToken parameter anymore.
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubEverything(rootContent: string | null, wildcardContent: string | null) {
    fetchWithRetryMock.mockImplementation((url: string, options?: { method?: string }) => {
      const method = options?.method ?? 'GET';
      // Hetzner Cloud side (servers/firewalls/ssh key) — "already gone /
      // not found" for all of it, matching the earlier tests in this file.
      if (url.startsWith(`${BASE}/servers/`)) return Promise.resolve(resp({}, 404));
      if (url.startsWith(`${BASE}/firewalls`)) return Promise.resolve(resp({ firewalls: [] }));
      if (url.startsWith(`${BASE}/ssh_keys`)) return Promise.resolve(resp({ ssh_keys: [] }));
      // Cloudflare side.
      if (url.includes('/healthchecks')) return Promise.resolve(resp({ result: [] }));
      if (url.includes('/dns_records/')) {
        return Promise.resolve(resp({ success: true })); // DELETE by id
      }
      if (url.includes('/dns_records?')) {
        // deleteDNSRecord filters listed records by exact `r.name === name`,
        // so the stub must echo back the queried name.
        const name = url.match(/[?&]name=([^&]+)/)?.[1] || '';
        const isWildcard = name.startsWith('*.');
        const content = isWildcard ? wildcardContent : rootContent;
        const result = content
          ? [{ id: isWildcard ? 'wc' : 'root', name, type: 'A', content }]
          : [];
        return Promise.resolve(resp({ result }));
      }
      throw new Error(`Unexpected fetchWithRetry call: ${method} ${url}`);
    });
  }

  function dnsRecordDeleteIds(): string[] {
    return fetchWithRetryMock.mock.calls
      .filter(
        ([url, options]) =>
          String(url).includes('/dns_records/') &&
          ((options as { method?: string })?.method ?? 'GET') === 'DELETE',
      )
      .map(([url]) => String(url).split('/dns_records/')[1]);
  }

  it('deletes both root and wildcard when both point at an owned (server) IP', async () => {
    stubEverything('1.1.1.1', '1.1.1.1');

    await destroyComposeHA({
      projectName: 'proj',
      environment: 'e2',
      envConfig: cfEnvConfig,
      providerToken: TOKEN,
      onProgress: () => {},
    });

    expect(dnsRecordDeleteIds().sort()).toEqual(['root', 'wc']);
  });

  it('deletes the owned root but preserves an unowned wildcard', async () => {
    stubEverything('1.1.1.1', '9.9.9.9');

    await destroyComposeHA({
      projectName: 'proj',
      environment: 'e2',
      envConfig: cfEnvConfig,
      providerToken: TOKEN,
      onProgress: () => {},
    });

    expect(dnsRecordDeleteIds()).toEqual(['root']);
  });
});
