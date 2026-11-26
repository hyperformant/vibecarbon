/**
 * The VultrProvider methods a k8s destroy calls after `pulumi destroy`: the
 * VPC by name, the reserved IP by address and by the program's label, and
 * the two accessors the pre-scan reads (serverNetworkIds, volumeName).
 *
 * Vultr's reserved IPs and VPCs carry no tags. The k8s program
 * (vultr-k8s.js) labels the reserved IP
 * `project:<project>:environment:<environment>` (reservedIpLabel) and
 * describes the VPC `${clusterName}-network`, so those exact strings are the
 * only attribution destroy has, with the tags of the instance an IP is
 * assigned to. Every delete lists first and matches exactly: an address or
 * label that is not this environment's is never deleted, one still assigned
 * to an instance is left alone, and a listing that cannot be read whole
 * throws. fetch is stubbed; nothing here touches Vultr.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args) };
});

import { BaseProvider } from '../../../src/lib/providers/base.js';
import {
  reservedIpLabel,
  reservedIpLabelOwner,
  VultrProvider,
} from '../../../src/lib/providers/vultr.js';

beforeEach(() => {
  fetchWithRetryMock.mockReset();
});

type ReservedIp = {
  id: string;
  subnet: string;
  label: string;
  instance_id?: string;
  region?: string;
};
type Call = { method: string; path: string };

const page = (key: string, items: unknown[], next = '') => ({
  ok: true,
  status: 200,
  json: async () => ({ [key]: items, meta: { links: { next } } }),
});
const status = (code: number, text = '') => ({
  ok: code >= 200 && code < 300,
  status: code,
  json: async () => ({}),
  text: async () => text,
});

/**
 * A fake Vultr API: GET /reserved-ips and GET /vpcs list `ips` and `vpcs`
 * (or answer `listStatus`), GET /instances/{id} answers the tags in
 * `instances` (404 for any other id, `instanceStatus` when set), and every
 * DELETE answers `deleteStatus`.
 */
