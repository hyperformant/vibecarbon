/**
 * Hetzner orphan sweep: the Cloud API (compute) half.
 *
 * Until this file only the bucket half had tests (sweep-hetzner.test.ts).
 * The fake below answers the Cloud API the way the sweep reads it: a
 * collection GET returns `{ <kind>: [...] }` on one final page, a GET of one
 * server returns 404 (the "delete has settled" signal the sweep polls for),
 * and a DELETE returns 204 unless a test says otherwise.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepOrphanedHetznerResources } from '../../e2e/utils/sweep-hetzner.js';

const TAG = '[test]';
const PROJECT = 'testapp-h1';

type Kind =
  | 'servers'
  | 'volumes'
  | 'placement_groups'
  | 'firewalls'
  | 'ssh_keys'
  | 'floating_ips'
  | 'networks';

interface CloudOpts {
  /** DELETE status per `<kind>/<id>`; default 204. */
  deleteStatus?: Record<string, number>;
  /** Collection GET status per kind; default 200. */
  listStatus?: Partial<Record<Kind, number>>;
  /** Kinds whose collection body cannot be parsed. */
  listThrows?: Kind[];
}

function fakeCloud(collections: Partial<Record<Kind, object[]>>, opts: CloudOpts = {}) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const m = u.pathname.match(/^\/v1\/([a-z_]+)(?:\/(\d+))?$/);
    if (!m) throw new Error(`unexpected URL ${u}`);
    const kind = m[1] as Kind;
    const id = m[2];
    calls.push(`${method} /${kind}${id ? `/${id}` : ''}${id ? '' : u.search}`);
    if (method === 'DELETE') {
      const status = opts.deleteStatus?.[`${kind}/${id}`] ?? 204;
      return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
    }
    if (id) return { ok: false, status: 404, json: async () => ({}) };
    const status = opts.listStatus?.[kind] ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (opts.listThrows?.includes(kind)) throw new SyntaxError('Unexpected token <');
        return { [kind]: collections[kind] ?? [] };
      },
    };
  }) as unknown as typeof fetch;
  return { impl, calls, deletes: () => calls.filter((c) => c.startsWith('DELETE ')) };
}

const noBuckets = {
  fsn1: {
    listBuckets: vi.fn().mockResolvedValue([]),
    emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
    locateBucket: vi.fn().mockResolvedValue(null),
  },
};

