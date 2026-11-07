/**
 * The k8s destroy backstop on Linode, plus the census that keeps a new k8s
 * provider from silently skipping it.
 *
 * Review focus: a deploy that failed after the master was created but before
 * the cluster was ready has no kubeconfig. The backstop must still remove the
 * reserved IP, VPC, firewall and SSH key by name or address, never through
 * the cluster.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args) };
});

import { planK8sBackstopTargets, sweepK8sBackstopTargets } from '../../../src/destroy.js';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { encodeLabel, LinodeProvider } from '../../../src/lib/providers/linode.js';

beforeEach(() => fetchWithRetryMock.mockReset());

const spinner = () => ({ start: vi.fn(), stop: vi.fn() });
const makeResults = () => ({ firewalls: [], sshKeys: [], leaks: createLeakLedger() });
const tags = (project: string, environment: string) => [
  encodeLabel('project', project),
  encodeLabel('environment', environment),
];
/** GET /networking/reserved/ips answers with `data`; a DELETE succeeds. */
const reservedIpsListing = (data: Array<{ address: string; tags: string[] }>) =>
  fetchWithRetryMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
    if (init?.method === 'DELETE') return { ok: true, status: 204 };
    return { ok: true, status: 200, json: async () => ({ page: 1, pages: 1, data }) };
  });
const deleteUrls = () =>
  fetchWithRetryMock.mock.calls
    .filter(([, init]) => init?.method === 'DELETE')
    .map(([url]) => url as string);

describe('sweepK8sBackstopTargets on Linode', () => {
  it('deletes firewall, SSH key, reserved IP and VPC once each, with no cluster access', async () => {
    const provider = new LinodeProvider('token');
    const deleteFirewallByName = vi
      .spyOn(provider, 'deleteFirewallByName')
      .mockResolvedValue({ deleted: true });
    const deleteSSHKeyByName = vi.spyOn(provider, 'deleteSSHKeyByName').mockResolvedValue(true);
    const deleteReservedIpByAddress = vi
      .spyOn(provider, 'deleteReservedIpByAddress')
      .mockResolvedValue(true);
    const deleteNetworkByName = vi
      .spyOn(provider, 'deleteNetworkByName')
      .mockResolvedValue({ deleted: true });
    reservedIpsListing([{ address: '203.0.113.7', tags: tags('proj', 'prod') }]);

    const results = makeResults();
    // envConfig carries no kubeconfig at all: the deploy died before the
    // cluster was ready.
    const targets = planK8sBackstopTargets({
      plan: { tier: 'k8s', stackEnvs: ['prod'] },
      envConfig: { region: 'us-iad', floatingIp: '203.0.113.7' },
      projectConfig: { projectName: 'proj' },
    });
    await sweepK8sBackstopTargets({
      provider,
      targets,
      results,
      s: spinner(),
      projectName: 'proj',
    });

    expect(deleteFirewallByName).toHaveBeenCalledExactlyOnceWith('proj-prod-firewall');
    expect(deleteSSHKeyByName).toHaveBeenCalledExactlyOnceWith('proj-prod-us-iad-key');
    expect(deleteReservedIpByAddress).toHaveBeenCalledExactlyOnceWith('203.0.113.7');
    expect(deleteNetworkByName).toHaveBeenCalledExactlyOnceWith('proj-prod-network');
    expect(results.leaks.entries).toHaveLength(0);
  });

  it('reports a leak when the reserved IP cannot be released', async () => {
    const provider = new LinodeProvider('token');
    vi.spyOn(provider, 'deleteFirewallByName').mockResolvedValue({ deleted: false });
    vi.spyOn(provider, 'deleteSSHKeyByName').mockResolvedValue(false);
    vi.spyOn(provider, 'deleteReservedIpByAddress').mockResolvedValue(false);
    vi.spyOn(provider, 'deleteNetworkByName').mockResolvedValue({ deleted: false });
    reservedIpsListing([{ address: '203.0.113.7', tags: tags('proj', 'prod') }]);
    const results = makeResults();
    await sweepK8sBackstopTargets({
      provider,
      targets: [
        {
          stackEnv: 'prod',
          firewallName: 'proj-prod-firewall',
          sshKeyName: null,
          floatingIp: '203.0.113.7',
          networkName: 'proj-prod-network',
        },
      ],
      results,
      s: spinner(),
      projectName: 'proj',
    });
    expect(
      results.leaks.entries.map(
        (e: { resourceClass: string; severity: string }) => `${e.severity}:${e.resourceClass}`,
      ),
    ).toEqual(['leak:reserved-ip']);
  });
});

