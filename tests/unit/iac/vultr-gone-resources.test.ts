/**
 * findGoneVultrResources: which resources of a Vultr stack's state Vultr says
 * are gone, read by id, and VultrProvider.readResourceStatus, the GET it reads
 * them with.
 *
 * Only Vultr's own not-found for that id drops a resource: a 404 whose
 * `error` is the type's wording. A 2xx, 401, 403, another 404, a 5xx or a
 * network error leaves it in state for the refresh to read. Nothing here
 * touches Vultr: the provider is a fake, and fetch is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args) };
});

import { findGoneVultrResources } from '../../../src/lib/iac/vultr-gone-resources.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';

const STACK = 'urn:pulumi:civ3::vibecarbon';
const urn = (type: string, name: string) => `${STACK}::${type}::${name}`;
const INSTANCE = 'vultr:index/instance:Instance';
const VPC = 'vultr:index/vpc:Vpc';
const RESERVED_IP = 'vultr:index/reservedIp:ReservedIp';
const RULE = 'vultr:index/firewallRule:FirewallRule';
const GROUP = 'vultr:index/firewallGroup:FirewallGroup';
const SSH_KEY = 'vultr:index/sSHKey:SSHKey';

const GROUP_ID = '6f2bcd49-1f0b-4a54-8e34-6d0c37f7d1a1';
const res = (type: string, name: string, id: string, extra: Record<string, unknown> = {}) => ({
  type,
  urn: urn(type, name),
  id,
  ...extra,
});
const STATE = {
  deployment: {
    resources: [
      { type: 'pulumi:pulumi:Stack', urn: `${STACK}::pulumi:pulumi:Stack::vibecarbon-civ3` },
      { type: 'pulumi:providers:vultr', urn: `${STACK}::pulumi:providers:vultr::default`, id: 'p' },
      res(SSH_KEY, 'ssh-key', 'key-uuid'),
      res(VPC, 'network', 'vpc-uuid'),
      res(GROUP, 'firewall', GROUP_ID),
      res(RULE, 'ssh-0', '1', { inputs: { firewallGroupId: GROUP_ID } }),
      res(RESERVED_IP, 'ingress', '9b32862d-ad72-4dd2-bd7d-527dfc4fa4ea'),
      res(INSTANCE, 'master', 'inst-master'),
      res(INSTANCE, 'db', 'inst-db'),
    ],
  },
};

/** The measured 404 `error` per path prefix (2026-11-27). */
const NOT_FOUND: Array<[RegExp, string]> = [
  [/^\/instances\//, 'instance not found'],
  [/^\/vpcs\//, 'VPC not found.'],
  [/^\/reserved-ips\//, 'reserved ip not found'],
  [/^\/firewalls\/[^/]+\/rules\//, 'Firewall Rule Not Found'],
];
const notFoundFor = (endpoint: string) =>
  NOT_FOUND.find(([re]) => re.test(endpoint))?.[1] ?? 'Not Found';

type Answer = { status: number; error: string | null } | 'throw';
/** A provider whose answers are `answers[endpoint]`, else Vultr's measured 404 for it. */
function provider(answers: Record<string, Answer> = {}, fallback: 'gone' | 'live' = 'gone') {
  const asked: string[] = [];
  return {
    asked,
    readResourceStatus: vi.fn(async (endpoint: string) => {
      asked.push(endpoint);
      const answer = answers[endpoint];
      if (answer === 'throw') throw new Error('fetch failed');
      if (answer) return answer;
      return fallback === 'gone'
        ? { status: 404, error: notFoundFor(endpoint) }
        : { status: 200, error: null };
    }),
  };
}

describe('findGoneVultrResources', () => {
  it('reads each Instance, Vpc, ReservedIp and FirewallRule by id, and nothing else', async () => {
    const p = provider({}, 'live');
    expect(await findGoneVultrResources(STATE, p)).toEqual([]);
    expect(p.asked.sort()).toEqual(
      [
        '/vpcs/vpc-uuid',
        `/firewalls/${GROUP_ID}/rules/1`,
        '/reserved-ips/9b32862d-ad72-4dd2-bd7d-527dfc4fa4ea',
        '/instances/inst-master',
        '/instances/inst-db',
      ].sort(),
    );
  });

  it("drops each one on Vultr's own not-found, with what Vultr said", async () => {
    const gone = await findGoneVultrResources(STATE, provider());
    expect(gone).toEqual([
      {
        urn: urn(VPC, 'network'),
        type: VPC,
        name: 'network',
        id: 'vpc-uuid',
        said: 'VPC not found.',
      },
      {
        urn: urn(RULE, 'ssh-0'),
        type: RULE,
        name: 'ssh-0',
        id: '1',
        said: 'Firewall Rule Not Found',
      },
      {
        urn: urn(RESERVED_IP, 'ingress'),
        type: RESERVED_IP,
        name: 'ingress',
        id: '9b32862d-ad72-4dd2-bd7d-527dfc4fa4ea',
        said: 'reserved ip not found',
      },
      {
        urn: urn(INSTANCE, 'master'),
        type: INSTANCE,
        name: 'master',
        id: 'inst-master',
        said: 'instance not found',
      },
      {
        urn: urn(INSTANCE, 'db'),
        type: INSTANCE,
        name: 'db',
        id: 'inst-db',
        said: 'instance not found',
      },
    ]);
  });

  it.each<[string, Answer]>([
    ['a 200', { status: 200, error: null }],
    ['a 401', { status: 401, error: 'Invalid API token.' }],
    ['a 403', { status: 403, error: 'Unauthorized IP address' }],
    ['a 500 that outlasted the retries', { status: 500, error: 'Internal server error' }],
    ['a 404 that is not the API naming this resource', { status: 404, error: 'Not Found' }],
    ['a 404 with no error text', { status: 404, error: null }],
    ["a 404 worded for another type's resource", { status: 404, error: 'VPC not found.' }],
    ['a 400 worded as its not-found', { status: 400, error: 'instance not found' }],
    ['a network error', 'throw'],
  ])('%s leaves the resource in state', async (_, answer) => {
    const gone = await findGoneVultrResources(
      STATE,
      provider({ '/instances/inst-master': answer }),
    );
    expect(gone.map((g) => g.name)).not.toContain('master');
    // The rest are still read and dropped: one answer decides one resource.
    expect(gone.map((g) => g.name)).toContain('db');
  });

  it("reads a firewall rule under its group, from outputs first, and an imported id's group", async () => {
    const p = provider({}, 'live');
    await findGoneVultrResources(
      {
        deployment: {
          resources: [
            res(RULE, 'a', '7', {
              inputs: { firewallGroupId: 'stale-group' },
              outputs: { firewallGroupId: GROUP_ID },
            }),
            res(RULE, 'b', `${GROUP_ID},12`),
          ],
        },
      },
      p,
    );
    expect(p.asked.sort()).toEqual(
      [`/firewalls/${GROUP_ID}/rules/7`, `/firewalls/${GROUP_ID}/rules/12`].sort(),
    );
  });

  it('never asks about a resource it cannot name a safe path for', async () => {
    const p = provider();
    const gone = await findGoneVultrResources(
      {
        deployment: {
          resources: [
            res(RULE, 'no-group', '3'),
            res(RULE, 'not-a-number', 'abc', { inputs: { firewallGroupId: GROUP_ID } }),
            res(INSTANCE, 'slash', '../account'),
            res(INSTANCE, 'query', 'x?y=1'),
            { type: INSTANCE, urn: urn(INSTANCE, 'no-id') },
          ],
        },
      },
      p,
    );
    expect(p.asked).toEqual([]);
    expect(gone).toEqual([]);
  });

  it('drops a URN two entries share only when both are gone (a replacement awaiting its delete)', async () => {
    const pair = {
      deployment: {
        resources: [
          res(INSTANCE, 'master', 'inst-new'),
          res(INSTANCE, 'master', 'inst-old', { delete: true }),
        ],
      },
    };
    expect(
      await findGoneVultrResources(
        pair,
        provider({ '/instances/inst-new': { status: 200, error: null } }),
      ),
    ).toEqual([]);
    expect((await findGoneVultrResources(pair, provider())).map((g) => g.id)).toEqual(['inst-new']);
  });

  it('a state with no resources asks nothing', async () => {
    const p = provider();
    expect(await findGoneVultrResources({}, p)).toEqual([]);
    expect(await findGoneVultrResources({ deployment: { resources: [] } }, p)).toEqual([]);
    expect(p.asked).toEqual([]);
  });
});

describe('VultrProvider.readResourceStatus', () => {
  // A block body: an arrow that returns the mock would hand vitest a cleanup
  // hook, and vitest would call the mock once more after every test.
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
  });

  const reply = (status: number, body: string) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });

  it("GETs the path with the account's token and returns the status and the API's error", async () => {
    fetchWithRetryMock.mockResolvedValue(reply(404, '{"error":"instance not found","status":404}'));
    expect(await new VultrProvider('tok').readResourceStatus('/instances/i-1')).toEqual({
      status: 404,
      error: 'instance not found',
    });
    const [url, init] = fetchWithRetryMock.mock.calls[0];
    expect(url).toBe('https://api.vultr.com/v2/instances/i-1');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('a 2xx has no error, and its body is read and thrown away', async () => {
    fetchWithRetryMock.mockResolvedValue(reply(200, '{"instance":{"id":"i-1"}}'));
    expect(await new VultrProvider('tok').readResourceStatus('/instances/i-1')).toEqual({
      status: 200,
      error: null,
    });
  });

  it('a body that is not JSON, or has no error string, has no error', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(reply(404, '<html>Not Found</html>'));
    fetchWithRetryMock.mockResolvedValueOnce(reply(404, '{"status":404}'));
    const p = new VultrProvider('tok');
    expect(await p.readResourceStatus('/vpcs/v')).toEqual({ status: 404, error: null });
    expect(await p.readResourceStatus('/vpcs/v')).toEqual({ status: 404, error: null });
  });

  it('a network that never answers throws, as fetchWithRetry does', async () => {
    fetchWithRetryMock.mockRejectedValue(new Error('fetch failed'));
    await expect(new VultrProvider('tok').readResourceStatus('/vpcs/v')).rejects.toThrow(
      'fetch failed',
    );
  });
});
