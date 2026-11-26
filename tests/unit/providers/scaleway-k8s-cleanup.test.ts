/**
 * The ScalewayProvider methods a k8s destroy calls after `pulumi destroy`:
 * the Private Network and VPC by name, the flexible IP by address and by the
 * program's tags, and the accessor the pre-scan reads (serverNetworkIds).
 *
 * scaleway-k8s.js names the cluster's VPC and its one Private Network both
 * `${clusterName}-network`, and tags every node's flexible IP with the
 * stack's `project:<p>` and `environment:<e>` as two tags (encodeLabels).
 * Every delete lists first and matches exactly: a name or address that is
 * not this environment's is never deleted, one still attached to a server is
 * left alone, a server holding an IP of ours is checked for the same two
 * tags, and a listing that cannot be read whole throws. fetch is stubbed;
 * nothing here touches Scaleway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args) };
});

import { encodeLabels, ScalewayProvider } from '../../../src/lib/providers/scaleway.js';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  fetchWithRetryMock.mockReset();
  // No project scope unless a test sets one.
  vi.stubEnv('SCALEWAY_DEFAULT_PROJECT_ID', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

type Pn = { id: string; name: string; region?: string; tags?: string[] };
type Vpc = { id: string; name: string; region?: string; is_default?: boolean; tags?: string[] };
type Ip = {
  id: string;
  address: string;
  zone?: string;
  tags?: string[];
  server?: { id: string; name: string } | null;
};
type Call = { method: string; path: string; query: URLSearchParams };

const json = (code: number, body: unknown = {}) => ({
  ok: code >= 200 && code < 300,
  status: code,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/**
 * A fake Scaleway API. GET `/vpc/v2/regions/{region}/private-networks` and
 * `.../vpcs` list `pns` and `vpcs` by their region (fr-par by default); GET
 * `/instance/v1/zones/{zone}/ips` lists `ips` by zone (fr-par-1 by default);
 * GET `/instance/v1/zones/fr-par-1/servers/{id}` answers the tags in
 * `servers` (404 for any other id or zone). `get` overrides a GET path's
 * answer with a status, or with `full` (a full page, every time, so the walk
 * runs into its page guard); `del` a DELETE path's (204 by default).
 */
