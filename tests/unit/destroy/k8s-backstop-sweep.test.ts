/**
 * The k8s destroy backstop on Linode, Vultr and Scaleway, plus the census that keeps a
 * new k8s provider from silently skipping it.
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
import {
  DigitalOceanProvider,
  encodeLabel as doLabel,
} from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { encodeLabel, LinodeProvider } from '../../../src/lib/providers/linode.js';
import {
  ScalewayProvider,
  encodeLabels as scalewayLabels,
} from '../../../src/lib/providers/scaleway.js';
import { reservedIpLabel, VultrProvider } from '../../../src/lib/providers/vultr.js';
import { k8sCensusProviders } from '../../_shared/k8s-built-ahead.js';

// A block body: an arrow that returns the mock would hand vitest a cleanup
// hook, and vitest would call the mock once more after every test.
beforeEach(() => {
  fetchWithRetryMock.mockReset();
});

const spinner = () => ({ start: vi.fn(), stop: vi.fn() });
/** The stack's project and environment, which go with every network name. */
const PROD = { project: 'proj', environment: 'prod' };
const makeResults = () => ({
  firewalls: [],
  sshKeys: [],
  leaks: createLeakLedger(),
  unreleasedReservedIps: [] as string[],
});
const tags = (project: string, environment: string) => [
  encodeLabel('project', project),
  encodeLabel('environment', environment),
];
/** GET /networking/reserved/ips answers with `data`; a DELETE succeeds. */
const reservedIpsListing = (
  data: Array<{
    address: string;
    tags: string[];
    linode_id?: number | null;
    assigned_entity?: { id: number; label?: string; type?: string } | null;
  }>,
) =>
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
      .mockResolvedValue({ released: true });
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
    expect(deleteNetworkByName).toHaveBeenCalledExactlyOnceWith('proj-prod-network', PROD);
    expect(results.leaks.entries).toHaveLength(0);
  });

  it('reports a leak when the reserved IP cannot be released', async () => {
    const provider = new LinodeProvider('token');
    vi.spyOn(provider, 'deleteFirewallByName').mockResolvedValue({ deleted: false });
    vi.spyOn(provider, 'deleteSSHKeyByName').mockResolvedValue(false);
    vi.spyOn(provider, 'deleteReservedIpByAddress').mockResolvedValue({
      released: false,
      held: true,
      region: null,
      reason: 'Linode refused the delete (HTTP 500)',
    });
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
          reservedIps: [{ address: '203.0.113.7', stacks: ['prod'] }],
          networkName: 'proj-prod-network',
        },
      ],
      results,
      s: spinner(),
      projectName: 'proj',
      environment: 'prod',
    });
    expect(
      results.leaks.entries.map(
        (e: { resourceClass: string; severity: string }) => `${e.severity}:${e.resourceClass}`,
      ),
    ).toEqual(['leak:reserved-ip']);
    expect(results.leaks.entries[0].reason).toContain('Linode refused the delete (HTTP 500)');
    // Still recorded, so the next destroy finds it again.
    expect(results.unreleasedReservedIps).toEqual(['203.0.113.7']);
  });
});

