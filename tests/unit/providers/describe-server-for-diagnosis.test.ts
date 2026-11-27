/**
 * describeServerForDiagnosis: what each provider says about a server that
 * never joined its cluster, for the failure log (node-join.js). Read-only
 * GETs, one attempt each under a 5 s abort, never fetchWithRetry: a failure
 * report must not hang on the API it describes, nor write to it.
 *
 * perf run 45922250720: the rig was destroyed before anyone read Hetzner's
 * status and actions for the database server that never came up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
}));

import { BaseProvider, SERVER_VIEW_EVENTS } from '../../../src/lib/providers/base.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';

type Answer = { status?: number; body?: unknown };
const ok = (body: unknown): Answer => ({ status: 200, body });

let fetchSpy: ReturnType<typeof vi.spyOn>;
let timeoutSpy: ReturnType<typeof vi.spyOn>;

/** Answer each request by its URL (path and query, under API_BASE). */
function answer(base: string, routes: Record<string, Answer | (() => Answer)>) {
  fetchSpy.mockImplementation(async (url: string | URL) => {
    const key = String(url).slice(base.length);
    const route = routes[key];
    if (!route) throw new Error(`unexpected request ${key}`);
    const a = typeof route === 'function' ? route() : route;
    return {
      ok: (a.status ?? 200) < 400,
      status: a.status ?? 200,
      json: async () => a.body,
    } as Response;
  });
}

/** Every request was a GET (no method, no body) under the 5 s abort, never retried. */
function expectReadOnly(calls: number) {
  expect(fetchSpy).toHaveBeenCalledTimes(calls);
  for (const [, init] of fetchSpy.mock.calls) {
    const opts = (init ?? {}) as RequestInit;
    expect(opts.method ?? 'GET').toBe('GET');
    expect(opts.body).toBeUndefined();
    expect(opts.signal).toBeDefined();
  }
  expect(timeoutSpy).toHaveBeenCalledWith(5000);
  expect(fetchWithRetryMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  fetchSpy = vi.spyOn(global, 'fetch');
  timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
  fetchWithRetryMock.mockClear();
});

afterEach(() => {
  fetchSpy.mockRestore();
  timeoutSpy.mockRestore();
});

describe('HetznerProvider.describeServerForDiagnosis', () => {
  const base = HetznerProvider.API_BASE;
  const server = {
    id: 4242,
    name: 'proj-ci4-db',
    status: 'running',
    created: '2026-11-27T02:32:10+00:00',
    datacenter: { name: 'nbg1-dc3', location: { name: 'nbg1' } },
    public_net: {
      ipv4: { id: 51, ip: '167.233.172.157', blocked: false, dns_ptr: 'static.example' },
      ipv6: { id: 52, ip: '2a01:4f8:1c1e::/64', blocked: false, dns_ptr: [] },
      floating_ips: [],
      firewalls: [{ id: 7, status: 'applied' }],
    },
    private_net: [
      { network: 4711, ip: '10.0.1.2', alias_ips: [], mac_address: '86:00:00:2a:7d:e0' },
    ],
  };

  it('the server, and its actions newest first with their errors', async () => {
    answer(base, {
      '/servers/4242': ok({ server }),
      [`/servers/4242/actions?sort=started:desc&per_page=${SERVER_VIEW_EVENTS}`]: ok({
        actions: [
          {
            command: 'create_server',
            status: 'success',
            started: '2026-11-27T02:32:10+00:00',
            finished: '2026-11-27T02:32:42+00:00',
            error: null,
          },
          {
            command: 'start_server',
            status: 'error',
            started: '2026-11-27T02:32:43+00:00',
            finished: '2026-11-27T02:33:00+00:00',
            error: { code: 'server_error', message: 'boot failed' },
          },
        ],
      }),
    });
    const view = await new HetznerProvider('t').describeServerForDiagnosis(4242);
    expect(view).toEqual({
      id: 4242,
      name: 'proj-ci4-db',
      status: 'running',
      created: '2026-11-27T02:32:10+00:00',
      location: 'nbg1-dc3',
      publicIp: '167.233.172.157',
      privateIp: '10.0.1.2',
      events: [
        {
          action: 'start_server',
          status: 'error',
          started: '2026-11-27T02:32:43+00:00',
          finished: '2026-11-27T02:33:00+00:00',
          error: 'server_error: boot failed',
        },
        {
          action: 'create_server',
          status: 'success',
          started: '2026-11-27T02:32:10+00:00',
          finished: '2026-11-27T02:32:42+00:00',
          error: null,
        },
      ],
    });
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer t' } });
    expectReadOnly(2);
  });

  it('a server on no private network has no private address, and no public one is null too', async () => {
    answer(base, {
      '/servers/4242': ok({
        server: { ...server, public_net: { ipv4: null, ipv6: null }, private_net: [] },
      }),
      [`/servers/4242/actions?sort=started:desc&per_page=${SERVER_VIEW_EVENTS}`]: ok({
        actions: [],
      }),
    });
    const view = await new HetznerProvider('t').describeServerForDiagnosis(4242);
    expect(view).toMatchObject({ publicIp: null, privateIp: null });
    expectReadOnly(2);
  });

  it('actions it cannot read leave the status, with the reason', async () => {
    answer(base, {
      '/servers/4242': ok({ server }),
      [`/servers/4242/actions?sort=started:desc&per_page=${SERVER_VIEW_EVENTS}`]: { status: 403 },
    });
    const view = await new HetznerProvider('t').describeServerForDiagnosis(4242);
    expect(view.status).toBe('running');
    expect(view.events).toEqual([]);
    expect(view.eventsError).toBe('Hetzner Cloud answered HTTP 403 for /servers/4242/actions');
  });

  it('a server it cannot read throws, with the status code', async () => {
    answer(base, {
      '/servers/4242': { status: 404 },
      [`/servers/4242/actions?sort=started:desc&per_page=${SERVER_VIEW_EVENTS}`]: ok({
        actions: [],
      }),
    });
    await expect(new HetznerProvider('t').describeServerForDiagnosis(4242)).rejects.toMatchObject({
      status: 404,
      message: 'Hetzner Cloud answered HTTP 404 for /servers/4242',
    });
  });
});

