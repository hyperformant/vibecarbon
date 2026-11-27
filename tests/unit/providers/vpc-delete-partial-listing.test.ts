/**
 * deleteNetworkByName on DigitalOcean, Linode and Vultr (one body,
 * deleteVpcByName in providers/base.js), and on Scaleway (its Private
 * Network, then its VPC, each listing read whole first), never reads part of
 * a network listing as the whole. listNetworks answers what it read when a
 * page fails, so a VPC on a page it never read looked already gone: destroy
 * said "VPC already gone (Pulumi)" and moved on. Now a listing that cannot
 * be read whole throws, no DELETE is sent, and destroy reports that it could
 * not confirm the VPC is gone (deleteBackstopNetwork). fetch is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args) };
});

import { sweepK8sBackstopTargets } from '../../../src/destroy.js';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import { inTestProject, stubScalewayProject } from '../../_shared/scaleway-project.js';

beforeEach(() => {
  fetchWithRetryMock.mockReset();
  // Scaleway lists only the configured project (scaleway-project.ts).
  stubScalewayProject();
});

const NAME = 'proj-prod-network';
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const failed = (status: number) => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => '',
});

type Row = {
  make: () => { deleteNetworkByName: (name: string) => Promise<unknown> };
  /** Page 1 of the listing, holding this stack's network, with a page 2 to follow. */
  firstPage: () => ReturnType<typeof ok>;
  /** The listing read first, as its error names it. */
  listing?: string;
  /** The GETs of that listing. */
  listed?: RegExp;
  /**
   * The provider's other listings a k8s destroy reads (its reserved or
   * flexible IPs, for the label sweep), answered empty and complete; any
   * GET that is neither is unexpected.
   */
  others?: Array<[RegExp, unknown]>;
};
const rows: Array<[string, Row]> = [
  [
    'DigitalOcean',
    {
      make: () => new DigitalOceanProvider('tok'),
      firstPage: () =>
        ok({
          vpcs: [{ id: 'vpc-1', name: NAME }],
          links: { pages: { next: 'https://api.digitalocean.com/v2/vpcs?page=2' } },
        }),
    },
  ],
  [
    'Linode',
    {
      make: () => new LinodeProvider('tok'),
      firstPage: () => ok({ data: [{ id: 1, label: NAME }], page: 1, pages: 2 }),
      others: [[/\/networking\/reserved\/ips(\?|$)/, { data: [], page: 1, pages: 1 }]],
    },
  ],
  [
    'Vultr',
    {
      make: () => new VultrProvider('tok'),
      firstPage: () =>
        ok({ vpcs: [{ id: 'vpc-1', description: NAME }], meta: { links: { next: 'NEXT' } } }),
      others: [[/\/reserved-ips(\?|$)/, { reserved_ips: [], meta: { links: { next: '' } } }]],
    },
  ],
  [
    'Scaleway',
    {
      make: () => new ScalewayProvider('tok'),
      // A full page (page_size=100) has a next; a short one ends the walk.
      firstPage: () =>
        ok({
          private_networks: inTestProject(
            [
              { id: 'pn-1', name: NAME },
              ...Array.from({ length: 99 }, (_, i) => ({ id: `pn-x${i}`, name: `other-${i}` })),
            ],
            'project_id',
          ),
        }),
      listing: 'Private Network',
      listed: /\/vpc\/v2\/regions\/[^/]+\/private-networks\?/,
      others: [[/\/instance\/v1\/zones\/[^/]+\/ips\?/, { ips: [] }]],
    },
  ],
];

/**
 * The listing's GETs (GET /vpcs by default) answer `pages` in order, the
 * row's other listings answer empty, and every DELETE succeeds.
 */
function api(
  pages: Array<ReturnType<typeof ok> | ReturnType<typeof failed>>,
  listed: RegExp,
  others: Array<[RegExp, unknown]> = [],
) {
  const deletes: string[] = [];
  let at = 0;
  fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'DELETE') {
      deletes.push(url);
      return { ok: true, status: 204 };
    }
    const other = others.find(([re]) => re.test(url));
    if (other) return ok(other[1]);
    if (!listed.test(url)) throw new Error(`unexpected GET ${url}`);
    return pages[Math.min(at++, pages.length - 1)];
  });
  return deletes;
}

describe.each(rows)(
  '%s deleteNetworkByName on a network listing it cannot read whole',
  (_, row) => {
    const listing = row.listing ?? 'VPC';
    const listed = row.listed ?? /\/vpcs(\?|$)/;

    it('throws when the first page fails, and sends no delete', async () => {
      const deletes = api([failed(503)], listed);
      await expect(row.make().deleteNetworkByName(NAME)).rejects.toThrow(
        `the ${listing} listing could not be read whole (HTTP 503)`,
      );
      expect(deletes).toEqual([]);
    });

    it('throws when a later page fails, even with the network on a page it read', async () => {
      const deletes = api([row.firstPage(), failed(500)], listed);
      await expect(row.make().deleteNetworkByName(NAME)).rejects.toThrow(
        `the ${listing} listing could not be read whole (HTTP 500)`,
      );
      expect(deletes).toEqual([]);
    });

    it('destroy reports it could not confirm the VPC is gone, never "already gone"', async () => {
      api([failed(503)], listed, row.others);
      const provider = row.make() as InstanceType<typeof VultrProvider>;
      for (const m of ['deleteFirewallByName', 'deleteSSHKeyByName'] as const) {
        vi.spyOn(provider, m).mockResolvedValue({ deleted: true } as never);
      }
      const stops: string[] = [];
      const results = {
        firewalls: [] as string[],
        sshKeys: [] as string[],
        leaks: createLeakLedger(),
        unreleasedReservedIps: [] as string[],
      };
      await sweepK8sBackstopTargets({
        provider,
        targets: [
          {
            stackEnv: 'prod',
            clusterName: 'proj-prod',
            firewallName: 'proj-prod-firewall',
            sshKeyName: null,
            reservedIps: [],
            networkName: NAME,
          },
        ],
        results,
        s: { start: () => {}, stop: (m: string) => stops.push(m), message: () => {} },
        projectName: 'proj',
        environment: 'prod',
      });
      const network = results.leaks.entries.filter(
        (e: { resourceClass: string }) => e.resourceClass === 'network',
      );
      expect(network).toHaveLength(1);
      // Nothing else is reported: every other read answered as expected.
      expect(results.leaks.entries).toEqual(network);
      expect(network[0]).toMatchObject({ severity: 'unverified', resource: NAME });
      expect(network[0].reason).toContain('could not confirm it is gone');
      expect(stops).not.toContain('VPC already gone (Pulumi)');
    });
  },
);