// Linode reissues a released address within minutes, so the address saved at
// deploy time can be another project's by the time destroy runs. Linode's
// reserved IPs carry the program's tags: release one by address only when it
// still carries this project's and this stack's tags.
describe('a saved reserved IP address is released only while it is still ours', () => {
  const target = {
    stackEnv: 'prod-primary',
    firewallName: 'proj-prod-primary-firewall',
    sshKeyName: null,
    floatingIp: '203.0.113.7',
    networkName: 'proj-prod-primary-network',
  };
  const linode = () => {
    const provider = new LinodeProvider('token');
    vi.spyOn(provider, 'deleteFirewallByName').mockResolvedValue({ deleted: false });
    vi.spyOn(provider, 'deleteNetworkByName').mockResolvedValue({ deleted: false });
    return provider;
  };
  const severities = (results: ReturnType<typeof makeResults>) =>
    results.leaks.entries.map(
      (e: { resourceClass: string; severity: string }) => `${e.severity}:${e.resourceClass}`,
    );
  const sweep = (provider: object, results: ReturnType<typeof makeResults>) =>
    sweepK8sBackstopTargets({
      provider,
      targets: [target],
      results,
      s: spinner(),
      projectName: 'proj',
    });

  it('Linode: releases the address when it carries this project and stack', async () => {
    reservedIpsListing([{ address: '203.0.113.7', tags: tags('proj', 'prod-primary') }]);
    const results = makeResults();
    await sweep(linode(), results);
    expect(deleteUrls()).toEqual(['https://api.linode.com/v4/networking/reserved/ips/203.0.113.7']);
    expect(results.leaks.entries).toHaveLength(0);
  });

  it.each([
    ['another project', tags('other', 'prod-primary')],
    ['the other stack of this project', tags('proj', 'prod-standby')],
    ['no tags at all', []],
  ])('Linode: leaves an address that now carries %s alone, and reports it', async (_, ipTags) => {
    reservedIpsListing([{ address: '203.0.113.7', tags: ipTags }]);
    const results = makeResults();
    await sweep(linode(), results);
    expect(deleteUrls()).toEqual([]);
    expect(severities(results)).toEqual(['foreign:reserved-ip']);
    expect(results.leaks.counts().leak + results.leaks.counts().unverified).toBe(0);
  });

  it('Linode: an address no longer reserved on the account is already released', async () => {
    reservedIpsListing([{ address: '203.0.113.99', tags: tags('proj', 'prod-primary') }]);
    const results = makeResults();
    await sweep(linode(), results);
    expect(deleteUrls()).toEqual([]);
    expect(results.leaks.entries).toHaveLength(0);
  });

  it('Linode: an unreadable listing deletes nothing and is unverified', async () => {
    fetchWithRetryMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const results = makeResults();
    await sweep(linode(), results);
    expect(deleteUrls()).toEqual([]);
    expect(severities(results)).toEqual(['unverified:reserved-ip']);
  });

  it('DigitalOcean: reserved IPs carry no tags, so the address alone still releases it', async () => {
    const provider = new DigitalOceanProvider('token');
    vi.spyOn(provider, 'deleteFirewallByName').mockResolvedValue({ deleted: false });
    vi.spyOn(provider, 'deleteNetworkByName').mockResolvedValue({ deleted: false });
    const deleteReservedIpByAddress = vi
      .spyOn(provider, 'deleteReservedIpByAddress')
      .mockResolvedValue(true);
    const results = makeResults();
    await sweep(provider, results);
    expect(deleteReservedIpByAddress).toHaveBeenCalledExactlyOnceWith('203.0.113.7');
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(results.leaks.entries).toHaveLength(0);
  });
});

describe('reserved IP found by tag when no address was persisted', () => {
  const target = {
    stackEnv: 'prod',
    firewallName: 'proj-prod-firewall',
    sshKeyName: null,
    floatingIp: null,
    networkName: 'proj-prod-network',
  };
  it("deletes this cluster's tagged IP and no other environment or project", async () => {
    const provider = new LinodeProvider('token');
    vi.spyOn(provider, 'deleteFirewallByName').mockResolvedValue({ deleted: false });
    vi.spyOn(provider, 'deleteNetworkByName').mockResolvedValue({ deleted: false });
    fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return { ok: true, status: 204 };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          page: 1,
          pages: 1,
          data: [
            { address: '203.0.113.1', tags: tags('proj', 'prod') },
            { address: '203.0.113.2', tags: tags('proj', 'staging') },
            { address: '203.0.113.3', tags: tags('other', 'prod') },
            { address: '203.0.113.4', tags: [] },
          ],
        }),
      };
    });
    const results = makeResults();
    await sweepK8sBackstopTargets({
      provider,
      targets: [target],
      results,
      s: spinner(),
      projectName: 'proj',
    });
    const deletes = fetchWithRetryMock.mock.calls
      .filter(([, init]) => init?.method === 'DELETE')
      .map(([url]) => url as string);
    expect(deletes).toEqual(['https://api.linode.com/v4/networking/reserved/ips/203.0.113.1']);
    expect(results.leaks.entries).toHaveLength(0);
  });

  it('DigitalOcean has no by-label method, so a missing address is skipped as before', () => {
    expect(typeof new DigitalOceanProvider('token').deleteReservedIpsByLabels).toBe('undefined');
  });
});

describe('K8S_DESTROY_BACKSTOP census', () => {
  // Hetzner is the one k8s provider without the flag: its Pulumi destroy
  // removes its floating IP, firewall, network and key, and has never been
  // observed to leak them. Every other provider that offers k8s must opt in.
  it('every provider that supports k8s sets the flag, or is Hetzner', () => {
    for (const [id, Provider] of Object.entries(PROVIDERS) as Array<
      [string, { SUPPORTED_TIERS: string[]; K8S_DESTROY_BACKSTOP?: boolean }]
    >) {
      if (!Provider.SUPPORTED_TIERS.includes('k8s')) continue;
      if (id === 'hetzner') continue;
      expect(Provider.K8S_DESTROY_BACKSTOP, id).toBe(true);
    }
  });

  it('is set on DigitalOcean and Linode', () => {
    expect(PROVIDERS.digitalocean.K8S_DESTROY_BACKSTOP).toBe(true);
    expect(PROVIDERS.linode.K8S_DESTROY_BACKSTOP).toBe(true);
  });
});
