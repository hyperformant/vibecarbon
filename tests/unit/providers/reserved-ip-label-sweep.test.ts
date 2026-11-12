/**
 * deleteReservedIpsByLabels, per provider: release every floating or reserved
 * IP that carries ALL of the given labels, and nothing else.
 *
 * Destroy calls it with this project's and this stack's labels (the ones the
 * Pulumi programs stamp on the IP) to find an IP no record names: a deploy
 * killed while Pulumi was creating it leaves it out of the stack's state (the
 * pre-destroy refresh drops a pending create) and out of .vibecarbon.json.
 * Another environment's or another project's IP must never be touched, an
 * IP still assigned to a server is left alone, and a listing that cannot be
 * read whole throws rather than read as "nothing left".
 *
 * The table is keyed by the providers whose class has the method, so a new
 * one fails the census until it says how its fake API answers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args) };
});

import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { encodeLabel as linodeLabel } from '../../../src/lib/providers/linode.js';
import { encodeLabel as scalewayLabel } from '../../../src/lib/providers/scaleway.js';

beforeEach(() => {
  fetchWithRetryMock.mockReset();
});

/** One IP as the test describes it, before any provider's wire shape. */
type Ip = {
  address: string;
  labels: Record<string, string>;
  /** Assigned to a server (its id). */
  server?: number;
};
type Call = { method: string; url: string };
type Row = {
  /** Serve `ips` as the provider's listing; `listStatus` fails it. */
  serve: (ips: Ip[], opts?: { listStatus?: number; deleteStatus?: number }) => Call[];
  /** The address a DELETE call removes, or null when the call is not a delete of an IP. */
  deletedBy: (call: Call, ips: Ip[]) => string | null;
};

const idOf = (address: string) => Number(address.split('.').pop());
const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** Record every call; GETs answer `list(url)`, everything else answers `deleteStatus`. */
function api(list: (url: string) => ReturnType<typeof json>, deleteStatus = 204) {
  const calls: Call[] = [];
  fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (method === 'GET') return list(url);
    return json({}, deleteStatus);
  });
  return calls;
}

const rows: Record<string, Row> = {
  hetzner: {
    // The listing ignores the label selector here, so the client-side
    // filter is what scopes the sweep. The selector is checked on the wire
    // in its own test.
    serve: (ips, { listStatus = 200, deleteStatus = 204 } = {}) =>
      api(
        () =>
          json(
            {
              floating_ips: ips.map((ip) => ({
                id: idOf(ip.address),
                ip: ip.address,
                server: ip.server ?? null,
                labels: ip.labels,
              })),
              meta: { pagination: { next_page: null } },
            },
            listStatus,
          ),
        deleteStatus,
      ),
    deletedBy: (call, ips) => {
      const m = call.method === 'DELETE' && call.url.match(/\/floating_ips\/(\d+)$/);
      return m ? (ips.find((ip) => idOf(ip.address) === Number(m[1]))?.address ?? '?') : null;
    },
  },
  linode: {
    serve: (ips, { listStatus = 200, deleteStatus = 204 } = {}) =>
      api(
        () =>
          json(
            {
              page: 1,
              pages: 1,
              data: ips.map((ip) => ({
                address: ip.address,
                linode_id: ip.server ?? null,
                tags: Object.entries(ip.labels).map(([k, v]) => linodeLabel(k, v)),
              })),
            },
            listStatus,
          ),
        deleteStatus,
      ),
    deletedBy: (call) => {
      const m =
        call.method === 'DELETE' && call.url.match(/\/networking\/reserved\/ips\/([\d.]+)$/);
      return m ? m[1] : null;
    },
  },
  scaleway: {
    // Every zone is walked; the IPs live in the first one.
    serve: (ips, { listStatus = 200, deleteStatus = 204 } = {}) =>
      api(
        (url) =>
          json(
            {
              ips: url.includes('/zones/fr-par-1/')
                ? ips.map((ip) => ({
                    id: `ip-${idOf(ip.address)}`,
                    address: ip.address,
                    server: ip.server ? { id: `srv-${ip.server}`, name: 'web' } : null,
                    tags: Object.entries(ip.labels).map(([k, v]) => scalewayLabel(k, v)),
                  }))
                : [],
            },
            listStatus,
          ),
        deleteStatus,
      ),
    deletedBy: (call, ips) => {
      const m = call.method === 'DELETE' && call.url.match(/\/ips\/ip-(\d+)$/);
      return m ? (ips.find((ip) => idOf(ip.address) === Number(m[1]))?.address ?? '?') : null;
    },
  },
};

type Sweeper = {
  deleteReservedIpsByLabels: (
    labels: Record<string, string>,
    options?: { except?: string[] },
  ) => Promise<{
    deleted: string[];
    failed: Array<{ address: string; held: boolean | null; reason: string }>;
  }>;
};
const sweepers = Object.entries(PROVIDERS as Record<string, { prototype: object }>).filter(
  ([, P]) => typeof (P.prototype as Partial<Sweeper>).deleteReservedIpsByLabels === 'function',
);

const census = (registered: string[], covered: string[]) => ({
  missing: registered.filter((id) => !covered.includes(id)),
  stale: covered.filter((id) => !registered.includes(id)),
});

describe('deleteReservedIpsByLabels census', () => {
  it('covers every provider with the method, and nothing else', () => {
    expect(
      census(
        sweepers.map(([id]) => id),
        Object.keys(rows),
      ),
    ).toEqual({ missing: [], stale: [] });
  });

  it('bites: a provider that gains the method without a row is named', () => {
    expect(census([...sweepers.map(([id]) => id), 'newcloud'], Object.keys(rows)).missing).toEqual([
      'newcloud',
    ]);
  });
});