function api({
  ips = [] as ReservedIp[],
  vpcs = [] as Array<{ id: string; description: string }>,
  instances = {} as Record<string, string[]>,
  instanceStatus = 200,
  listStatus = 200,
  deleteStatus = 204,
  deleteText = '',
} = {}) {
  const calls: Call[] = [];
  fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname.replace(/^\/v2/, '');
    calls.push({ method, path });
    if (method === 'DELETE') return status(deleteStatus, deleteText);
    if (listStatus !== 200) return status(listStatus);
    if (path === '/reserved-ips') {
      return page(
        'reserved_ips',
        ips.map((ip) => ({
          instance_id: '',
          region: 'ewr',
          ip_type: 'v4',
          subnet_size: 32,
          ...ip,
        })),
      );
    }
    if (path === '/vpcs') return page('vpcs', vpcs);
    const instance = /^\/instances\/([^/]+)$/.exec(path)?.[1];
    if (instance) {
      if (instanceStatus !== 200) return status(instanceStatus);
      const tags = instances[instance];
      if (!tags) return status(404);
      return { ok: true, status: 200, json: async () => ({ instance: { id: instance, tags } }) };
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  return calls;
}
const deletes = (calls: Call[]) => calls.filter((c) => c.method === 'DELETE').map((c) => c.path);

const OURS = { project: 'acme', environment: 'prod' };
const L = (project: string, environment: string) => `project:${project}:environment:${environment}`;
/** The tags vultr-k8s.js gives an instance of that stack (encodeLabels). */
const TAGS = (project: string, environment: string) => [
  `project:${project}`,
  `environment:${environment}`,
  'managed-by:vibecarbon',
  'role:master',
];

describe('VultrProvider k8s destroy members', () => {
  it('runs the k8s destroy backstop, and never guesses a volume owner by region', () => {
    expect(VultrProvider.K8S_DESTROY_BACKSTOP).toBe(true);
    expect(VultrProvider.ORPHAN_VOLUME_REGION_GUESS).toBe(false);
  });

  it('the base keeps the region guess, so every other provider is unchanged', () => {
    expect(BaseProvider.ORPHAN_VOLUME_REGION_GUESS).toBe(true);
  });
});

describe('the reserved IP label: project:<project>:environment:<environment>', () => {
  it("names the project and environment in the instance tags' key:value form", () => {
    expect(reservedIpLabel(OURS)).toBe('project:acme:environment:prod');
    expect(reservedIpLabelOwner('project:acme:environment:prod')).toEqual(OURS);
  });

  // Names are spelled [a-z0-9-], so `-` cannot separate them: project acme's
  // k8s-ha stack prod-primary and project acme-prod's environment primary
  // were both `acme-prod-primary-ingress`. `:` is in no name.
  it('gives two stacks whose names join to the same string two labels', () => {
    const haSide = reservedIpLabel({ project: 'acme', environment: 'prod-primary' });
    const other = reservedIpLabel({ project: 'acme-prod', environment: 'primary' });
    expect(haSide).toBe('project:acme:environment:prod-primary');
    expect(other).toBe('project:acme-prod:environment:primary');
    expect(haSide).not.toBe(other);
    expect(reservedIpLabelOwner(haSide)).toEqual({ project: 'acme', environment: 'prod-primary' });
    expect(reservedIpLabelOwner(other)).toEqual({ project: 'acme-prod', environment: 'primary' });
  });

  it.each([
    ['a third key', { ...OURS, role: 'master' }],
    ['only a project', { project: 'acme' }],
    ['an empty value', { project: 'acme', environment: '' }],
    ['a value holding the separator', { project: 'acme', environment: 'prod:x' }],
    ['a value outside the name characters', { project: 'Acme', environment: 'prod' }],
    ['no labels', undefined],
  ])('labels with %s have no label', (_, labels) => {
    expect(reservedIpLabel(labels as Record<string, string> | undefined)).toBeNull();
  });

  it.each([
    'acme-prod-ingress',
    'project:acme',
    'project:acme:environment:prod:role:master',
    'environment:prod:project:acme',
    'project::environment:prod',
    'project:Acme:environment:prod',
    '',
  ])('reads no owner from %j, a label it did not write', (label) => {
    expect(reservedIpLabelOwner(label)).toBeNull();
  });
});

describe('VultrProvider.deleteNetworkByName', () => {
  const vpcs = [
    { id: 'vpc-1', description: 'acme-prod-network' },
    { id: 'vpc-2', description: 'acme-prod-network-old' },
  ];

  it('listNetworks then deleteNetworkByName find a VPC by its description', async () => {
    const calls = api({ vpcs });
    const p = new VultrProvider('tok');
    expect((await p.listNetworks()).map((n) => n.name)).toEqual([
      'acme-prod-network',
      'acme-prod-network-old',
    ]);
    expect(await p.deleteNetworkByName('acme-prod-network')).toEqual({
      deleted: true,
      everExisted: true,
      apiError: null,
    });
    expect(deletes(calls)).toEqual(['/vpcs/vpc-1']);
  });

  it('a 404 on the delete is deleted (already gone)', async () => {
    api({ vpcs, deleteStatus: 404 });
    expect((await new VultrProvider('tok').deleteNetworkByName('acme-prod-network')).deleted).toBe(
      true,
    );
  });

  it('no VPC by that exact description: nothing deleted, never existed', async () => {
    const calls = api({ vpcs });
    expect(await new VultrProvider('tok').deleteNetworkByName('acme-prod')).toEqual({
      deleted: false,
      everExisted: false,
      apiError: null,
    });
    expect(deletes(calls)).toEqual([]);
  });

  it('Vultr refusing while instances are still attached comes back as apiError', async () => {
    api({ vpcs, deleteStatus: 400, deleteText: 'VPC has instances attached' });
    const out = await new VultrProvider('tok').deleteNetworkByName('acme-prod-network');
    expect(out.deleted).toBe(false);
    expect(out.everExisted).toBe(true);
    expect(out.apiError?.message).toBe(
      'DELETE /vpcs/vpc-1 failed: HTTP 400 VPC has instances attached',
    );
  });
});

describe('VultrProvider._listReservedIps', () => {
  it('walks every cursor page of GET /reserved-ips', async () => {
    fetchWithRetryMock.mockImplementation(async (url: string) =>
      url.includes('cursor=NEXT')
        ? page('reserved_ips', [{ id: 'r2', subnet: '203.0.113.2', label: '' }])
        : page('reserved_ips', [{ id: 'r1', subnet: '203.0.113.1', label: '' }], 'NEXT'),
    );
    const ips = await new VultrProvider('tok')._listReservedIps();
    expect(ips.map((ip: ReservedIp) => ip.subnet)).toEqual(['203.0.113.1', '203.0.113.2']);
  });

  it('throws when a page cannot be read', async () => {
    api({ listStatus: 503 });
    await expect(new VultrProvider('tok')._listReservedIps()).rejects.toThrow(
      'GET /reserved-ips failed: HTTP 503',
    );
  });

  it('throws when the walk stops at its page guard, rather than read part as the whole', async () => {
    fetchWithRetryMock.mockImplementation(async () =>
      page('reserved_ips', [{ id: 'r', subnet: '203.0.113.9', label: '' }], 'MORE'),
    );
    await expect(new VultrProvider('tok')._listReservedIps()).rejects.toThrow(
      /more reserved IPs than vibecarbon reads/,
    );
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(20);
  });
});

describe('VultrProvider.deleteReservedIpByAddress', () => {
  const ips = [
    { id: 'rip-7', subnet: '203.0.113.7', label: L('acme', 'prod') },
    { id: 'rip-8', subnet: '203.0.113.8', label: L('other', 'prod') },
  ];

  it('lists, matches the address, and deletes that one by id', async () => {
    const calls = api({ ips });
    expect(await new VultrProvider('tok').deleteReservedIpByAddress('203.0.113.7')).toEqual({
      released: true,
    });
    expect(deletes(calls)).toEqual(['/reserved-ips/rip-7']);
  });

  it('a 404 on the delete is released', async () => {
    api({ ips, deleteStatus: 404 });
    expect(await new VultrProvider('tok').deleteReservedIpByAddress('203.0.113.7')).toEqual({
      released: true,
    });
  });

  it('an address the account no longer holds is released, with no delete', async () => {
    const calls = api({ ips });
    expect(await new VultrProvider('tok').deleteReservedIpByAddress('203.0.113.70')).toEqual({
      released: true,
    });
    expect(deletes(calls)).toEqual([]);
  });

  it.each([
    [403, true, 'Vultr refused the delete (HTTP 403)'],
    [500, null, 'Vultr could not complete the delete (HTTP 500)'],
  ])('a %i on the delete is not released (held %s)', async (code, held, reason) => {
    api({ ips, deleteStatus: code });
    expect(await new VultrProvider('tok').deleteReservedIpByAddress('203.0.113.7')).toEqual({
      released: false,
      held,
      region: null,
      reason,
    });
  });

  it('a listing it cannot read throws, and deletes nothing', async () => {
    const calls = api({ ips, listStatus: 500 });
    await expect(new VultrProvider('tok').deleteReservedIpByAddress('203.0.113.7')).rejects.toThrow(
      /HTTP 500/,
    );
    expect(deletes(calls)).toEqual([]);
  });

  it('refuses one still assigned to an instance, and sends no delete', async () => {
    const calls = api({
      ips: [{ id: 'rip-7', subnet: '203.0.113.7', label: L('acme', 'prod'), instance_id: 'i-9' }],
    });
    expect(await new VultrProvider('tok').deleteReservedIpByAddress('203.0.113.7')).toEqual({
      released: false,
      held: true,
      region: null,
      reason: 'it is still assigned to instance i-9',
    });
    expect(deletes(calls)).toEqual([]);
  });
});

describe('VultrProvider.reservedIpLabelMatch', () => {
  const ips = [
    { id: 'rip-7', subnet: '203.0.113.7', label: L('acme', 'prod') },
    { id: 'rip-8', subnet: '203.0.113.8', label: L('acme', 'prod'), instance_id: 'inst-42' },
    { id: 'rip-9', subnet: '203.0.113.9', label: '' },
  ];
  const match = (address: string, labels: Record<string, string>) => {
    api({ ips, instances: { 'inst-42': TAGS('acme', 'prod') } });
    return new VultrProvider('tok').reservedIpLabelMatch(address, labels);
  };

  it('a reserved IP labelled project:acme:environment:prod is project acme, environment prod', async () => {
    expect(await match('203.0.113.7', OURS)).toEqual({
      found: true,
      matches: true,
      tags: [L('acme', 'prod')],
      holder: null,
    });
  });

  it.each([
    ['another environment whose name starts with ours', { project: 'acme', environment: 'prod2' }],
    ['another project', { project: 'acm', environment: 'prod' }],
    ['the other k8s-ha side', { project: 'acme', environment: 'prod-standby' }],
    ['empty labels', {}],
    ['only a project', { project: 'acme' }],
  ])('does not match %s', async (_, labels) => {
    const out = await match('203.0.113.7', labels as Record<string, string>);
    expect(out).toMatchObject({ found: true, matches: false, tags: [L('acme', 'prod')] });
  });

  it('names the instance an assigned one is held by', async () => {
    expect(await match('203.0.113.8', OURS)).toEqual({
      found: true,
      matches: true,
      tags: [L('acme', 'prod')],
      holder: 'instance inst-42',
    });
  });

  it('an unlabelled one carries no tags', async () => {
    expect(await match('203.0.113.9', OURS)).toEqual({
      found: true,
      matches: false,
      tags: [],
      holder: null,
    });
  });

  it('an address the account does not hold is not found', async () => {
    expect(await match('203.0.113.70', OURS)).toEqual({ found: false });
  });

  it('a listing it cannot read throws', async () => {
    api({ ips, listStatus: 401 });
    await expect(
      new VultrProvider('tok').reservedIpLabelMatch('203.0.113.7', OURS),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe('VultrProvider.deleteReservedIpsByLabels', () => {
  const LANDSCAPE = [
    { id: 'rip-1', subnet: '203.0.113.1', label: L('acme', 'prod') },
    { id: 'rip-2', subnet: '203.0.113.2', label: L('acme', 'prod2') },
    { id: 'rip-3', subnet: '203.0.113.3', label: L('acme-prod', 'primary') },
    { id: 'rip-4', subnet: '203.0.113.4', label: L('xacme', 'prod') },
    { id: 'rip-5', subnet: '203.0.113.5', label: 'acme-prod-ingress' },
    { id: 'rip-6', subnet: '203.0.113.6', label: '' },
  ];

  it('releases only the IP labelled for this project and environment, matched exactly', async () => {
    const calls = api({ ips: LANDSCAPE });
    expect(await new VultrProvider('tok').deleteReservedIpsByLabels(OURS)).toEqual({
      deleted: ['203.0.113.1'],
      failed: [],
    });
    expect(deletes(calls)).toEqual(['/reserved-ips/rip-1']);
  });

  it('skips an address the caller already handled', async () => {
    const calls = api({ ips: LANDSCAPE });
    expect(
      await new VultrProvider('tok').deleteReservedIpsByLabels(OURS, { except: ['203.0.113.1'] }),
    ).toEqual({ deleted: [], failed: [] });
    expect(deletes(calls)).toEqual([]);
  });

  it('an assigned one is held and never deleted', async () => {
    const calls = api({
      ips: [{ id: 'rip-1', subnet: '203.0.113.1', label: L('acme', 'prod'), instance_id: 'i-9' }],
      instances: { 'i-9': TAGS('acme', 'prod') },
    });
    expect(await new VultrProvider('tok').deleteReservedIpsByLabels(OURS)).toEqual({
      deleted: [],
      failed: [
        {
          address: '203.0.113.1',
          held: true,
          reason: 'it is still assigned to instance i-9, which was not deleted',
        },
      ],
    });
    expect(deletes(calls)).toEqual([]);
  });

  it('a refused delete is held, with the status in the reason', async () => {
    api({ ips: LANDSCAPE, deleteStatus: 403 });
    expect(await new VultrProvider('tok').deleteReservedIpsByLabels(OURS)).toEqual({
      deleted: [],
      failed: [
        { address: '203.0.113.1', held: true, reason: 'Vultr refused the delete (HTTP 403)' },
      ],
    });
  });

  it('a listing it cannot read throws, and deletes nothing', async () => {
    const calls = api({ ips: LANDSCAPE, listStatus: 403 });
    await expect(new VultrProvider('tok').deleteReservedIpsByLabels(OURS)).rejects.toThrow(
      /HTTP 403/,
    );
    expect(deletes(calls)).toEqual([]);
  });

  it.each([
    ['an extra key', { ...OURS, role: 'master' }],
    ['only a project', { project: 'acme' }],
    ['other keys', { project: 'acme', stack: 'prod' }],
  ])('labels with %s are refused, and nothing is read', async (_, labels) => {
    api({ ips: LANDSCAPE });
    await expect(
      new VultrProvider('tok').deleteReservedIpsByLabels(labels as Record<string, string>),
    ).rejects.toThrow(/only by project and environment/);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
  });

  it('a label without a value is refused by sweepLabels first', async () => {
    api({ ips: LANDSCAPE });
    await expect(
      new VultrProvider('tok').deleteReservedIpsByLabels({ project: 'acme', environment: '' }),
    ).rejects.toThrow(/refusing to sweep by labels/);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
  });
});

// The label names one stack, and the instance an IP is assigned to says
// whose the address is: vultr-k8s.js tags every instance with the stack's
// project and environment. A stack's destroy never releases, or reports as
// held, an IP whose holder is another stack's.
describe('two stacks whose names join to the same string', () => {
  const HA = { project: 'acme', environment: 'prod-primary' };
  const OTHER = { project: 'acme-prod', environment: 'primary' };
  const ha = { id: 'rip-1', subnet: '203.0.113.1', label: L('acme', 'prod-primary') };
  const other = { id: 'rip-2', subnet: '203.0.113.2', label: L('acme-prod', 'primary') };
  const assigned = {
    ips: [
      { ...ha, instance_id: 'i-ha' },
      { ...other, instance_id: 'i-other' },
    ],
    instances: { 'i-ha': TAGS('acme', 'prod-primary'), 'i-other': TAGS('acme-prod', 'primary') },
  };

  it.each([
    ['acme prod-primary', HA, '203.0.113.1', '/reserved-ips/rip-1'],
    ['acme-prod primary', OTHER, '203.0.113.2', '/reserved-ips/rip-2'],
  ])('unassigned: %s releases its own IP and not the other', async (_, labels, own, path) => {
    const calls = api({ ips: [ha, other] });
    expect(await new VultrProvider('tok').deleteReservedIpsByLabels(labels)).toEqual({
      deleted: [own],
      failed: [],
    });
    expect(deletes(calls)).toEqual([path]);
  });

  it.each([
    ['acme prod-primary', HA, '203.0.113.1', 'i-ha'],
    ['acme-prod primary', OTHER, '203.0.113.2', 'i-other'],
  ])(
    'assigned: %s reports only its own IP as held, and deletes nothing',
    async (_, labels, own, holder) => {
      const calls = api(assigned);
      expect(await new VultrProvider('tok').deleteReservedIpsByLabels(labels)).toEqual({
        deleted: [],
        failed: [
          {
            address: own,
            held: true,
            reason: `it is still assigned to instance ${holder}, which was not deleted`,
          },
        ],
      });
      expect(deletes(calls)).toEqual([]);
    },
  );

  it("assigned: each stack's saved address of the other's IP does not match", async () => {
    api(assigned);
    const p = new VultrProvider('tok');
    expect(await p.reservedIpLabelMatch('203.0.113.2', HA)).toMatchObject({ matches: false });
    expect(await p.reservedIpLabelMatch('203.0.113.1', OTHER)).toMatchObject({ matches: false });
    expect(await p.reservedIpLabelMatch('203.0.113.1', HA)).toMatchObject({
      matches: true,
      holder: 'instance i-ha',
    });
  });
});

describe("a reserved IP labelled ours, held by another stack's instance", () => {
  const ip = { id: 'rip-1', subnet: '203.0.113.1', label: L('acme', 'prod'), instance_id: 'i-9' };

  it('does not match, and says whose its holder is', async () => {
    api({ ips: [ip], instances: { 'i-9': TAGS('other', 'prod') } });
    expect(await new VultrProvider('tok').reservedIpLabelMatch('203.0.113.1', OURS)).toEqual({
      found: true,
      matches: false,
      tags: [L('acme', 'prod'), 'held by instance i-9, which is project other, environment prod'],
      holder: 'instance i-9',
    });
  });

  it('a holder with no project tag is not ours either', async () => {
    api({ ips: [ip], instances: { 'i-9': ['laptop'] } });
    const out = await new VultrProvider('tok').reservedIpLabelMatch('203.0.113.1', OURS);
    expect(out).toMatchObject({ matches: false });
    expect((out as { tags: string[] }).tags[1]).toBe(
      'held by instance i-9, which is no vibecarbon project',
    );
  });

  it('the label sweep leaves it out: not released, not reported held', async () => {
    const calls = api({ ips: [ip], instances: { 'i-9': TAGS('acme', 'prod2') } });
    expect(await new VultrProvider('tok').deleteReservedIpsByLabels(OURS)).toEqual({
      deleted: [],
      failed: [],
    });
    expect(deletes(calls)).toEqual([]);
  });

  it('a holder Vultr no longer lists (404) leaves the IP ours and held', async () => {
    api({ ips: [ip] });
    expect(await new VultrProvider('tok').reservedIpLabelMatch('203.0.113.1', OURS)).toMatchObject({
      matches: true,
      holder: 'instance i-9',
    });
  });

  it('a holder it cannot read: the match throws, the sweep reports it unverified', async () => {
    const calls = api({ ips: [ip], instanceStatus: 500 });
    const p = new VultrProvider('tok');
    await expect(p.reservedIpLabelMatch('203.0.113.1', OURS)).rejects.toThrow(
      'Vultr did not answer for instance i-9, which holds it (HTTP 500)',
    );
    expect(await p.deleteReservedIpsByLabels(OURS)).toEqual({
      deleted: [],
      failed: [
        {
          address: '203.0.113.1',
          held: null,
          reason: 'Vultr did not answer for instance i-9, which holds it (HTTP 500)',
        },
      ],
    });
    expect(deletes(calls)).toEqual([]);
  });
});
