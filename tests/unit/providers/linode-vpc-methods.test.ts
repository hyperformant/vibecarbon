import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The LinodeProvider methods the k8s path calls: createServer into a VPC
 * (autoscaler-made nodes must match linode-k8s.js's Pulumi workers),
 * listNetworks `name`, serverNetworkIds, the two idempotent deletes and
 * volumeName. fetch is stubbed; nothing here touches Linode.
 */

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { BaseProvider } from '../../../src/lib/providers/base.js';
import { encodeLabels, LinodeProvider } from '../../../src/lib/providers/linode.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const status = (code: number, text = '') => ({
  ok: code >= 200 && code < 300,
  status: code,
  json: async () => ({}),
  text: async () => text,
});

beforeEach(() => {
  fetchWithRetryMock.mockReset();
});

describe('LinodeProvider.createServer into a VPC', () => {
  it('posts public + vpc legacy interfaces on the first subnet and the firewall at create', async () => {
    let posted: Record<string, unknown> | undefined;
    fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/linode/instances?')) return ok({ data: [], page: 1, pages: 1 });
      if (url.endsWith('/vpcs/77/subnets')) return ok({ data: [{ id: 501 }, { id: 502 }] });
      if (url.endsWith('/linode/instances') && init?.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return ok({ id: 9 });
      }
      throw new Error(`unexpected ${url}`);
    });
    const provider = new LinodeProvider('tok');
    const res = await provider.createServer({
      name: 'n1',
      region: 'us-iad',
      serverType: 'g6-standard-2',
      image: 'linode/ubuntu24.04',
      sshKeys: ['ssh-ed25519 AAAA key'],
      labels: {},
      networks: [77],
      firewalls: [4242],
    });
    expect(res.id).toBe(9);
    expect(posted?.interface_generation).toBe('legacy_config');
    expect(posted?.interfaces).toEqual([{ purpose: 'public' }, { purpose: 'vpc', subnet_id: 501 }]);
    expect(posted?.firewall_id).toBe(4242);
  });

  it('adds no interfaces without networks (compose path unchanged)', async () => {
    let posted: Record<string, unknown> | undefined;
    fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/linode/instances?')) return ok({ data: [], page: 1, pages: 1 });
      posted = JSON.parse(String(init?.body));
      return ok({ id: 1 });
    });
    await new LinodeProvider('tok').createServer({
      name: 'n2',
      region: 'us-iad',
      serverType: 't',
      image: 'i',
      sshKeys: ['ssh-ed25519 AAAA key'],
      labels: {},
    });
    expect(posted).not.toHaveProperty('interfaces');
    expect(posted).not.toHaveProperty('interface_generation');
  });

  it('throws before creating when the VPC has no subnet', async () => {
    fetchWithRetryMock.mockImplementation(async (url: string) => {
      if (url.includes('/linode/instances?')) return ok({ data: [], page: 1, pages: 1 });
      if (url.endsWith('/subnets')) return ok({ data: [] });
      throw new Error(`unexpected ${url}`);
    });
    await expect(
      new LinodeProvider('tok').createServer({
        name: 'n3',
        region: 'us-iad',
        serverType: 't',
        image: 'i',
        sshKeys: ['ssh-ed25519 AAAA key'],
        labels: {},
        networks: [77],
      }),
    ).rejects.toThrow(/no subnet/);
  });
});