describe('DigitalOceanProvider.describeServerForDiagnosis', () => {
  it('the droplet, and its actions', async () => {
    answer(DigitalOceanProvider.API_BASE, {
      '/droplets/77': ok({
        droplet: {
          id: 77,
          name: 'proj-ci4-db',
          status: 'new',
          created_at: '2026-11-27T02:32:10Z',
          region: { slug: 'nyc3' },
          // DigitalOcean lists the VPC address first as often as not.
          networks: {
            v4: [
              { ip_address: '10.116.0.3', netmask: '255.255.240.0', gateway: '', type: 'private' },
              {
                ip_address: '159.89.40.7',
                netmask: '255.255.240.0',
                gateway: '159.89.32.1',
                type: 'public',
              },
            ],
            v6: [],
          },
        },
      }),
      [`/droplets/77/actions?per_page=${SERVER_VIEW_EVENTS}`]: ok({
        actions: [
          {
            type: 'create',
            status: 'errored',
            started_at: '2026-11-27T02:32:10Z',
            completed_at: '2026-11-27T02:35:10Z',
          },
        ],
      }),
    });
    const view = await new DigitalOceanProvider('t').describeServerForDiagnosis(77);
    expect(view).toEqual({
      id: 77,
      name: 'proj-ci4-db',
      status: 'new',
      created: '2026-11-27T02:32:10Z',
      location: 'nyc3',
      publicIp: '159.89.40.7',
      privateIp: '10.116.0.3',
      events: [
        {
          action: 'create',
          status: 'errored',
          started: '2026-11-27T02:32:10Z',
          finished: '2026-11-27T02:35:10Z',
          error: 'the action errored',
        },
      ],
    });
    expectReadOnly(2);
  });
});

