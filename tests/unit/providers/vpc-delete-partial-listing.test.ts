/**
 * deleteNetworkByName on DigitalOcean, Linode and Vultr (one body,
 * deleteVpcByName in providers/base.js) never reads part of the VPC listing
 * as the whole. listNetworks answers what it read when a page fails, so a VPC
 * on a page it never read looked already gone: destroy said "VPC already
 * gone (Pulumi)" and moved on. Now a listing that cannot be read whole
 * throws, no DELETE is sent, and destroy reports that it could not confirm
 * the VPC is gone (deleteBackstopNetwork). fetch is stubbed.
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
import { VultrProvider } from '../../../src/lib/providers/vultr.js';

beforeEach(() => {
  fetchWithRetryMock.mockReset();
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
  /** Page 1 of the VPC listing, holding this stack's VPC, with a page 2 to follow. */
  firstPage: () => ReturnType<typeof ok>;
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
    },
  ],
  [
    'Vultr',
    {
      make: () => new VultrProvider('tok'),
      firstPage: () =>
        ok({ vpcs: [{ id: 'vpc-1', description: NAME }], meta: { links: { next: 'NEXT' } } }),
    },
  ],
];

/** GET /vpcs answers `pages` in order; every DELETE succeeds. */
function api(pages: Array<ReturnType<typeof ok> | ReturnType<typeof failed>>) {
  const deletes: string[] = [];
  let at = 0;
  fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'DELETE') {
      deletes.push(url);
      return { ok: true, status: 204 };
    }
    if (!/\/vpcs(\?|$)/.test(url)) throw new Error(`unexpected GET ${url}`);
    return pages[Math.min(at++, pages.length - 1)];
  });
  return deletes;
}

describe.each(rows)('%s deleteNetworkByName on a VPC listing it cannot read whole', (_, row) => {
  it('throws when the first page fails, and sends no delete', async () => {
    const deletes = api([failed(503)]);
    await expect(row.make().deleteNetworkByName(NAME)).rejects.toThrow(
      'the VPC listing could not be read whole (HTTP 503)',
    );
    expect(deletes).toEqual([]);
  });

  it('throws when a later page fails, even with the VPC on a page it read', async () => {
    const deletes = api([row.firstPage(), failed(500)]);
    await expect(row.make().deleteNetworkByName(NAME)).rejects.toThrow(
      'the VPC listing could not be read whole (HTTP 500)',
    );
    expect(deletes).toEqual([]);
  });

  it('destroy reports it could not confirm the VPC is gone, never "already gone"', async () => {
    api([failed(503)]);
    const provider = row.make() as InstanceType<typeof VultrProvider>;
    for (const m of ['deleteFirewallByName', 'deleteSSHKeyByName'] as const) {
      vi.spyOn(provider, m).mockResolvedValue({ deleted: true } as never);
    }
    const stops: string[] = [];
    const results = {
      leaks: createLeakLedger(),
      unreleasedReservedIps: [] as string[],
    };
    await sweepK8sBackstopTargets({
      provider,
      targets: [
        {
          stackEnv: 'prod',
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
    expect(network[0]).toMatchObject({ severity: 'unverified', resource: NAME });
    expect(network[0].reason).toContain('could not confirm it is gone');
    expect(stops).not.toContain('VPC already gone (Pulumi)');
  });
});
