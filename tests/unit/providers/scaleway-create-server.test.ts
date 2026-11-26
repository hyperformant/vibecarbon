import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ScalewayProvider.createServer as the carbon-autoscaler calls it for a k8s
 * worker: the server joins the cluster's Private Network before it boots,
 * because the worker's boot script waits for the 02:00:00 NIC and gives up
 * after 180 s. A failed attach leaves nothing behind: the half-made server is
 * terminated and its flexible IP released, as a failed IP reservation does.
 * Stubbed fetch, every call recorded in order.
 */

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

// @ts-expect-error JS module without types
import { GroupManager } from '../../../src/autoscaler/groups.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';

const jsonResp = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

type Call = { method: string; path: string; body: Record<string, unknown> | string | null };

/** One server in fr-par-1, srv-new, from POST to poweron (or teardown). */
function wire({ nicStatus = 201 }: { nicStatus?: number } = {}) {
  const calls: Call[] = [];
  let terminated = false;
  let ipReleased = false;
  const handler = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const raw = typeof init?.body === 'string' ? init.body : null;
    const body = raw?.startsWith('{') ? JSON.parse(raw) : raw;
    const u = new URL(url);
    const path = u.pathname;
    calls.push({ method, path, body });
    if (method === 'GET' && path.endsWith('/servers') && u.searchParams.has('name')) {
      return jsonResp({ servers: [] });
    }
    if (method === 'POST' && path === '/instance/v1/zones/fr-par-1/servers') {
      return jsonResp({ server: { id: 'srv-new', zone: 'fr-par-1' } }, 201);
    }
    if (method === 'PATCH' && path.endsWith('/servers/srv-new/user_data/cloud-init')) {
      return jsonResp({}, 204);
    }
    if (method === 'POST' && path === '/instance/v1/zones/fr-par-1/ips') {
      return jsonResp({ ip: { id: 'ip-new', address: '203.0.113.7' } }, 201);
    }
    if (method === 'POST' && path.endsWith('/servers/srv-new/private_nics')) {
      return nicStatus < 300
        ? jsonResp({ private_nic: { id: 'nic-1', private_network_id: 'pn-uuid' } }, nicStatus)
        : jsonResp({ message: 'insufficient permissions', type: 'permissions_denied' }, nicStatus);
    }
    if (method === 'POST' && path.endsWith('/servers/srv-new/action')) {
      if ((body as { action?: string })?.action === 'terminate') terminated = true;
      return jsonResp({ task: { id: 't' } }, 202);
    }
    if (method === 'GET' && path === '/instance/v1/zones/fr-par-1/servers/srv-new') {
      return terminated
        ? jsonResp({}, 404)
        : jsonResp({
            server: {
              id: 'srv-new',
              zone: 'fr-par-1',
              volumes: { '0': { id: 'root-vol', volume_type: 'sbs_volume' } },
              public_ips: [{ id: 'ip-new', address: '203.0.113.7' }],
            },
          });
    }
    if (method === 'DELETE' && path === '/block/v1/zones/fr-par-1/volumes/root-vol') {
      return jsonResp({}, 204);
    }
    if (path === '/instance/v1/zones/fr-par-1/ips/ip-new') {
      if (method === 'GET')
        return ipReleased ? jsonResp({}, 404) : jsonResp({ ip: { id: 'ip-new' } });
      if (method === 'DELETE') {
        ipReleased = true;
        return jsonResp({}, 204);
      }
    }
    return jsonResp({ message: `unexpected ${method} ${path}` }, 404);
  };
  fetchWithRetryMock.mockImplementation(handler);
  // deleteServer's termination wait reads with the global fetch.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => handler(String(url), init)),
  );
  return calls;
}

/** The calls that change something, in order, by what they do. */
function writes(calls: Call[]) {
  return calls
    .filter((c) => c.method !== 'GET')
    .map((c) => {
      if (c.method === 'POST' && c.path.endsWith('/servers')) return 'create server';
      if (c.path.endsWith('/user_data/cloud-init')) return 'write user data';
      if (c.method === 'POST' && c.path.endsWith('/ips')) return 'reserve IP';
      if (c.path.endsWith('/private_nics')) return 'attach private network';
      if (c.path.endsWith('/action')) return (c.body as { action: string }).action;
      if (c.method === 'DELETE' && c.path.includes('/block/v1/')) return 'delete root volume';
      if (c.method === 'DELETE' && c.path.endsWith('/ips/ip-new')) return 'release IP';
      return `${c.method} ${c.path}`;
    });
}

const worker = {
  name: 'acme-prod-ca-k3x9q2ab',
  region: 'fr-par-1',
  serverType: 'DEV1-M',
  image: 'ubuntu_resolute',
  labels: { 'cluster-autoscaler/node': 'worker-pool', cluster: 'acme-prod' },
  userData: '#cloud-config\n',
  sshKeys: ['acme-prod-fr-par-1-key'],
};