// Review focus 1, on Vultr: a deploy that failed partway, the reserved IP and
// VPC made and the master never ready, so there is no kubeconfig. Nothing goes
// through the cluster: the firewall group and SSH key by name, the reserved IP
// by address once its label says it is still this stack's, any IP labelled for
// the stack that no record names, and the VPC last, by name (Vultr refuses to
// delete a VPC an instance is still in).
describe('sweepK8sBackstopTargets on Vultr', () => {
  type VultrIp = { id: string; subnet: string; label: string; instance_id?: string };
  /** The label vultr-k8s.js gives the stack's reserved IP. */
  const label = (project: string, environment: string) =>
    reservedIpLabel({ project, environment }) as string;
  /** The ownership tags vultr-k8s.js gives the stack's instances. */
  const tags = (project: string, environment: string) => [
    `project:${project}`,
    `environment:${environment}`,
  ];
  /**
   * GET /reserved-ips answers with `ips`, GET /instances/{id} with the tags
   * in `instances` (404 for any other id); a DELETE succeeds.
   */
  const vultrReservedIps = (ips: VultrIp[], instances: Record<string, string[]> = {}) =>
    fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return { ok: true, status: 204 };
      const instance = /\/instances\/([^/?]+)$/.exec(url)?.[1];
      if (instance) {
        const found = instances[instance];
        return found
          ? {
              ok: true,
              status: 200,
              json: async () => ({ instance: { id: instance, tags: found } }),
            }
          : { ok: false, status: 404, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          reserved_ips: ips.map((ip) => ({ instance_id: '', region: 'ewr', ...ip })),
          meta: { links: { next: '' } },
        }),
      };
    });
  const vultr = () => {
    const provider = new VultrProvider('token');
    const byName = {
      firewall: vi
        .spyOn(provider, 'deleteFirewallByName')
        .mockResolvedValue({ deleted: true, everExisted: true, apiError: null }),
      sshKey: vi.spyOn(provider, 'deleteSSHKeyByName').mockResolvedValue(true),
      network: vi
        .spyOn(provider, 'deleteNetworkByName')
        .mockResolvedValue({ deleted: true, everExisted: true, apiError: null }),
    };
    return { provider, byName };
  };
  const sweepSingle = async (
    provider: VultrProvider,
    floatingIp?: string,
    { projectName = 'proj', stackEnv = 'prod' } = {},
  ) => {
    const results = makeResults();
    const targets = planK8sBackstopTargets({
      plan: { tier: 'k8s', stackEnvs: [stackEnv] },
      envConfig: { provider: 'vultr', region: 'ewr', ...(floatingIp ? { floatingIp } : {}) },
      projectConfig: { projectName },
    });
    await sweepK8sBackstopTargets({
      provider,
      targets,
      results,
      s: spinner(),
      projectName,
      environment: stackEnv,
    });
    return results;
  };

  it('deletes the firewall group, SSH key, reserved IP and VPC once each, the VPC last', async () => {
    const { provider, byName } = vultr();
    const byAddress = vi.spyOn(provider, 'deleteReservedIpByAddress');
    const byLabel = vi.spyOn(provider, 'deleteReservedIpsByLabels');
    vultrReservedIps([{ id: 'rip-7', subnet: '203.0.113.7', label: label('proj', 'prod') }]);

    const results = await sweepSingle(provider, '203.0.113.7');

    expect(byName.firewall).toHaveBeenCalledExactlyOnceWith('proj-prod-firewall');
    expect(byName.sshKey).toHaveBeenCalledExactlyOnceWith('proj-prod-ewr-key');
    expect(byAddress).toHaveBeenCalledExactlyOnceWith('203.0.113.7');
    expect(byName.network).toHaveBeenCalledExactlyOnceWith('proj-prod-network', PROD);
    // The label sweep leaves the recorded address to the address path.
    expect(byLabel).toHaveBeenCalledExactlyOnceWith(
      { project: 'proj', environment: 'prod' },
      { except: ['203.0.113.7'] },
    );
    expect(deleteUrls()).toEqual(['https://api.vultr.com/v2/reserved-ips/rip-7']);
    const vpcAt = byName.network.mock.invocationCallOrder[0];
    for (const spy of [byName.firewall, byName.sshKey, byAddress, byLabel]) {
      expect(spy.mock.invocationCallOrder[0]).toBeLessThan(vpcAt);
    }
    expect(results.leaks.entries).toHaveLength(0);
  });

  it('a reserved IP no record names is released by its label, and no other', async () => {
    const { provider } = vultr();
    vultrReservedIps([
      { id: 'rip-8', subnet: '203.0.113.8', label: label('proj', 'prod') },
      { id: 'rip-9', subnet: '203.0.113.9', label: label('proj', 'prod2') },
      { id: 'rip-10', subnet: '203.0.113.10', label: label('other', 'prod') },
    ]);
    const results = await sweepSingle(provider);
    expect(deleteUrls()).toEqual(['https://api.vultr.com/v2/reserved-ips/rip-8']);
    expect(results.leaks.entries).toHaveLength(0);
  });

  it('a recorded address now labelled for another stack is left alone, and reported', async () => {
    const { provider } = vultr();
    vultrReservedIps([
      { id: 'rip-7', subnet: '203.0.113.7', label: label('proj', 'prod-standby') },
    ]);
    const results = await sweepSingle(provider, '203.0.113.7');
    expect(deleteUrls()).toEqual([]);
    expect(results.leaks.entries.map((e: { severity: string }) => e.severity)).toEqual(['foreign']);
    expect(results.leaks.entries[0].reason).toContain(
      'it carries project:proj:environment:prod-standby',
    );
    expect(results.unreleasedReservedIps).toEqual([]);
  });

  it('a recorded address of ours still assigned to an instance is never released, and keeps the record', async () => {
    const { provider } = vultr();
    vultrReservedIps(
      [
        {
          id: 'rip-7',
          subnet: '203.0.113.7',
          label: label('proj', 'prod'),
          instance_id: 'inst-42',
        },
      ],
      { 'inst-42': tags('proj', 'prod') },
    );
    const results = await sweepSingle(provider, '203.0.113.7');
    expect(deleteUrls()).toEqual([]);
    expect(results.leaks.entries).toHaveLength(1);
    expect(results.leaks.entries[0]).toMatchObject({ severity: 'leak', resource: '203.0.113.7' });
    expect(results.leaks.entries[0].reason).toBe(
      'not released: it is still assigned to instance inst-42, which was not deleted',
    );
    expect(results.unreleasedReservedIps).toEqual(['203.0.113.7']);
  });

  it('k8s-ha: each side releases the IP labelled for its own stack', async () => {
    const { provider, byName } = vultr();
    vultrReservedIps([
      { id: 'rip-1', subnet: '203.0.113.1', label: label('proj', 'prod-primary') },
      { id: 'rip-2', subnet: '203.0.113.2', label: label('proj', 'prod-standby') },
    ]);
    const results = makeResults();
    await sweepK8sBackstopTargets({
      provider,
      targets: planK8sBackstopTargets({
        plan: { tier: 'k8s-ha', stackEnvs: ['prod-primary', 'prod-standby'] },
        envConfig: {
          provider: 'vultr',
          region: 'ewr',
          ha: {
            primary: { stack: 'prod-primary', floatingIp: '203.0.113.1', region: 'ewr' },
            standby: { stack: 'prod-standby', floatingIp: '203.0.113.2', region: 'ord' },
          },
        },
        projectConfig: { projectName: 'proj' },
      }),
      results,
      s: spinner(),
      projectName: 'proj',
      environment: 'prod',
    });
    expect(deleteUrls()).toEqual([
      'https://api.vultr.com/v2/reserved-ips/rip-1',
      'https://api.vultr.com/v2/reserved-ips/rip-2',
    ]);
    expect(byName.network.mock.calls).toEqual([
      ['proj-prod-primary-network', { project: 'proj', environment: 'prod-primary' }],
      ['proj-prod-standby-network', { project: 'proj', environment: 'prod-standby' }],
    ]);
    expect(results.leaks.entries).toHaveLength(0);
  });

  describe('stacks whose names join to the same string', () => {
    // Project proj's k8s-ha stack prod-primary and project proj-prod's
    // environment primary: `<cluster>-ingress` labelled both
    // `proj-prod-primary-ingress`, so either destroy could release the other's
    // unassigned IP (during a master replacement, or before the master
    // existed) and hold its own destroy on the other's assigned one.
    const HA = { projectName: 'proj', stackEnv: 'prod-primary' };
    const OTHER = { projectName: 'proj-prod', stackEnv: 'primary' };
    const IPS = [
      { id: 'rip-1', subnet: '203.0.113.1', label: label('proj', 'prod-primary') },
      { id: 'rip-2', subnet: '203.0.113.2', label: label('proj-prod', 'primary') },
    ];
    const HOLDERS = {
      'i-ha': tags('proj', 'prod-primary'),
      'i-other': tags('proj-prod', 'primary'),
    };
    const assigned = () => [
      { ...IPS[0], instance_id: 'i-ha' },
      { ...IPS[1], instance_id: 'i-other' },
    ];

    it.each([
      ['proj prod-primary', HA, 'rip-1'],
      ['proj-prod primary', OTHER, 'rip-2'],
    ])(
      'unassigned: the %s destroy releases its own IP and not the other',
      async (_, stack, own) => {
        const { provider } = vultr();
        vultrReservedIps(IPS);
        const results = await sweepSingle(provider, undefined, stack);
        expect(deleteUrls()).toEqual([`https://api.vultr.com/v2/reserved-ips/${own}`]);
        expect(results.leaks.entries).toHaveLength(0);
      },
    );

    it.each([
      ['proj prod-primary', HA, '203.0.113.1', 'i-ha'],
      ['proj-prod primary', OTHER, '203.0.113.2', 'i-other'],
    ])(
      'assigned: the %s destroy reports only its own IP held, and deletes nothing',
      async (_, stack, own, holder) => {
        const { provider } = vultr();
        vultrReservedIps(assigned(), HOLDERS);
        const results = await sweepSingle(provider, undefined, stack);
        expect(deleteUrls()).toEqual([]);
        expect(
          results.leaks.entries.map((e: { severity: string; resource: string }) => [
            e.severity,
            e.resource,
          ]),
        ).toEqual([['leak', own]]);
        expect(results.leaks.entries[0].reason).toContain(`assigned to instance ${holder}`);
        expect(results.unreleasedReservedIps).toEqual([own]);
      },
    );

    it("assigned: a saved address that is the other stack's IP is foreign, never held", async () => {
      const { provider } = vultr();
      vultrReservedIps(assigned(), HOLDERS);
      // proj-prod's record names proj's address (a reissue, or a bad record).
      const results = await sweepSingle(provider, '203.0.113.1', OTHER);
      expect(deleteUrls()).toEqual([]);
      const severities = results.leaks.entries.map((e: { severity: string; resource: string }) => [
        e.severity,
        e.resource,
      ]);
      expect(severities).toContainEqual(['foreign', '203.0.113.1']);
      expect(severities).not.toContainEqual(['leak', '203.0.113.1']);
      expect(results.unreleasedReservedIps).not.toContain('203.0.113.1');
    });
  });

  describe("an IP labelled ours, held by another stack's instance", () => {
    const ip = {
      id: 'rip-7',
      subnet: '203.0.113.7',
      label: label('proj', 'prod'),
      instance_id: 'i-9',
    };

    it('a recorded address is foreign, not held, and keeps no record', async () => {
      const { provider } = vultr();
      vultrReservedIps([ip], { 'i-9': tags('other', 'prod') });
      const results = await sweepSingle(provider, '203.0.113.7');
      expect(deleteUrls()).toEqual([]);
      expect(results.leaks.entries.map((e: { severity: string }) => e.severity)).toEqual([
        'foreign',
      ]);
      expect(results.leaks.entries[0].reason).toContain(
        'held by instance i-9, which is project other, environment prod',
      );
      expect(results.unreleasedReservedIps).toEqual([]);
    });

    it('an unrecorded one is left out of the label sweep: no delete, no entry', async () => {
      const { provider } = vultr();
      vultrReservedIps([ip], { 'i-9': tags('other', 'prod') });
      const results = await sweepSingle(provider);
      expect(deleteUrls()).toEqual([]);
      expect(results.leaks.entries).toHaveLength(0);
    });
  });
});

