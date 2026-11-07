/**
 * buildLinodeK8sProgram: program-shape tests through Pulumi mocks, same
 * harness as digitalocean-k8s.test.ts.
 */
import * as pulumi from '@pulumi/pulumi';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildLinodeK8sProgram } from '../../../src/lib/iac/programs/linode-k8s.js';
import {
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
  apiToken: 'linode_test_token_1234',
  allowedSshIps: ['203.0.113.5/32', '2001:db8::1/128'],
  allowedK8sApiIps: ['203.0.113.6/32'],
  labels: { 'managed-by': 'vibecarbon' },
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
    expect(byType(captured, 'linode:index/vpc:Vpc')[0].inputs.label).toBe(
      squeezeLinodeLabel(`${CLUSTER}-network`),
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
    const userData = Buffer.from(master.inputs.metadatas[0].userData, 'base64').toString();
    expect(userData).toContain('linode_test_token_1234');
    expect(userData).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
  });

  it('puts every node on a static VPC address, public eth0 then VPC eth1', () => {
    const vpcAddr = (name: string) => {
      const i = byType(captured, INSTANCE).find((x) => x.name === name) as Captured;
      expect(i.inputs.interfaceGeneration).toBe('legacy_config');
      expect(i.inputs.interfaces[0].purpose).toBe('public');
      expect(i.inputs.interfaces[1].purpose).toBe('vpc');
      expect(i.inputs.interfaces[1].vpcId).toBe(1234);
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
      const ud = Buffer.from(i.inputs.metadatas[0].userData, 'base64').toString();
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

describe('LinodeProvider k8s constants', () => {
  it('pins the image, CIDR and storage class', () => {
    expect(LinodeProvider.K8S_IMAGE).toBe('linode/ubuntu26.04');
    expect(LinodeProvider.DEFAULT_VPC_CIDR).toBe('10.0.1.0/24');
    expect(LinodeProvider.K8S_STORAGE_CLASS).toBe('linode-block-storage-vibecarbon');
  });
});
