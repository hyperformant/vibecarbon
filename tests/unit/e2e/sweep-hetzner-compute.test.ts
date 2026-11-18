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