describe('sweepK8sBackstopTargets on Scaleway', () => {
  type ScalewayIp = {
    id: string;
    address: string;
    tags: string[];
    server?: { id: string; name: string } | null;
  };
  /** The tags scaleway-k8s.js gives a node's flexible IP and its server. */
  const tags = (project: string, environment: string, role = 'master') =>
    scalewayLabels({ project, environment, role });
  /**
   * GET /instance/v1/zones/fr-par-1/ips lists `ips` (every other zone none),
   * GET .../zones/fr-par-1/servers/{id} answers the tags in `servers` (404
   * for any other id or zone); a DELETE succeeds.
   */
  const scalewayIps = (ips: ScalewayIp[], servers: Record<string, string[]> = {}) =>
    fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return { ok: true, status: 204 };
      const path = new URL(url).pathname;
      const list = /^\/instance\/v1\/zones\/([^/]+)\/ips$/.exec(path);
      if (list) {
        const rows = list[1] === 'fr-par-1' ? ips.map((ip) => ({ server: null, ...ip })) : [];
        return { ok: true, status: 200, json: async () => ({ ips: rows }) };
      }
      const server = /^\/instance\/v1\/zones\/([^/]+)\/servers\/([^/]+)$/.exec(path);
      if (server) {
        const found = server[1] === 'fr-par-1' ? servers[server[2]] : undefined;
        return found
          ? {
              ok: true,
              status: 200,
              json: async () => ({ server: { id: server[2], tags: found } }),
            }
          : { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      }
      throw new Error(`unexpected GET ${url}`);
    });
  const scaleway = () => {
    const provider = new ScalewayProvider('token');
    const byName = {
      firewall: vi
        .spyOn(provider, 'deleteFirewallByName')
        .mockResolvedValue({ deleted: true, everExisted: true, apiError: null }),
      sshKey: vi.spyOn(provider, 'deleteSSHKeyByName').mockResolvedValue(true),
      network: vi
        .spyOn(provider, 'deleteNetworkByName')
        .mockResolvedValue({ deleted: true, everExisted: true, apiError: null }),
    };
    return { provider, byName };
  };
  const sweepSingle = async (provider: ScalewayProvider, floatingIp?: string) => {
    const results = makeResults();
    await sweepK8sBackstopTargets({
      provider,
      targets: planK8sBackstopTargets({
        plan: { tier: 'k8s', stackEnvs: ['prod'] },
        envConfig: {
          provider: 'scaleway',
          region: 'fr-par-1',
          ...(floatingIp ? { floatingIp } : {}),
        },
        projectConfig: { projectName: 'proj' },
      }),
      results,
      s: spinner(),
      projectName: 'proj',
      environment: 'prod',
    });
    return results;
  };
  const IP_7 = 'https://api.scaleway.com/instance/v1/zones/fr-par-1/ips/ip-7';

  it('asks for the security group, SSH key, flexible IP by address and network by name once each, the network last', async () => {
    const { provider, byName } = scaleway();
    const byAddress = vi.spyOn(provider, 'deleteReservedIpByAddress');
    const byLabel = vi.spyOn(provider, 'deleteReservedIpsByLabels');
    scalewayIps([{ id: 'ip-7', address: '203.0.113.7', tags: tags('proj', 'prod') }]);

    const results = await sweepSingle(provider, '203.0.113.7');

    expect(byName.firewall).toHaveBeenCalledExactlyOnceWith('proj-prod-firewall');
    expect(byName.sshKey).toHaveBeenCalledExactlyOnceWith('proj-prod-fr-par-1-key');
    expect(byAddress).toHaveBeenCalledExactlyOnceWith('203.0.113.7');
    expect(byName.network).toHaveBeenCalledExactlyOnceWith('proj-prod-network', PROD);
    // Both label sweeps leave the recorded address to the address path: the
    // program's IPs by project, then autoscaled workers' by cluster.
    expect(byLabel.mock.calls).toEqual([
      [{ project: 'proj', environment: 'prod' }, { except: ['203.0.113.7'] }],
      [{ cluster: 'proj-prod', environment: 'prod' }, { except: ['203.0.113.7'] }],
    ]);
    expect(deleteUrls()).toEqual([IP_7]);
    const networkAt = byName.network.mock.invocationCallOrder[0];
    for (const spy of [byName.firewall, byName.sshKey, byAddress, byLabel]) {
      expect(spy.mock.invocationCallOrder[0]).toBeLessThan(networkAt);
    }
    expect(results.leaks.entries).toHaveLength(0);
  });

  /**
   * The tags createServer gives an autoscaled worker's flexible IP and its
   * server: renderCarbonAutoscalerConfig's serverLabels, with no project.
   */
  const workerTags = (cluster: string, environment: string) =>
    scalewayLabels({
      'cluster-autoscaler/node': 'worker-pool',
      'managed-by': 'vibecarbon',
      environment,
      cluster,
    });
  const sweepHaPrimary = async (provider: ScalewayProvider) => {
    const results = makeResults();
    await sweepK8sBackstopTargets({
      provider,
      targets: planK8sBackstopTargets({
        plan: { tier: 'k8s-ha', stackEnvs: ['prod-primary'] },
        envConfig: { provider: 'scaleway', region: 'fr-par-1' },
        projectConfig: { projectName: 'proj' },
      }),
      results,
      s: spinner(),
      projectName: 'proj',
      environment: 'prod',
    });
    return results;
  };

  it("an autoscaled worker's flexible IP its delete did not release is released by its cluster and environment", async () => {
    const { provider } = scaleway();
    scalewayIps([
      { id: 'ip-8', address: '203.0.113.8', tags: workerTags('proj-prod', 'prod') },
      { id: 'ip-9', address: '203.0.113.9', tags: workerTags('proj-prod2', 'prod') },
      { id: 'ip-10', address: '203.0.113.10', tags: workerTags('proj-prod', 'staging') },
    ]);
    const results = await sweepSingle(provider);
    expect(deleteUrls()).toEqual(['https://api.scaleway.com/instance/v1/zones/fr-par-1/ips/ip-8']);
    expect(results.leaks.entries).toHaveLength(0);
  });

  // Project proj's k8s-ha side prod-primary and project proj-prod's
  // environment primary are both cluster proj-prod-primary; the environment
  // tag tells them apart.
  it('a worker IP with the same cluster name in another environment is left alone', async () => {
    const { provider } = scaleway();
    scalewayIps([
      { id: 'ip-1', address: '203.0.113.1', tags: workerTags('proj-prod-primary', 'prod-primary') },
      { id: 'ip-2', address: '203.0.113.2', tags: workerTags('proj-prod-primary', 'primary') },
    ]);
    const results = await sweepHaPrimary(provider);
    expect(deleteUrls()).toEqual(['https://api.scaleway.com/instance/v1/zones/fr-par-1/ips/ip-1']);
    expect(results.leaks.entries).toHaveLength(0);
  });

  it("a worker IP still attached follows the holder rule: held on our worker, left out on the other environment's", async () => {
    const { provider } = scaleway();
    scalewayIps(
      [
        {
          id: 'ip-1',
          address: '203.0.113.1',
          tags: workerTags('proj-prod-primary', 'prod-primary'),
          server: { id: 'srv-1', name: 'proj-prod-primary-ca-aaaa' },
        },
        {
          id: 'ip-2',
          address: '203.0.113.2',
          tags: workerTags('proj-prod-primary', 'prod-primary'),
          server: { id: 'srv-2', name: 'proj-prod-primary-ca-bbbb' },
        },
      ],
      {
        'srv-1': workerTags('proj-prod-primary', 'prod-primary'),
        'srv-2': workerTags('proj-prod-primary', 'primary'),
      },
    );
    const results = await sweepHaPrimary(provider);
    expect(deleteUrls()).toEqual([]);
    expect(results.leaks.entries).toHaveLength(1);
    expect(results.leaks.entries[0]).toMatchObject({ severity: 'leak', resource: '203.0.113.1' });
    expect(results.leaks.entries[0].reason).toContain(
      'labelled cluster proj-prod-primary, environment prod-primary not released: it is still ' +
        'attached to server proj-prod-primary-ca-aaaa, which was not deleted',
    );
    expect(results.unreleasedReservedIps).toEqual(['203.0.113.1']);
  });

  it('a flexible IP no record names is released by its tags, and no other', async () => {
    const { provider } = scaleway();
    scalewayIps([
      { id: 'ip-8', address: '203.0.113.8', tags: tags('proj', 'prod', 'worker') },
      { id: 'ip-9', address: '203.0.113.9', tags: tags('proj', 'prod2') },
      { id: 'ip-10', address: '203.0.113.10', tags: tags('other', 'prod') },
    ]);
    const results = await sweepSingle(provider);
    expect(deleteUrls()).toEqual(['https://api.scaleway.com/instance/v1/zones/fr-par-1/ips/ip-8']);
    expect(results.leaks.entries).toHaveLength(0);
  });

  it('a recorded address now tagged for another stack is left alone, and reported', async () => {
    const { provider } = scaleway();
    scalewayIps([{ id: 'ip-7', address: '203.0.113.7', tags: tags('proj', 'prod-standby') }]);
    const results = await sweepSingle(provider, '203.0.113.7');
    expect(deleteUrls()).toEqual([]);
    expect(results.leaks.entries.map((e: { severity: string }) => e.severity)).toEqual(['foreign']);
    expect(results.leaks.entries[0].reason).toContain('environment:prod-standby');
    expect(results.unreleasedReservedIps).toEqual([]);
  });

  it('a recorded address of ours still attached to its server is never released, and keeps the record', async () => {
    const { provider } = scaleway();
    scalewayIps(
      [
        {
          id: 'ip-7',
          address: '203.0.113.7',
          tags: tags('proj', 'prod'),
          server: { id: 'srv-1', name: 'proj-prod-master' },
        },
      ],
      { 'srv-1': tags('proj', 'prod') },
    );
    const results = await sweepSingle(provider, '203.0.113.7');
    expect(deleteUrls()).toEqual([]);
    expect(results.leaks.entries).toHaveLength(1);
    expect(results.leaks.entries[0]).toMatchObject({ severity: 'leak', resource: '203.0.113.7' });
    expect(results.leaks.entries[0].reason).toBe(
      'not released: it is still assigned to server proj-prod-master (srv-1), which was not deleted',
    );
    expect(results.unreleasedReservedIps).toEqual(['203.0.113.7']);
  });

  it("a network by our name carrying another stack's tags is reported foreign, and the exit code stays clean", async () => {
    const { provider, byName } = scaleway();
    const foreign =
      'left alone: Private Network pn-7 in fr-par carries project proj-prod, environment ' +
      'primary, not project proj, environment prod';
    byName.network.mockResolvedValue({
      deleted: false,
      everExisted: false,
      apiError: null,
      foreign,
    } as never);
    scalewayIps([]);
    const s = spinner();
    const results = makeResults();
    await sweepK8sBackstopTargets({
      provider,
      targets: planK8sBackstopTargets({
        plan: { tier: 'k8s', stackEnvs: ['prod'] },
        envConfig: { provider: 'scaleway', region: 'fr-par-1' },
        projectConfig: { projectName: 'proj' },
      }),
      results,
      s,
      projectName: 'proj',
      environment: 'prod',
    });
    expect(results.leaks.entries).toHaveLength(1);
    expect(results.leaks.entries[0]).toMatchObject({
      severity: 'foreign',
      resourceClass: 'network',
      resource: 'proj-prod-network',
      reason: foreign,
    });
    expect(results.leaks.exitCode()).toBe(0);
    expect(s.stop.mock.calls.map(([m]) => m)).not.toContain('VPC already gone (Pulumi)');
  });

  it("a recorded address tagged ours on another stack's server is foreign, never held or released", async () => {
    const { provider } = scaleway();
    scalewayIps(
      [
        {
          id: 'ip-7',
          address: '203.0.113.7',
          tags: tags('proj', 'prod'),
          server: { id: 'srv-9', name: 'other-prod-master' },
        },
      ],
      { 'srv-9': tags('other', 'prod') },
    );
    const results = await sweepSingle(provider, '203.0.113.7');
    expect(deleteUrls()).toEqual([]);
    expect(results.leaks.entries.map((e: { severity: string }) => e.severity)).toEqual(['foreign']);
    expect(results.leaks.entries[0].reason).toContain(
      'held by server other-prod-master (srv-9), which is project other, environment prod',
    );
    expect(results.unreleasedReservedIps).toEqual([]);
  });

  it("an unrecorded one tagged ours on another stack's server is left out of the label sweep: no delete, no entry", async () => {
    const { provider } = scaleway();
    scalewayIps(
      [
        {
          id: 'ip-7',
          address: '203.0.113.7',
          tags: tags('proj', 'prod'),
          server: { id: 'srv-9', name: 'other-prod-master' },
        },
      ],
      { 'srv-9': tags('other', 'prod') },
    );
    const results = await sweepSingle(provider);
    expect(deleteUrls()).toEqual([]);
    expect(results.leaks.entries).toHaveLength(0);
    expect(results.unreleasedReservedIps).toEqual([]);
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
    reservedIps: [{ address: '203.0.113.7', stacks: ['prod-primary'] }],
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
  const sweep = (
    provider: object,
    results: ReturnType<typeof makeResults>,
    args?: { purgeBackups?: boolean },
  ) =>
    sweepK8sBackstopTargets({
      provider,
      targets: [target],
      results,
      s: spinner(),
      projectName: 'proj',
      environment: 'prod',
      args,
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
    // Somebody else's address: nothing of ours to retry.
    expect(results.unreleasedReservedIps).toEqual([]);
  });

  // Tags say the address is ours; an assignment says something still holds
  // it. This runs after the teardown, so that something was not deleted, and
  // releasing the address would take it off a running server.
  it.each([
    ['a Linode', { linode_id: 4242 }, 'Linode 4242'],
    [
      'another entity',
      { linode_id: null, assigned_entity: { id: 31, label: 'edge-lb', type: 'nodebalancer' } },
      'nodebalancer edge-lb',
    ],
  ])(
    'Linode: an address of ours still assigned to %s is never released, and keeps the record',
    async (_, assignment, holder) => {
      reservedIpsListing([
        { address: '203.0.113.7', tags: tags('proj', 'prod-primary'), ...assignment },
      ]);
      const results = makeResults();
      await sweep(linode(), results);
      expect(deleteUrls()).toEqual([]);
      expect(severities(results)).toEqual(['leak:reserved-ip']);
      const [entry] = results.leaks.entries;
      expect(entry.reason).toBe(
        `not released: it is still assigned to ${holder}, which was not deleted`,
      );
      expect(entry.hint).toContain('Run `vibecarbon destroy prod` again');
      expect(results.unreleasedReservedIps).toEqual(['203.0.113.7']);
    },
  );

  it('Linode: the retry line of an address it keeps names the -purge rerun after a -purge destroy', async () => {
    reservedIpsListing([
      { address: '203.0.113.7', tags: tags('proj', 'prod-primary'), linode_id: 4242 },
    ]);
    const results = makeResults();
    await sweep(linode(), results, { purgeBackups: true });
    expect(results.leaks.entries[0].hint).toContain('Run `vibecarbon destroy prod -purge` again');
  });

  it('Linode: an address no longer reserved on the account is already released', async () => {
    // The account holds another project's address only.
    reservedIpsListing([{ address: '203.0.113.99', tags: tags('other', 'prod-primary') }]);
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
    // Once for the recorded address, once for the label sweep beside it.
    expect(severities(results)).toEqual(['unverified:reserved-ip', 'unverified:reserved-ip']);
    // Not proven released: the record stays for the next destroy.
    expect(results.unreleasedReservedIps).toEqual(['203.0.113.7']);
  });

  it('DigitalOcean: reserved IPs carry no tags, so an unassigned address is still ours and released', async () => {
    const provider = new DigitalOceanProvider('token');
    vi.spyOn(provider, 'deleteFirewallByName').mockResolvedValue({ deleted: false });
    vi.spyOn(provider, 'deleteNetworkByName').mockResolvedValue({ deleted: false });
    const deleteReservedIpByAddress = vi
      .spyOn(provider, 'deleteReservedIpByAddress')
      .mockResolvedValue({ released: true });
    fetchWithRetryMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ reserved_ip: { ip: '203.0.113.7', droplet: null } }),
    });
    const results = makeResults();
    await sweep(provider, results);
    expect(deleteReservedIpByAddress).toHaveBeenCalledExactlyOnceWith('203.0.113.7');
    // The one read: where the address is assigned.
    expect(fetchWithRetryMock).toHaveBeenCalledOnce();
    expect(results.leaks.entries).toHaveLength(0);
  });
});

