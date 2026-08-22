import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B3 — DigitalOcean instance methods (REST), the DO counterpart to
 * tests/unit/providers/hetzner-destroy-primitives.test.ts. Same pattern: stub
 * `fetchWithRetry` (which also transparently intercepts calls made through
 * `this.apiRequest`, since apiRequest dynamically imports fetch-retry.js and
 * vi.mock intercepts by resolved specifier, not import site — see
 * hetzner-destroy-primitives.test.ts's own scale-semantics deleteServer test
 * for the precedent) and, where a method uses a raw `fetch`
 * (getServerSummary, the waitUntilGone 404-poll), stub the global directly.
 *
 * Covers every wire contract from task-B3-brief.md's mapping table: exact
 * URLs/methods/bodies, DO's `{id, message}` error shape (not Hetzner's
 * `{error:{message,code}}`), the DO-specific pagination cursor
 * (`links.pages.next` presence, not `meta.pagination.next_page`), the
 * droplet-name-uniqueness recovery ordering (check-then-create, not
 * create-then-recover), and the firewall PUT-is-total-replace merge.
 */

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
}));

import {
  DigitalOceanProvider,
  decodeLabels,
  encodeLabel,
  encodeLabels,
  normalizePublicKey,
} from '../../../src/lib/providers/digitalocean.js';

const TOKEN = 'tok-do-methods';
const BASE = 'https://api.digitalocean.com/v2';

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

describe('encodeLabel / encodeLabels', () => {
  it('encodes key:value, replacing invalid tag characters with -', () => {
    expect(encodeLabel('managed-by', 'vibecarbon')).toBe('managed-by:vibecarbon');
    expect(encodeLabel('environment', 'e2 test')).toBe('environment:e2-test');
  });

  it('maps a labels object to an array of encoded tags', () => {
    expect(encodeLabels({ 'managed-by': 'vibecarbon', environment: 'prod' })).toEqual([
      'managed-by:vibecarbon',
      'environment:prod',
    ]);
    expect(encodeLabels()).toEqual([]);
  });

  // M3 Task 1 (correctness-critical) — these are the EXACT wire strings the
  // destroy sweep (Task 7) and carbon-autoscaler's groups.js listServers
  // filtering (below) match against on DO. `cluster-autoscaler/node`'s `/`
  // is not a legal DO tag character, so encodeLabel replaces it with `-`;
  // pinning the canonical output here is what keeps IaC tagging
  // (digitalocean-k8s.js, Task 5), createServer's `tags`, and destroy's
  // decode side from ever drifting apart.
  it('pins the canonical encoded tag for every k8s-critical label (destroy-sweep + groups.js wire contract)', () => {
    expect(encodeLabel('cluster-autoscaler/node', 'worker-pool')).toBe(
      'cluster-autoscaler-node:worker-pool',
    );
    expect(encodeLabel('cluster-autoscaler/node', 'static')).toBe('cluster-autoscaler-node:static');
    expect(encodeLabel('cluster', 'demo-cluster')).toBe('cluster:demo-cluster');
    expect(encodeLabel('managed-by', 'vibecarbon')).toBe('managed-by:vibecarbon');
  });

  // Collision check: every OTHER real label key this codebase tags k8s
  // droplets with (destroy.js, hetzner-k8s.js, k3s.js — see the M3 dossier's
  // repo inventory) contains no `/`, so none of them collapse onto
  // `cluster-autoscaler/node`'s encoded form after the slash→`-`
  // substitution. If a future key were added that differs from
  // `cluster-autoscaler/node` only by using `-` where it uses `/` (e.g. a
  // literal `cluster-autoscaler-node` key), it WOULD collide — there is no
  // such key today.
  it('does not collide with the other real k8s label keys (role, node-pool, os-flavor)', () => {
    const encoded = new Set([
      encodeLabel('cluster-autoscaler/node', 'worker-pool'),
      encodeLabel('cluster-autoscaler/node', 'static'),
      encodeLabel('cluster', 'demo-cluster'),
      encodeLabel('managed-by', 'vibecarbon'),
      encodeLabel('role', 'worker'),
      encodeLabel('role', 'supabase'),
      encodeLabel('node-pool', 'worker-pool'),
      encodeLabel('node-pool', 'supabase-pool'),
      encodeLabel('os-flavor', 'k3s'),
    ]);
    expect(encoded.size).toBe(9);
  });
});

describe('decodeLabels (Task 7 — inverse of encodeLabels for the known key set)', () => {
  it('round-trips every k8s-critical label through encodeLabels then decodeLabels', () => {
    const original = {
      'cluster-autoscaler/node': 'worker-pool',
      'managed-by': 'vibecarbon',
      cluster: 'demo-prod',
      role: 'worker',
      'node-pool': 'worker-pool',
      environment: 'prod',
      project: 'demo',
    };
    expect(decodeLabels(encodeLabels(original))).toEqual(original);
  });

  it('un-mangles cluster-autoscaler-node back to cluster-autoscaler/node (the one known slash/dash collision)', () => {
    expect(decodeLabels(['cluster-autoscaler-node:worker-pool'])).toEqual({
      'cluster-autoscaler/node': 'worker-pool',
    });
    expect(decodeLabels(['cluster-autoscaler-node:static'])).toEqual({
      'cluster-autoscaler/node': 'static',
    });
  });

  it('skips tags with no colon and defaults to {} for undefined/null/empty input', () => {
    expect(decodeLabels(['not-a-kv-tag'])).toEqual({});
    expect(decodeLabels()).toEqual({});
    expect(decodeLabels([])).toEqual({});
    // godo's Tags field is `omitempty` — an untagged droplet/volume from a
    // real API response omits the key (undefined), but callers may also
    // pass an explicit null (e.g. serverLabels/volumeLabels on a fixture
    // object shaped `{ tags: null }`); both must resolve to {}, not throw.
    expect(decodeLabels(null)).toEqual({});
  });
});

