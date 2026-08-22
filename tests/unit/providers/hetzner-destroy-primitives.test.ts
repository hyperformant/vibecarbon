import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C10a — the destroy teardown primitives that used to live as raw-API
 * `hetzner*` helpers in src/destroy.js now live on HetznerProvider. The
 * destroy fixtures (tests/unit/destroy/*) dispatch on URL *substrings* and so
 * can't catch query-string drift (a dropped `?name=`, a missing `per_page=50`,
 * a label_selector encoding change). These tests assert each moved primitive's
 * FULL request URL + verb against a mocked `fetchWithRetry` (and the global
 * `fetch` the deleteServer 404-poll uses) so a wire-shape regression fails
 * here, loudly, in unit CI — the e2e matrix stays the true wire gate.
 */

const fetchWithRetryMock = vi.fn();

vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

const TOKEN = 'tok-primitives';
const BASE = 'https://api.hetzner.cloud/v1';

type Resp = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
};

function resp(body: unknown, status = 200): Resp {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Records of `fetchWithRetry(url, init)` calls as `[method, url]` tuples. */
function calls(): Array<[string, string]> {
  return fetchWithRetryMock.mock.calls.map((c) => [
    ((c[1] as { method?: string })?.method ?? 'GET') as string,
    c[0] as string,
  ]);
}

describe('HetznerProvider destroy primitives — exact wire URLs (C10a)', () => {
  let provider: HetznerProvider;

  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    provider = new HetznerProvider(TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listServers() → GET /servers?per_page=50&page=1 (no label selector)', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({ servers: [{ id: 1 }] }));
    const out = await provider.listServers();
    expect(calls()).toEqual([['GET', `${BASE}/servers?per_page=50&page=1`]]);
    expect(out).toEqual([{ id: 1 }]);
  });

  it('listServers(labels) → appends &label_selector= with url-encoded selector', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({ servers: [] }));
    await provider.listServers({ 'managed-by': 'vibecarbon', environment: 'prod' });
    expect(calls()).toEqual([
      [
        'GET',
        `${BASE}/servers?per_page=50&label_selector=managed-by%3Dvibecarbon%2Cenvironment%3Dprod&page=1`,
      ],
    ]);
  });

  it('listServers() walks pagination past the first page (B0-4)', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(
        resp({ servers: [{ id: 1 }, { id: 2 }], meta: { pagination: { next_page: 2 } } }),
      )
      .mockResolvedValueOnce(resp({ servers: [{ id: 3 }], meta: { pagination: {} } }));
    const out = await provider.listServers();
    expect(calls()).toEqual([
      ['GET', `${BASE}/servers?per_page=50&page=1`],
      ['GET', `${BASE}/servers?per_page=50&page=2`],
    ]);
    expect(out).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('listServers() returns [] on a non-ok response', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({ error: {} }, 500));
    expect(await provider.listServers()).toEqual([]);
  });

  it('listServers() keeps already-collected pages when a later page fails', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(resp({ servers: [{ id: 1 }], meta: { pagination: { next_page: 2 } } }))
      .mockResolvedValueOnce(resp({ error: {} }, 500));
    expect(await provider.listServers()).toEqual([{ id: 1 }]);
  });

  it('findServersByName() → GET /servers?name= with url-encoded name (B0-3)', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({ servers: [{ id: 9, name: 'a b' }] }));
    const out = await provider.findServersByName('a b');
    expect(calls()).toEqual([['GET', `${BASE}/servers?name=a%20b`]]);
    expect(out).toEqual([{ id: 9, name: 'a b' }]);
  });

  it('findServersByName() returns [] on a non-ok response', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({ error: {} }, 500));
    expect(await provider.findServersByName('x')).toEqual([]);
  });

  it('findServersByName() filters out non-exact name matches defensively', async () => {
    fetchWithRetryMock.mockResolvedValue(
      resp({
        servers: [
          { id: 1, name: 'proj-e2' },
          { id: 2, name: 'proj-e2-standby' },
        ],
      }),
    );
    expect(await provider.findServersByName('proj-e2')).toEqual([{ id: 1, name: 'proj-e2' }]);
  });

  it('listNetworks() → GET /networks (paginated)', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({ networks: [{ id: 7 }] }));
    const out = await provider.listNetworks();
    expect(calls()).toEqual([['GET', `${BASE}/networks?per_page=50&page=1`]]);
    expect(out).toEqual([{ id: 7 }]);
  });

  it('listNetworks() returns [] on a non-ok response', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({}, 503));
    expect(await provider.listNetworks()).toEqual([]);
  });

  it('listVolumes() → GET /volumes (paginated)', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({ volumes: [{ id: 9 }] }));
    const out = await provider.listVolumes();
    expect(calls()).toEqual([['GET', `${BASE}/volumes?per_page=50&page=1`]]);
    expect(out).toEqual([{ id: 9 }]);
  });

  // 2026-07-30: the Cloud API defaults to per_page=25 when the parameter is
  // omitted, so the pre-fix single-shot GET silently truncated — and the
  // destroy sweeps, which filter this list client-side, could not match what
  // they never received. Six orphaned pvc-* volumes survived a green run.
  it('listVolumes() walks every page (per_page=50 + meta.pagination.next_page)', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(resp({ volumes: [{ id: 1 }], meta: { pagination: { next_page: 2 } } }))
      .mockResolvedValueOnce(resp({ volumes: [{ id: 2 }], meta: { pagination: {} } }));
    const out = await provider.listVolumes();
    expect(calls()).toEqual([
      ['GET', `${BASE}/volumes?per_page=50&page=1`],
      ['GET', `${BASE}/volumes?per_page=50&page=2`],
    ]);
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('listVolumes() returns the pages collected so far on a mid-walk failure', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(resp({ volumes: [{ id: 1 }], meta: { pagination: { next_page: 2 } } }))
      .mockResolvedValueOnce(resp({}, 503));
    expect(await provider.listVolumes()).toEqual([{ id: 1 }]);
  });

  it('deleteVolume(id) → DELETE /volumes/{id} (true on ok)', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({}, 204));
    const out = await provider.deleteVolume(555);
    expect(calls()).toEqual([['DELETE', `${BASE}/volumes/555`]]);
    expect(out).toBe(true);
  });

  it('deleteVolume(id) → true on 404 (already gone)', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({}, 404));
    expect(await provider.deleteVolume(556)).toBe(true);
  });

  it('listLoadBalancers() → GET /load_balancers (paginated)', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({ load_balancers: [{ id: 3 }] }));
    const out = await provider.listLoadBalancers();
    expect(calls()).toEqual([['GET', `${BASE}/load_balancers?per_page=50&page=1`]]);
    expect(out).toEqual([{ id: 3 }]);
  });

  it('deleteLoadBalancer(id) → DELETE /load_balancers/{id}', async () => {
    fetchWithRetryMock.mockResolvedValue(resp({}, 200));
    const out = await provider.deleteLoadBalancer(42);
    expect(calls()).toEqual([['DELETE', `${BASE}/load_balancers/42`]]);
    expect(out).toBe(true);
  });

  it('deleteSSHKeyByName(name) → GET /ssh_keys?name= then DELETE /ssh_keys/{id}', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(resp({ ssh_keys: [{ id: 88 }] }))
      .mockResolvedValueOnce(resp({}, 204));
    const out = await provider.deleteSSHKeyByName('proj env key');
    expect(calls()).toEqual([
      ['GET', `${BASE}/ssh_keys?name=proj%20env%20key`],
      ['DELETE', `${BASE}/ssh_keys/88`],
    ]);
    expect(out).toBe(true);
  });

  it('deleteSSHKeyByName(name) → false (never deletes) when no key matches', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(resp({ ssh_keys: [] }));
    const out = await provider.deleteSSHKeyByName('missing');
    expect(calls()).toEqual([['GET', `${BASE}/ssh_keys?name=missing`]]);
    expect(out).toBe(false);
  });

  it('deleteFirewallByName(name) → GET /firewalls?name= then DELETE /firewalls/{id} (no attachments)', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(resp({ firewalls: [{ id: 12, applied_to: [] }] }))
      .mockResolvedValueOnce(resp({}, 204));
    const out = await provider.deleteFirewallByName('proj-prod-firewall');
    expect(calls()).toEqual([
      ['GET', `${BASE}/firewalls?name=proj-prod-firewall`],
      ['DELETE', `${BASE}/firewalls/12`],
    ]);
    expect(out).toEqual({ deleted: true, everExisted: true, apiError: null });
  });

  it('deleteFirewallByName(name) → detaches servers via remove_from_resources before DELETE', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(
        resp({ firewalls: [{ id: 13, applied_to: [{ type: 'server', server: { id: 900 } }] }] }),
      )
      .mockResolvedValueOnce(resp({})) // remove_from_resources
      .mockResolvedValueOnce(resp({}, 204)); // delete
    const out = await provider.deleteFirewallByName('fw');
    expect(calls()).toEqual([
      ['GET', `${BASE}/firewalls?name=fw`],
      ['POST', `${BASE}/firewalls/13/actions/remove_from_resources`],
      ['DELETE', `${BASE}/firewalls/13`],
    ]);
    expect(out.deleted).toBe(true);
  });

  it('deleteFirewallByName(name) → {deleted:false, everExisted:false} when the firewall is absent', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(resp({ firewalls: [] }));
    const out = await provider.deleteFirewallByName('gone');
    expect(calls()).toEqual([['GET', `${BASE}/firewalls?name=gone`]]);
    expect(out).toEqual({ deleted: false, everExisted: false, apiError: null });
  });

  describe('deleteServer(id, {waitUntilGone:true}) — destroy semantics: DELETE then 404-poll', () => {
    it('DELETEs via fetchWithRetry then polls the global fetch for 404', async () => {
      fetchWithRetryMock.mockResolvedValue(resp({}, 204));
      const fetchSpy = vi.fn(async () => resp({}, 404) as unknown as Response);
      vi.stubGlobal('fetch', fetchSpy);

      const out = await provider.deleteServer(321, { waitUntilGone: true });

      expect(calls()).toEqual([['DELETE', `${BASE}/servers/321`]]);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE}/servers/321`,
        expect.objectContaining({ headers: { Authorization: `Bearer ${TOKEN}` } }),
      );
      // 204 (not 404) DELETE ⇒ "was present" ⇒ returns true.
      expect(out).toBe(true);
    });

    it('skips the poll and returns false when the server was already gone (404 DELETE)', async () => {
      fetchWithRetryMock.mockResolvedValue(resp({}, 404));
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const out = await provider.deleteServer(322, { waitUntilGone: true });

      expect(calls()).toEqual([['DELETE', `${BASE}/servers/322`]]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(out).toBe(false);
    });

    it('throws the converged error.error.message shape on a non-2xx, non-404 DELETE (B0-5)', async () => {
      fetchWithRetryMock.mockResolvedValue(resp({ error: { message: 'boom', code: 'x' } }, 500));
      await expect(provider.deleteServer(323, { waitUntilGone: true })).rejects.toThrow(
        'Failed to delete server: boom',
      );
    });
  });

  describe('deleteServer(id) — scale semantics (default): no poll', () => {
    it('DELETEs and never polls the global fetch', async () => {
      fetchWithRetryMock.mockResolvedValue(resp({}, 204));
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await provider.deleteServer(400);

      expect(calls()).toEqual([['DELETE', `${BASE}/servers/400`]]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws the error.error.message shape on a non-2xx, non-404 DELETE', async () => {
      fetchWithRetryMock.mockResolvedValue(
        resp({ error: { message: 'server is locked', code: 'locked' } }, 423),
      );
      await expect(provider.deleteServer(401)).rejects.toThrow(
        'Failed to delete server: server is locked',
      );
    });

    it('does not throw on a 404 DELETE (already gone)', async () => {
      fetchWithRetryMock.mockResolvedValue(resp({}, 404));
      await expect(provider.deleteServer(402)).resolves.toBeUndefined();
    });
  });

  describe('renameServer', () => {
    it('PUTs /servers/{id} with {name} and does not check response.ok', async () => {
      fetchWithRetryMock.mockResolvedValue(resp({ error: { message: 'ignored' } }, 423));

      await expect(provider.renameServer(500, 'proj-prod-master')).resolves.toBeUndefined();

      expect(calls()).toEqual([['PUT', `${BASE}/servers/500`]]);
      const body = JSON.parse((fetchWithRetryMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body).toEqual({ name: 'proj-prod-master' });
    });
  });
});