describe('LinodeProvider.describeServerForDiagnosis', () => {
  // GET /linode/instances/{id} lists the public IPv4 first in `ipv4`; a VPC
  // address is not in it. GET /linode/instances/{id}/ips lists it under
  // `ipv4.vpc` (Linode API, get-linode-ips; linodego InstanceIPv4Response.VPC).
  const instance = {
    id: 9001,
    label: 'proj-ci4-db',
    status: 'provisioning',
    created: '2026-11-27T02:32:10',
    region: 'us-ord',
    ipv4: ['172.105.12.34'],
    ipv6: '2600:3c06::f03c:95ff:fe12:3456/128',
  };
  const ips = {
    ipv4: {
      public: [{ address: '172.105.12.34', type: 'ipv4', public: true, linode_id: 9001 }],
      private: [],
      shared: [],
      reserved: [],
      vpc: [
        {
          address: '10.0.1.3',
          address_range: null,
          vpc_id: 123,
          subnet_id: 456,
          config_id: 789,
          interface_id: 1011,
          linode_id: 9001,
          active: true,
          nat_1_1: null,
          gateway: '10.0.1.1',
          prefix: 24,
          subnet_mask: '255.255.255.0',
          region: 'us-ord',
        },
      ],
    },
    ipv6: { slaac: null, link_local: null, global: [] },
  };

  it("the instance, its VPC address, and the account's events for it", async () => {
    answer(LinodeProvider.API_BASE, {
      '/linode/instances/9001': ok(instance),
      '/linode/instances/9001/ips': ok(ips),
      '/account/events?page_size=25': ok({
        data: [
          {
            action: 'linode_boot',
            status: 'failed',
            created: '2026-11-27T02:33:10',
            message: 'host unavailable',
          },
          { action: 'linode_create', status: 'finished', created: '2026-11-27T02:32:10' },
        ],
      }),
    });
    const view = await new LinodeProvider('t').describeServerForDiagnosis('9001');
    expect(view).toMatchObject({
      id: 9001,
      name: 'proj-ci4-db',
      status: 'provisioning',
      location: 'us-ord',
      publicIp: '172.105.12.34',
      privateIp: '10.0.1.3',
      events: [
        { action: 'linode_boot', status: 'failed', error: 'host unavailable' },
        { action: 'linode_create', status: 'finished', error: null },
      ],
    });
    expect(view.privateIpNote).toBeUndefined();
    // The events are filtered to this instance, newest first.
    const eventsCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('/account/events'));
    expect(eventsCall).toBeDefined();
    const init = (eventsCall as [string, RequestInit])[1];
    const filter = JSON.parse((init.headers as Record<string, string>)['X-Filter']);
    expect(filter).toEqual({
      'entity.id': 9001,
      'entity.type': 'linode',
      '+order_by': 'created',
      '+order': 'desc',
    });
    expectReadOnly(3);
  });

  it('a token without the events scope still gets the status', async () => {
    answer(LinodeProvider.API_BASE, {
      '/linode/instances/9001': ok({ id: 9001, label: 'x', status: 'running' }),
      '/linode/instances/9001/ips': ok(ips),
      '/account/events?page_size=25': { status: 401 },
    });
    const view = await new LinodeProvider('t').describeServerForDiagnosis('9001');
    expect(view.status).toBe('running');
    expect(view.eventsError).toBe('Linode answered HTTP 401 for /account/events');
  });

  it('addresses it cannot read leave the status, with the reason', async () => {
    answer(LinodeProvider.API_BASE, {
      '/linode/instances/9001': ok(instance),
      '/linode/instances/9001/ips': { status: 403 },
      '/account/events?page_size=25': ok({ data: [] }),
    });
    const view = await new LinodeProvider('t').describeServerForDiagnosis('9001');
    expect(view).toMatchObject({ status: 'provisioning', publicIp: '172.105.12.34' });
    expect(view.privateIp).toBeNull();
    expect(view.privateIpNote).toBe('Linode answered HTTP 403 for /linode/instances/9001/ips');
  });

  it('an instance on no VPC has no private address', async () => {
    answer(LinodeProvider.API_BASE, {
      '/linode/instances/9001': ok(instance),
      '/linode/instances/9001/ips': ok({ ipv4: { ...ips.ipv4, vpc: [] } }),
      '/account/events?page_size=25': ok({ data: [] }),
    });
    const view = await new LinodeProvider('t').describeServerForDiagnosis('9001');
    expect(view.privateIp).toBeNull();
    expect(view.privateIpNote).toBeUndefined();
  });
});