// DigitalOcean has answered a DELETE with success and kept the address, and a
// 404 alone has proved nothing (its SSH key API, 2026-11-06). The reserved IP
// is released only when the read by address answers 404; anything else is
// reported, and the environment's record stays so the next destroy retries.
describe('DigitalOcean: the backstop reads the reserved IP back before it reports it released', () => {
  const IP = '203.0.113.7';
  const IP_URL = `https://api.digitalocean.com/v2/reserved_ips/${IP}`;
  const target = {
    stackEnv: 'prod',
    firewallName: 'proj-prod-firewall',
    sshKeyName: null,
    reservedIps: [{ address: IP, stacks: ['prod'] }],
    networkName: 'proj-prod-network',
  };
  type Read = number | 'listed' | Error | { droplet: { id: number; name: string; tags: string[] } };
  const answer = (read: Read) => {
    if (read instanceof Error) throw read;
    if (read === 'listed' || typeof read === 'object') {
      const droplet = typeof read === 'object' ? read.droplet : null;
      return {
        ok: true,
        status: 200,
        json: async () => ({ reserved_ip: { ip: IP, region: { slug: 'nyc3' }, droplet } }),
      };
    }
    return { ok: read < 300, status: read, json: async () => ({}) };
  };
  /**
   * The read before the delete answers `before` (where the address is
   * assigned; unassigned by default), the DELETE answers `del` (or throws
   * it), and the read by address after it answers `read`.
   */
  const api = (del: number | Error, read: Read, before: Read = 'listed') => {
    let gets = 0;
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') {
        if (del instanceof Error) throw del;
        return { ok: del < 300, status: del, json: async () => ({}) };
      }
      gets += 1;
      return answer(gets === 1 ? before : read);
    });
  };
  const sweep = async () => {
    const provider = new DigitalOceanProvider('token');
    vi.spyOn(provider, 'deleteFirewallByName').mockResolvedValue({ deleted: false });
    vi.spyOn(provider, 'deleteNetworkByName').mockResolvedValue({ deleted: false });
    const results = makeResults();
    const s = spinner();
    await sweepK8sBackstopTargets({
      provider,
      targets: [target],
      results,
      s,
      projectName: 'proj',
      environment: 'prod',
    });
    return { results, s };
  };
  const stops = (s: ReturnType<typeof spinner>) => s.stop.mock.calls.map(([line]) => line);
  const calls = () =>
    fetchWithRetryMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
  const doTags = (project: string, environment: string) => [
    doLabel('project', project),
    doLabel('environment', environment),
    doLabel('role', 'master'),
  ];

  it('DELETE accepted and the read answers 404: released, nothing reported or kept', async () => {
    api(204, 404);
    const { results, s } = await sweep();
    expect(calls()).toEqual([`GET ${IP_URL}`, `DELETE ${IP_URL}`, `GET ${IP_URL}`]);
    expect(results.leaks.entries).toHaveLength(0);
    expect(results.unreleasedReservedIps).toEqual([]);
    expect(stops(s)).toContain('Reserved IP released (backstop)');
  });

  it('DELETE accepted but DigitalOcean still lists it: a leak naming the address, region and bill, and the record kept', async () => {
    api(204, 'listed');
    const { results, s } = await sweep();
    expect(stops(s)).not.toContain('Reserved IP released (backstop)');
    expect(results.leaks.entries).toHaveLength(1);
    const [entry] = results.leaks.entries;
    expect(entry).toMatchObject({
      severity: 'leak',
      resourceClass: 'reserved-ip',
      resource: `${IP} (nyc3)`,
    });
    expect(entry.reason).toContain('DigitalOcean still lists it after the delete');
    expect(entry.reason).toContain('keeps billing on your DigitalOcean account');
    expect(entry.hint).toContain('Run `vibecarbon destroy prod` again');
    expect(entry.hint).toContain('stays in .vibecarbon.json');
    expect(`${entry.reason} ${entry.hint}`).not.toContain('—');
    expect(results.unreleasedReservedIps).toEqual([IP]);
  });

  it('a read that fails proves nothing: unverified, and the record kept', async () => {
    api(204, 503);
    const { results } = await sweep();
    expect(results.leaks.entries).toHaveLength(1);
    const [entry] = results.leaks.entries;
    expect(entry).toMatchObject({ severity: 'unverified', resourceClass: 'reserved-ip' });
    expect(entry.reason).toContain('the read-back after the delete failed (HTTP 503)');
    expect(entry.reason).toContain('cannot tell whether DigitalOcean released it');
    expect(results.unreleasedReservedIps).toEqual([IP]);
  });

  it('a DELETE that throws: unverified, and the record kept', async () => {
    api(new Error('socket hang up'), 404);
    const { results } = await sweep();
    expect(results.leaks.entries.map((e: { severity: string }) => e.severity)).toEqual([
      'unverified',
    ]);
    expect(results.leaks.entries[0].reason).toContain('socket hang up');
    expect(results.unreleasedReservedIps).toEqual([IP]);
  });

  it('an address DigitalOcean no longer has is already released: nothing deleted or kept', async () => {
    api(204, 404, 404);
    const { results, s } = await sweep();
    expect(calls()).toEqual([`GET ${IP_URL}`]);
    expect(stops(s)).toContain('Reserved IP already released');
    expect(results.leaks.entries).toHaveLength(0);
    expect(results.unreleasedReservedIps).toEqual([]);
  });

  // By now this cluster's droplets are deleted, so a droplet holding the
  // address got it after the release: never delete it out from under it.
  it("assigned to a droplet that is not this cluster's: left alone, never deleted, and reported as someone else's", async () => {
    api(204, 404, { droplet: { id: 4242, name: 'shop-web-1', tags: doTags('shop', 'prod') } });
    const { results, s } = await sweep();
    expect(calls()).toEqual([`GET ${IP_URL}`]);
    expect(results.leaks.entries).toHaveLength(1);
    const [entry] = results.leaks.entries;
    expect(entry).toMatchObject({
      severity: 'foreign',
      resourceClass: 'reserved-ip',
      resource: IP,
    });
    expect(entry.reason).toContain('assigned to droplet shop-web-1 (4242)');
    expect(entry.reason).toContain('likely reissued');
    expect(stops(s)).toContain(
      `Reserved IP ${IP} left alone: it is assigned to droplet shop-web-1 (4242)`,
    );
    // Somebody else's address: nothing of ours to retry.
    expect(results.unreleasedReservedIps).toEqual([]);
  });

  it("still assigned to this cluster's own droplet: never deleted, a leak, and the record kept", async () => {
    api(204, 404, {
      droplet: { id: 77, name: 'proj-prod-master', tags: doTags('proj', 'prod') },
    });
    const { results } = await sweep();
    expect(calls()).toEqual([`GET ${IP_URL}`]);
    expect(results.leaks.entries).toHaveLength(1);
    const [entry] = results.leaks.entries;
    expect(entry).toMatchObject({ severity: 'leak', resourceClass: 'reserved-ip', resource: IP });
    expect(entry.reason).toContain("this cluster's droplet proj-prod-master (77)");
    expect(entry.hint).toContain('Run `vibecarbon destroy prod` again');
    expect(results.unreleasedReservedIps).toEqual([IP]);
  });

  it('the read before the delete fails: nothing deleted, unverified, and the record kept', async () => {
    api(204, 404, 500);
    const { results } = await sweep();
    expect(calls()).toEqual([`GET ${IP_URL}`]);
    expect(results.leaks.entries.map((e: { severity: string }) => e.severity)).toEqual([
      'unverified',
    ]);
    expect(results.leaks.entries[0].reason).toContain('HTTP 500');
    expect(results.unreleasedReservedIps).toEqual([IP]);
  });
});