describe('DigitalOceanProvider instance methods — exact wire shapes (B3)', () => {
  let provider: DigitalOceanProvider;

  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    provider = new DigitalOceanProvider(TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('createServer', () => {
    it('checks findServersByName FIRST and reuses an existing same-named droplet without POSTing', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(
        resp({ droplets: [{ id: 5, name: 'proj-e2' }], links: {} }),
      );

      const out = await provider.createServer({
        name: 'proj-e2',
        region: 'nyc3',
        serverType: 's-2vcpu-4gb',
        image: 'ubuntu-24-04-x64',
        sshKeys: [111],
        labels: {},
      });

      expect(calls()).toEqual([['GET', `${BASE}/droplets?per_page=50&page=1`]]);
      expect(out).toEqual({ id: 5, server: { id: 5, name: 'proj-e2' }, reused: true });
    });

    it('POSTs the exact DO body shape when no existing droplet is found', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(resp({ droplets: [], links: {} }))
        .mockResolvedValueOnce(resp({ droplet: { id: 99, name: 'proj-e2' } }, 202));

      const cloudInit = '#cloud-config\nruncmd:\n  - [touch, /var/lib/vibecarbon/ready]\n';
      const result = await provider.createServer({
        name: 'proj-e2',
        region: 'nyc3',
        serverType: 's-2vcpu-4gb',
        image: 'ubuntu-24-04-x64',
        sshKeys: [111],
        labels: { 'managed-by': 'vibecarbon', environment: 'e2' },
        userData: cloudInit,
      });

      expect(calls()).toEqual([
        ['GET', `${BASE}/droplets?per_page=50&page=1`],
        ['POST', `${BASE}/droplets`],
      ]);
      const body = JSON.parse((fetchWithRetryMock.mock.calls[1][1] as RequestInit).body as string);
      expect(body).toEqual({
        name: 'proj-e2',
        region: 'nyc3',
        size: 's-2vcpu-4gb',
        image: 'ubuntu-24-04-x64',
        ssh_keys: [111],
        tags: ['managed-by:vibecarbon', 'environment:e2'],
        user_data: cloudInit,
      });
      expect(result).toEqual({ id: 99, server: { id: 99, name: 'proj-e2' } });
    });

    it('omits user_data when userData is not provided', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(resp({ droplets: [], links: {} }))
        .mockResolvedValueOnce(resp({ droplet: { id: 1, name: 'x' } }, 202));

      await provider.createServer({
        name: 'x',
        region: 'nyc3',
        serverType: 's-2vcpu-4gb',
        image: 'ubuntu-24-04-x64',
        sshKeys: [1],
        labels: {},
      });

      const body = JSON.parse((fetchWithRetryMock.mock.calls[1][1] as RequestInit).body as string);
      expect(body).not.toHaveProperty('user_data');
    });

    // M3 Task 1 — CA-spawned k8s workers must join the cluster VPC.
    // groups.js passes `networks:[networkId]`; the compose path never sets
    // `networks` at all, so the two request bodies must stay byte-identical
    // except for this one field.
    it('includes vpc_uuid = String(networks[0]) when config.networks is a non-empty array', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(resp({ droplets: [], links: {} }))
        .mockResolvedValueOnce(resp({ droplet: { id: 1, name: 'x' } }, 202));

      await provider.createServer({
        name: 'x',
        region: 'nyc3',
        serverType: 's-2vcpu-4gb',
        image: 'ubuntu-24-04-x64',
        sshKeys: [1],
        labels: {},
        networks: ['vpc-abc-123'],
      });

      const body = JSON.parse((fetchWithRetryMock.mock.calls[1][1] as RequestInit).body as string);
      expect(body.vpc_uuid).toBe('vpc-abc-123');
    });

    it('coerces a numeric networks[0] to a string vpc_uuid', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(resp({ droplets: [], links: {} }))
        .mockResolvedValueOnce(resp({ droplet: { id: 1, name: 'x' } }, 202));

      await provider.createServer({
        name: 'x',
        region: 'nyc3',
        serverType: 's-2vcpu-4gb',
        image: 'ubuntu-24-04-x64',
        sshKeys: [1],
        labels: {},
        networks: [12345],
      });

      const body = JSON.parse((fetchWithRetryMock.mock.calls[1][1] as RequestInit).body as string);
      expect(body.vpc_uuid).toBe('12345');
    });

    it('omits vpc_uuid entirely when config.networks is absent (compose paths byte-identical)', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(resp({ droplets: [], links: {} }))
        .mockResolvedValueOnce(resp({ droplet: { id: 1, name: 'x' } }, 202));

      await provider.createServer({
        name: 'x',
        region: 'nyc3',
        serverType: 's-2vcpu-4gb',
        image: 'ubuntu-24-04-x64',
        sshKeys: [1],
        labels: {},
      });

      const body = JSON.parse((fetchWithRetryMock.mock.calls[1][1] as RequestInit).body as string);
      expect(body).not.toHaveProperty('vpc_uuid');
      expect(body).toEqual({
        name: 'x',
        region: 'nyc3',
        size: 's-2vcpu-4gb',
        image: 'ubuntu-24-04-x64',
        ssh_keys: [1],
        tags: [],
      });
    });

    it('omits vpc_uuid entirely when config.networks is an empty array', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(resp({ droplets: [], links: {} }))
        .mockResolvedValueOnce(resp({ droplet: { id: 1, name: 'x' } }, 202));

      await provider.createServer({
        name: 'x',
        region: 'nyc3',
        serverType: 's-2vcpu-4gb',
        image: 'ubuntu-24-04-x64',
        sshKeys: [1],
        labels: {},
        networks: [],
      });

      const body = JSON.parse((fetchWithRetryMock.mock.calls[1][1] as RequestInit).body as string);
      expect(body).not.toHaveProperty('vpc_uuid');
    });

    it('throws the DO {message} error shape on a non-ok POST', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(resp({ droplets: [], links: {} }))
        .mockResolvedValueOnce(
          resp({ id: 'unprocessable_entity', message: 'size not available in region' }, 422),
        );

      await expect(
        provider.createServer({
          name: 'x',
          region: 'nyc3',
          serverType: 's-2vcpu-4gb',
          image: 'ubuntu-24-04-x64',
          sshKeys: [1],
          labels: {},
        }),
      ).rejects.toThrow('DigitalOcean API error: size not available in region');
    });

    // M3 Task 5b Critical — DO's droplet-create `ssh_keys` field accepts
    // only numeric IDs/fingerprints, never names (unlike Hetzner's, which
    // accepts either). groups.js passes `sshKeys: [this.config.sshKeyName]`
    // (a NAME) to every provider generically — createServer must resolve
    // any non-numeric entry to an ID via the account-keys API before it
    // ever reaches the POST body, or DO 422s on every CA-initiated create.
    describe('ssh key name -> ID resolution (M3 Task 5b Critical)', () => {
      it('resolves a NAME entry to its numeric ID via /account/keys before POSTing', async () => {
        fetchWithRetryMock
          .mockResolvedValueOnce(resp({ droplets: [], links: {} })) // findServersByName
          .mockResolvedValueOnce(
            resp({ ssh_keys: [{ id: 555, name: 'acme-prod-nbg1-key' }], links: {} }),
          ) // /account/keys page 1
          .mockResolvedValueOnce(resp({ droplet: { id: 1, name: 'x' } }, 202)); // POST

        await provider.createServer({
          name: 'x',
          region: 'nyc3',
          serverType: 's-2vcpu-4gb',
          image: 'ubuntu-24-04-x64',
          sshKeys: ['acme-prod-nbg1-key'],
          labels: {},
        });

        expect(calls()).toEqual([
          ['GET', `${BASE}/droplets?per_page=50&page=1`],
          ['GET', `${BASE}/account/keys?per_page=50&page=1`],
          ['POST', `${BASE}/droplets`],
        ]);
        const body = JSON.parse(
          (fetchWithRetryMock.mock.calls[2][1] as RequestInit).body as string,
        );
        expect(body.ssh_keys).toEqual([555]);
      });

      it('passes a numeric ID through unchanged with zero extra API calls (existing compose-path behavior byte-identical)', async () => {
        fetchWithRetryMock
          .mockResolvedValueOnce(resp({ droplets: [], links: {} }))
          .mockResolvedValueOnce(resp({ droplet: { id: 1, name: 'x' } }, 202));

        await provider.createServer({
          name: 'x',
          region: 'nyc3',
          serverType: 's-2vcpu-4gb',
          image: 'ubuntu-24-04-x64',
          sshKeys: [111],
          labels: {},
        });

        expect(calls()).toEqual([
          ['GET', `${BASE}/droplets?per_page=50&page=1`],
          ['POST', `${BASE}/droplets`],
        ]);
        const body = JSON.parse(
          (fetchWithRetryMock.mock.calls[1][1] as RequestInit).body as string,
        );
        expect(body.ssh_keys).toEqual([111]);
      });

      it('passes a numeric-STRING ID through unchanged (still a string, not coerced to number)', async () => {
        fetchWithRetryMock
          .mockResolvedValueOnce(resp({ droplets: [], links: {} }))
          .mockResolvedValueOnce(resp({ droplet: { id: 1, name: 'x' } }, 202));

        await provider.createServer({
          name: 'x',
          region: 'nyc3',
          serverType: 's-2vcpu-4gb',
          image: 'ubuntu-24-04-x64',
          sshKeys: ['222'],
          labels: {},
        });

        expect(calls()).toEqual([
          ['GET', `${BASE}/droplets?per_page=50&page=1`],
          ['POST', `${BASE}/droplets`],
        ]);
        const body = JSON.parse(
          (fetchWithRetryMock.mock.calls[1][1] as RequestInit).body as string,
        );
        expect(body.ssh_keys).toEqual(['222']);
      });

      it('throws a loud, specific error when the name is not found after walking every page (fail fast, no silent skip)', async () => {
        fetchWithRetryMock
          .mockResolvedValueOnce(resp({ droplets: [], links: {} }))
          .mockResolvedValueOnce(
            resp({ ssh_keys: [{ id: 1, name: 'someone-else-key' }], links: {} }),
          );

        await expect(
          provider.createServer({
            name: 'x',
            region: 'nyc3',
            serverType: 's-2vcpu-4gb',
            image: 'ubuntu-24-04-x64',
            sshKeys: ['missing-key'],
            labels: {},
          }),
        ).rejects.toThrow(/"missing-key"/);

        // Never POSTs a droplet when a key can't be resolved.
        expect(calls().some(([method]) => method === 'POST')).toBe(false);
      });

      it('paginates the account-keys walk (per_page=50, links.pages.next) — a match on page 2 is found', async () => {
        fetchWithRetryMock
          .mockResolvedValueOnce(resp({ droplets: [], links: {} })) // findServersByName
          .mockResolvedValueOnce(
            resp({ ssh_keys: [{ id: 1, name: 'other-key' }], links: { pages: { next: 'x' } } }),
          ) // account/keys page 1
          .mockResolvedValueOnce(
            resp({ ssh_keys: [{ id: 777, name: 'acme-prod-nbg1-key' }], links: {} }),
          ) // account/keys page 2
          .mockResolvedValueOnce(resp({ droplet: { id: 1, name: 'x' } }, 202)); // POST

        await provider.createServer({
          name: 'x',
          region: 'nyc3',
          serverType: 's-2vcpu-4gb',
          image: 'ubuntu-24-04-x64',
          sshKeys: ['acme-prod-nbg1-key'],
          labels: {},
        });

        expect(calls()).toEqual([
          ['GET', `${BASE}/droplets?per_page=50&page=1`],
          ['GET', `${BASE}/account/keys?per_page=50&page=1`],
          ['GET', `${BASE}/account/keys?per_page=50&page=2`],
          ['POST', `${BASE}/droplets`],
        ]);
        const body = JSON.parse(
          (fetchWithRetryMock.mock.calls[3][1] as RequestInit).body as string,
        );
        expect(body.ssh_keys).toEqual([777]);
      });
    });
  });

  describe('deleteServer(id) — scale semantics (default): no poll', () => {
    it('DELETEs via apiRequest and never touches the global fetch', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({}, 204));
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await provider.deleteServer(400);

      expect(calls()).toEqual([['DELETE', `${BASE}/droplets/400`]]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws "Failed to delete server: <message>" on a non-2xx, non-404 DELETE', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(
        resp({ id: 'locked', message: 'droplet is locked' }, 423),
      );
      await expect(provider.deleteServer(401)).rejects.toThrow(
        'Failed to delete server: droplet is locked',
      );
    });

    it('does not throw on a 404 DELETE (already gone)', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({}, 404));
      await expect(provider.deleteServer(402)).resolves.toBeUndefined();
    });
  });

  describe('deleteServer(id, {waitUntilGone:true}) — destroy semantics: DELETE then 404-poll', () => {
    it('DELETEs via fetchWithRetry then polls the global fetch for 404', async () => {
      fetchWithRetryMock.mockResolvedValue(resp({}, 204));
      const fetchSpy = vi.fn(async () => resp({}, 404) as unknown as Response);
      vi.stubGlobal('fetch', fetchSpy);

      const out = await provider.deleteServer(321, { waitUntilGone: true });

      expect(calls()).toEqual([['DELETE', `${BASE}/droplets/321`]]);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE}/droplets/321`,
        expect.objectContaining({ headers: { Authorization: `Bearer ${TOKEN}` } }),
      );
      expect(out).toBe(true);
    });

    it('skips the poll and returns false when the server was already gone (404 DELETE)', async () => {
      fetchWithRetryMock.mockResolvedValue(resp({}, 404));
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const out = await provider.deleteServer(322, { waitUntilGone: true });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(out).toBe(false);
    });

    it('throws "Failed to delete server: boom" on a non-2xx, non-404 DELETE (B0-5 shape)', async () => {
      fetchWithRetryMock.mockResolvedValue(resp({ id: 'server_error', message: 'boom' }, 500));
      await expect(provider.deleteServer(323, { waitUntilGone: true })).rejects.toThrow(
        'Failed to delete server: boom',
      );
    });
  });

  describe('getServer', () => {
    it('GETs /droplets/{id} and returns data.droplet', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ droplet: { id: 5, name: 'x' } }));
      const out = await provider.getServer(5);
      expect(calls()).toEqual([['GET', `${BASE}/droplets/5`]]);
      expect(out).toEqual({ id: 5, name: 'x' });
    });

    it('throws the DO {message} shape on a non-ok response', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(
        resp({ id: 'not_found', message: 'droplet not found' }, 404),
      );
      await expect(provider.getServer(999)).rejects.toThrow(
        'Failed to get server: droplet not found',
      );
    });
  });

  describe('renameServer', () => {
    it('POSTs /droplets/{id}/actions with {type:"rename", name}', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ action: { id: 1, status: 'in-progress' } }));

      await provider.renameServer(500, 'proj-prod-master');

      expect(calls()).toEqual([['POST', `${BASE}/droplets/500/actions`]]);
      const body = JSON.parse((fetchWithRetryMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body).toEqual({ type: 'rename', name: 'proj-prod-master' });
    });

    it('throws the DO {message} shape on a non-ok response', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(
        resp({ id: 'unprocessable_entity', message: 'name already in use' }, 422),
      );
      await expect(provider.renameServer(500, 'proj-prod-master')).rejects.toThrow(
        'Failed to rename server: name already in use',
      );
    });
  });

  describe('waitForServer', () => {
    it('resolves once status is active AND a public v4 IP is present', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(
        resp({
          droplet: {
            id: 5,
            status: 'active',
            networks: { v4: [{ type: 'public', ip_address: '1.2.3.4' }] },
          },
        }),
      );
      const out = await provider.waitForServer(5, 60_000);
      expect(out.status).toBe('active');
    });

    it('does not resolve on active status alone without a public v4 IP', async () => {
      // Budget expires (0ms) before the poll interval elapses, so this
      // exercises the "not ready yet" branch without a real 5s sleep.
      fetchWithRetryMock.mockResolvedValue(
        resp({ droplet: { id: 5, status: 'active', networks: { v4: [] } } }),
      );
      await expect(provider.waitForServer(5, 0)).rejects.toThrow('Server creation timed out');
    });

    it('throws "Server creation timed out" immediately when the budget is already exhausted', async () => {
      await expect(provider.waitForServer(5, 0)).rejects.toThrow('Server creation timed out');
      expect(fetchWithRetryMock).not.toHaveBeenCalled();
    });
  });

  describe('getServerSummary', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(global, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('makes exactly one raw fetch with a 5000ms AbortSignal, never touching fetchWithRetry', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ droplet: { status: 'active', size_slug: 's-2vcpu-4gb' } }),
      } as Response);

      const result = await provider.getServerSummary(5);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE}/droplets/5`,
        expect.objectContaining({ headers: { Authorization: `Bearer ${TOKEN}` } }),
      );
      expect(fetchWithRetryMock).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'active', serverType: 's-2vcpu-4gb' });
    });

    it('returns null on a non-ok response', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 } as Response);
      expect(await provider.getServerSummary(999)).toBeNull();
    });

    it('returns null when fetch throws (network error)', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('fetch failed'));
      expect(await provider.getServerSummary(999)).toBeNull();
    });

    it('resolves serverType to null when size_slug is absent', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ droplet: { status: 'off' } }),
      } as Response);
      expect(await provider.getServerSummary(1)).toEqual({ status: 'off', serverType: null });
    });
  });

  describe('createSSHKey', () => {
    it('POSTs {name, public_key} and returns the new key id', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ ssh_key: { id: 456 } }, 201));

      const out = await provider.createSSHKey('proj-key', 'ssh-ed25519 AAAA test');

      expect(calls()).toEqual([['POST', `${BASE}/account/keys`]]);
      const body = JSON.parse((fetchWithRetryMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body).toEqual({ name: 'proj-key', public_key: 'ssh-ed25519 AAAA test' });
      expect(out).toBe(456);
    });

    // d1 regression pin: DigitalOcean dedupes SSH keys by FINGERPRINT
    // account-wide, not by name — `deploy` registered these exact key bytes
    // under "deploy-key", and `scale` re-registers the SAME bytes under a
    // DIFFERENT name ("scale-key"). Recovery must match by key MATERIAL, not
    // by the name the caller happened to pass this time. Pre-fix, the
    // name-only match missed this and threw "no key named ... was found".
    it('on 422 "already in use", matches the paginated list by key MATERIAL under a DIFFERENT name and returns its id', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp(
            { id: 'unprocessable_entity', message: 'SSH Key is already in use on your account' },
            422,
          ),
        )
        .mockResolvedValueOnce(
          resp({
            ssh_keys: [{ id: 77, name: 'deploy-key', public_key: 'ssh-ed25519 AAAA test' }],
            links: {},
          }),
        );

      const out = await provider.createSSHKey('scale-key', 'ssh-ed25519 AAAA test');

      expect(calls()).toEqual([
        ['POST', `${BASE}/account/keys`],
        ['GET', `${BASE}/account/keys?per_page=100&page=1`],
      ]);
      expect(out).toBe(77);
    });

    it('on 422, same name AND same material still resolves to that key (pre-existing behavior unchanged)', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp(
            { id: 'unprocessable_entity', message: 'SSH Key is already in use on your account' },
            422,
          ),
        )
        .mockResolvedValueOnce(
          resp({
            ssh_keys: [{ id: 77, name: 'proj-key', public_key: 'ssh-ed25519 AAAA test' }],
            links: {},
          }),
        );

      const out = await provider.createSSHKey('proj-key', 'ssh-ed25519 AAAA test');

      expect(out).toBe(77);
    });

    it('on 422, a same-NAME hit with DIFFERENT material is a genuine conflict — throws loudly instead of reusing the wrong key', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp(
            { id: 'unprocessable_entity', message: 'SSH Key is already in use on your account' },
            422,
          ),
        )
        .mockResolvedValueOnce(
          resp({
            ssh_keys: [{ id: 99, name: 'proj-key', public_key: 'ssh-ed25519 BBBB other' }],
            links: {},
          }),
        );

      await expect(provider.createSSHKey('proj-key', 'ssh-ed25519 AAAA test')).rejects.toThrow(
        'a key named "proj-key" already exists on this account with different key material',
      );
    });

    it('throws when the 422 recovery walk finds neither a material nor a name match', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp(
            { id: 'unprocessable_entity', message: 'SSH Key is already in use on your account' },
            422,
          ),
        )
        .mockResolvedValueOnce(resp({ ssh_keys: [], links: {} }));

      await expect(provider.createSSHKey('proj-key', 'k')).rejects.toThrow(
        'key already in use, but no matching key (by material or name "proj-key") was found',
      );
    });

    it('throws the generic message shape on a non-422 failure', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ id: 'server_error', message: 'boom' }, 500));
      await expect(provider.createSSHKey('proj-key', 'k')).rejects.toThrow(
        'Failed to create SSH key: boom',
      );
    });
  });

  describe('normalizePublicKey', () => {
    it('tolerates a different/missing trailing comment', () => {
      expect(normalizePublicKey('ssh-ed25519 AAAA test@host-a')).toBe(
        normalizePublicKey('ssh-ed25519 AAAA test@host-b'),
      );
      expect(normalizePublicKey('ssh-ed25519 AAAA')).toBe(
        normalizePublicKey('ssh-ed25519 AAAA some comment here'),
      );
    });

    it('tolerates whitespace variance (extra spaces, tabs)', () => {
      expect(normalizePublicKey('ssh-ed25519   AAAA')).toBe(normalizePublicKey('ssh-ed25519 AAAA'));
      expect(normalizePublicKey('ssh-ed25519\tAAAA\tcomment')).toBe(
        normalizePublicKey('ssh-ed25519 AAAA'),
      );
    });

    it('treats a different type or body as different material', () => {
      expect(normalizePublicKey('ssh-ed25519 AAAA')).not.toBe(normalizePublicKey('ssh-rsa AAAA'));
      expect(normalizePublicKey('ssh-ed25519 AAAA')).not.toBe(
        normalizePublicKey('ssh-ed25519 BBBB'),
      );
    });

    it('handles undefined/empty input without throwing', () => {
      expect(normalizePublicKey(undefined)).toBe('');
      expect(normalizePublicKey('')).toBe('');
    });
  });

  describe('listServers', () => {
    it('→ GET /droplets?per_page=50&page=1 (no label filter)', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ droplets: [{ id: 1 }], links: {} }));
      const out = await provider.listServers();
      expect(calls()).toEqual([['GET', `${BASE}/droplets?per_page=50&page=1`]]);
      expect(out).toEqual([{ id: 1 }]);
    });

    it('single label → appends &tag_name=<encoded key:value>', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ droplets: [], links: {} }));
      await provider.listServers({ 'managed-by': 'vibecarbon' });
      expect(calls()).toEqual([
        [
          'GET',
          `${BASE}/droplets?per_page=50&tag_name=${encodeURIComponent('managed-by:vibecarbon')}&page=1`,
        ],
      ]);
    });

    it('walks pagination past the first page via links.pages.next (B0-4)', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp({ droplets: [{ id: 1 }, { id: 2 }], links: { pages: { next: 'x' } } }),
        )
        .mockResolvedValueOnce(resp({ droplets: [{ id: 3 }], links: {} }));
      const out = await provider.listServers();
      expect(calls()).toEqual([
        ['GET', `${BASE}/droplets?per_page=50&page=1`],
        ['GET', `${BASE}/droplets?per_page=50&page=2`],
      ]);
      expect(out).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });

    it('returns [] on a non-ok first-page response', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({}, 500));
      expect(await provider.listServers()).toEqual([]);
    });

    it('keeps already-collected pages when a later page fails', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(resp({ droplets: [{ id: 1 }], links: { pages: { next: 'x' } } }))
        .mockResolvedValueOnce(resp({}, 500));
      expect(await provider.listServers()).toEqual([{ id: 1 }]);
    });

    // M3 Task 1 — DO's tag_name query can only AND-filter server-side on ONE
    // tag (dossier §7). 2+ labels: the FIRST entry (caller-ordered) drives
    // the single tag_name request; remaining predicates are checked
    // client-side against each returned droplet's tags[] using the same
    // encodeLabel encoding groups.js/createServer/destroy all share.
    it('2+ labels: the FIRST entry drives the single server-side tag_name query', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ droplets: [], links: {} }));

      await provider.listServers({ 'cluster-autoscaler/node': 'worker-pool', cluster: 'demo' });

      expect(calls()).toEqual([
        [
          'GET',
          `${BASE}/droplets?per_page=50&tag_name=${encodeURIComponent('cluster-autoscaler-node:worker-pool')}&page=1`,
        ],
      ]);
    });

    it('2+ labels: filters the remaining predicates client-side against tags[]', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(
        resp({
          droplets: [
            {
              id: 1,
              tags: [
                'cluster-autoscaler-node:worker-pool',
                'cluster:demo',
                'managed-by:vibecarbon',
              ],
            },
            { id: 2, tags: ['cluster-autoscaler-node:worker-pool', 'cluster:demo'] },
          ],
          links: {},
        }),
      );

      const out = await provider.listServers({
        'cluster-autoscaler/node': 'worker-pool',
        cluster: 'demo',
        'managed-by': 'vibecarbon',
      });

      expect(out.map((d: { id: number }) => d.id)).toEqual([1]);
    });

    it('2+ labels: a droplet matching the fetched tag but failing a second predicate is EXCLUDED', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(
        resp({
          droplets: [
            { id: 1, tags: ['cluster-autoscaler-node:worker-pool', 'cluster:demo'] },
            { id: 2, tags: ['cluster-autoscaler-node:worker-pool', 'cluster:other-cluster'] },
          ],
          links: {},
        }),
      );

      const out = await provider.listServers({
        'cluster-autoscaler/node': 'worker-pool',
        cluster: 'demo',
      });

      expect(out.map((d: { id: number }) => d.id)).toEqual([1]);
    });

    it('a droplet with no tags[] at all fails any remaining predicate (never throws)', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ droplets: [{ id: 1 }], links: {} }));

      const out = await provider.listServers({
        'cluster-autoscaler/node': 'worker-pool',
        cluster: 'demo',
      });

      expect(out).toEqual([]);
    });
  });

  describe('findServersByName', () => {
    it('walks all pages and filters the exact name (no name query param in DO API)', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp({
            droplets: [
              { id: 1, name: 'proj-e2' },
              { id: 2, name: 'proj-e2-standby' },
            ],
            links: { pages: { next: 'x' } },
          }),
        )
        .mockResolvedValueOnce(resp({ droplets: [{ id: 3, name: 'proj-e2' }], links: {} }));

      const out = await provider.findServersByName('proj-e2');

      expect(calls()).toEqual([
        ['GET', `${BASE}/droplets?per_page=50&page=1`],
        ['GET', `${BASE}/droplets?per_page=50&page=2`],
      ]);
      expect(out).toEqual([
        { id: 1, name: 'proj-e2' },
        { id: 3, name: 'proj-e2' },
      ]);
    });

    it('returns [] on a non-ok response at any page', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({}, 500));
      expect(await provider.findServersByName('x')).toEqual([]);
    });
  });

  describe('findFirewallByName', () => {
    it('walks /firewalls and returns the exact-name match', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(
        resp({ firewalls: [{ id: 42, name: 'proj-e2-primary-firewall' }], links: {} }),
      );
      const out = await provider.findFirewallByName('proj-e2-primary-firewall');
      expect(calls()).toEqual([['GET', `${BASE}/firewalls?per_page=50&page=1`]]);
      expect(out).toEqual({ id: 42, name: 'proj-e2-primary-firewall' });
    });

    it('returns null on a non-ok response', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({}, 500));
      expect(await provider.findFirewallByName('x')).toBeNull();
    });

    it('returns null when no firewall matches after walking to exhaustion', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ firewalls: [], links: {} }));
      expect(await provider.findFirewallByName('missing')).toBeNull();
    });
  });

  describe('setFirewallRules', () => {
    it('fetches the current firewall, then PUTs the merged full object (total-replace)', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp({
            firewall: {
              id: 7,
              name: 'proj-e2-firewall',
              inbound_rules: [
                { protocol: 'tcp', ports: '22', sources: { addresses: ['0.0.0.0/0'] } },
              ],
              outbound_rules: [
                { protocol: 'tcp', ports: 'all', destinations: { addresses: ['0.0.0.0/0'] } },
              ],
              droplet_ids: [123],
              tags: ['managed-by:vibecarbon'],
            },
          }),
        )
        .mockResolvedValueOnce(resp({}, 200));

      const newRules = [
        { protocol: 'udp', ports: '51821', sources: { addresses: ['9.9.9.9/32'] } },
      ];
      await provider.setFirewallRules(7, newRules);

      expect(calls()).toEqual([
        ['GET', `${BASE}/firewalls/7`],
        ['PUT', `${BASE}/firewalls/7`],
      ]);
      const body = JSON.parse((fetchWithRetryMock.mock.calls[1][1] as RequestInit).body as string);
      expect(body).toEqual({
        name: 'proj-e2-firewall',
        inbound_rules: newRules,
        outbound_rules: [
          { protocol: 'tcp', ports: 'all', destinations: { addresses: ['0.0.0.0/0'] } },
        ],
        droplet_ids: [123],
        tags: ['managed-by:vibecarbon'],
      });
    });

    it('throws when the initial firewall lookup fails', async () => {
      fetchWithRetryMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'not found',
      });
      await expect(provider.setFirewallRules(7, [])).rejects.toThrow(
        'DigitalOcean firewall lookup failed (404): not found',
      );
    });

    it('throws on a non-2xx PUT (500)', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp({ firewall: { id: 7, name: 'fw', outbound_rules: [], droplet_ids: [], tags: [] } }),
        )
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' });
      await expect(provider.setFirewallRules(7, [])).rejects.toThrow(
        'DigitalOcean firewall update failed (500): server error',
      );
    });
  });

  describe('buildReplicationFirewallRules (DO shape)', () => {
    // Contract fix (finding review, 2026-07-23): the method now takes the
    // FIREWALL OBJECT (as findFirewallByName returns it), not a
    // pre-extracted rules array — DO's rules live under
    // `firewall.inbound_rules`, not the flat `.rules` Hetzner uses. Before
    // this fix the openers always called `provider.buildReplicationFirewallRules(
    // firewall.rules || [], peerIp)`, which is `undefined` on a DO firewall
    // object, so the builder always saw `[]` and the caller's total-replace
    // PUT silently wiped every existing inbound rule (SSH/HTTP/HTTPS
    // lockout) — see the regression test below.
    it('appends the udp/51821 rule scoped to the peer /32 when absent', () => {
      const existing = [{ protocol: 'tcp', ports: '22', sources: { addresses: ['0.0.0.0/0'] } }];
      const updated = provider.buildReplicationFirewallRules(
        { inbound_rules: existing },
        '203.0.113.7',
      );
      expect(updated).toEqual([
        ...existing,
        { protocol: 'udp', ports: '51821', sources: { addresses: ['203.0.113.7/32'] } },
      ]);
    });

    it('returns null (idempotent) when the exact peer rule already exists', () => {
      const existing = [
        { protocol: 'udp', ports: '51821', sources: { addresses: ['203.0.113.7/32'] } },
      ];
      expect(
        provider.buildReplicationFirewallRules({ inbound_rules: existing }, '203.0.113.7'),
      ).toBeNull();
    });

    it('appends rather than replacing when a rule for a different peer is present', () => {
      const existing = [
        { protocol: 'udp', ports: '51821', sources: { addresses: ['198.51.100.9/32'] } },
      ];
      const updated = provider.buildReplicationFirewallRules(
        { inbound_rules: existing },
        '203.0.113.7',
      );
      expect(updated).toContainEqual({
        protocol: 'udp',
        ports: '51821',
        sources: { addresses: ['203.0.113.7/32'] },
      });
      expect(updated).toHaveLength(2);
    });

    // Lockout pin: given a REAL DO firewall object (findFirewallByName's
    // shape, inbound_rules keyed — not the bare array the pre-fix caller
    // extracted via the wrong field name), the result must retain every
    // pre-existing ingress rule (SSH/22, HTTP/80, HTTPS/443) alongside the
    // new WG rule. A regression here means the opener's total-replace PUT
    // (setFirewallRules) would strip SSH/HTTP/HTTPS ingress from a live DO
    // compose-ha firewall.
    it('given a real DO firewall object, retains SSH/80/443 ingress alongside the new WG rule (lockout regression pin)', () => {
      const firewall = {
        id: 7,
        name: 'proj-e2-firewall',
        inbound_rules: [
          { protocol: 'tcp', ports: '22', sources: { addresses: ['0.0.0.0/0'] } },
          { protocol: 'tcp', ports: '80', sources: { addresses: ['0.0.0.0/0'] } },
          { protocol: 'tcp', ports: '443', sources: { addresses: ['0.0.0.0/0'] } },
        ],
        outbound_rules: [],
        droplet_ids: [123],
        tags: [],
      };
      const updated = provider.buildReplicationFirewallRules(firewall, '203.0.113.7');
      expect(updated).toContainEqual({
        protocol: 'tcp',
        ports: '22',
        sources: { addresses: ['0.0.0.0/0'] },
      });
      expect(updated).toContainEqual({
        protocol: 'tcp',
        ports: '80',
        sources: { addresses: ['0.0.0.0/0'] },
      });
      expect(updated).toContainEqual({
        protocol: 'tcp',
        ports: '443',
        sources: { addresses: ['0.0.0.0/0'] },
      });
      expect(updated).toContainEqual({
        protocol: 'udp',
        ports: '51821',
        sources: { addresses: ['203.0.113.7/32'] },
      });
      expect(updated).toHaveLength(4);
    });
  });

  describe('applyOperatorCidrs', () => {
    it('rewrites the port-22 inbound rule sources.addresses and PUTs, leaving other rules untouched', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp({
            firewalls: [
              {
                id: 7,
                name: 'proj-e2-firewall',
                inbound_rules: [
                  { protocol: 'tcp', ports: '22', sources: { addresses: ['9.9.9.9/32'] } },
                  { protocol: 'tcp', ports: '443', sources: { addresses: ['0.0.0.0/0'] } },
                ],
              },
            ],
            links: {},
          }),
        )
        .mockResolvedValueOnce(
          resp({
            firewall: {
              id: 7,
              name: 'proj-e2-firewall',
              outbound_rules: [],
              droplet_ids: [],
              tags: [],
            },
          }),
        )
        .mockResolvedValueOnce(resp({}, 200));

      const result = await provider.applyOperatorCidrs({
        firewallName: 'proj-e2-firewall',
        cidrs: ['1.2.3.4/32'],
      });

      expect(result).toBe(true);
      const putBody = JSON.parse(
        (fetchWithRetryMock.mock.calls[2][1] as RequestInit).body as string,
      );
      expect(putBody.inbound_rules).toEqual([
        { protocol: 'tcp', ports: '22', sources: { addresses: ['1.2.3.4/32'] } },
        { protocol: 'tcp', ports: '443', sources: { addresses: ['0.0.0.0/0'] } },
      ]);
    });

    it('returns false and never calls setFirewallRules when the firewall does not exist', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ firewalls: [], links: {} }));
      const result = await provider.applyOperatorCidrs({
        firewallName: 'not-deployed-firewall',
        cidrs: ['1.2.3.4/32'],
      });
      expect(result).toBe(false);
      expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    });

    // Task 7 controller-added requirement: DO's rewrite used to touch ONLY
    // port 22, unlike Hetzner's SSH_PORT/K8S_API_PORT pair — a stale 6443
    // source after an operator-IP change locked kubectl out of DO k8s
    // clusters. Mirrors the Hetzner fixture in
    // hetzner-operator-firewall.test.ts: SSH + k8s-API rules alongside an
    // unrelated HTTP rule and an internal (VPC-CIDR, all-protocols) rule that
    // must be left untouched.
    it('rewrites BOTH the port-22 and port-6443 inbound rules, leaving HTTP/HTTPS/internal rules untouched', async () => {
      const existingRules = [
        { protocol: 'tcp', ports: '22', sources: { addresses: ['9.9.9.9/32'] } },
        { protocol: 'tcp', ports: '6443', sources: { addresses: ['9.9.9.9/32'] } },
        { protocol: 'tcp', ports: '80', sources: { addresses: ['0.0.0.0/0', '::/0'] } },
        { protocol: 'tcp', ports: '443', sources: { addresses: ['0.0.0.0/0', '::/0'] } },
        { protocol: 'tcp', ports: '1-65535', sources: { addresses: ['10.10.0.0/20'] } },
        { protocol: 'udp', ports: '1-65535', sources: { addresses: ['10.10.0.0/20'] } },
      ];
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp({
            firewalls: [{ id: 7, name: 'proj-prod-firewall', inbound_rules: existingRules }],
            links: {},
          }),
        )
        .mockResolvedValueOnce(
          resp({
            firewall: {
              id: 7,
              name: 'proj-prod-firewall',
              outbound_rules: [],
              droplet_ids: [],
              tags: ['cluster:proj-prod'],
            },
          }),
        )
        .mockResolvedValueOnce(resp({}, 200));

      const cidrs = ['1.2.3.4/32', '5.6.7.8/32'];
      const result = await provider.applyOperatorCidrs({
        firewallName: 'proj-prod-firewall',
        cidrs,
      });

      expect(result).toBe(true);
      const putBody = JSON.parse(
        (fetchWithRetryMock.mock.calls[2][1] as RequestInit).body as string,
      );
      expect(putBody.inbound_rules).toEqual([
        { protocol: 'tcp', ports: '22', sources: { addresses: cidrs } },
        { protocol: 'tcp', ports: '6443', sources: { addresses: cidrs } },
        { protocol: 'tcp', ports: '80', sources: { addresses: ['0.0.0.0/0', '::/0'] } },
        { protocol: 'tcp', ports: '443', sources: { addresses: ['0.0.0.0/0', '::/0'] } },
        { protocol: 'tcp', ports: '1-65535', sources: { addresses: ['10.10.0.0/20'] } },
        { protocol: 'udp', ports: '1-65535', sources: { addresses: ['10.10.0.0/20'] } },
      ]);
      // The PUT is a total replace on DO — name/outbound_rules/droplet_ids/tags
      // must survive untouched alongside the rewritten inbound rules.
      expect(putBody.tags).toEqual(['cluster:proj-prod']);
    });

    it('also rewrites the operator-scoped Supavisor pooler rules (5432/6543)', async () => {
      // Compose deploys firewall the pooler ports to operator CIDRs, same
      // as SSH — access add/remove/prune must keep them in lockstep.
      const existingRules = [
        { protocol: 'tcp', ports: '22', sources: { addresses: ['9.9.9.9/32'] } },
        { protocol: 'tcp', ports: '5432', sources: { addresses: ['9.9.9.9/32'] } },
        { protocol: 'tcp', ports: '6543', sources: { addresses: ['9.9.9.9/32'] } },
        { protocol: 'tcp', ports: '443', sources: { addresses: ['0.0.0.0/0', '::/0'] } },
      ];
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp({
            firewalls: [{ id: 7, name: 'proj-prod-firewall', inbound_rules: existingRules }],
            links: {},
          }),
        )
        .mockResolvedValueOnce(
          resp({
            firewall: {
              id: 7,
              name: 'proj-prod-firewall',
              outbound_rules: [],
              droplet_ids: [],
              tags: [],
            },
          }),
        )
        .mockResolvedValueOnce(resp({}, 200));

      const cidrs = ['1.2.3.4/32'];
      await provider.applyOperatorCidrs({ firewallName: 'proj-prod-firewall', cidrs });

      const putBody = JSON.parse(
        (fetchWithRetryMock.mock.calls[2][1] as RequestInit).body as string,
      );
      expect(putBody.inbound_rules).toEqual([
        { protocol: 'tcp', ports: '22', sources: { addresses: cidrs } },
        { protocol: 'tcp', ports: '5432', sources: { addresses: cidrs } },
        { protocol: 'tcp', ports: '6543', sources: { addresses: cidrs } },
        { protocol: 'tcp', ports: '443', sources: { addresses: ['0.0.0.0/0', '::/0'] } },
      ]);
    });
  });

  describe('deleteFirewallByName', () => {
    it('finds then DELETEs, returning {deleted:true, everExisted:true, apiError:null}', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp({ firewalls: [{ id: 12, name: 'proj-prod-firewall' }], links: {} }),
        )
        .mockResolvedValueOnce(resp({}, 204));

      const out = await provider.deleteFirewallByName('proj-prod-firewall');

      expect(calls()).toEqual([
        ['GET', `${BASE}/firewalls?per_page=50&page=1`],
        ['DELETE', `${BASE}/firewalls/12`],
      ]);
      expect(out).toEqual({ deleted: true, everExisted: true, apiError: null });
    });

    it('returns {deleted:false, everExisted:false, apiError:null} when the firewall is absent', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ firewalls: [], links: {} }));
      const out = await provider.deleteFirewallByName('gone');
      expect(out).toEqual({ deleted: false, everExisted: false, apiError: null });
    });
  });

  describe('deleteSSHKeyByName', () => {
    it('walks /account/keys then DELETEs the exact-name match', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(resp({ ssh_keys: [{ id: 88, name: 'proj env key' }], links: {} }))
        .mockResolvedValueOnce(resp({}, 204));

      const out = await provider.deleteSSHKeyByName('proj env key');

      expect(calls()).toEqual([
        ['GET', `${BASE}/account/keys?per_page=100&page=1`],
        ['DELETE', `${BASE}/account/keys/88`],
      ]);
      expect(out).toBe(true);
    });

    it('returns false (never deletes) when no key matches after walking to exhaustion', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ ssh_keys: [], links: {} }));
      const out = await provider.deleteSSHKeyByName('missing');
      expect(calls()).toEqual([['GET', `${BASE}/account/keys?per_page=100&page=1`]]);
      expect(out).toBe(false);
    });
  });

  // M3 Task 9f — the k8s destroy sweep's DO-only backstop for
  // digitalocean-k8s.js's `network` (Vpc) resource. Mirrors
  // deleteFirewallByName's {deleted, everExisted, apiError} shape exactly.
  describe('deleteNetworkByName', () => {
    it('finds then DELETEs, returning {deleted:true, everExisted:true, apiError:null}', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp({ vpcs: [{ id: 'vpc-7', name: 'proj-prod-network' }], links: {} }),
        )
        .mockResolvedValueOnce(resp({}, 204));

      const out = await provider.deleteNetworkByName('proj-prod-network');

      expect(calls()).toEqual([
        ['GET', `${BASE}/vpcs?per_page=50&page=1`],
        ['DELETE', `${BASE}/vpcs/vpc-7`],
      ]);
      expect(out).toEqual({ deleted: true, everExisted: true, apiError: null });
    });

    it('returns {deleted:false, everExisted:false, apiError:null} when the VPC is absent (not-found = success)', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ vpcs: [], links: {} }));
      const out = await provider.deleteNetworkByName('gone');
      expect(out).toEqual({ deleted: false, everExisted: false, apiError: null });
    });

    it('treats a 404 DELETE as deleted (already gone)', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp({ vpcs: [{ id: 'vpc-7', name: 'proj-prod-network' }], links: {} }),
        )
        .mockResolvedValueOnce(resp({}, 404));

      const out = await provider.deleteNetworkByName('proj-prod-network');
      expect(out).toEqual({ deleted: true, everExisted: true, apiError: null });
    });

    // Brief requirement: a non-empty VPC delete refusal (403/409 depending
    // on account/API version — DO's docs disagree) must surface as a loud
    // apiError, never a silent "not found"/swallowed no-op.
    it('surfaces a 409 "still has members" refusal as apiError, not a swallowed no-op', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp({ vpcs: [{ id: 'vpc-7', name: 'proj-prod-network' }], links: {} }),
        )
        .mockResolvedValueOnce({
          ok: false,
          status: 409,
          text: async () => 'vpc has member resources',
        });

      const out = await provider.deleteNetworkByName('proj-prod-network');
      expect(out.deleted).toBe(false);
      expect(out.everExisted).toBe(true);
      expect(out.apiError).toBeInstanceOf(Error);
      expect(out.apiError?.message).toContain('409');
    });

    it('surfaces a 403 "default VPC" refusal as apiError too', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp({ vpcs: [{ id: 'vpc-7', name: 'proj-prod-network' }], links: {} }),
        )
        .mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'forbidden' });

      const out = await provider.deleteNetworkByName('proj-prod-network');
      expect(out.deleted).toBe(false);
      expect(out.apiError).toBeInstanceOf(Error);
    });
  });

  // M3 Task 9f — the k8s destroy sweep's DO-only backstop for
  // digitalocean-k8s.js's `reservedIp` resource. Unlike every other DO
  // resource here, ReservedIp has no `name` — the wire path param IS the
  // address, so this is deliberately a simple boolean idempotent delete
  // (deleteVolume's shape), not deleteFirewallByName's richer shape.
  describe('deleteReservedIpByAddress', () => {
    it('DELETEs /reserved_ips/{address} (true on ok)', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({}, 204));
      const out = await provider.deleteReservedIpByAddress('203.0.113.9');
      expect(calls()).toEqual([['DELETE', `${BASE}/reserved_ips/203.0.113.9`]]);
      expect(out).toBe(true);
    });

    it('returns true on 404 (already gone — idempotent)', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({}, 404));
      expect(await provider.deleteReservedIpByAddress('203.0.113.9')).toBe(true);
    });

    it('returns false on a genuine failure (e.g. 500)', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({}, 500));
      expect(await provider.deleteReservedIpByAddress('203.0.113.9')).toBe(false);
    });
  });

  // M3 Task 5b (Important) — a DO account starts with ~10 default VPCs;
  // >20 is plausible, and DO's single-page fetch was silently truncating at
  // whatever the API's own default page size is. Page-walk exactly like
  // listServers (per_page=50, guard loop, links.pages.next) so
  // carbon-autoscaler's `_lookupNetworkId` (groups.js) can't miss the
  // cluster VPC, and the destroy sweep can't miss a volume/LB, just because
  // the account has more than one page of them.
  describe('listNetworks', () => {
    it('→ GET /vpcs?per_page=50&page=1 → data.vpcs', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ vpcs: [{ id: 'vpc-1' }], links: {} }));
      const out = await provider.listNetworks();
      expect(calls()).toEqual([['GET', `${BASE}/vpcs?per_page=50&page=1`]]);
      expect(out).toEqual([{ id: 'vpc-1' }]);
    });

    it('returns [] on a non-ok first-page response', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({}, 503));
      expect(await provider.listNetworks()).toEqual([]);
    });

    it('walks pagination past the first page via links.pages.next — a VPC on page 2 is returned', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(resp({ vpcs: [{ id: 'vpc-1' }], links: { pages: { next: 'x' } } }))
        .mockResolvedValueOnce(resp({ vpcs: [{ id: 'vpc-2' }], links: {} }));
      const out = await provider.listNetworks();
      expect(calls()).toEqual([
        ['GET', `${BASE}/vpcs?per_page=50&page=1`],
        ['GET', `${BASE}/vpcs?per_page=50&page=2`],
      ]);
      expect(out).toEqual([{ id: 'vpc-1' }, { id: 'vpc-2' }]);
    });
  });

  describe('listVolumes / deleteVolume', () => {
    it('listVolumes() → GET /volumes?per_page=50&page=1 → data.volumes', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({ volumes: [{ id: 'v1' }], links: {} }));
      const out = await provider.listVolumes();
      expect(calls()).toEqual([['GET', `${BASE}/volumes?per_page=50&page=1`]]);
      expect(out).toEqual([{ id: 'v1' }]);
    });

    it('returns [] on a non-ok first-page response', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({}, 503));
      expect(await provider.listVolumes()).toEqual([]);
    });

    it('walks pagination past the first page via links.pages.next — a volume on page 2 is returned', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(resp({ volumes: [{ id: 'v1' }], links: { pages: { next: 'x' } } }))
        .mockResolvedValueOnce(resp({ volumes: [{ id: 'v2' }], links: {} }));
      const out = await provider.listVolumes();
      expect(calls()).toEqual([
        ['GET', `${BASE}/volumes?per_page=50&page=1`],
        ['GET', `${BASE}/volumes?per_page=50&page=2`],
      ]);
      expect(out).toEqual([{ id: 'v1' }, { id: 'v2' }]);
    });

    it('deleteVolume(id) → DELETE /volumes/{id} (true on ok)', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({}, 204));
      expect(await provider.deleteVolume('v1')).toBe(true);
      expect(calls()).toEqual([['DELETE', `${BASE}/volumes/v1`]]);
    });

    it('deleteVolume(id) → true on 404 (already gone)', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({}, 404));
      expect(await provider.deleteVolume('v1')).toBe(true);
    });
  });

  describe('listLoadBalancers / deleteLoadBalancer', () => {
    it('listLoadBalancers() → GET /load_balancers?per_page=50&page=1 → data.load_balancers', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(
        resp({ load_balancers: [{ id: 'lb1' }], links: {} }),
      );
      const out = await provider.listLoadBalancers();
      expect(calls()).toEqual([['GET', `${BASE}/load_balancers?per_page=50&page=1`]]);
      expect(out).toEqual([{ id: 'lb1' }]);
    });

    it('returns [] on a non-ok first-page response', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({}, 503));
      expect(await provider.listLoadBalancers()).toEqual([]);
    });

    it('walks pagination past the first page via links.pages.next — a load balancer on page 2 is returned', async () => {
      fetchWithRetryMock
        .mockResolvedValueOnce(
          resp({ load_balancers: [{ id: 'lb1' }], links: { pages: { next: 'x' } } }),
        )
        .mockResolvedValueOnce(resp({ load_balancers: [{ id: 'lb2' }], links: {} }));
      const out = await provider.listLoadBalancers();
      expect(calls()).toEqual([
        ['GET', `${BASE}/load_balancers?per_page=50&page=1`],
        ['GET', `${BASE}/load_balancers?per_page=50&page=2`],
      ]);
      expect(out).toEqual([{ id: 'lb1' }, { id: 'lb2' }]);
    });

    it('deleteLoadBalancer(id) → DELETE /load_balancers/{id}', async () => {
      fetchWithRetryMock.mockResolvedValueOnce(resp({}, 204));
      expect(await provider.deleteLoadBalancer('lb1')).toBe(true);
      expect(calls()).toEqual([['DELETE', `${BASE}/load_balancers/lb1`]]);
    });
  });
});