function api({
  pns = [] as Pn[],
  vpcs = [] as Vpc[],
  ips = [] as Ip[],
  servers = {} as Record<string, string[]>,
  get = {} as Record<string, number | 'full'>,
  del = {} as Record<string, number>,
} = {}) {
  const calls: Call[] = [];
  fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    const { pathname: path, searchParams: query } = new URL(url);
    calls.push({ method, path, query });
    if (method === 'DELETE') return del[path] ? json(del[path], { message: 'nope' }) : json(204);
    const override = get[path];
    if (override === 'full') {
      const key = path.endsWith('/vpcs') ? 'vpcs' : 'private_networks';
      return json(200, {
        [key]: Array.from({ length: 100 }, (_, i) => ({ id: `x-${i}`, name: `x-${i}` })),
      });
    }
    if (override !== undefined) return json(override, { message: 'nope' });
    const vpcApi = /^\/vpc\/v2\/regions\/([^/]+)\/(private-networks|vpcs)$/.exec(path);
    if (vpcApi) {
      const [, region, kind] = vpcApi;
      const rows = (kind === 'vpcs' ? vpcs : pns).filter((r) => (r.region ?? 'fr-par') === region);
      return json(200, { [kind === 'vpcs' ? 'vpcs' : 'private_networks']: rows });
    }
    const ipList = /^\/instance\/v1\/zones\/([^/]+)\/ips$/.exec(path);
    if (ipList) {
      return json(200, {
        ips: ips
          .filter((ip) => (ip.zone ?? 'fr-par-1') === ipList[1])
          .map(({ zone: _z, ...ip }) => ({ server: null, tags: [], ...ip })),
      });
    }
    const server = /^\/instance\/v1\/zones\/([^/]+)\/servers\/([^/]+)$/.exec(path);
    if (server) {
      const tags = servers[server[2]];
      if (server[1] !== 'fr-par-1' || !tags) return json(404, { message: 'not found' });
      return json(200, { server: { id: server[2], name: `name-of-${server[2]}`, tags } });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  return calls;
}
const deletes = (calls: Call[]) => calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
const provider = () => new ScalewayProvider('tok');

const OURS = { project: 'acme', environment: 'prod' };
/** The tags scaleway-k8s.js gives a node's flexible IP and its server. */
const TAGS = (project: string, environment: string, role = 'master') =>
  encodeLabels({ project, environment, 'managed-by': 'vibecarbon', role });

describe('ScalewayProvider k8s destroy members', () => {
  it('runs the k8s destroy backstop, and never guesses a volume owner by region', () => {
    expect(ScalewayProvider.K8S_DESTROY_BACKSTOP).toBe(true);
    expect(ScalewayProvider.ORPHAN_VOLUME_REGION_GUESS).toBe(false);
  });

  it('serverNetworkIds reads private_nics[].private_network_id, [] when none', () => {
    const p = provider();
    expect(
      p.serverNetworkIds({
        id: 'srv-1',
        private_nics: [
          { id: 'nic-1', private_network_id: 'pn-1' },
          { id: 'nic-2', private_network_id: 'pn-2' },
        ],
      }),
    ).toEqual(['pn-1', 'pn-2']);
    expect(p.serverNetworkIds({ id: 'srv-1', private_nics: [] })).toEqual([]);
    expect(p.serverNetworkIds({})).toEqual([]);
  });

  it('volumeName and labelValue keep the base: Scaleway volumes carry name, tags verbatim', () => {
    const p = provider();
    expect(p.volumeName({ id: 'v', name: 'pvc-01234567-89ab-cdef-0123-456789abcdef' })).toBe(
      'pvc-01234567-89ab-cdef-0123-456789abcdef',
    );
    expect(p.labelValue('environment', 'prod-primary')).toBe('prod-primary');
  });
});

describe('ScalewayProvider.listNetworksDetailed', () => {
  it("walks every region's Private Networks, stamping each with its region", async () => {
    api({
      pns: [
        { id: 'pn-1', name: 'acme-prod-network' },
        { id: 'pn-2', name: 'acme-stage-network', region: 'nl-ams' },
      ],
    });
    const out = await provider().listNetworksDetailed();
    expect(out.complete).toBe(true);
    expect(out.status).toBeUndefined();
    expect(out.items.map((n: Pn) => [n.id, n.region])).toEqual([
      ['pn-1', 'fr-par'],
      ['pn-2', 'nl-ams'],
    ]);
  });

  it("a region it cannot read is incomplete, with that region's status", async () => {
    api({
      pns: [{ id: 'pn-1', name: 'acme-prod-network' }],
      get: { '/vpc/v2/regions/nl-ams/private-networks': 503 },
    });
    const out = await provider().listNetworksDetailed();
    expect(out).toMatchObject({ complete: false, status: 503 });
    expect(out.items.map((n: Pn) => n.id)).toEqual(['pn-1']);
  });

  it('listNetworks keeps its soft-fail: [] when a region cannot be read', async () => {
    api({
      pns: [{ id: 'pn-1', name: 'acme-prod-network' }],
      get: { '/vpc/v2/regions/nl-ams/private-networks': 503 },
    });
    expect(await provider().listNetworks()).toEqual([]);
  });

  it('is scoped to SCALEWAY_DEFAULT_PROJECT_ID when it is set, and unscoped when not', async () => {
    let calls = api();
    await provider().listNetworksDetailed();
    expect(calls.map((c) => c.query.get('project_id'))).toEqual([null, null]);

    vi.stubEnv('SCALEWAY_DEFAULT_PROJECT_ID', PROJECT_ID);
    calls = api();
    await provider().listNetworksDetailed();
    expect(calls.map((c) => c.query.get('project_id'))).toEqual([PROJECT_ID, PROJECT_ID]);
  });
});

describe('ScalewayProvider.deleteNetworkByName', () => {
  const NAME = 'acme-prod-network';
  /** The tags scaleway-k8s.js gives a stack's VPC and Private Network. */
  const NET = (project: string, environment: string) =>
    encodeLabels({ project, environment, 'managed-by': 'vibecarbon' });
  const pns = [
    { id: 'pn-1', name: NAME, tags: NET('acme', 'prod') },
    { id: 'pn-2', name: `${NAME}-old`, tags: NET('acme', 'prod') },
  ];
  const vpcs = [
    { id: 'vpc-def', name: 'default', is_default: true, tags: [] },
    { id: 'vpc-1', name: NAME, tags: NET('acme', 'prod') },
    { id: 'vpc-2', name: `${NAME}-old`, tags: NET('acme', 'prod') },
  ];

  it('deletes the Private Network, then its VPC, each matched exactly by name', async () => {
    const calls = api({ pns, vpcs });
    expect(await provider().deleteNetworkByName(NAME, OURS)).toEqual({
      deleted: true,
      everExisted: true,
      apiError: null,
    });
    // A VPC holding a Private Network cannot go, so the network goes first.
    expect(deletes(calls)).toEqual([
      '/vpc/v2/regions/fr-par/private-networks/pn-1',
      '/vpc/v2/regions/fr-par/vpcs/vpc-1',
    ]);
  });

  it('reads both listings whole before any delete', async () => {
    const calls = api({ pns, vpcs });
    await provider().deleteNetworkByName(NAME, OURS);
    const firstDelete = calls.findIndex((c) => c.method === 'DELETE');
    const listed = calls.slice(0, firstDelete).map((c) => c.path);
    expect(listed).toEqual([
      '/vpc/v2/regions/fr-par/private-networks',
      '/vpc/v2/regions/nl-ams/private-networks',
      '/vpc/v2/regions/fr-par/vpcs',
      '/vpc/v2/regions/nl-ams/vpcs',
    ]);
  });

  it('deletes them in the region they are listed in', async () => {
    const calls = api({
      pns: [{ id: 'pn-9', name: NAME, region: 'nl-ams', tags: NET('acme', 'prod') }],
      vpcs: [{ id: 'vpc-9', name: NAME, region: 'nl-ams', tags: NET('acme', 'prod') }],
    });
    await provider().deleteNetworkByName(NAME, OURS);
    expect(deletes(calls)).toEqual([
      '/vpc/v2/regions/nl-ams/private-networks/pn-9',
      '/vpc/v2/regions/nl-ams/vpcs/vpc-9',
    ]);
  });

  it('both listings carry project_id when SCALEWAY_DEFAULT_PROJECT_ID is set', async () => {
    vi.stubEnv('SCALEWAY_DEFAULT_PROJECT_ID', PROJECT_ID);
    const calls = api({ pns, vpcs });
    await provider().deleteNetworkByName(NAME, OURS);
    const listings = calls.filter((c) => c.method === 'GET');
    expect(listings).toHaveLength(4);
    for (const c of listings) expect(c.query.get('project_id'), c.path).toBe(PROJECT_ID);
  });

  it('a VPC named default is never matched, even by its own name', async () => {
    const calls = api({ pns, vpcs });
    expect(await provider().deleteNetworkByName('default', OURS)).toEqual({
      deleted: false,
      everExisted: false,
      apiError: null,
    });
    // Nor a project's default VPC renamed to ours.
    const renamed = api({
      vpcs: [{ id: 'vpc-def', name: NAME, is_default: true, tags: NET('acme', 'prod') }],
    });
    expect((await provider().deleteNetworkByName(NAME, OURS)).everExisted).toBe(false);
    expect([...deletes(calls), ...deletes(renamed)]).toEqual([]);
  });

  it('neither by that exact name: nothing deleted, never existed', async () => {
    const calls = api({ pns, vpcs });
    expect(await provider().deleteNetworkByName('acme-prod', OURS)).toEqual({
      deleted: false,
      everExisted: false,
      apiError: null,
    });
    expect(deletes(calls)).toEqual([]);
  });

  it('a VPC whose Private Network is already gone is deleted alone', async () => {
    const calls = api({ vpcs });
    expect((await provider().deleteNetworkByName(NAME, OURS)).deleted).toBe(true);
    expect(deletes(calls)).toEqual(['/vpc/v2/regions/fr-par/vpcs/vpc-1']);
  });

  it('a 404 on either delete is deleted (already gone)', async () => {
    api({
      pns,
      vpcs,
      del: {
        '/vpc/v2/regions/fr-par/private-networks/pn-1': 404,
        '/vpc/v2/regions/fr-par/vpcs/vpc-1': 404,
      },
    });
    expect((await provider().deleteNetworkByName(NAME, OURS)).deleted).toBe(true);
  });

  it('a refused Private Network delete is apiError, and the VPC is not tried', async () => {
    const calls = api({
      pns,
      vpcs,
      del: { '/vpc/v2/regions/fr-par/private-networks/pn-1': 409 },
    });
    const out = await provider().deleteNetworkByName(NAME, OURS);
    expect(out.deleted).toBe(false);
    expect(out.everExisted).toBe(true);
    expect(out.apiError?.message).toBe(
      'DELETE /vpc/v2/regions/fr-par/private-networks/pn-1 failed: HTTP 409 {"message":"nope"}',
    );
    expect(deletes(calls)).toEqual(['/vpc/v2/regions/fr-par/private-networks/pn-1']);
  });

  it('a refused VPC delete is apiError', async () => {
    api({ pns, vpcs, del: { '/vpc/v2/regions/fr-par/vpcs/vpc-1': 412 } });
    const out = await provider().deleteNetworkByName(NAME, OURS);
    expect(out).toMatchObject({ deleted: false, everExisted: true });
    expect(out.apiError?.message).toMatch(
      /^DELETE \/vpc\/v2\/regions\/fr-par\/vpcs\/vpc-1 failed: HTTP 412/,
    );
  });

  it('a partial Private Network listing throws, and sends no delete', async () => {
    const calls = api({ pns, vpcs, get: { '/vpc/v2/regions/nl-ams/private-networks': 503 } });
    await expect(provider().deleteNetworkByName(NAME, OURS)).rejects.toThrow(
      'the Private Network listing could not be read whole (HTTP 503)',
    );
    expect(deletes(calls)).toEqual([]);
  });

  it('a Private Network listing that runs into its page guard throws, and sends no delete', async () => {
    const calls = api({ pns, vpcs, get: { '/vpc/v2/regions/fr-par/private-networks': 'full' } });
    await expect(provider().deleteNetworkByName(NAME, OURS)).rejects.toThrow(
      'the Private Network listing could not be read whole (it stopped early)',
    );
    expect(deletes(calls)).toEqual([]);
  });

  it('a complete Private Network listing with a partial VPC listing throws, and sends no delete', async () => {
    const calls = api({ pns, vpcs, get: { '/vpc/v2/regions/nl-ams/vpcs': 500 } });
    await expect(provider().deleteNetworkByName(NAME, OURS)).rejects.toThrow(
      'the VPC listing could not be read whole (HTTP 500)',
    );
    // The Private Network was found on a listing read whole, and still
    // nothing is deleted: the VPC listing is read before any delete.
    expect(deletes(calls)).toEqual([]);
  });

  // A name is not proof. `acme` on stack prod-primary and `acme-prod` on
  // primary name the same network, and an organization-wide key with no
  // project id lists every project's: only the stack's tags say whose it is.
  const THEIRS = NET('acme-prod', 'primary');

  it("one by that name carrying another stack's tags is left alone, and named in foreign", async () => {
    const calls = api({
      pns: [{ id: 'pn-7', name: NAME, tags: THEIRS }],
      vpcs: [{ id: 'vpc-7', name: NAME, tags: THEIRS }],
    });
    expect(await provider().deleteNetworkByName(NAME, OURS)).toEqual({
      deleted: false,
      everExisted: false,
      apiError: null,
      foreign:
        'left alone: Private Network pn-7 in fr-par carries project acme-prod, environment ' +
        'primary; VPC vpc-7 in fr-par carries project acme-prod, environment primary, not ' +
        'project acme, environment prod',
    });
    expect(deletes(calls)).toEqual([]);
  });

  it("ours and another stack's by the same name: deletes ours, and names the other", async () => {
    const calls = api({
      pns: [...pns, { id: 'pn-7', name: NAME, region: 'nl-ams', tags: THEIRS }],
      vpcs: [...vpcs, { id: 'vpc-7', name: NAME, region: 'nl-ams', tags: THEIRS }],
    });
    const out = await provider().deleteNetworkByName(NAME, OURS);
    expect(out).toMatchObject({ deleted: true, everExisted: true, apiError: null });
    expect(out.foreign).toContain('Private Network pn-7 in nl-ams carries project acme-prod');
    expect(deletes(calls)).toEqual([
      '/vpc/v2/regions/fr-par/private-networks/pn-1',
      '/vpc/v2/regions/fr-par/vpcs/vpc-1',
    ]);
  });

  it('an untagged one by that name is no vibecarbon project, and left alone', async () => {
    const calls = api({ pns: [{ id: 'pn-7', name: NAME, tags: [] }] });
    const out = await provider().deleteNetworkByName(NAME, OURS);
    expect(out).toMatchObject({ deleted: false, everExisted: false, apiError: null });
    expect(out.foreign).toBe(
      'left alone: Private Network pn-7 in fr-par carries no vibecarbon project, ' +
        'not project acme, environment prod',
    );
    expect(deletes(calls)).toEqual([]);
  });

  it('one carrying our project and another environment is not ours', async () => {
    const calls = api({ pns: [{ id: 'pn-7', name: NAME, tags: NET('acme', 'prod2') }] });
    expect((await provider().deleteNetworkByName(NAME, OURS)).foreign).toContain(
      'carries project acme, environment prod2',
    );
    expect(deletes(calls)).toEqual([]);
  });

  it.each([
    ['no labels', undefined],
    ['only a project', { project: 'acme' }],
    ['an empty environment', { project: 'acme', environment: '' }],
  ])('with %s, nothing is ours: every name match is left alone', async (_, labels) => {
    const calls = api({ pns, vpcs });
    const out = await provider().deleteNetworkByName(NAME, labels);
    expect(out).toMatchObject({ deleted: false, everExisted: false, apiError: null });
    expect(out.foreign).toMatch(
      /, and no project and environment were given to check its tags against$/,
    );
    expect(deletes(calls)).toEqual([]);
  });
});

describe('ScalewayProvider.deleteReservedIpByAddress', () => {
  const ips = [
    { id: 'ip-7', address: '203.0.113.7', tags: TAGS('acme', 'prod') },
    { id: 'ip-8', address: '203.0.113.8', zone: 'nl-ams-1', tags: TAGS('other', 'prod') },
  ];

  it('lists, matches the address, and releases that one in its zone', async () => {
    const calls = api({ ips });
    expect(await provider().deleteReservedIpByAddress('203.0.113.8')).toEqual({ released: true });
    expect(deletes(calls)).toEqual(['/instance/v1/zones/nl-ams-1/ips/ip-8']);
  });

  it('a 404 on the delete is released', async () => {
    api({ ips, del: { '/instance/v1/zones/fr-par-1/ips/ip-7': 404 } });
    expect(await provider().deleteReservedIpByAddress('203.0.113.7')).toEqual({ released: true });
  });

  it('an address the account no longer holds is released, with no delete', async () => {
    const calls = api({ ips });
    expect(await provider().deleteReservedIpByAddress('203.0.113.70')).toEqual({
      released: true,
    });
    expect(deletes(calls)).toEqual([]);
  });

  it.each([
    [403, true, 'Scaleway refused the delete (HTTP 403)'],
    [500, null, 'Scaleway could not complete the delete (HTTP 500)'],
  ])('a %i on the delete is not released (held %s)', async (code, held, reason) => {
    api({ ips, del: { '/instance/v1/zones/fr-par-1/ips/ip-7': code } });
    expect(await provider().deleteReservedIpByAddress('203.0.113.7')).toEqual({
      released: false,
      held,
      region: 'fr-par-1',
      reason,
    });
  });

  it('refuses one still attached to a server, and sends no delete', async () => {
    const calls = api({
      ips: [{ ...ips[0], server: { id: 'srv-1', name: 'acme-prod-master' } }],
    });
    expect(await provider().deleteReservedIpByAddress('203.0.113.7')).toEqual({
      released: false,
      held: true,
      region: 'fr-par-1',
      reason: 'it is still attached to server acme-prod-master',
    });
    expect(deletes(calls)).toEqual([]);
  });

  it('a listing it cannot read whole throws, and deletes nothing', async () => {
    const calls = api({ ips, get: { '/instance/v1/zones/nl-ams-2/ips': 503 } });
    await expect(provider().deleteReservedIpByAddress('203.0.113.7')).rejects.toThrow(
      'GET /ips failed: HTTP 503',
    );
    expect(deletes(calls)).toEqual([]);
  });
});

describe('ScalewayProvider.reservedIpLabelMatch', () => {
  const ips = [
    { id: 'ip-7', address: '203.0.113.7', tags: TAGS('acme', 'prod') },
    {
      id: 'ip-8',
      address: '203.0.113.8',
      tags: TAGS('acme', 'prod', 'worker'),
      server: { id: 'srv-1', name: 'acme-prod-worker-1' },
    },
    { id: 'ip-9', address: '203.0.113.9' },
  ];
  const match = (address: string, labels: Record<string, string>) => {
    api({ ips, servers: { 'srv-1': TAGS('acme', 'prod', 'worker') } });
    return provider().reservedIpLabelMatch(address, labels);
  };

  it('a flexible IP tagged project:acme and environment:prod is project acme, environment prod', async () => {
    expect(await match('203.0.113.7', OURS)).toEqual({
      found: true,
      matches: true,
      tags: TAGS('acme', 'prod'),
      holder: null,
    });
  });

  it.each([
    ['another environment whose name starts with ours', { project: 'acme', environment: 'prod2' }],
    ['another project', { project: 'acm', environment: 'prod' }],
    ['the other k8s-ha side', { project: 'acme', environment: 'prod-standby' }],
    ['empty labels', {}],
    ['only a project', { project: 'acme' }],
    ['an empty environment', { project: 'acme', environment: '' }],
  ])('does not match %s', async (_, labels) => {
    const out = await match('203.0.113.7', labels as Record<string, string>);
    expect(out).toMatchObject({ found: true, matches: false, tags: TAGS('acme', 'prod') });
  });

  it('an attached IP of ours is held, not deleted: it matches and names its server', async () => {
    const calls = api({ ips, servers: { 'srv-1': TAGS('acme', 'prod', 'worker') } });
    expect(await provider().reservedIpLabelMatch('203.0.113.8', OURS)).toEqual({
      found: true,
      matches: true,
      tags: TAGS('acme', 'prod', 'worker'),
      holder: 'server acme-prod-worker-1 (srv-1)',
    });
    expect(deletes(calls)).toEqual([]);
  });

  it('an untagged one carries no tags and is not ours', async () => {
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

  it('a listing it cannot read whole throws', async () => {
    api({ ips, get: { '/instance/v1/zones/fr-par-2/ips': 401 } });
    await expect(provider().reservedIpLabelMatch('203.0.113.7', OURS)).rejects.toThrow(
      'GET /ips failed: HTTP 401',
    );
  });
});

// The IP's own tags name a stack, and the server it is attached to says
// whose the address is: scaleway-k8s.js tags every server with the stack's
// project and environment too. An IP of ours held by someone else's server
// is never released, or reported as held by this stack.
describe("a flexible IP tagged ours, attached to another stack's server", () => {
  const ip = {
    id: 'ip-1',
    address: '203.0.113.1',
    tags: TAGS('acme', 'prod'),
    server: { id: 'srv-9', name: 'other-prod-master' },
  };

  it('an attached IP whose server lacks our tags is foreign and never deleted', async () => {
    const calls = api({ ips: [ip], servers: { 'srv-9': TAGS('other', 'prod') } });
    const p = provider();
    expect(await p.reservedIpLabelMatch('203.0.113.1', OURS)).toEqual({
      found: true,
      matches: false,
      tags: [
        ...TAGS('acme', 'prod'),
        'held by server other-prod-master (srv-9), which is project other, environment prod',
      ],
      holder: 'server other-prod-master (srv-9)',
    });
    expect((await p.deleteReservedIpByAddress('203.0.113.1')).released).toBe(false);
    expect(deletes(calls)).toEqual([]);
  });

  it('a server with no project tag is not ours either', async () => {
    api({ ips: [ip], servers: { 'srv-9': ['laptop'] } });
    const out = await provider().reservedIpLabelMatch('203.0.113.1', OURS);
    expect(out).toMatchObject({ matches: false });
    expect((out as { tags: string[] }).tags.at(-1)).toBe(
      'held by server other-prod-master (srv-9), which is no vibecarbon project',
    );
  });

  it('a server only one of whose tags is ours is not ours', async () => {
    api({ ips: [ip], servers: { 'srv-9': TAGS('acme', 'prod2') } });
    expect(await provider().reservedIpLabelMatch('203.0.113.1', OURS)).toMatchObject({
      matches: false,
    });
  });

  it('a server no zone lists (404) holds it on its way out: ours, and held', async () => {
    api({ ips: [ip] });
    expect(await provider().reservedIpLabelMatch('203.0.113.1', OURS)).toMatchObject({
      matches: true,
      holder: 'server other-prod-master (srv-9)',
    });
  });

  it('a server every zone refuses to show is never read as gone: the match throws', async () => {
    const zones = Object.keys(ScalewayProvider.REGIONS);
    api({
      ips: [ip],
      get: Object.fromEntries(zones.map((z) => [`/instance/v1/zones/${z}/servers/srv-9`, 403])),
    });
    await expect(provider().reservedIpLabelMatch('203.0.113.1', OURS)).rejects.toThrow(
      'could not read server other-prod-master (srv-9), which holds it (HTTP 403)',
    );
  });

  it('the label sweep leaves it out: not released, not reported held', async () => {
    const calls = api({ ips: [ip], servers: { 'srv-9': TAGS('acme', 'prod2') } });
    expect(await provider().deleteReservedIpsByLabels(OURS)).toEqual({ deleted: [], failed: [] });
    expect(deletes(calls)).toEqual([]);
  });

  it('the label sweep reports one on a server carrying our tags as held, and deletes nothing', async () => {
    const calls = api({ ips: [ip], servers: { 'srv-9': TAGS('acme', 'prod', 'worker') } });
    expect(await provider().deleteReservedIpsByLabels(OURS)).toEqual({
      deleted: [],
      failed: [
        {
          address: '203.0.113.1',
          held: true,
          reason: 'it is still attached to server other-prod-master, which was not deleted',
        },
      ],
    });
    expect(deletes(calls)).toEqual([]);
  });

  it('the label sweep reports one whose server no zone lists (404) as held', async () => {
    api({ ips: [ip] });
    expect(await provider().deleteReservedIpsByLabels(OURS)).toMatchObject({
      deleted: [],
      failed: [{ address: '203.0.113.1', held: true }],
    });
  });

  it('the label sweep reports one whose server a zone refuses to show as unverified', async () => {
    const zones = Object.keys(ScalewayProvider.REGIONS);
    const calls = api({
      ips: [ip],
      get: Object.fromEntries(zones.map((z) => [`/instance/v1/zones/${z}/servers/srv-9`, 403])),
    });
    expect(await provider().deleteReservedIpsByLabels(OURS)).toEqual({
      deleted: [],
      failed: [
        {
          address: '203.0.113.1',
          held: null,
          reason: 'could not read server other-prod-master (srv-9), which holds it (HTTP 403)',
        },
      ],
    });
    expect(deletes(calls)).toEqual([]);
  });
});

describe('two stacks whose names join to the same string', () => {
  // Project acme's k8s-ha side prod-primary and project acme-prod's
  // environment primary are both `acme-prod-primary` once joined. The
  // project and environment are two tags here, so they never meet.
  const HA = { project: 'acme', environment: 'prod-primary' };
  const OTHER = { project: 'acme-prod', environment: 'primary' };
  const ips = [
    { id: 'ip-1', address: '203.0.113.1', tags: TAGS('acme', 'prod-primary') },
    { id: 'ip-2', address: '203.0.113.2', tags: TAGS('acme-prod', 'primary') },
  ];

  it('acme on stack prod-primary and acme-prod on environment primary never match each other', async () => {
    api({ ips });
    const p = provider();
    expect(await p.reservedIpLabelMatch('203.0.113.1', HA)).toMatchObject({ matches: true });
    expect(await p.reservedIpLabelMatch('203.0.113.2', OTHER)).toMatchObject({ matches: true });
    expect(await p.reservedIpLabelMatch('203.0.113.2', HA)).toMatchObject({ matches: false });
    expect(await p.reservedIpLabelMatch('203.0.113.1', OTHER)).toMatchObject({ matches: false });
  });

  it.each([
    ['acme prod-primary', HA, '203.0.113.1', '/instance/v1/zones/fr-par-1/ips/ip-1'],
    ['acme-prod primary', OTHER, '203.0.113.2', '/instance/v1/zones/fr-par-1/ips/ip-2'],
  ])(
    'the label sweep for %s releases its own IP and not the other',
    async (_, labels, own, path) => {
      const calls = api({ ips });
      expect(await provider().deleteReservedIpsByLabels(labels)).toEqual({
        deleted: [own],
        failed: [],
      });
      expect(deletes(calls)).toEqual([path]);
    },
  );

  it.each([
    ['acme prod-primary', HA, '203.0.113.1', 'srv-ha'],
    ['acme-prod primary', OTHER, '203.0.113.2', 'srv-other'],
  ])(
    'attached: the label sweep for %s reports only its own IP held, and deletes nothing',
    async (_, labels, own, holder) => {
      const calls = api({
        ips: [
          { ...ips[0], server: { id: 'srv-ha', name: 'srv-ha' } },
          { ...ips[1], server: { id: 'srv-other', name: 'srv-other' } },
        ],
        servers: {
          'srv-ha': TAGS('acme', 'prod-primary'),
          'srv-other': TAGS('acme-prod', 'primary'),
        },
      });
      expect(await provider().deleteReservedIpsByLabels(labels)).toEqual({
        deleted: [],
        failed: [
          {
            address: own,
            held: true,
            reason: `it is still attached to server ${holder}, which was not deleted`,
          },
        ],
      });
      expect(deletes(calls)).toEqual([]);
    },
  );
});