beforeEach(() => {
  fetchWithRetryMock.mockReset();
  vi.stubEnv('SCALEWAY_DEFAULT_PROJECT_ID', 'proj-1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('createServer: an autoscaled worker joins the Private Network before it boots', () => {
  it('creates, writes user data, reserves the IP, attaches each network, then powers on', async () => {
    const calls = wire();
    const result = await new ScalewayProvider('tok').createServer({
      ...worker,
      networks: ['pn-uuid'],
      firewalls: ['sg-uuid'],
    });

    expect(result.id).toBe('srv-new');
    expect(writes(calls)).toEqual([
      'create server',
      'write user data',
      'reserve IP',
      'attach private network',
      'poweron',
    ]);
    const create = calls.find((c) => c.method === 'POST' && c.path.endsWith('/servers'));
    expect(create?.body).toMatchObject({ security_group: 'sg-uuid', project: 'proj-1' });
    const attach = calls.find((c) => c.path.endsWith('/private_nics'));
    expect(attach?.path).toBe('/instance/v1/zones/fr-par-1/servers/srv-new/private_nics');
    expect(attach?.body).toEqual({ private_network_id: 'pn-uuid' });
  });

  it('attaches nothing without networks (a compose replacement)', async () => {
    const calls = wire();
    await new ScalewayProvider('tok').createServer(worker);
    expect(writes(calls)).toEqual(['create server', 'write user data', 'reserve IP', 'poweron']);
  });

  it('a refused attach never powers on, terminates the server and releases its IP', async () => {
    const calls = wire({ nicStatus: 403 });
    const err = await new ScalewayProvider('tok')
      .createServer({ ...worker, networks: ['pn-uuid'], firewalls: ['sg-uuid'] })
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('pn-uuid');
    expect((err as Error).message).toContain('HTTP 403');
    const done = writes(calls);
    expect(done).not.toContain('poweron');
    expect(done.slice(0, 4)).toEqual([
      'create server',
      'write user data',
      'reserve IP',
      'attach private network',
    ]);
    expect(done).toContain('terminate');
    expect(done).toContain('delete root volume');
    expect(done).toContain('release IP');
  });

  it('sends no hostname, whatever the name: Scaleway takes the name', async () => {
    const calls = wire();
    await new ScalewayProvider('tok').createServer({
      ...worker,
      name: 'a'.repeat(70),
      networks: ['pn-uuid'],
    });
    const create = calls.find((c) => c.method === 'POST' && c.path.endsWith('/servers'));
    expect(create?.body).not.toHaveProperty('hostname');
  });
});

describe('the autoscaler path end to end: GroupManager over ScalewayProvider', () => {
  it("attaches the network listNetworks names for the cluster, with the cluster's security group", async () => {
    const calls = wire();
    const provider = new ScalewayProvider('tok');
    vi.spyOn(provider, 'listNetworks').mockResolvedValue([
      { id: 'pn-other', name: 'other-prod-network' },
      { id: 'pn-uuid', name: 'acme-prod-network' },
    ] as never);
    vi.spyOn(provider, 'findFirewallByName').mockResolvedValue({ id: 'sg-uuid' } as never);
    const gm = new GroupManager({
      config: {
        provider: 'scaleway',
        providerIdPrefix: 'scaleway://',
        clusterName: 'acme-prod',
        nodeGroups: {
          'worker-pool': {
            minSize: 0,
            maxSize: 2,
            serverType: 'DEV1-M',
            region: 'fr-par-1',
            image: 'ubuntu_resolute',
            cloudInit: '#cloud-config\n',
            serverLabels: { 'cluster-autoscaler/node': 'worker-pool', cluster: 'acme-prod' },
            nodeLabels: {},
            taints: [],
            podsPerNode: 110,
          },
        },
        sshKeyName: 'acme-prod-fr-par-1-key',
        firewallName: 'acme-prod-firewall',
        networkName: 'acme-prod-network',
      },
      provider,
      providerIdPrefix: 'scaleway://',
      log: vi.fn(),
    });

    await gm.increaseSize('worker-pool', 1);
    await vi.waitFor(() => expect(writes(calls)).toContain('poweron'));

    expect(provider.findFirewallByName).toHaveBeenCalledWith('acme-prod-firewall');
    const create = calls.find((c) => c.method === 'POST' && c.path.endsWith('/servers'));
    expect(create?.body).toMatchObject({ security_group: 'sg-uuid' });
    const attach = calls.find((c) => c.path.endsWith('/private_nics'));
    expect(attach?.body).toEqual({ private_network_id: 'pn-uuid' });
    expect(writes(calls).indexOf('attach private network')).toBeLessThan(
      writes(calls).indexOf('poweron'),
    );
  });
});