describe('LinodeProvider VPC reads', () => {
  it('listNetworks items carry name = label', async () => {
    fetchWithRetryMock.mockResolvedValue(
      ok({ data: [{ id: 1, label: 'proj-prod-network' }], page: 1, pages: 1 }),
    );
    const nets = await new LinodeProvider('tok').listNetworks();
    expect(nets[0]).toMatchObject({ id: 1, name: 'proj-prod-network' });
  });

  it('serverNetworkIds reads the attached vpc_ids, [] when none', () => {
    const p = new LinodeProvider('tok');
    expect(
      p.serverNetworkIds({
        vpc_ids: [77],
      }),
    ).toEqual([77]);
    expect(p.serverNetworkIds({ id: 1 })).toEqual([]);
  });

  it('an unfiltered listing reads VPC membership once from /vpcs/ips, across pages', async () => {
    const urls: string[] = [];
    fetchWithRetryMock.mockImplementation(async (url: string) => {
      urls.push(url);
      if (url.includes('/linode/instances?'))
        return ok({ data: [{ id: 5 }, { id: 6 }], page: 1, pages: 1 });
      if (url.includes('/vpcs/ips?page=1'))
        return ok({ data: [{ linode_id: 5, vpc_id: 77 }], page: 1, pages: 2 });
      if (url.includes('/vpcs/ips?page=2'))
        return ok({
          data: [
            { linode_id: 5, vpc_id: 77 },
            { linode_id: 9, vpc_id: 1 },
          ],
          page: 2,
          pages: 2,
        });
      throw new Error(`unexpected ${url}`);
    });
    const p = new LinodeProvider('tok');
    const [a, b] = await p.listServers();
    expect(p.serverNetworkIds(a)).toEqual([77]);
    expect(p.serverNetworkIds(b)).toEqual([]);
    expect(urls.filter((u) => u.includes('/vpcs')).length).toBe(2);
    expect(urls.some((u) => u.includes('/configs'))).toBe(false);
  });

  it('listServers(selector), as the autoscaler calls it, makes no VPC or config request', async () => {
    const urls: string[] = [];
    fetchWithRetryMock.mockImplementation(async (url: string) => {
      urls.push(url);
      if (url.includes('/linode/instances?'))
        return ok({
          data: [
            { id: 5, tags: encodeLabels({ 'cluster-autoscaler/node': 'pool', cluster: 'c' }) },
          ],
          page: 1,
          pages: 1,
        });
      throw new Error(`unexpected ${url}`);
    });
    const servers = await new LinodeProvider('tok').listServers({
      'cluster-autoscaler/node': 'pool',
      cluster: 'c',
    });
    expect(servers).toHaveLength(1);
    expect(urls.every((u) => u.includes('/linode/instances?'))).toBe(true);
  });

  it('a failed membership read reports complete:false and listServers rejects', async () => {
    for (const failure of [
      async () => status(500),
      async () => {
        throw new Error('socket hang up');
      },
    ]) {
      fetchWithRetryMock.mockReset();
      fetchWithRetryMock.mockImplementation(async (url: string) => {
        if (url.includes('/linode/instances?')) return ok({ data: [{ id: 5 }], page: 1, pages: 1 });
        return failure();
      });
      const p = new LinodeProvider('tok');
      const detailed = await p.listServersDetailed();
      expect(detailed.complete).toBe(false);
      expect(detailed.items).toHaveLength(1);
      await expect(p.listServers()).rejects.toThrow(/VPC membership read failed/);
    }
  });
});

describe('LinodeProvider deletes', () => {
  it('deleteNetworkByName: deleted, already gone, missing, and refusal', async () => {
    const p = new LinodeProvider('tok');
    const list = ok({ data: [{ id: 7, label: 'c-network' }], page: 1, pages: 1 });

    fetchWithRetryMock.mockResolvedValueOnce(list).mockResolvedValueOnce(status(204));
    expect(await p.deleteNetworkByName('c-network')).toEqual({
      deleted: true,
      everExisted: true,
      apiError: null,
    });

    fetchWithRetryMock.mockResolvedValueOnce(list).mockResolvedValueOnce(status(404));
    expect((await p.deleteNetworkByName('c-network')).deleted).toBe(true);

    fetchWithRetryMock.mockResolvedValueOnce(list);
    expect(await p.deleteNetworkByName('other')).toEqual({
      deleted: false,
      everExisted: false,
      apiError: null,
    });

    fetchWithRetryMock.mockResolvedValueOnce(list).mockResolvedValueOnce(status(400, 'in use'));
    const refused = await p.deleteNetworkByName('c-network');
    expect(refused.deleted).toBe(false);
    expect(refused.everExisted).toBe(true);
    expect(refused.apiError?.message).toMatch(/HTTP 400 in use/);
  });

  it('deleteReservedIpByAddress treats 404 as already gone', async () => {
    const p = new LinodeProvider('tok');
    fetchWithRetryMock.mockResolvedValueOnce(status(200));
    expect(await p.deleteReservedIpByAddress('1.2.3.4')).toBe(true);
    fetchWithRetryMock.mockResolvedValueOnce(status(404));
    expect(await p.deleteReservedIpByAddress('1.2.3.4')).toBe(true);
    fetchWithRetryMock.mockResolvedValueOnce(status(500));
    expect(await p.deleteReservedIpByAddress('1.2.3.4')).toBe(false);
    expect(fetchWithRetryMock.mock.calls[0][0]).toMatch(/\/networking\/reserved\/ips\/1\.2\.3\.4$/);
    expect(fetchWithRetryMock.mock.calls[0][1].method).toBe('DELETE');
  });
});

describe('volumeName', () => {
  it('Linode returns the label; the base default returns the name', () => {
    expect(new LinodeProvider('tok').volumeName({ label: 'pvc-abc', name: 'x' })).toBe('pvc-abc');
    expect(BaseProvider.prototype.volumeName.call({}, { name: 'vol-1' })).toBe('vol-1');
  });
});

describe('VultrProvider.listNetworks', () => {
  it('items carry name = description', async () => {
    const p = new VultrProvider('tok');
    vi.spyOn(p as never, '_walkCursor').mockResolvedValue({
      items: [{ id: 'v1', description: 'c-network' }],
    } as never);
    expect((await p.listNetworks())[0]).toMatchObject({ name: 'c-network' });
  });
});