// The results object is built in main(); a caller that builds its own (a
// test, a future tier) may not carry the list. Every branch that keeps the
// record keeps it all the same.
describe('the backstop keeps the record on a results object without the list', () => {
  const unassigned = { reserved_ip: { ip: '203.0.113.7', droplet: null } };
  const heldByOurs = {
    reserved_ip: {
      ip: '203.0.113.7',
      droplet: {
        id: 77,
        name: 'proj-prod-master',
        tags: [doLabel('project', 'proj'), doLabel('environment', 'prod')],
      },
    },
  };
  type Read = { ok: boolean; status: number; body?: unknown };
  const cases: Array<{ name: string; reads: Read[] }> = [
    { name: 'the read before the delete fails', reads: [{ ok: false, status: 500 }] },
    {
      name: 'the read after the delete fails',
      reads: [
        { ok: true, status: 200, body: unassigned },
        { ok: false, status: 503 },
      ],
    },
    {
      name: "this cluster's droplet still holds it",
      reads: [{ ok: true, status: 200, body: heldByOurs }],
    },
  ];
  it.each(cases)('$name', async ({ reads }) => {
    const queue = [...reads];
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return { ok: true, status: 204 };
      const next = queue.shift() as Read;
      if (!next) throw new Error(`unexpected read: ${_url}`);
      return { ok: next.ok, status: next.status, json: async () => next.body ?? {} };
    });
    const provider = new DigitalOceanProvider('token');
    vi.spyOn(provider, 'deleteFirewallByName').mockResolvedValue({ deleted: false });
    vi.spyOn(provider, 'deleteNetworkByName').mockResolvedValue({ deleted: false });
    const results: Record<string, unknown> = {
      firewalls: [],
      sshKeys: [],
      leaks: createLeakLedger(),
    };
    await sweepK8sBackstopTargets({
      provider,
      targets: [
        {
          stackEnv: 'prod',
          firewallName: 'proj-prod-firewall',
          sshKeyName: null,
          reservedIps: [{ address: '203.0.113.7', stacks: ['prod'] }],
          networkName: 'proj-prod-network',
        },
      ],
      results,
      s: spinner(),
      projectName: 'proj',
      environment: 'prod',
    });
    expect(results.unreleasedReservedIps).toEqual(['203.0.113.7']);
  });
});

