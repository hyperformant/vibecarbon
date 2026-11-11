/**
 * buildLinodeK8sProgram: program-shape tests through Pulumi mocks, same
 * harness as digitalocean-k8s.test.ts.
 */
import * as pulumi from '@pulumi/pulumi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { unsealMockInput } from '../../_shared/pulumi-secrets.js';

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { planK8sBackstopTargets } from '../../../src/destroy.js';
import { renderCarbonAutoscalerConfig } from '../../../src/lib/deploy/k8s/k3s.js';
import { buildLinodeK8sProgram } from '../../../src/lib/iac/programs/linode-k8s.js';
import {
  encodeLabel,
  LinodeProvider,
  rewriteOperatorRules,
  squeezeLinodeLabel,
} from '../../../src/lib/providers/linode.js';

type Captured = {
  type: string;
  name: string;
  inputs: Record<string, any>;
};
const captured: Captured[] = [];
let instanceCounter = 0;

pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs) {
      captured.push({
        type: args.type,
        name: args.name,
        inputs: args.inputs,
      });
      switch (args.type) {
        case 'linode:index/instance:Instance': {
          instanceCounter += 1;
          return {
            id: String(5_000_000 + instanceCounter),
            state: { ...args.inputs, ipAddress: `198.51.100.${instanceCounter}` },
          };
        }
        case 'linode:index/vpc:Vpc':
          return { id: '1234', state: { ...args.inputs } };
        case 'linode:index/vpcSubnet:VpcSubnet':
          return { id: '5678', state: { ...args.inputs } };
        case 'linode:index/reservedIp:ReservedIp':
          return { id: '203.0.113.250', state: { ...args.inputs, address: '203.0.113.250' } };
        case 'linode:index/sshKey:SshKey':
          return { id: '999888', state: { ...args.inputs } };
        case 'linode:index/firewall:Firewall':
          return { id: '4242', state: { ...args.inputs } };
        default:
          return { id: `${args.name}-mock-id`, state: args.inputs };
      }
    },
    call(args: pulumi.runtime.MockCallArgs) {
      return args.inputs;
    },
  },
  'vibecarbon',
  'test',
);

const baseConfig = {
  projectName: 'acme',
  environment: 'prod',
  sshPublicKey: 'ssh-ed25519 AAAAtest test@example.com\n',
  location: 'us-east',
  masterServerType: 'g6-standard-2',
  dbServerType: 'g6-standard-2',
  workerServerType: 'g6-standard-2',
  minWorkers: 2,
  k3sVersion: 'v1.37.2+k3s1',
  // Programs no longer read it: the census
  // (tests/unit/deploy/k8s-user-data-secret-census.test.ts) passes it to
  // prove no resource gets it.
  apiToken: 'linode_test_token_1234',
  allowedSshIps: ['203.0.113.5/32', '2001:db8::1/128'],
  allowedK8sApiIps: ['203.0.113.6/32'],
  labels: { 'managed-by': 'vibecarbon' },
  // The CLI always passes one (lib/iac/k3s-token.js). Sentinel only.
  k3sToken: 'SENTINEL-k3s-token',
};
const CLUSTER = 'acme-prod';

