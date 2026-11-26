/**
 * VultrProvider.createServer on the autoscaler path. An autoscaled worker has
 * to land in the cluster VPC (`attach_vpc`) and behind the cluster firewall
 * group (`firewall_group_id`): the boot scripts turn UFW off, so the group is
 * the node's only network filter, and a worker outside the VPC can never
 * reach the master's private address. Wire stubs only: no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import { GroupManager } from '../../../src/autoscaler/groups.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';

const KEY_ID = '11111111-2222-3333-4444-555555555555';

type Posted = Record<string, unknown>;

function stubbedProvider(walks: Record<string, unknown[]> = {}) {
  const provider = new VultrProvider('tok-vultr-create');
  const posted: Posted[] = [];
  vi.spyOn(provider, '_walkCursor').mockImplementation(async (path: string) => ({
    items: walks[path] ?? [],
    complete: true,
  }));
  vi.spyOn(provider, 'apiRequest').mockImplementation(async (path: string, init?: RequestInit) => {
    expect(path).toBe('/instances');
    posted.push(JSON.parse(String(init?.body)));
    return {
      ok: true,
      status: 202,
      json: async () => ({ instance: { id: 'inst-1' } }),
    } as Response;
  });
  return { provider, posted };
}

const base = {
  name: 'worker-pool-abc',
  region: 'ewr',
  serverType: 'vc2-2c-4gb',
  image: '2760',
  sshKeys: [KEY_ID],
  userData: '#!/bin/bash\ntrue\n',
  labels: { cluster: 'acme-prod' },
};

afterEach(() => vi.restoreAllMocks());

describe('VultrProvider.createServer: VPC, firewall and hostname', () => {
  it('attaches the VPC and the firewall group and sets the hostname', async () => {
    const { provider, posted } = stubbedProvider();
    await provider.createServer({ ...base, networks: ['vpc-uuid'], firewalls: ['fw-uuid'] });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      attach_vpc: ['vpc-uuid'],
      firewall_group_id: 'fw-uuid',
      hostname: 'worker-pool-abc',
      label: 'worker-pool-abc',
      sshkey_id: [KEY_ID],
      os_id: 2760,
    });
  });

  it('stringifies a numeric network id', async () => {
    const { provider, posted } = stubbedProvider();
    await provider.createServer({ ...base, networks: [42] });
    expect(posted[0].attach_vpc).toEqual(['42']);
  });

  it('sends no attach_vpc without networks', async () => {
    const { provider, posted } = stubbedProvider();
    await provider.createServer({ ...base });
    expect(posted[0]).not.toHaveProperty('attach_vpc');
    const empty = stubbedProvider();
    await empty.provider.createServer({ ...base, networks: [] });
    expect(empty.posted[0]).not.toHaveProperty('attach_vpc');
  });
});

describe('autoscaler groups.js on a Vultr cluster', () => {
  it('creates the worker in the cluster VPC and behind the cluster firewall', async () => {
    const { provider, posted } = stubbedProvider({
      '/vpcs': [{ id: 'vpc-uuid', description: 'acme-prod-network' }],
      '/firewalls': [{ id: 'fw-uuid', description: 'acme-prod-firewall' }],
      '/ssh-keys': [{ id: KEY_ID, name: 'acme-prod-ewr-key' }],
    });
    const gm = new GroupManager({
      config: {
        provider: 'vultr',
        providerIdPrefix: 'vultr://',
        clusterName: 'acme-prod',
        nodeGroups: {
          'worker-pool': {
            minSize: 0,
            maxSize: 3,
            serverType: 'vc2-2c-4gb',
            region: 'ewr',
            image: '2760',
            cloudInit: '#!/bin/bash\ntrue\n',
            serverLabels: { cluster: 'acme-prod' },
            nodeLabels: {},
            taints: [],
            podsPerNode: 110,
          },
        },
        sshKeyName: 'acme-prod-ewr-key',
        firewallName: 'acme-prod-firewall',
        networkName: 'acme-prod-network',
      },
      provider,
      providerIdPrefix: 'vultr://',
      log: vi.fn(),
    });
    await gm.increaseSize('worker-pool', 1);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      attach_vpc: ['vpc-uuid'],
      firewall_group_id: 'fw-uuid',
      sshkey_id: [KEY_ID],
      os_id: 2760,
    });
    expect(posted[0].hostname).toBe(posted[0].label);
  });
});