const OURS = { project: 'proj', environment: 'prod' };
const LANDSCAPE: Ip[] = [
  { address: '203.0.113.1', labels: { ...OURS, 'managed-by': 'vibecarbon' } },
  // Another environment of this project, including one whose name starts with ours.
  { address: '203.0.113.2', labels: { project: 'proj', environment: 'staging' } },
  { address: '203.0.113.3', labels: { project: 'proj', environment: 'prod-primary' } },
  // Another project's environment of the same name.
  { address: '203.0.113.4', labels: { project: 'other', environment: 'prod' } },
  // Only one of the two labels.
  { address: '203.0.113.5', labels: { project: 'proj' } },
  { address: '203.0.113.6', labels: {} },
];

for (const [id, Provider] of sweepers) {
  const row = rows[id];
  if (!row) continue;
  const make = () => new (Provider as unknown as new (t: string) => Sweeper)('token');
  const deletes = (calls: Call[], ips: Ip[]) =>
    calls.map((c) => row.deletedBy(c, ips)).filter((a): a is string => a !== null);

  describe(`${id}: deleteReservedIpsByLabels`, () => {
    it("releases this environment's IP and leaves every other environment's and project's alone", async () => {
      const calls = row.serve(LANDSCAPE);
      const out = await make().deleteReservedIpsByLabels(OURS);
      expect(out).toEqual({ deleted: ['203.0.113.1'], failed: [] });
      expect(deletes(calls, LANDSCAPE)).toEqual(['203.0.113.1']);
    });

    it('skips an address the caller already handled', async () => {
      const calls = row.serve(LANDSCAPE);
      const out = await make().deleteReservedIpsByLabels(OURS, { except: ['203.0.113.1'] });
      expect(out).toEqual({ deleted: [], failed: [] });
      expect(deletes(calls, LANDSCAPE)).toEqual([]);
    });

    it('leaves an IP still assigned to a server alone, and says so', async () => {
      const ips: Ip[] = [{ address: '203.0.113.1', labels: OURS, server: 77 }];
      const calls = row.serve(ips);
      const out = await make().deleteReservedIpsByLabels(OURS);
      expect(out.deleted).toEqual([]);
      expect(out.failed).toHaveLength(1);
      expect(out.failed[0]).toMatchObject({ address: '203.0.113.1', held: true });
      expect(out.failed[0].reason).toMatch(/assigned|attached/);
      expect(deletes(calls, ips)).toEqual([]);
    });

    it('a refused delete is held, with the status in the reason', async () => {
      const ips: Ip[] = [{ address: '203.0.113.1', labels: OURS }];
      row.serve(ips, { deleteStatus: 403 });
      const out = await make().deleteReservedIpsByLabels(OURS);
      expect(out.deleted).toEqual([]);
      expect(out.failed).toEqual([
        { address: '203.0.113.1', held: expect.anything(), reason: expect.stringContaining('403') },
      ]);
    });

    it('a listing it cannot read throws, and deletes nothing', async () => {
      const calls = row.serve(LANDSCAPE, { listStatus: 403 });
      await expect(make().deleteReservedIpsByLabels(OURS)).rejects.toThrow();
      expect(deletes(calls, LANDSCAPE)).toEqual([]);
    });

    it.each([
      ['no labels', {}],
      ['an undefined value', { project: 'proj', environment: undefined }],
      ['an empty value', { project: '', environment: 'prod' }],
      ['a blank value', { project: 'proj', environment: '  ' }],
    ])('a scope with %s is refused, and reads nothing', async (_, labels) => {
      row.serve(LANDSCAPE);
      await expect(
        make().deleteReservedIpsByLabels(labels as Record<string, string>),
      ).rejects.toThrow(/refusing to sweep by labels/);
      expect(fetchWithRetryMock).not.toHaveBeenCalled();
    });
  });
}

describe('linode: an address assigned to any entity is left alone', () => {
  it('assigned_entity without linode_id still holds it', async () => {
    const calls = api(() =>
      json({
        page: 1,
        pages: 1,
        data: [
          {
            address: '203.0.113.1',
            linode_id: null,
            assigned_entity: { id: 31, label: 'edge-lb', type: 'nodebalancer' },
            tags: Object.entries(OURS).map(([k, v]) => linodeLabel(k, v)),
          },
        ],
      }),
    );
    const Linode = PROVIDERS.linode as unknown as new (t: string) => Sweeper;
    const out = await new Linode('token').deleteReservedIpsByLabels(OURS);
    expect(out.deleted).toEqual([]);
    expect(out.failed).toEqual([
      {
        address: '203.0.113.1',
        held: true,
        reason: 'it is still assigned to nodebalancer edge-lb, which was not deleted',
      },
    ]);
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });
});

describe('hetzner: the label selector on the wire', () => {
  it('asks for both labels, so the listing holds only this stack', async () => {
    const calls = rows.hetzner.serve([]);
    const Hetzner = PROVIDERS.hetzner as unknown as new (t: string) => Sweeper;
    await new Hetzner('token').deleteReservedIpsByLabels(OURS);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/v1/floating_ips');
    expect(url.searchParams.get('label_selector')).toBe('project=proj,environment=prod');
  });

  it('a listing longer than its page guard throws rather than read part as the whole', async () => {
    let page = 0;
    fetchWithRetryMock.mockImplementation(async () => {
      page += 1;
      return json({ floating_ips: [], meta: { pagination: { next_page: page + 1 } } });
    });
    const Hetzner = PROVIDERS.hetzner as unknown as new (t: string) => Sweeper;
    await expect(new Hetzner('token').deleteReservedIpsByLabels(OURS)).rejects.toThrow(
      /more Floating IPs than vibecarbon reads/,
    );
  });
});