describe('reserved IP found by tag when no address was persisted', () => {
  const target = {
    stackEnv: 'prod',
    firewallName: 'proj-prod-firewall',
    sshKeyName: null,
    reservedIps: [],
    networkName: 'proj-prod-network',
  };
  it("deletes this cluster's tagged IP and no other environment or project", async () => {
    const provider = new LinodeProvider('token');
    vi.spyOn(provider, 'deleteFirewallByName').mockResolvedValue({ deleted: false });
    vi.spyOn(provider, 'deleteNetworkByName').mockResolvedValue({ deleted: false });
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
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

// A deploy killed while Pulumi was creating the reserved IP leaves it out of
// the stack's state (the pre-destroy refresh drops a pending create) and out
// of the record. The label sweep finds it by the program's labels, beside any
// recorded address, and never touches another environment's or project's.
describe('the label sweep runs beside a recorded address', () => {
  const target = {
    stackEnv: 'prod',
    firewallName: 'proj-prod-firewall',
    sshKeyName: null,
    reservedIps: [{ address: '203.0.113.7', stacks: ['prod'] }],
    networkName: 'proj-prod-network',
  };
  const linode = () => {
    const provider = new LinodeProvider('token');
    vi.spyOn(provider, 'deleteFirewallByName').mockResolvedValue({ deleted: false });
    vi.spyOn(provider, 'deleteNetworkByName').mockResolvedValue({ deleted: false });
    return provider;
  };

  it('releases an unrecorded IP labelled for this stack, the recorded one once, and no other', async () => {
    reservedIpsListing([
      { address: '203.0.113.7', tags: tags('proj', 'prod') },
      { address: '203.0.113.8', tags: tags('proj', 'prod') },
      { address: '203.0.113.9', tags: tags('proj', 'staging') },
      { address: '203.0.113.10', tags: tags('other', 'prod') },
    ]);
    const results = makeResults();
    await sweepK8sBackstopTargets({
      provider: linode(),
      targets: [target],
      results,
      s: spinner(),
      projectName: 'proj',
      environment: 'prod',
    });
    expect(deleteUrls()).toEqual([
      'https://api.linode.com/v4/networking/reserved/ips/203.0.113.7',
      'https://api.linode.com/v4/networking/reserved/ips/203.0.113.8',
    ]);
    expect(results.leaks.entries).toHaveLength(0);
  });

  it('one found by label that is not released stays on record, so the next destroy retries it', async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return { ok: false, status: 403, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          page: 1,
          pages: 1,
          data: [{ address: '203.0.113.8', tags: tags('proj', 'prod') }],
        }),
      };
    });
    const results = makeResults();
    await sweepK8sBackstopTargets({
      provider: linode(),
      targets: [{ ...target, reservedIps: [] }],
      results,
      s: spinner(),
      projectName: 'proj',
      environment: 'prod',
    });
    expect(results.leaks.entries).toHaveLength(1);
    const [entry] = results.leaks.entries;
    expect(entry).toMatchObject({ severity: 'leak', resourceClass: 'reserved-ip' });
    expect(entry.resource).toBe('203.0.113.8');
    expect(entry.reason).toContain('Linode refused the delete (HTTP 403)');
    expect(entry.hint).toContain('Run `vibecarbon destroy prod` again');
    expect(`${entry.reason} ${entry.hint}`).not.toContain('—');
    expect(results.unreleasedReservedIps).toEqual(['203.0.113.8']);
  });
});