async function waitFor(min: number, timeoutMs = 3000) {
  const start = Date.now();
  while (captured.length < min) {
    if (Date.now() - start > timeoutMs) throw new Error(`got ${captured.length} of ${min}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const byType = (list: Captured[], t: string) => list.filter((r) => r.type === t);
const INSTANCE = 'linode:index/instance:Instance';

describe('buildLinodeK8sProgram config guard', () => {
  it('requires both operator CIDR lists', () => {
    expect(() => buildLinodeK8sProgram({ ...baseConfig, allowedSshIps: [] })).toThrow(
      /allowedSshIps required/,
    );
    expect(() => buildLinodeK8sProgram({ ...baseConfig, allowedK8sApiIps: [] })).toThrow(
      /allowedK8sApiIps required/,
    );
  });

  // Linode caps VPC, VPC subnet and SSH key labels at 64 (API spec). They go
  // out unsqueezed so every lookup can use the plain name, so a name past
  // the cap must stop the deploy here, before anything exists.
  it('refuses a cluster whose network label passes 64 characters, naming the fix', () => {
    const projectName = `p${'x'.repeat(44)}`; // 45 + '-' + 'prod-primary' = 58; '-network' = 66
    const build = () =>
      buildLinodeK8sProgram({
        ...baseConfig,
        projectName,
        environment: 'prod-primary',
        existingSshKeyId: '424242',
      });
    expect(build).toThrow(`${projectName}-prod-primary-network`);
    expect(build).toThrow(/66 characters/);
    expect(build).toThrow(/Linode allows 64/);
    expect(build).toThrow(/shorter project or environment name/);
  });

  it('refuses a cluster whose own SSH key label passes 64 characters', () => {
    // A 50-character cluster (45 + '-prod'): key `<cluster>-jp-tyo-3-key` is 63, fits.
    expect(() =>
      buildLinodeK8sProgram({
        ...baseConfig,
        projectName: `p${'x'.repeat(44)}`,
        location: 'jp-tyo-3',
      }),
    ).not.toThrow();
    // Two more characters: the key is 65, while the network label (60) still fits.
    const build = () =>
      buildLinodeK8sProgram({
        ...baseConfig,
        projectName: `p${'x'.repeat(46)}`,
        location: 'jp-tyo-3',
      });
    expect(build).toThrow(/-jp-tyo-3-key/);
    expect(build).toThrow(/65 characters/);
  });

  // Each node takes its Linode label as hostname and so as its k8s node name,
  // which Kubernetes caps at 63. The longest is an autoscaler worker,
  // `<cluster>-ca-` plus 8 characters.
  it('refuses a cluster whose autoscaler node names would pass 63 characters', () => {
    const fits = { ...baseConfig, environment: 'prod', existingSshKeyId: '424242' };
    // 46 + '-prod' = a 51-character cluster: its autoscaler nodes are 63.
    expect(() =>
      buildLinodeK8sProgram({ ...fits, projectName: `p${'x'.repeat(45)}` }),
    ).not.toThrow();
    const build = () => buildLinodeK8sProgram({ ...fits, projectName: `p${'x'.repeat(46)}` });
    expect(build).toThrow(/node name/);
    expect(build).toThrow(/64 characters/);
    expect(build).toThrow(/allows 63/);
    expect(build).toThrow(/shorter project or environment name/);
  });

  it('builds the longest e2e names with room to spare', () => {
    expect(() =>
      buildLinodeK8sProgram({
        ...baseConfig,
        projectName: 'citest-k8s-ha-1787258789210-0typg2',
        environment: 'cil4-standby',
        existingSshKeyId: '424242',
      }),
    ).not.toThrow();
    expect(() =>
      buildLinodeK8sProgram({
        ...baseConfig,
        projectName: 'citest-k8s-1787258789210-0typg2',
        environment: 'cil3',
        location: 'jp-tyo-3',
      }),
    ).not.toThrow();
  });
});

describe('buildLinodeK8sProgram resource graph', () => {
  let outputs: Record<string, any>;

  beforeAll(async () => {
    const raw = await buildLinodeK8sProgram(baseConfig)();
    // sshKey, vpc, subnet, firewall, reservedIp, master, db, 2 workers
    await waitFor(9);
    outputs = (await pulumi.output(raw).promise()) as Record<string, any>;
  });

  it('exports the same output names as the DigitalOcean program', () => {
    expect(Object.keys(outputs).sort()).toEqual(
      [
        'masterIp',
        // Read back by a scale or failover (converge-cluster.js priorMasterFrom).
        'masterId',
        'masterPrivateIp',
        'dbIp',
        'dbPrivateIp',
        'workerIps',
        'floatingIp',
        'networkId',
        'sshKeyId',
        'k3sToken',
        'clusterName',
        'vpcCidr',
      ].sort(),
    );
    expect(outputs.clusterName).toBe(CLUSTER);
    expect(outputs.vpcCidr).toBe('10.0.1.0/24');
    expect(outputs.masterIp).toBe('203.0.113.250');
    expect(outputs.floatingIp).toBe('203.0.113.250');
    expect(outputs.masterPrivateIp).toBe('10.0.1.2');
    expect(outputs.dbPrivateIp).toBe('10.0.1.3');
    expect(outputs.networkId).toBe('1234');
    expect(outputs.sshKeyId).toBe('999888');
    expect(outputs.workerIps).toHaveLength(2);
  });

  it('registers exactly the expected resources', () => {
    expect(captured).toHaveLength(9);
  });

  it('names network, firewall and ssh key as the autoscaler looks them up', () => {
    expect(byType(captured, 'linode:index/vpc:Vpc')[0].inputs.label).toBe(`${CLUSTER}-network`);
    expect(byType(captured, 'linode:index/vpcSubnet:VpcSubnet')[0].inputs.label).toBe(
      `${CLUSTER}-subnet`,
    );
    expect(byType(captured, 'linode:index/firewall:Firewall')[0].inputs.label).toBe(
      squeezeLinodeLabel(`${CLUSTER}-firewall`),
    );
    expect(byType(captured, 'linode:index/sshKey:SshKey')[0].inputs.label).toBe(
      `${CLUSTER}-us-east-key`,
    );
  });

  it('binds the master to the ReservedIp on legacy interfaces', () => {
    const master = byType(captured, INSTANCE).find((i) => i.name === 'master') as Captured;
    expect(master.inputs.ipv4s).toEqual(['203.0.113.250']);
    expect(master.inputs.interfaceGeneration).toBe('legacy_config');
    expect(master.inputs.firewallId).toBe(4242);
    expect(master.inputs.authorizedKeys).toEqual(['ssh-ed25519 AAAAtest test@example.com']);
    expect(master.inputs.tags).toEqual(
      expect.arrayContaining(['role:master', `cluster:${CLUSTER}`]),
    );
    const userData = Buffer.from(
      unsealMockInput<Array<{ userData: string }>>(master.inputs.metadatas)[0].userData,
      'base64',
    ).toString();
    // The CLI hands the token to the cluster (applyCloudSecrets).
    expect(userData).not.toContain('linode_test_token_1234');
    expect(userData).toContain('--agent-token');
    expect(userData).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
  });

  it('puts every node on a static VPC address, public eth0 then VPC eth1', () => {
    const vpcAddr = (name: string) => {
      const i = byType(captured, INSTANCE).find((x) => x.name === name) as Captured;
      expect(i.inputs.interfaceGeneration).toBe('legacy_config');
      expect(i.inputs.interfaces[0].purpose).toBe('public');
      expect(i.inputs.interfaces[1].purpose).toBe('vpc');
      // The provider computes vpc_id from the subnet and refuses a set value
      // at create ("Can't configure a value for interface.1.vpc_id"), live
      // 2026-11-08. Preview does not catch it: the id is unknown there.
      expect(Object.keys(i.inputs.interfaces[1]).sort()).toEqual(['ipv4', 'purpose', 'subnetId']);
      expect(i.inputs.interfaces[1].subnetId).toBe(5678);
      return i.inputs.interfaces[1].ipv4.vpc;
    };
    expect(vpcAddr('master')).toBe('10.0.1.2');
    expect(vpcAddr('db')).toBe('10.0.1.3');
    expect(vpcAddr('worker-1')).toBe('10.0.1.10');
    expect(vpcAddr('worker-2')).toBe('10.0.1.11');
  });

  it('renders db and worker user data against the fixed master address', () => {
    for (const name of ['db', 'worker-1']) {
      const i = byType(captured, INSTANCE).find((x) => x.name === name) as Captured;
      const ud = Buffer.from(
        unsealMockInput<Array<{ userData: string }>>(i.inputs.metadatas)[0].userData,
        'base64',
      ).toString();
      expect(ud).toContain('https://10.0.1.2:6443');
      expect(ud).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
    }
  });

  it('tags workers as static pool members', () => {
    const w = byType(captured, INSTANCE).find((x) => x.name === 'worker-1') as Captured;
    expect(w.inputs.tags).toEqual(
      expect.arrayContaining(['role:worker', 'cluster-autoscaler-node:static']),
    );
  });

  describe('firewall', () => {
    const rules = () => byType(captured, 'linode:index/firewall:Firewall')[0].inputs.inbounds;

    it('drops inbound by default and has the four rule groups', () => {
      const fw = byType(captured, 'linode:index/firewall:Firewall')[0].inputs;
      expect(fw.inboundPolicy).toBe('DROP');
      expect(fw.outboundPolicy).toBe('ACCEPT');
      const ssh = rules().find((r: any) => r.ports === '22');
      const api = rules().find((r: any) => r.ports === '6443');
      expect(ssh.ipv4s).toEqual(['203.0.113.5/32']);
      expect(ssh.ipv6s).toEqual(['2001:db8::1/128']);
      expect(api.ipv4s).toEqual(['203.0.113.6/32']);
      expect(api.ipv6s).toBeUndefined();
      for (const p of ['80', '443']) {
        const r = rules().find((x: any) => x.ports === p);
        expect(r.ipv4s).toEqual(['0.0.0.0/0']);
        expect(r.ipv6s).toEqual(['::/0']);
      }
      const internal = rules().filter((r: any) => r.ipv4s?.[0] === '10.0.1.0/24');
      expect(internal.map((r: any) => `${r.protocol}:${r.ports ?? ''}`).sort()).toEqual([
        'ICMP:',
        'TCP:1-65535',
        'UDP:1-65535',
      ]);
    });

    it('keeps the VPC rules when applyOperatorCidrs rewrites the operator ports', () => {
      // Pulumi's ipv4s/ipv6s become the API's addresses.{ipv4,ipv6}.
      const apiShape = rules().map((r: any) => ({
        label: r.label,
        action: r.action,
        protocol: r.protocol,
        ...(r.ports ? { ports: r.ports } : {}),
        addresses: {
          ...(r.ipv4s ? { ipv4: r.ipv4s } : {}),
          ...(r.ipv6s ? { ipv6: r.ipv6s } : {}),
        },
      }));
      const rewritten = rewriteOperatorRules(apiShape, ['198.51.100.9/32']);
      expect(rewritten).toHaveLength(apiShape.length);
      const changed = rewritten.filter((r, i) => r !== apiShape[i]);
      expect(changed.map((r: any) => r.ports).sort()).toEqual(['22', '6443']);
      for (const r of changed) expect(r.addresses).toEqual({ ipv4: ['198.51.100.9/32'] });
      for (const r of rewritten.filter((x: any) => !['22', '6443'].includes(x.ports))) {
        expect(apiShape).toContainEqual(r);
      }
    });
  });
});

describe('buildLinodeK8sProgram with existingSshKeyId', () => {
  it('creates no SshKey and reports the passed id', async () => {
    const start = captured.length;
    const raw = await buildLinodeK8sProgram({ ...baseConfig, existingSshKeyId: '424242' })();
    await waitFor(start + 8);
    const out = (await pulumi.output(raw).promise()) as Record<string, any>;
    expect(byType(captured.slice(start), 'linode:index/sshKey:SshKey')).toHaveLength(0);
    expect(out.sshKeyId).toBe('424242');
    const master = byType(captured.slice(start), INSTANCE).find(
      (i) => i.name === 'master',
    ) as Captured;
    expect(master.inputs.authorizedKeys).toEqual(['ssh-ed25519 AAAAtest test@example.com']);
  });
});

// The longest cluster name the e2e matrix makes: runner.ts names the project
// `citest-<mode>-<ms>-<6 chars>`, the env is `cil4`, and k8s-ha adds
// `-primary`/`-standby`. 47 characters, past the 32-character firewall cap,
// so a label squeezed on one side and not the other cannot hide here.
const E2E_PROJECT = 'citest-k8s-ha-1787258789210-0typg2';
const E2E_STACK_ENV = 'cil4-standby';
const E2E_CLUSTER = `${E2E_PROJECT}-${E2E_STACK_ENV}`;
const VPC = 'linode:index/vpc:Vpc';
const FIREWALL = 'linode:index/firewall:Firewall';

describe('a long e2e-shaped k8s-ha standby: program, autoscaler, destroy and sweep agree', () => {
  type Names = { networkName: string; firewallName: string };
  let slice: Captured[];
  let caConfig: Names;
  let standbyTarget: Names;

  beforeAll(async () => {
    const start = captured.length;
    // The standby stack's shape: shared key, no static workers.
    const raw = await buildLinodeK8sProgram({
      ...baseConfig,
      projectName: E2E_PROJECT,
      environment: E2E_STACK_ENV,
      location: 'us-ord',
      minWorkers: 0,
      existingSshKeyId: '424242',
    })();
    // vpc, subnet, firewall, reservedIp, master, db
    await waitFor(start + 6);
    await pulumi.output(raw).promise();
    slice = captured.slice(start);
    caConfig = JSON.parse(
      await renderCarbonAutoscalerConfig({
        k3sVersion: baseConfig.k3sVersion,
        k3sToken: 'deadbeefcafe1234567890abcdef',
        masterPrivateIp: '10.0.1.2',
        clusterName: E2E_CLUSTER,
        environment: E2E_STACK_ENV,
        providerId: 'linode',
        ProviderClass: LinodeProvider,
        region: 'us-ord',
        workerServerType: 'g6-standard-2',
        minWorkers: 0,
        maxWorkers: 3,
        caBoundsMin: 1,
        sshKeyName: `${E2E_PROJECT}-cil4-ha-key`,
      }),
    );
    const targets = planK8sBackstopTargets({
      plan: { tier: 'k8s-ha', stackEnvs: ['cil4-primary', 'cil4-standby'] },
      envConfig: {
        region: 'us-iad',
        ha: {
          primary: { stack: 'cil4-primary', region: 'us-iad' },
          standby: { stack: 'cil4-standby', region: 'us-ord' },
        },
      },
      projectConfig: { projectName: E2E_PROJECT },
    });
    standbyTarget = targets.find((t) => t.stackEnv === E2E_STACK_ENV) as Names;
  });

  it('creates no static worker at minWorkers 0', () => {
    expect(
      byType(slice, INSTANCE)
        .map((i) => i.name)
        .sort(),
    ).toEqual(['db', 'master']);
  });

  it('labels the VPC with the exact name the autoscaler and destroy look up', () => {
    const vpcLabel = byType(slice, VPC)[0].inputs.label;
    expect(vpcLabel).toBe(caConfig.networkName);
    expect(vpcLabel).toBe(standbyTarget.networkName);
  });

  it('labels the VPC so the e2e sweep finds it by project prefix', () => {
    expect(byType(slice, VPC)[0].inputs.label.startsWith(E2E_PROJECT)).toBe(true);
  });

  it('labels the firewall as findFirewallByName squeezes the autoscaler and destroy names', () => {
    const fwLabel = byType(slice, FIREWALL)[0].inputs.label;
    expect(fwLabel.length).toBeLessThanOrEqual(32);
    expect(fwLabel).toBe(squeezeLinodeLabel(caConfig.firewallName));
    expect(fwLabel).toBe(squeezeLinodeLabel(standbyTarget.firewallName));
  });
});

// A local k8s-ha primary: runner.ts names the project
// `testapp-k8s-ha-<13 digits>-<6 chars>`, the stack env is `l4-primary`.
// `cluster:<project>-l4-primary` is 54 characters, past Linode's 50-character
// tag cap, so the program's tags and the autoscaler's selector must squeeze
// the same way.
const HA_PROJECT = 'testapp-k8s-ha-1787258789210-0typg2';
const HA_STACK_ENV = 'l4-primary';
const HA_CLUSTER = `${HA_PROJECT}-${HA_STACK_ENV}`;

describe('a long e2e-shaped k8s-ha primary: every tag fits and the autoscaler finds its own', () => {
  let slice: Captured[];
  let caConfig: {
    clusterName: string;
    nodeGroups: Record<string, { serverLabels: Record<string, string> }>;
  };

  beforeAll(async () => {
    const start = captured.length;
    const raw = await buildLinodeK8sProgram({
      ...baseConfig,
      projectName: HA_PROJECT,
      environment: HA_STACK_ENV,
      location: 'us-iad',
      minWorkers: 1,
      existingSshKeyId: '424242',
    })();
    // vpc, subnet, firewall, reservedIp, master, db, worker-1
    await waitFor(start + 7);
    await pulumi.output(raw).promise();
    slice = captured.slice(start);
    caConfig = JSON.parse(
      await renderCarbonAutoscalerConfig({
        k3sVersion: baseConfig.k3sVersion,
        k3sToken: 'deadbeefcafe1234567890abcdef',
        masterPrivateIp: '10.0.1.2',
        clusterName: HA_CLUSTER,
        environment: HA_STACK_ENV,
        providerId: 'linode',
        ProviderClass: LinodeProvider,
        region: 'us-iad',
        workerServerType: 'g6-standard-2',
        minWorkers: 1,
        maxWorkers: 3,
        caBoundsMin: 1,
        sshKeyName: `${HA_PROJECT}-l4-ha-key`,
      }),
    );
  });

  it('writes only tags of 3 to 50 characters', () => {
    const tags = slice.flatMap((r) => (r.inputs.tags ?? []) as string[]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag.length, tag).toBeGreaterThanOrEqual(3);
      expect(tag.length, tag).toBeLessThanOrEqual(50);
    }
  });

  it("tags the master's cluster exactly as the autoscaler's selector encodes it", () => {
    const master = byType(slice, INSTANCE).find((i) => i.name === 'master') as Captured;
    const clusterTag = (master.inputs.tags as string[]).find((t) => t.startsWith('cluster:'));
    expect(clusterTag).toBe(encodeLabel('cluster', caConfig.clusterName));
  });

  it('lists the static worker under the selector the autoscaler and destroy send', async () => {
    const instances = byType(slice, INSTANCE).map((i, n) => ({
      id: n + 1,
      label: i.inputs.label,
      tags: i.inputs.tags,
    }));
    fetchWithRetryMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: instances, page: 1, pages: 1 }),
    });
    const provider = new LinodeProvider('t');
    const workers = await provider.listServers({
      'cluster-autoscaler/node': 'static',
      cluster: caConfig.clusterName,
    });
    expect(workers.map((w: { label: string }) => w.label)).toEqual([
      byType(slice, INSTANCE).find((i) => i.name === 'worker-1')?.inputs.label,
    ]);
    const all = await provider.listServers({ cluster: caConfig.clusterName });
    expect(all).toHaveLength(3);
  });

  it("renders the CSI StorageClass volumeTags as the project's encoded tag", () => {
    const master = byType(slice, INSTANCE).find((i) => i.name === 'master') as Captured;
    const userData = Buffer.from(
      unsealMockInput<Array<{ userData: string }>>(master.inputs.metadatas)[0].userData,
      'base64',
    ).toString();
    expect(userData).toContain(
      `linodebs.csi.linode.com/volumeTags: "${encodeLabel('project', HA_PROJECT)}"`,
    );
  });
});

describe('LinodeProvider k8s constants', () => {
  it('pins the image, CIDR and storage class', () => {
    expect(LinodeProvider.K8S_IMAGE).toBe('linode/ubuntu26.04');
    expect(LinodeProvider.DEFAULT_VPC_CIDR).toBe('10.0.1.0/24');
    expect(LinodeProvider.K8S_STORAGE_CLASS).toBe('linode-block-storage-vibecarbon');
  });
});
