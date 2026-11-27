/**
 * The VultrProvider methods a k8s destroy calls after `pulumi destroy`: the
 * VPC by name. A Vultr k8s cluster has no reserved IP (K8S_FLOATING_IP is
 * false: its domain points at the master's own address, vultr-k8s.js), so
 * the provider has no reserved-IP release for destroy to call.
 *
 * Vultr's VPCs carry no tags. The k8s program (vultr-k8s.js) describes the
 * VPC `${clusterName}-network`, so that exact string is the only attribution
 * destroy has. The delete lists first and matches exactly: a VPC that is not
 * this environment's is never deleted, and a listing that cannot be read
 * whole throws. fetch is stubbed; nothing here touches Vultr.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args) };
});

import { BaseProvider } from '../../../src/lib/providers/base.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';

beforeEach(() => {
  fetchWithRetryMock.mockReset();
});

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
 * A fake Vultr API: GET /vpcs lists `vpcs`, and every DELETE answers
 * `deleteStatus`.
 */
function api({
  vpcs = [] as Array<{ id: string; description: string }>,
  deleteStatus = 204,
  deleteText = '',
} = {}) {
  const calls: Call[] = [];
  fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname.replace(/^\/v2/, '');
    calls.push({ method, path });
    if (method === 'DELETE') return status(deleteStatus, deleteText);
    if (path === '/vpcs') return page('vpcs', vpcs);
    throw new Error(`unexpected ${method} ${url}`);
  });
  return calls;
}
const deletes = (calls: Call[]) => calls.filter((c) => c.method === 'DELETE').map((c) => c.path);

describe('VultrProvider k8s destroy members', () => {
  it('runs the k8s destroy backstop, and never guesses a volume owner by region', () => {
    expect(VultrProvider.K8S_DESTROY_BACKSTOP).toBe(true);
    expect(VultrProvider.ORPHAN_VOLUME_REGION_GUESS).toBe(false);
  });

  it('the base keeps the region guess, so every other provider is unchanged', () => {
    expect(BaseProvider.ORPHAN_VOLUME_REGION_GUESS).toBe(true);
  });

  // No Vultr program makes a reserved IP, so destroy has none to release:
  // without these, it never lists the account's reserved IPs at all.
  it('has no reserved IP to release, by address or by label', () => {
    expect(VultrProvider.K8S_FLOATING_IP).toBe(false);
    const proto = VultrProvider.prototype as unknown as Record<string, unknown>;
    expect(proto.deleteReservedIpByAddress).toBeUndefined();
    expect(proto.reservedIpLabelMatch).toBeUndefined();
    expect(proto.deleteReservedIpsByLabels).toBeUndefined();
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