// The backstop reads k8s-ha's environment-level address as either side's
// (planK8sBackstopTargets): its owner check accepts either side's tags.
describe('an environment-level address on k8s-ha belongs to either side', () => {
  const IP = '203.0.113.30';
  const target = {
    stackEnv: 'prod-primary',
    firewallName: 'proj-prod-primary-firewall',
    sshKeyName: null,
    reservedIps: [{ address: IP, stacks: ['prod-primary', 'prod-standby'] }],
    networkName: 'proj-prod-primary-network',
  };
  const sweepWith = async (provider: object) => {
    const results = makeResults();
    await sweepK8sBackstopTargets({
      provider,
      targets: [target, { ...target, stackEnv: 'prod-standby', reservedIps: [] }],
      results,
      s: spinner(),
      projectName: 'proj',
      environment: 'prod',
    });
    return results;
  };

  it("Linode: tagged for the standby, it is this environment's and released", async () => {
    const provider = new LinodeProvider('token');
    vi.spyOn(provider, 'deleteFirewallByName').mockResolvedValue({ deleted: false });
    vi.spyOn(provider, 'deleteNetworkByName').mockResolvedValue({ deleted: false });
    reservedIpsListing([{ address: IP, tags: tags('proj', 'prod-standby') }]);
    const results = await sweepWith(provider);
    // Released once: the standby's label sweep leaves the recorded address to the address path.
    expect(deleteUrls()).toEqual([`https://api.linode.com/v4/networking/reserved/ips/${IP}`]);
    expect(results.leaks.entries).toHaveLength(0);
  });

  it("DigitalOcean: held by the standby's droplet, it is this cluster's, never someone else's", async () => {
    const provider = new DigitalOceanProvider('token');
    vi.spyOn(provider, 'deleteFirewallByName').mockResolvedValue({ deleted: false });
    vi.spyOn(provider, 'deleteNetworkByName').mockResolvedValue({ deleted: false });
    fetchWithRetryMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        reserved_ip: {
          ip: IP,
          droplet: {
            id: 77,
            name: 'proj-prod-standby-master',
            tags: [doLabel('project', 'proj'), doLabel('environment', 'prod-standby')],
          },
        },
      }),
    });
    const results = await sweepWith(provider);
    expect(deleteUrls()).toEqual([]);
    expect(
      results.leaks.entries.map((e: { severity: string }) => e.severity),
      'held by our own droplet, not reissued',
    ).toEqual(['leak']);
    expect(results.unreleasedReservedIps).toEqual([IP]);
  });

  it('DigitalOcean: unassigned, it is released once across both sides', async () => {
    const provider = new DigitalOceanProvider('token');
    vi.spyOn(provider, 'deleteFirewallByName').mockResolvedValue({ deleted: false });
    vi.spyOn(provider, 'deleteNetworkByName').mockResolvedValue({ deleted: false });
    let gets = 0;
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) };
      gets += 1;
      return gets === 1
        ? { ok: true, status: 200, json: async () => ({ reserved_ip: { ip: IP, droplet: null } }) }
        : { ok: false, status: 404, json: async () => ({}) };
    });
    const targets = planK8sBackstopTargets({
      plan: { tier: 'k8s-ha', stackEnvs: ['prod-primary', 'prod-standby'] },
      envConfig: {
        floatingIp: IP,
        ha: { primary: { stack: 'prod-primary' }, standby: { stack: 'prod-standby' } },
      },
      projectConfig: { projectName: 'proj' },
    });
    const results = makeResults();
    await sweepK8sBackstopTargets({
      provider,
      targets,
      results,
      s: spinner(),
      projectName: 'proj',
      environment: 'prod',
    });
    expect(deleteUrls()).toEqual([`https://api.digitalocean.com/v2/reserved_ips/${IP}`]);
    expect(results.leaks.entries).toHaveLength(0);
  });
});