async function sweep(collections: Partial<Record<Kind, object[]>>, opts: CloudOpts = {}) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const cloud = fakeCloud(collections, opts);
  const result = await sweepOrphanedHetznerResources(TAG, PROJECT, 'tok', {
    fetchImpl: cloud.impl,
    objectStorageByRegion: noBuckets,
  });
  const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
  const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
  return { ...result, warned, logged, calls: cloud.calls, deletes: cloud.deletes() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** One owned, deletable resource of each dependent kind. */
const DEPENDENTS: Array<{
  kind: Exclude<Kind, 'servers'>;
  count: 'volumes' | 'placementGroups' | 'firewalls' | 'sshKeys' | 'floatingIps' | 'networks';
  row: { id: number; name: string } & Record<string, unknown>;
  names: RegExp;
}> = [
  {
    kind: 'volumes',
    count: 'volumes',
    row: { id: 11, name: 'pvc-0a1b', server: null },
    names: /Volume 11 \(pvc-0a1b\)/,
  },
  {
    kind: 'placement_groups',
    count: 'placementGroups',
    row: { id: 12, name: 'testapp-h1-prod-pg', servers: [] },
    names: /Placement group 12 \(testapp-h1-prod-pg\)/,
  },
  {
    kind: 'firewalls',
    count: 'firewalls',
    row: { id: 13, name: 'testapp-h1-prod-firewall', applied_to: [] },
    names: /Firewall 13 \(testapp-h1-prod-firewall\)/,
  },
  {
    kind: 'ssh_keys',
    count: 'sshKeys',
    row: { id: 14, name: 'testapp-h1-prod-key' },
    names: /SSH key 14 \(testapp-h1-prod-key\)/,
  },
  {
    kind: 'floating_ips',
    count: 'floatingIps',
    row: { id: 15, name: 'testapp-h1-prod-ingress', server: null },
    names: /Floating IP 15 \(testapp-h1-prod-ingress\)/,
  },
  {
    kind: 'networks',
    count: 'networks',
    row: { id: 16, name: 'testapp-h1-prod-network', servers: [] },
    names: /Network 16 \(testapp-h1-prod-network\)/,
  },
];

describe('sweepOrphanedHetznerResources: a delete the API refused', () => {
  for (const { kind, count, row, names } of DEPENDENTS) {
    it(`${kind}: a refused delete is not counted, fails the sweep and names the resource`, async () => {
      const { counts, enumFailed, warned, deletes } = await sweep(
        { [kind]: [row] },
        { deleteStatus: { [`${kind}/${row.id}`]: 409 } },
      );
      expect(deletes).toEqual([`DELETE /${kind}/${row.id}`]);
      expect(counts[count]).toBe(0);
      expect(enumFailed).toBe(true);
      expect(warned).toMatch(names);
      expect(warned).toContain('delete failed: returned 409');
    });

    it(`${kind}: a 404 is already gone, neither an orphan nor a failure`, async () => {
      const { counts, enumFailed, logged, warned } = await sweep(
        { [kind]: [row] },
        { deleteStatus: { [`${kind}/${row.id}`]: 404 } },
      );
      expect(counts[count]).toBe(0);
      expect(enumFailed).toBe(false);
      expect(logged).toMatch(names);
      expect(logged).toContain('was already gone');
      expect(warned).not.toContain('REGRESSION');
    });

    it(`${kind}: an accepted delete is counted`, async () => {
      const { counts, enumFailed } = await sweep({ [kind]: [row] });
      expect(counts[count]).toBe(1);
      expect(enumFailed).toBe(false);
    });
  }
});

describe('sweepOrphanedHetznerResources: a pass that threw', () => {
  const KINDS: Array<[Kind, string]> = [
    ['servers', 'server list'],
    ['volumes', 'volume list'],
    ['placement_groups', 'placement-group list'],
    ['firewalls', 'firewall list'],
    ['ssh_keys', 'ssh-key list'],
    ['floating_ips', 'floating-IP list'],
    ['networks', 'network list'],
  ];
  for (const [kind, what] of KINDS) {
    it(`${kind}: a listing whose body cannot be read marks the sweep incomplete`, async () => {
      const { enumFailed, warned } = await sweep({}, { listThrows: [kind] });
      expect(enumFailed).toBe(true);
      expect(warned).toContain(`${what} enumeration incomplete`);
      expect(warned).toContain('could not enumerate');
    });
  }
});

describe('sweepOrphanedHetznerResources: the project-name guard', () => {
  for (const name of ['', 'abc']) {
    it(`refuses ${JSON.stringify(name)} before any request (a short prefix matches resources that are not ours)`, async () => {
      const cloud = fakeCloud({});
      await expect(
        sweepOrphanedHetznerResources(TAG, name, 'tok', {
          fetchImpl: cloud.impl,
          objectStorageByRegion: noBuckets,
        }),
      ).rejects.toThrow(/refusing to sweep Hetzner with project name/);
      expect(cloud.calls).toEqual([]);
    });
  }
});

describe('sweepOrphanedHetznerResources: what each compute pass owns', () => {
  it('servers: lists by the project label, deletes each one and waits for it to be gone', async () => {
    const { counts, enumFailed, calls } = await sweep({
      servers: [
        { id: 1, name: 'testapp-h1-prod-master' },
        { id: 2, name: 'testapp-h1-prod-worker-new' },
      ],
    });
    expect(calls).toContain('GET /servers?per_page=50&label_selector=project%3Dtestapp-h1&page=1');
    expect(calls.filter((c) => c.startsWith('DELETE /servers'))).toEqual([
      'DELETE /servers/1',
      'DELETE /servers/2',
    ]);
    // The settle wait: one GET per deleted server, answered 404 (gone).
    expect(calls).toContain('GET /servers/1');
    expect(calls).toContain('GET /servers/2');
    expect(counts.servers).toBe(2);
    expect(enumFailed).toBe(false);
  });

  it('servers: a refused delete is not counted, fails the sweep and is not waited for', async () => {
    const { counts, enumFailed, warned, calls } = await sweep(
      { servers: [{ id: 1, name: 'testapp-h1-prod-master' }] },
      { deleteStatus: { 'servers/1': 500 } },
    );
    expect(counts.servers).toBe(0);
    expect(enumFailed).toBe(true);
    expect(warned).toContain('Server 1 delete returned 500');
    expect(calls).not.toContain('GET /servers/1');
  });

  it('servers: a 404 on delete counts as swept', async () => {
    const { counts, enumFailed } = await sweep(
      { servers: [{ id: 1, name: 'testapp-h1-prod-master' }] },
      { deleteStatus: { 'servers/1': 404 } },
    );
    expect(counts.servers).toBe(1);
    expect(enumFailed).toBe(false);
  });

  it('volumes: lists by the project label and deletes only unattached pvc- volumes', async () => {
    const { counts, deletes, calls } = await sweep({
      volumes: [
        { id: 21, name: 'pvc-0a1b', server: null },
        { id: 22, name: 'pvc-attached', server: 7 },
        { id: 23, name: 'testapp-h1-data', server: null },
      ],
    });
    expect(calls).toContain('GET /volumes?per_page=50&label_selector=project%3Dtestapp-h1&page=1');
    expect(deletes).toEqual(['DELETE /volumes/21']);
    expect(counts.volumes).toBe(1);
  });

  it('placement groups: deletes a project-prefixed one with no live server, leaves in-use and foreign ones', async () => {
    const { counts, deletes } = await sweep({
      placement_groups: [
        { id: 31, name: 'testapp-h1-prod-pg', servers: [] },
        { id: 32, name: 'testapp-h1-prod-db-pg', servers: [99] },
        { id: 33, name: 'someone-elses-pg', servers: [] },
      ],
    });
    expect(deletes).toEqual(['DELETE /placement_groups/31']);
    expect(counts.placementGroups).toBe(1);
  });

  it('firewalls: deletes a project-prefixed one applied to nothing live, leaves in-use and foreign ones', async () => {
    const { counts, deletes } = await sweep({
      firewalls: [
        { id: 41, name: 'testapp-h1-prod-firewall', applied_to: [] },
        {
          id: 42,
          name: 'testapp-h1-stg-firewall',
          applied_to: [{ type: 'server', server: { id: 99 } }],
        },
        { id: 43, name: 'testapp-h1-lbl-firewall', applied_to: [{ type: 'label_selector' }] },
        { id: 44, name: 'someone-elses-firewall', applied_to: [] },
      ],
    });
    expect(deletes).toEqual(['DELETE /firewalls/41']);
    expect(counts.firewalls).toBe(1);
  });

  it('ssh keys: deletes by project prefix and leaves foreign keys', async () => {
    const { counts, deletes } = await sweep({
      ssh_keys: [
        { id: 51, name: 'testapp-h1-prod-nbg1-key' },
        { id: 52, name: 'laptop' },
      ],
    });
    expect(deletes).toEqual(['DELETE /ssh_keys/51']);
    expect(counts.sshKeys).toBe(1);
  });

  it('floating IPs: deletes a project-prefixed unassigned one, leaves assigned and foreign ones', async () => {
    const { counts, deletes } = await sweep({
      floating_ips: [
        { id: 61, name: 'testapp-h1-prod-ingress', server: null },
        { id: 62, name: 'testapp-h1-stg-ingress', server: 99 },
        { id: 63, name: 'someone-elses-ip', server: null },
      ],
    });
    expect(deletes).toEqual(['DELETE /floating_ips/61']);
    expect(counts.floatingIps).toBe(1);
  });

  it('networks: deletes a project-prefixed one with no live server, leaves in-use and foreign ones', async () => {
    const { counts, deletes } = await sweep({
      networks: [
        { id: 71, name: 'testapp-h1-prod-network', servers: [] },
        { id: 72, name: 'testapp-h1-stg-network', servers: [99] },
        { id: 73, name: 'default', servers: [] },
      ],
    });
    expect(deletes).toEqual(['DELETE /networks/71']);
    expect(counts.networks).toBe(1);
  });

  it('a dependent still attached to a server this sweep just deleted counts as released', async () => {
    const { counts, deletes, enumFailed } = await sweep({
      servers: [{ id: 1, name: 'testapp-h1-prod-master' }],
      placement_groups: [{ id: 31, name: 'testapp-h1-prod-pg', servers: [1] }],
      firewalls: [
        {
          id: 41,
          name: 'testapp-h1-prod-firewall',
          applied_to: [{ type: 'server', server: { id: 1 } }],
        },
      ],
      floating_ips: [{ id: 61, name: 'testapp-h1-prod-ingress', server: 1 }],
      networks: [{ id: 71, name: 'testapp-h1-prod-network', servers: [1] }],
    });
    expect(deletes).toEqual([
      'DELETE /servers/1',
      'DELETE /placement_groups/31',
      'DELETE /firewalls/41',
      'DELETE /floating_ips/61',
      'DELETE /networks/71',
    ]);
    expect(counts).toMatchObject({
      servers: 1,
      placementGroups: 1,
      firewalls: 1,
      floatingIps: 1,
      networks: 1,
    });
    expect(enumFailed).toBe(false);
  });

  it('a listing that answers non-ok marks the sweep incomplete and deletes nothing', async () => {
    const { enumFailed, warned, deletes } = await sweep(
      { firewalls: [{ id: 41, name: 'testapp-h1-prod-firewall', applied_to: [] }] },
      { listStatus: { firewalls: 503 } },
    );
    expect(enumFailed).toBe(true);
    expect(warned).toContain('firewall list enumeration incomplete');
    expect(deletes).toEqual([]);
  });

  it('the banner: orphans name the breakdown, an empty account names the cloud', async () => {
    const dirty = await sweep({ ssh_keys: [{ id: 51, name: 'testapp-h1-prod-key' }] });
    expect(dirty.warned).toContain(
      'REGRESSION: destroy left 1 orphan resource(s) (servers=0, volumes=0, placement-groups=0, firewalls=0, fips=0, networks=0, s3-buckets=0, ssh-keys=1)',
    );
    vi.restoreAllMocks();
    const clean = await sweep({});
    expect(clean.logged).toContain('No Hetzner orphans found');
    expect(clean.counts).toEqual({
      servers: 0,
      volumes: 0,
      placementGroups: 0,
      firewalls: 0,
      floatingIps: 0,
      networks: 0,
      s3Buckets: 0,
      sshKeys: 0,
    });
  });
});