describe('VultrProvider.describeServerForDiagnosis', () => {
  it('the instance only: its API keeps no event history', async () => {
    answer(VultrProvider.API_BASE, {
      '/instances/abc-123': ok({
        instance: {
          id: 'abc-123',
          label: 'proj-ci4-db',
          status: 'active',
          power_status: 'running',
          server_status: 'installingbooting',
          date_created: '2026-11-27T02:32:10+00:00',
          region: 'ewr',
          main_ip: '137.220.58.74',
          internal_ip: '10.1.96.4',
          v6_main_ip: '2001:19f0:5c01:1234:5400:05ff:fe12:3456',
          vpc_id: '',
        },
      }),
    });
    const view = await new VultrProvider('t').describeServerForDiagnosis('abc-123');
    expect(view).toEqual({
      id: 'abc-123',
      name: 'proj-ci4-db',
      status: 'installingbooting',
      detail: 'power running, subscription active',
      created: '2026-11-27T02:32:10+00:00',
      location: 'ewr',
      publicIp: '137.220.58.74',
      privateIp: '10.1.96.4',
      events: [],
      eventsNote: "Vultr's API keeps no event history for an instance",
    });
    expectReadOnly(1);
  });

  it('an address Vultr has not assigned yet reads as none: its 0.0.0.0 placeholder and an empty internal_ip', async () => {
    answer(VultrProvider.API_BASE, {
      '/instances/abc-123': ok({
        instance: {
          id: 'abc-123',
          label: 'proj-ci4-db',
          status: 'pending',
          power_status: 'stopped',
          server_status: 'none',
          main_ip: '0.0.0.0',
          internal_ip: '',
        },
      }),
    });
    const view = await new VultrProvider('t').describeServerForDiagnosis('abc-123');
    expect(view).toMatchObject({ publicIp: null, privateIp: null });
  });
});

describe('ScalewayProvider.describeServerForDiagnosis', () => {
  const server = {
    id: 'srv-1',
    name: 'proj-ci4-db',
    state: 'starting',
    state_detail: 'provisioning node',
    creation_date: '2026-11-27T02:32:10Z',
    zone: 'nl-ams-1',
    // Routed-IP era: the flexible IPs, and the Private Network NIC, which
    // carries no address (IPAM holds it: ipam_ip_ids).
    public_ip: null,
    public_ips: [
      { id: 'ip-6', address: '2001:bc8:1640::1', family: 'inet6', dynamic: false },
      { id: 'ip-4', address: '51.15.200.7', family: 'inet', dynamic: false },
    ],
    private_nics: [
      {
        id: 'nic-1',
        private_network_id: 'pn-1',
        server_id: 'srv-1',
        mac_address: '02:00:00:12:34:56',
        state: 'available',
        zone: 'nl-ams-1',
        ipam_ip_ids: ['ipam-1', 'ipam-2'],
      },
    ],
  };

  it('finds the zone that has the server, one read per zone', async () => {
    answer(ScalewayProvider.API_BASE, {
      '/instance/v1/zones/fr-par-1/servers/srv-1': { status: 404 },
      '/instance/v1/zones/fr-par-2/servers/srv-1': { status: 404 },
      '/instance/v1/zones/nl-ams-1/servers/srv-1': ok({ server }),
      '/instance/v1/zones/nl-ams-2/servers/srv-1': { status: 404 },
    });
    const provider = new ScalewayProvider('t');
    const view = await provider.describeServerForDiagnosis('srv-1');
    expect(view).toEqual({
      id: 'srv-1',
      name: 'proj-ci4-db',
      status: 'starting',
      detail: 'provisioning node',
      created: '2026-11-27T02:32:10Z',
      location: 'nl-ams-1',
      publicIp: '51.15.200.7',
      privateIp: null,
      privateIpNote: "Scaleway's server read carries no private address; its IPAM API holds it",
      events: [],
      eventsNote: "Scaleway's Instance API keeps no event history for a server",
    });
    expectReadOnly(3);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ headers: { 'X-Auth-Token': 't' } });
    // The zone is remembered: a second read goes straight there.
    fetchSpy.mockClear();
    await provider.describeServerForDiagnosis('srv-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a refusal that is not a 404 stops the walk and is reported', async () => {
    answer(ScalewayProvider.API_BASE, {
      '/instance/v1/zones/fr-par-1/servers/srv-1': { status: 403 },
    });
    await expect(new ScalewayProvider('t').describeServerForDiagnosis('srv-1')).rejects.toThrow(
      /HTTP 403/,
    );
  });

  it('no zone has it', async () => {
    answer(
      ScalewayProvider.API_BASE,
      Object.fromEntries(
        ScalewayProvider._zones().map((z) => [
          `/instance/v1/zones/${z}/servers/srv-1`,
          { status: 404 },
        ]),
      ),
    );
    await expect(new ScalewayProvider('t').describeServerForDiagnosis('srv-1')).rejects.toThrow(
      'no Scaleway zone has the server srv-1',
    );
  });
});

describe('BaseProvider.describeServerForDiagnosis', () => {
  it('a provider without it says so, and reads nothing', async () => {
    class NoView extends BaseProvider {
      static NAME = 'Example Cloud';
    }
    await expect(new NoView('t').describeServerForDiagnosis(1)).rejects.toThrow(
      /Example Cloud has no read of a server's own status/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
