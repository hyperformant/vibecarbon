/**
 * The operator-firewall reconcile (applyOperatorCidrs, run by every
 * `vibecarbon access add/remove/prune` and by the operator-IP auto-add on
 * deploy) deletes leftover inbound tcp/5432 and tcp/6543 rules. Those were
 * the retired external pooler's operator-CIDR rules; the database has no
 * public port now (operators use `vibecarbon shell` / SSH), so a firewall
 * created before the pooler was removed must not keep them.
 *
 * Hetzner and DigitalOcean pin the same contract next to their other
 * applyOperatorCidrs tests (hetzner-operator-firewall.test.ts,
 * digitalocean-methods.test.ts). This file covers Linode, Vultr and
 * Scaleway, asserting the exact rule payload each provider sends: the DB
 * rules are gone, SSH and the k8s API carry the new CIDRs, and HTTPS, the
 * WireGuard replication rule and any outbound rules are exactly as read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';

const jsonResp = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

type Call = { url: string; method: string; body?: string };

beforeEach(() => {
  fetchWithRetryMock.mockReset();
});

describe('LinodeProvider.applyOperatorCidrs scrubs retired DB-port rules', () => {
  const inbound = [
    {
      label: 'ssh',
      action: 'ACCEPT',
      protocol: 'TCP',
      ports: '22',
      addresses: { ipv4: ['9.9.9.9/32'] },
    },
    {
      label: 'k8s',
      action: 'ACCEPT',
      protocol: 'TCP',
      ports: '6443',
      addresses: { ipv4: ['9.9.9.9/32'] },
    },
    {
      label: 'https',
      action: 'ACCEPT',
      protocol: 'TCP',
      ports: '443',
      addresses: { ipv4: ['0.0.0.0/0'], ipv6: ['::/0'] },
    },
    {
      label: 'pooler-session',
      action: 'ACCEPT',
      protocol: 'TCP',
      ports: '5432',
      addresses: { ipv4: ['9.9.9.9/32'] },
    },
    {
      label: 'pooler-transaction',
      action: 'ACCEPT',
      protocol: 'TCP',
      ports: '6543',
      addresses: { ipv4: ['9.9.9.9/32'] },
    },
    {
      label: 'wg-replication',
      action: 'ACCEPT',
      protocol: 'UDP',
      ports: '51821',
      addresses: { ipv4: ['5.5.5.5/32'] },
    },
  ];
  const outbound = [
    {
      label: 'all',
      action: 'ACCEPT',
      protocol: 'TCP',
      ports: '5432',
      addresses: { ipv4: ['0.0.0.0/0'] },
    },
  ];

  it('PUTs the inbound set without 5432/6543 and everything else as read', async () => {
    const calls: Call[] = [];
    fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body as string | undefined });
      if (url.includes('/networking/firewalls?')) {
        return jsonResp({
          data: [{ id: 7, label: 'proj-prod-firewall', rules: { inbound } }],
          page: 1,
          pages: 1,
        });
      }
      if (url.endsWith('/networking/firewalls/7/rules') && method === 'GET') {
        return jsonResp({ inbound, inbound_policy: 'DROP', outbound, outbound_policy: 'ACCEPT' });
      }
      if (url.endsWith('/networking/firewalls/7/rules') && method === 'PUT') return jsonResp({});
      return jsonResp({}, 404);
    });

    const cidrs = ['1.2.3.4/32', '2001:db8::/64'];
    const updated = await new LinodeProvider('tok').applyOperatorCidrs({
      firewallName: 'proj-prod-firewall',
      cidrs,
    });

    expect(updated).toBe(true);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe('https://api.linode.com/v4/networking/firewalls/7/rules');
    const addresses = { ipv4: ['1.2.3.4/32'], ipv6: ['2001:db8::/64'] };
    expect(JSON.parse(puts[0].body ?? '{}')).toEqual({
      inbound: [{ ...inbound[0], addresses }, { ...inbound[1], addresses }, inbound[2], inbound[5]],
      inbound_policy: 'DROP',
      outbound,
      outbound_policy: 'ACCEPT',
    });
  });
});

describe('VultrProvider.applyOperatorCidrs scrubs retired DB-port rules', () => {
  // Rows as GET /v2/firewalls/<id>/rules returns them (ids included).
  const rules = [
    {
      id: 1,
      ip_type: 'v4',
      protocol: 'tcp',
      port: '22',
      subnet: '9.9.9.9',
      subnet_size: 32,
      notes: 'operator-22',
    },
    {
      id: 2,
      ip_type: 'v4',
      protocol: 'tcp',
      port: '443',
      subnet: '0.0.0.0',
      subnet_size: 0,
      notes: 'https',
    },
    {
      id: 3,
      ip_type: 'v4',
      protocol: 'tcp',
      port: '5432',
      subnet: '9.9.9.9',
      subnet_size: 32,
      notes: 'operator-5432',
    },
    {
      id: 4,
      ip_type: 'v4',
      protocol: 'tcp',
      port: '6543',
      subnet: '9.9.9.9',
      subnet_size: 32,
      notes: 'operator-6543',
    },
    {
      id: 5,
      ip_type: 'v4',
      protocol: 'udp',
      port: '51821',
      subnet: '5.5.5.5',
      subnet_size: 32,
      notes: 'wg-replication',
    },
  ];

  it('deletes every live rule, then recreates the set without 5432/6543', async () => {
    const provider = new VultrProvider('tok');
    const deletes: string[] = [];
    fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'DELETE') {
        deletes.push(url);
        return { ok: true, status: 204 };
      }
      if (/\/firewalls\?per_page/.test(url)) {
        return jsonResp({
          firewall_groups: [{ id: 'gid-1', description: 'proj-prod-firewall' }],
          meta: {},
        });
      }
      if (/\/firewalls\/gid-1\/rules\?per_page/.test(url)) {
        return jsonResp({ firewall_rules: rules, meta: {} });
      }
      return jsonResp({}, 404);
    });
    const posts: unknown[] = [];
    vi.spyOn(provider, 'apiRequest').mockImplementation(
      async (path: string, opts?: RequestInit) => {
        expect(path).toBe('/firewalls/gid-1/rules');
        posts.push(JSON.parse(String(opts?.body)));
        return { ok: true, json: async () => ({}) } as Response;
      },
    );

    const updated = await provider.applyOperatorCidrs({
      firewallName: 'proj-prod-firewall',
      cidrs: ['1.2.3.4/32'],
    });

    expect(updated).toBe(true);
    expect(deletes).toEqual(
      [1, 2, 3, 4, 5].map((id) => `https://api.vultr.com/v2/firewalls/gid-1/rules/${id}`),
    );
    expect(posts).toEqual([
      {
        ip_type: 'v4',
        protocol: 'tcp',
        subnet: '0.0.0.0',
        subnet_size: 0,
        port: '443',
        notes: 'https',
      },
      {
        ip_type: 'v4',
        protocol: 'udp',
        subnet: '5.5.5.5',
        subnet_size: 32,
        port: '51821',
        notes: 'wg-replication',
      },
      {
        ip_type: 'v4',
        protocol: 'tcp',
        subnet: '1.2.3.4',
        subnet_size: 32,
        port: '22',
        notes: 'operator-22',
      },
    ]);
  });
});

describe('ScalewayProvider.applyOperatorCidrs scrubs retired DB-port rules', () => {
  const rule = (
    id: string,
    protocol: string,
    port: number,
    ip_range: string,
    direction = 'inbound',
  ) => ({
    id,
    action: 'accept',
    protocol,
    direction,
    ip_range,
    dest_port_from: port,
    dest_port_to: port,
  });
  const existing = [
    rule('r1', 'TCP', 22, '9.9.9.9/32'),
    rule('r2', 'TCP', 6443, '9.9.9.9/32'),
    rule('r3', 'TCP', 443, '0.0.0.0/0'),
    rule('r4', 'TCP', 5432, '9.9.9.9/32'),
    rule('r5', 'TCP', 6543, '9.9.9.9/32'),
    rule('r6', 'UDP', 51821, '5.5.5.5/32'),
    rule('r7', 'TCP', 5432, '0.0.0.0/0', 'outbound'),
  ];

  it('sends one atomic PUT without the inbound 5432/6543 rules', async () => {
    const calls: Call[] = [];
    fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body as string | undefined });
      if (url.includes('/security_groups?name=')) {
        return jsonResp({ security_groups: [{ id: 'sg-1', name: 'proj-prod-firewall' }] });
      }
      if (url.includes('/security_groups/sg-1/rules') && method === 'PUT')
        return jsonResp({ rules: [] });
      if (url.includes('/security_groups/sg-1/rules')) return jsonResp({ rules: existing });
      if (url.includes('/security_groups/sg-1')) return jsonResp({});
      return jsonResp({}, 404);
    });

    const updated = await new ScalewayProvider('tok').applyOperatorCidrs({
      firewallName: 'proj-prod-firewall',
      cidrs: ['1.2.3.4/32'],
    });

    expect(updated).toBe(true);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toMatch(/\/instance\/v1\/zones\/[a-z0-9-]+\/security_groups\/sg-1\/rules$/);
    const strip = ({ id: _id, ...r }: ReturnType<typeof rule>) => r;
    const kept = [existing[2], existing[5], existing[6]].map(strip);
    const rebuilt = [
      strip(rule('', 'TCP', 22, '1.2.3.4/32')),
      strip(rule('', 'TCP', 6443, '1.2.3.4/32')),
    ];
    expect(JSON.parse(puts[0].body ?? '{}')).toEqual({
      rules: [...kept, ...rebuilt].map((r, i) => ({
        id: null,
        position: i + 1,
        editable: true,
        ...r,
      })),
    });
  });
});