// Hetzner's k8s program labels its Floating IP with the project and the
// stack's environment. Its Pulumi destroy removes the IP, firewall, network
// and key, so the name sweeps stay off (K8S_DESTROY_BACKSTOP), but a Floating
// IP a killed deploy never recorded is found by its labels all the same.
describe('Hetzner: the label sweep alone', () => {
  const target = {
    stackEnv: 'prod',
    firewallName: 'proj-prod-firewall',
    sshKeyName: 'proj-prod-nbg1-key',
    reservedIps: [{ address: '203.0.113.7', stacks: ['prod'] }],
    networkName: 'proj-prod-network',
  };
  const floatingIps = (
    items: Array<{ id: number; ip: string; labels: Record<string, string>; server?: number }>,
  ) =>
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          floating_ips: items.map((i) => ({ server: null, ...i })),
          meta: { pagination: { next_page: null } },
        }),
      };
    });

  it("releases this stack's labelled Floating IP, recorded or not, and no other; no name sweeps", async () => {
    const provider = new HetznerProvider('token');
    const byName = [
      vi.spyOn(provider, 'deleteFirewallByName'),
      vi.spyOn(provider, 'deleteSSHKeyByName'),
    ];
    floatingIps([
      { id: 7, ip: '203.0.113.7', labels: { project: 'proj', environment: 'prod' } },
      { id: 8, ip: '203.0.113.8', labels: { project: 'proj', environment: 'staging' } },
      { id: 9, ip: '203.0.113.9', labels: { project: 'other', environment: 'prod' } },
    ]);
    const results = makeResults();
    await sweepK8sBackstopTargets({
      provider,
      targets: [target],
      results,
      s: spinner(),
      projectName: 'proj',
      environment: 'prod',
    });
    expect(deleteUrls()).toEqual(['https://api.hetzner.cloud/v1/floating_ips/7']);
    for (const spy of byName) expect(spy).not.toHaveBeenCalled();
    expect(results.leaks.entries).toHaveLength(0);
  });

  it('one still assigned to a server is left alone, reported, and kept on record', async () => {
    floatingIps([
      { id: 7, ip: '203.0.113.7', labels: { project: 'proj', environment: 'prod' }, server: 42 },
    ]);
    const results = makeResults();
    await sweepK8sBackstopTargets({
      provider: new HetznerProvider('token'),
      targets: [target],
      results,
      s: spinner(),
      projectName: 'proj',
      environment: 'prod',
    });
    expect(deleteUrls()).toEqual([]);
    expect(results.leaks.entries).toHaveLength(1);
    expect(results.leaks.entries[0]).toMatchObject({ severity: 'leak', resource: '203.0.113.7' });
    expect(results.leaks.entries[0].reason).toContain('still assigned to server 42');
    expect(results.unreleasedReservedIps).toEqual(['203.0.113.7']);
  });
});

describe('K8S_DESTROY_BACKSTOP census', () => {
  // Hetzner is the one k8s provider without the flag: its Pulumi destroy
  // removes its floating IP, firewall, network and key, and has never been
  // observed to leak them. Every other provider that offers k8s, or has its
  // k8s code built ahead of the tier, must opt in.
  it('every provider that supports k8s sets the flag, or is Hetzner', () => {
    const providers = k8sCensusProviders('destroy') as unknown as Array<
      [string, { K8S_DESTROY_BACKSTOP?: boolean }]
    >;
    expect(providers.map(([id]) => id)).toContain('vultr');
    expect(providers.map(([id]) => id)).toContain('scaleway');
    for (const [id, Provider] of providers) {
      if (id === 'hetzner') continue;
      expect(Provider.K8S_DESTROY_BACKSTOP, id).toBe(true);
    }
  });

  it("K8S_AUTOSCALED_WORKER_IPS is Scaleway's alone: no other createServer reserves a worker an IP", () => {
    const flagged = Object.entries(PROVIDERS)
      .filter(([, P]) => (P as { K8S_AUTOSCALED_WORKER_IPS?: boolean }).K8S_AUTOSCALED_WORKER_IPS)
      .map(([id]) => id);
    expect(flagged).toEqual(['scaleway']);
  });

  it('is set on DigitalOcean, Linode, Vultr and Scaleway', () => {
    expect(PROVIDERS.digitalocean.K8S_DESTROY_BACKSTOP).toBe(true);
    expect(PROVIDERS.linode.K8S_DESTROY_BACKSTOP).toBe(true);
    expect((PROVIDERS.vultr as { K8S_DESTROY_BACKSTOP?: boolean }).K8S_DESTROY_BACKSTOP).toBe(true);
    expect((PROVIDERS.scaleway as { K8S_DESTROY_BACKSTOP?: boolean }).K8S_DESTROY_BACKSTOP).toBe(
      true,
    );
  });
});
