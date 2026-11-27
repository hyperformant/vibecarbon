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
    datacenter: { name: 'nbg1-dc3' },
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
  it("the instance, and the account's events for it", async () => {
    answer(LinodeProvider.API_BASE, {
      '/linode/instances/9001': ok({
        id: 9001,
        label: 'proj-ci4-db',
        status: 'provisioning',
        created: '2026-11-27T02:32:10',
        region: 'us-ord',
      }),
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
      events: [
        { action: 'linode_boot', status: 'failed', error: 'host unavailable' },
        { action: 'linode_create', status: 'finished', error: null },
      ],
    });
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
    expectReadOnly(2);
  });

  it('a token without the events scope still gets the status', async () => {
    answer(LinodeProvider.API_BASE, {
      '/linode/instances/9001': ok({ id: 9001, label: 'x', status: 'running' }),
      '/account/events?page_size=25': { status: 401 },
    });
    const view = await new LinodeProvider('t').describeServerForDiagnosis('9001');
    expect(view.status).toBe('running');
    expect(view.eventsError).toBe('Linode answered HTTP 401 for /account/events');
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
      events: [],
      eventsNote: "Vultr's API keeps no event history for an instance",
    });
    expectReadOnly(1);
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
