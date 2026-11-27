/**
 * buildScalewayK8sProgram: program-shape tests through Pulumi mocks, same
 * harness as vultr-k8s.test.ts. The resource classes are the real ones,
 * subclassed so each also records its options and the object it built: the
 * mocks do not see resource options, and dependsOn names resource objects.
 */
import * as pulumi from '@pulumi/pulumi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { unsealMockInput } from '../../_shared/pulumi-secrets.js';
import { listedRules } from '../../_shared/scaleway-listed-rules.js';

type Opts = { dependsOn?: unknown[]; deleteBeforeReplace?: boolean; replacementTrigger?: unknown };
type Built = { name: string; resource: object; opts?: Opts };
const { built, net } = vi.hoisted(() => ({
  built: [] as Built[],
  /** Where the provider's REST calls go: a test's Scaleway security-group API. */
  net: { fetch: null as null | ((url: string, init?: RequestInit) => Promise<unknown>) },
}));

vi.mock('../../../src/lib/fetch-retry.js', async (orig) => ({
  ...((await orig()) as object),
  fetchWithRetry: (url: string, init?: RequestInit) => {
    if (!net.fetch) throw new Error(`no Scaleway API in this test: ${url}`);
    return net.fetch(url, init);
  },
}));

vi.mock('@pulumiverse/scaleway', async (orig) => {
  type ResourceClass = new (name: string, args: unknown, opts?: Opts) => object;
  const actual = (await orig()) as Record<string, Record<string, ResourceClass>>;
  const recording = (Base: ResourceClass) =>
    class extends Base {
      constructor(name: string, args: unknown, opts?: Opts) {
        super(name, args, opts);
        built.push({ name, resource: this, opts });
      }
    };
  // Only the classes the program builds: one it reached for beyond these is
  // undefined here, and fails loudly.
  const only = (ns: string, classes: string[]) =>
    Object.fromEntries(classes.map((k) => [k, recording(actual[ns][k])]));
  return {
    iam: only('iam', ['SshKey']),
    network: only('network', ['Vpc', 'PrivateNetwork']),
    instance: only('instance', ['SecurityGroup', 'Ip', 'Server']),
  };
});

import { replicationRuleNotice } from '../../../src/lib/iac/program-inputs.js';
import {
  buildScalewayK8sProgram,
  privateIpv4In,
} from '../../../src/lib/iac/programs/scaleway-k8s.js';
import { timedTypeName } from '../../../src/lib/iac/resource-timing.js';
import { vpcCidrForCluster } from '../../../src/lib/iac/vpc-cidr.js';
import { firewallName } from '../../../src/lib/operator-ip.js';
import {
  canonicalScalewayRule,
  decodeLabels,
  ScalewayProvider,
} from '../../../src/lib/providers/scaleway.js';
import { checkScaleUpsKeptReplicationRule } from '../../e2e/checks/scale-ha.js';

// biome-ignore lint/suspicious/noExplicitAny: mock inputs of every resource shape
type Captured = { type: string; name: string; inputs: Record<string, any> };
// biome-ignore lint/suspicious/noExplicitAny: the program's outputs, resolved
type Outputs = Record<string, any>;
type Rule = Record<string, unknown>;

const ZONE = 'fr-par-1';
const MASTER_UUID = '6f1c2a4e-1d2b-4c3a-9e8f-0a1b2c3d4e5f';
const INGRESS = '203.0.113.250';
const captured: Captured[] = [];
let serverCounter = 0;
let ipCounter = 0;
/** The subnet the last Private Network was made with: the nodes' addresses come from it. */
let pnSubnet = '';
/**
 * What IPAM reports for a node's NIC, by resource name, in place of the
 * default (an IPv6 from the network's block, then an IPv4 in its subnet). A
 * test sets one to [], as an API key without IPAMReadOnly sees it.
 */
const privateIpsOverride: Record<string, unknown[]> = {};

/** The default IPv4 the mocks give a node: .3 the master, .4 the db, .10 on the workers. */
function nodeAddress(name: string, n: number): string {
  const prefix = pnSubnet.split('/')[0].split('.').slice(0, 3).join('.');
  const host = name === 'master' ? 3 : name === 'db' ? 4 : 10 + n;
  return `${prefix}.${host}`;
}

pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs) {
      captured.push({ type: args.type, name: args.name, inputs: args.inputs });
      switch (args.type) {
        case 'scaleway:instance/server:Server': {
          serverCounter += 1;
          const uuid =
            args.name === 'master'
              ? MASTER_UUID
              : `00000000-0000-4000-8000-${String(serverCounter).padStart(12, '0')}`;
          return {
            // A zoned resource's id is `<zone>/<uuid>` (the bridged provider's form).
            id: `${ZONE}/${uuid}`,
            state: {
              ...args.inputs,
              privateIps: privateIpsOverride[args.name] ?? [
                { id: `ipam-v6-${serverCounter}`, address: `fd5c:1:2:3::${serverCounter}` },
                { id: `ipam-v4-${serverCounter}`, address: nodeAddress(args.name, serverCounter) },
              ],
            },
          };
        }
        case 'scaleway:instance/ip:Ip':
          ipCounter += 1;
          return {
            id: `${ZONE}/ip-${args.name}`,
            state: {
              ...args.inputs,
              address: args.name === 'ingress' ? INGRESS : `198.51.100.${ipCounter % 250}`,
            },
          };
        case 'scaleway:network/privateNetwork:PrivateNetwork':
          pnSubnet = args.inputs.ipv4Subnet.subnet;
          // A regional resource's id is `<region>/<uuid>`.
          return { id: 'fr-par/pn-uuid', state: { ...args.inputs } };
        case 'scaleway:network/vpc:Vpc':
          return { id: 'fr-par/vpc-uuid', state: { ...args.inputs } };
        case 'scaleway:instance/securityGroup:SecurityGroup':
          return { id: `${ZONE}/sg-uuid`, state: { ...args.inputs } };
        case 'scaleway:iam/sshKey:SshKey':
          return { id: 'key-uuid', state: { ...args.inputs } };
        default:
          return { id: `${args.name}-mock-id`, state: { ...args.inputs } };
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
  location: ZONE,
  masterServerType: 'BASIC3-X2C-4G',
  dbServerType: 'DEV1-S',
  workerServerType: 'DEV1-M',
  minWorkers: 2,
  k3sVersion: 'v1.37.2+k3s1',
  // Programs no longer read it: the census
  // (tests/unit/deploy/k8s-user-data-secret-census.test.ts) passes it to
  // prove no resource gets it.
  apiToken: 'scw_test_token_1234',
  allowedSshIps: ['203.0.113.5/32', '2001:db8::1/128'],
  allowedK8sApiIps: ['203.0.113.6/32'],
  labels: { 'managed-by': 'vibecarbon' },
  // The CLI always passes one (lib/iac/k3s-token.js). Sentinel only.
  k3sToken: 'SENTINEL-k3s-token',
};
const CLUSTER = 'acme-prod';
const VPC_CIDR = vpcCidrForCluster(CLUSTER, 24);
const PEER = '198.51.100.7';

const SERVER = 'scaleway:instance/server:Server';
const IP = 'scaleway:instance/ip:Ip';
const GROUP = 'scaleway:instance/securityGroup:SecurityGroup';
const VPC = 'scaleway:network/vpc:Vpc';
const PN = 'scaleway:network/privateNetwork:PrivateNetwork';
const SSH_KEY = 'scaleway:iam/sshKey:SshKey';

const IPAM_HINT =
  "If your API key's policy lacks IPAMReadOnly, Scaleway hides that address; add it and deploy again.";
const NO_MASTER_ADDRESS = `Scaleway gave the master no address in the cluster's Private Network ${VPC_CIDR}, so the other nodes cannot join it. ${IPAM_HINT}`;
const NO_DB_ADDRESS = `Scaleway gave the database node no address in the cluster's Private Network ${VPC_CIDR}, so the cluster cannot reach its database. ${IPAM_HINT}`;

const byType = (list: Captured[], t: string) => list.filter((r) => r.type === t);
const server = (list: Captured[], name: string) =>
  byType(list, SERVER).find((i) => i.name === name) as Captured;
/** A server's boot script: the `cloud-init` key of its user data, through the secret wrapper. */
const userData = (i: Captured) =>
  unsealMockInput<string>(
    unsealMockInput<Record<string, unknown>>(i.inputs.userData)['cloud-init'],
  );

/**
 * Run a program to quiescence: every output resolved, then no more
 * resources arriving. The resources and built objects it made.
 */
async function run(config: Record<string, unknown>) {
  const start = captured.length;
  const builtStart = built.length;
  const raw = await buildScalewayK8sProgram(config)();
  const outputs = (await pulumi.output(raw).promise()) as Outputs;
  for (let seen = -1; seen !== captured.length; ) {
    seen = captured.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { outputs, resources: captured.slice(start), objects: built.slice(builtStart) };
}

/** The security group's declared inbound rules, in order. */
async function declaredRules(config: Record<string, unknown>): Promise<Rule[]> {
  const groups = byType((await run(config)).resources, GROUP);
  expect(groups).toHaveLength(1);
  return groups[0].inputs.inboundRules as Rule[];
}

const tcp = (port: number, ipRange: string) => ({
  action: 'accept',
  protocol: 'TCP',
  port,
  ipRange,
});

/** The rules, in their order: the web, the replication peer, then 22 and 6443. */
const expectedRules = (ssh: string[], api: string[], peer?: string) => [
  tcp(80, '0.0.0.0/0'),
  tcp(80, '::/0'),
  tcp(443, '0.0.0.0/0'),
  tcp(443, '::/0'),
  ...(peer ? [{ action: 'accept', protocol: 'UDP', port: 51821, ipRange: `${peer}/32` }] : []),
  ...ssh.map((cidr) => tcp(22, cidr)),
  ...api.map((cidr) => tcp(6443, cidr)),
];

/**
 * The declared rules as Scaleway's rules listing returns them: the six
 * non-editable outbound SMTP drops first, then each rule with the id and
 * position the API gives it, a host range bare and `dest_port_to: null`
 * (tests/_shared/scaleway-listed-rules.ts cites the cassettes). What the
 * refresh reads back and what findFirewallByName hands the REST writers.
 */
const asListed = (rules: Rule[]) => listedRules(rules as Parameters<typeof listedRules>[0]);

/**
 * Two rule lists compare in the provider's canonical rule form, in order:
 * the API's spelling of a rule and the CLI's are the same rule.
 */
const canonical = (rules: Rule[]) => rules.map(canonicalScalewayRule);

/** The program's declared rules, as REST rules in canonical form. */
const declaredAsRest = (rules: Rule[]) =>
  canonical(
    rules.map((r) => ({
      action: r.action,
      protocol: r.protocol,
      direction: 'inbound',
      ip_range: r.ipRange,
      dest_port_from: r.port,
      dest_port_to: r.port,
    })),
  );

const group = (name: string, rules: Rule[]) => ({ id: 'sg-uuid', name, zone: ZONE, rules });

/**
 * The rule list one REST write sends: `write` runs against a Scaleway API
 * that answers the group's zone probe and records the one PUT.
 */
async function capturePut(write: (provider: ScalewayProvider) => Promise<unknown>) {
  const puts: Rule[][] = [];
  net.fetch = async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      puts.push(JSON.parse(String(init.body)).rules);
      return { ok: true, status: 200, json: async () => ({ rules: [] }) };
    }
    if (url.endsWith(`/zones/${ZONE}/security_groups/sg-uuid`)) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    await write(new ScalewayProvider('t'));
  } finally {
    net.fetch = null;
  }
  expect(puts).toHaveLength(1);
  // Scaleway's own rules are never sent back: a PUT without them keeps them
  // (Terraform's PUT bodies, in the cassettes, carry only its own rules).
  expect(puts[0].filter((r) => r.editable === false)).toEqual([]);
  expect(puts[0].filter((r) => r.direction === 'outbound')).toEqual([]);
  // The array order is the order on the group: each rule's position is its
  // place in the list, never the position a kept rule was read with.
  expect(puts[0].map((r) => r.position)).toEqual(puts[0].map((_r, i) => i + 1));
  return puts[0];
}

describe('buildScalewayK8sProgram config guard', () => {
  it('requires both operator CIDR lists', () => {
    expect(() => buildScalewayK8sProgram({ ...baseConfig, allowedSshIps: [] })).toThrow(
      /allowedSshIps required/,
    );
    expect(() => buildScalewayK8sProgram({ ...baseConfig, allowedK8sApiIps: [] })).toThrow(
      /allowedK8sApiIps required/,
    );
  });

  it('requires the k3s token the CLI hands it', () => {
    expect(() => buildScalewayK8sProgram({ ...baseConfig, k3sToken: '' })).toThrow(
      /k3sToken required/,
    );
  });

  // Each node takes its server name as its hostname, then its k8s node name,
  // which Kubernetes caps at 63. The longest is an autoscaler worker,
  // `<cluster>-ca-` plus 8.
  it('refuses a cluster whose autoscaler node names would pass 63 characters', () => {
    // 46 + '-prod' = a 51-character cluster: its autoscaler nodes are 63.
    expect(() =>
      buildScalewayK8sProgram({ ...baseConfig, projectName: `p${'x'.repeat(45)}` }),
    ).not.toThrow();
    // 51 + '-prod' = a 56-character cluster: 68.
    const projectName = `p${'x'.repeat(50)}`;
    const build = () => buildScalewayK8sProgram({ ...baseConfig, projectName });
    expect(build).toThrow(/Kubernetes on Scaleway cannot give this cluster's nodes a node name/);
    expect(build).toThrow(/68 characters/);
    expect(build).toThrow(/allows 63/);
    expect(build).toThrow(/shorter project or environment name/);
  });
});

describe('buildScalewayK8sProgram resource graph', () => {
  let outputs: Outputs;
  let resources: Captured[];
  let objects: Built[];

  beforeAll(async () => {
    ({ outputs, resources, objects } = await run(baseConfig));
  });

  it("exports exactly Vultr's output names, with bare ids", () => {
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
    const prefix = VPC_CIDR.split('.').slice(0, 3).join('.');
    expect(outputs.clusterName).toBe(CLUSTER);
    expect(outputs.masterIp).toBe(INGRESS);
    expect(outputs.floatingIp).toBe(INGRESS);
    expect(outputs.masterPrivateIp).toBe(`${prefix}.3`);
    // The db's own addresses, not the master's.
    expect(outputs.dbPrivateIp).toBe(`${prefix}.4`);
    expect(outputs.dbIp).toMatch(/^198\.51\.100\.\d+$/);
    expect(outputs.workerIps).toHaveLength(2);
    for (const ip of outputs.workerIps) expect(ip).toMatch(/^198\.51\.100\.\d+$/);
    expect(new Set([outputs.dbIp, ...outputs.workerIps]).size).toBe(3);
    // The REST paths speak bare UUIDs (`<zone>/` or `<region>/` stripped).
    expect(outputs.masterId).toBe(MASTER_UUID);
    expect(outputs.networkId).toBe('pn-uuid');
    expect(outputs.sshKeyId).toBe('key-uuid');
    expect(outputs.k3sToken).toBe('SENTINEL-k3s-token');
    expect(outputs.vpcCidr).toBe(VPC_CIDR);
  });

  it('registers one key, VPC, network, group, four IPs and four servers, and nothing else', () => {
    const count = (t: string) => byType(resources, t).length;
    expect(count(SSH_KEY)).toBe(1);
    expect(count(VPC)).toBe(1);
    expect(count(PN)).toBe(1);
    expect(count(GROUP)).toBe(1);
    expect(
      byType(resources, IP)
        .map((i) => i.name)
        .sort(),
    ).toEqual(['db-ip', 'ingress', 'worker-1-ip', 'worker-2-ip']);
    expect(
      byType(resources, SERVER)
        .map((i) => i.name)
        .sort(),
    ).toEqual(['db', 'master', 'worker-1', 'worker-2']);
    // No Public Gateway, no PrivateNic, no IPAM address: the Private Network
    // carries no default route (the boot refuses a NIC that does).
    expect(resources).toHaveLength(1 + 1 + 1 + 1 + 4 + 4);
  });

  // Review Focus 4: a shared routed VPC with no PN filter would expose each
  // environment's kubelet, flannel and Postgres to the other's.
  it('every cluster has its own VPC and its Private Network sits in it', () => {
    const vpc = byType(resources, VPC)[0].inputs;
    expect(vpc).toEqual({
      name: `${CLUSTER}-network`,
      region: 'fr-par',
      tags: expect.arrayContaining(['project:acme', 'environment:prod']),
    });
    const pn = byType(resources, PN)[0].inputs;
    expect(pn).toEqual({
      name: `${CLUSTER}-network`,
      region: 'fr-par',
      vpcId: 'fr-par/vpc-uuid',
      ipv4Subnet: { subnet: VPC_CIDR },
      // Pinned off: the boot refuses a Private Network NIC that carries the
      // default route (_scaleway-metadata.sh), so the source says so too.
      enableDefaultRoutePropagation: false,
      tags: expect.arrayContaining(['project:acme', 'environment:prod']),
    });
    expect(outputs.vpcCidr).toBe(VPC_CIDR);
  });

  it('puts every server on exactly that network, behind the group, holding its own flexible IP, replaced delete-first', () => {
    const ipIds = new Set<string>();
    for (const s of byType(resources, SERVER)) {
      expect(s.inputs.privateNetworks, s.name).toEqual([{ pnId: 'fr-par/pn-uuid' }]);
      expect(s.inputs.securityGroupId, s.name).toBe(`${ZONE}/sg-uuid`);
      expect(s.inputs.ipIds, s.name).toHaveLength(1);
      ipIds.add(s.inputs.ipIds[0]);
      expect(s.inputs.enableDynamicIp, s.name).toBeUndefined();
      expect(s.inputs.zone, s.name).toBe(ZONE);
      expect(s.inputs.image, s.name).toBe('ubuntu_resolute');
      expect(s.inputs.rootVolume, s.name).toEqual({
        volumeType: 'sbs_volume',
        sizeInGb: 40,
        deleteOnTermination: true,
      });
      const opts = objects.find((o) => o.name === s.name)?.opts;
      expect(opts?.deleteBeforeReplace, s.name).toBe(true);
    }
    expect(ipIds).toEqual(
      new Set([
        `${ZONE}/ip-ingress`,
        `${ZONE}/ip-db-ip`,
        `${ZONE}/ip-worker-1-ip`,
        `${ZONE}/ip-worker-2-ip`,
      ]),
    );
    expect(server(resources, 'master').inputs.ipIds).toEqual([`${ZONE}/ip-ingress`]);
    expect(server(resources, 'db').inputs.ipIds).toEqual([`${ZONE}/ip-db-ip`]);
    expect(server(resources, 'worker-2').inputs.ipIds).toEqual([`${ZONE}/ip-worker-2-ip`]);
    expect(server(resources, 'master').inputs.type).toBe('BASIC3-X2C-4G');
    expect(server(resources, 'db').inputs.type).toBe('DEV1-S');
    expect(server(resources, 'worker-1').inputs.type).toBe('DEV1-M');
  });

  it('names each server for the cluster and its role', () => {
    expect(server(resources, 'master').inputs.name).toBe(`${CLUSTER}-master`);
    expect(server(resources, 'db').inputs.name).toBe(`${CLUSTER}-db`);
    expect(server(resources, 'worker-2').inputs.name).toBe(`${CLUSTER}-worker-2`);
  });

  // Destroy finds an IP no record names by its tags (deleteReservedIpsByLabels),
  // each label its own tag, never a joined name (RV9).
  it('tags every flexible IP with the project and the environment as separate tags', () => {
    for (const ip of byType(resources, IP)) {
      expect(ip.inputs.zone, ip.name).toBe(ZONE);
      expect(ip.inputs.type, ip.name).toBe('routed_ipv4');
      expect(ip.inputs.tags, ip.name).toEqual(
        expect.arrayContaining(['project:acme', 'environment:prod', 'managed-by:vibecarbon']),
      );
      const labels = decodeLabels(ip.inputs.tags as string[]);
      expect({ project: labels.project, environment: labels.environment }, ip.name).toEqual({
        project: 'acme',
        environment: 'prod',
      });
    }
  });

  it("renders the db and worker user data against the master's Private Network address", () => {
    const masterAddress = outputs.masterPrivateIp;
    for (const name of ['db', 'worker-1', 'worker-2']) {
      const ud = userData(server(resources, name));
      expect(ud, name).toContain(`K3S_URL="https://${masterAddress}:6443"`);
      expect(ud, name).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
      expect(ud, name).not.toContain('scw_test_token_1234');
      expect(ud, name).toContain('SENTINEL-k3s-token');
    }
    const master = userData(server(resources, 'master'));
    expect(master).toContain('--agent-token');
    expect(master).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
    expect(master).not.toContain('scw_test_token_1234');
  });

  it('tags each node with its role and the cluster, and the workers as static', () => {
    expect(server(resources, 'master').inputs.tags).toEqual(
      expect.arrayContaining(['role:master', `cluster:${CLUSTER}`, 'project:acme']),
    );
    expect(server(resources, 'db').inputs.tags).toEqual(
      expect.arrayContaining(['role:db', 'node-pool:db-pool', `cluster:${CLUSTER}`]),
    );
    expect(server(resources, 'worker-1').inputs.tags).toEqual(
      expect.arrayContaining([
        'role:worker',
        'node-pool:worker-pool',
        'cluster-autoscaler-node:static',
        `cluster:${CLUSTER}`,
      ]),
    );
  });

  it('names the SSH key for the cluster and the zone', () => {
    expect(byType(resources, SSH_KEY)[0].inputs).toEqual({
      name: `${CLUSTER}-${ZONE}-key`,
      publicKey: 'ssh-ed25519 AAAAtest test@example.com',
    });
  });

  it('declares the group stateful, dropping inbound by default', () => {
    const g = byType(resources, GROUP)[0].inputs;
    expect(g.name).toBe(`${CLUSTER}-firewall`);
    expect(g.zone).toBe(ZONE);
    expect(g.stateful).toBe(true);
    expect(g.inboundDefaultPolicy).toBe('drop');
    expect(g.outboundDefaultPolicy).toBe('accept');
    expect(g.tags).toEqual(expect.arrayContaining(['project:acme', 'environment:prod']));
  });

  // The e2e scale check (tests/e2e/checks/scale-ha.ts) reads a firewall
  // change from the per-resource markers by type name: the security group
  // must count as one, and nothing a scale legitimately changes may. On
  // Scaleway the first up after a REST insert rewrites the group
  // (K8S_FIREWALL_RULES_READ_BACK_IN_PLACE), so there the change passes on
  // the declared peer.
  it('the scale firewall check counts the security group, and no other resource, as a firewall', () => {
    const ha = {
      ha: {
        primary: { stack: 'prod-primary', dbIp: '203.0.113.10' },
        standby: { stack: 'prod-standby', dbIp: '203.0.113.20' },
      },
    };
    const lines = (list: Captured[]) =>
      (
        [
          ['prod-primary', '203.0.113.20'],
          ['prod-standby', '203.0.113.10'],
        ] as const
      ).flatMap(([stack, peer]) => [
        replicationRuleNotice(stack, peer),
        `[perf] scale.k8s.${stack}.upStack 1000ms`,
        ...list.map(
          (r) =>
            `[perf] scale.k8s.${stack}.upStack.resource.${timedTypeName(r.type)}.${r.name} 1ms`,
        ),
      ]);
    const check = (list: Captured[], rulesReadBackInPlace = true) =>
      checkScaleUpsKeptReplicationRule({
        output: lines(list).join('\n'),
        envName: 'prod',
        envConfig: ha,
        rulesReadBackInPlace,
      }).map((r) => r.status);
    expect(check(resources.filter((r) => r.type !== GROUP))).toEqual(['pass', 'pass']);
    expect(check(byType(resources, GROUP))).toEqual(['fail', 'fail']);
    expect(ScalewayProvider.K8S_FIREWALL_RULES_READ_BACK_IN_PLACE).toBe(false);
    expect(
      check(byType(resources, GROUP), ScalewayProvider.K8S_FIREWALL_RULES_READ_BACK_IN_PLACE),
    ).toEqual(['pass', 'pass']);
  });
});

describe('the security group declares every rule the REST writers leave, in their order', () => {
  it('without a replication peer: the web, then 22 per SSH CIDR, then 6443 per API CIDR', async () => {
    const rules = await declaredRules(baseConfig);
    expect(rules).toEqual(expectedRules(baseConfig.allowedSshIps, baseConfig.allowedK8sApiIps));
    expect(JSON.stringify(rules)).not.toContain('51821');
  });

  it('with a replication peer: its UDP 51821 rule sits after the web and before 22', async () => {
    const rules = await declaredRules({ ...baseConfig, replicationPeerIp: PEER });
    expect(rules).toEqual(
      expectedRules(baseConfig.allowedSshIps, baseConfig.allowedK8sApiIps, PEER),
    );
    // Field for field ScalewayProvider.buildReplicationFirewallRules's rule:
    // no description, a numeric port, the peer as a /32.
    const peerRule = rules.find((r) => r.port === 51821);
    expect(peerRule).toEqual({
      action: 'accept',
      protocol: 'UDP',
      port: 51821,
      ipRange: `${PEER}/32`,
    });
  });

  // RC3: `vibecarbon access` saves the new list, then pushes it
  // (operator-ip.js); the next up builds the program from the saved list.
  it('the next up plans no rule change after an access push', async () => {
    const side = { ...baseConfig, environment: 'prod-primary', replicationPeerIp: PEER };
    const before = await declaredRules(side);
    const moved = ['198.51.100.9/32', '2001:db8::9/128'];
    const after = await declaredRules({ ...side, allowedSshIps: moved, allowedK8sApiIps: moved });
    expect(after).not.toEqual(before);

    const put = await capturePut(async (provider) => {
      vi.spyOn(provider, 'findFirewallByName').mockResolvedValue(
        group('acme-prod-primary-firewall', asListed(before)),
      );
      expect(
        await provider.applyOperatorCidrs({
          firewallName: 'acme-prod-primary-firewall',
          cidrs: moved,
        }),
      ).toBe(true);
    });
    expect(canonical(put)).toEqual(declaredAsRest(after));
    // And the replication opener finds nothing to write on what the up declares.
    expect(
      new ScalewayProvider('t').buildReplicationFirewallRules(
        group('acme-prod-primary-firewall', asListed(after)),
        PEER,
      ),
    ).toBeNull();
  });

  it("after a first deploy's REST bootstrap, the next up plans no rule change", async () => {
    const side = { ...baseConfig, environment: 'prod-standby' };
    const firstUp = await declaredRules(side);
    // The deploy's opener (openReplicationFirewallForPeers): read, build, write.
    const put = await capturePut(async (provider) => {
      const fw = group('acme-prod-standby-firewall', asListed(firstUp));
      const rules = provider.buildReplicationFirewallRules(fw, PEER);
      expect(rules).not.toBeNull();
      await provider.setFirewallRules(fw.id, rules as Rule[], fw);
    });
    const nextUp = await declaredRules({ ...side, replicationPeerIp: PEER });
    expect(canonical(put)).toEqual(declaredAsRest(nextUp));
  });

  // The API lists the peer's rule as `198.51.100.7` with `dest_port_to:
  // null`, where the CLI wrote `198.51.100.7/32` and 51821: the same rule.
  it('a listing that already holds the peer rule, in the API form, needs no write', async () => {
    const side = { ...baseConfig, environment: 'prod-standby', replicationPeerIp: PEER };
    const fw = group('acme-prod-standby-firewall', asListed(await declaredRules(side)));
    expect(fw.rules).toContainEqual(
      expect.objectContaining({ ip_range: PEER, dest_port_from: 51821, dest_port_to: null }),
    );
    expect(new ScalewayProvider('t').buildReplicationFirewallRules(fw, PEER)).toBeNull();
  });

  it('a listed peer rule over a port range, or for another address, is rewritten', async () => {
    const side = { ...baseConfig, environment: 'prod-standby', replicationPeerIp: PEER };
    const listed = asListed(await declaredRules(side));
    const peerAt = listed.findIndex((r) => r.dest_port_from === 51821);
    for (const change of [{ dest_port_to: 51822 }, { ip_range: '198.51.100.8' }]) {
      const rules = listed.map((r, i) => (i === peerAt ? { ...r, ...change } : r));
      const written = new ScalewayProvider('t').buildReplicationFirewallRules(
        group('acme-prod-standby-firewall', rules),
        PEER,
      );
      expect(written).not.toBeNull();
      expect(canonical((written as Rule[]).filter((r) => r.editable !== false))).toEqual(
        declaredAsRest(await declaredRules(side)),
      );
    }
  });
});

describe('the security group is the one operator-ip pushes to', () => {
  // A k8s environment, and both sides of a k8s-ha pair.
  it.each(['prod', 'prod-primary', 'prod-standby'])('%s', async (side) => {
    const { resources } = await run({
      ...baseConfig,
      environment: side,
      minWorkers: 0,
      existingSshKeyId: 'shared-key',
    });
    const g = byType(resources, GROUP);
    expect(g).toHaveLength(1);
    expect(g[0].inputs.name).toBe(firewallName(baseConfig.projectName, side));
  });
});

describe('a k8s-ha pair', () => {
  it("gets two VPCs and two subnets, one per side, neither the other's", async () => {
    // One side at a time: the mocks take each node's address from the
    // network the run made last.
    const sides = [];
    for (const environment of ['prod-primary', 'prod-standby']) {
      const { outputs, resources } = await run({
        ...baseConfig,
        environment,
        minWorkers: 0,
        existingSshKeyId: 'shared-key',
      });
      sides.push({
        vpc: byType(resources, VPC)[0].inputs.name,
        pn: byType(resources, PN)[0].inputs,
        vpcCidr: outputs.vpcCidr,
        cluster: `acme-${environment}`,
      });
    }
    for (const s of sides) {
      expect(s.vpc).toBe(`${s.cluster}-network`);
      expect(s.pn.name).toBe(`${s.cluster}-network`);
      expect(s.pn.ipv4Subnet.subnet).toBe(vpcCidrForCluster(s.cluster, 24));
      expect(s.vpcCidr).toBe(s.pn.ipv4Subnet.subnet);
    }
    expect(sides[0].vpc).not.toBe(sides[1].vpc);
    expect(sides[0].vpcCidr).not.toBe(sides[1].vpcCidr);
  });
});

describe('privateIpv4In', () => {
  it('takes the first IPv4 inside the subnet, past an IPv6 listed first', () => {
    // The case that fails without the family argument to cidrContainsIp.
    expect(
      privateIpv4In([{ address: 'fd00::3' }, { address: '10.130.5.3' }], '10.130.5.0/24'),
    ).toBe('10.130.5.3');
  });

  it('skips an IPv4 outside the subnet', () => {
    expect(
      privateIpv4In(
        [{ address: '10.130.6.3' }, { address: '172.16.0.9' }, { address: '10.130.5.7' }],
        '10.130.5.0/24',
      ),
    ).toBe('10.130.5.7');
  });

  it('is null when none is an IPv4 inside the subnet', () => {
    expect(privateIpv4In([], '10.130.5.0/24')).toBeNull();
    expect(privateIpv4In([{ address: 'fd00::3' }], '10.130.5.0/24')).toBeNull();
    expect(privateIpv4In([{ address: '10.130.6.3' }], '10.130.5.0/24')).toBeNull();
    expect(privateIpv4In(undefined, '10.130.5.0/24')).toBeNull();
  });
});

/**
 * Run the program with one node's private addresses hidden, as an API key
 * without IPAMReadOnly sees them. The throw lands in every value built from
 * the address, the db's and workers' user data among them, which the runtime
 * serializes as it registers them: a real `pulumi up` fails the program on
 * those unhandled rejections, so this takes them over from vitest while the
 * program runs, and returns them with the output that must reject.
 */
async function withHiddenAddress(node: string, output: string) {
  const caught: unknown[] = [];
  const vitestListeners = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', (reason) => caught.push(reason));
  privateIpsOverride[node] = [];
  let rejection: unknown;
  try {
    const raw = await buildScalewayK8sProgram({ ...baseConfig, minWorkers: 1 })();
    await pulumi
      .output(raw[output])
      .promise()
      .catch((err: unknown) => {
        rejection = err;
      });
    // Until the rejections stop arriving (bounded).
    let stable = 0;
    for (let i = 0; i < 100 && stable < 3; i++) {
      const before = caught.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      stable = caught.length === before ? stable + 1 : 0;
    }
  } finally {
    delete privateIpsOverride[node];
    process.removeAllListeners('unhandledRejection');
    for (const listener of vitestListeners) process.on('unhandledRejection', listener);
  }
  return { rejection, caught };
}

describe('a node Scaleway gives no Private Network address', () => {
  it('the master: the program fails, naming why', async () => {
    const { rejection, caught } = await withHiddenAddress('master', 'masterPrivateIp');
    // The runtime prefixes the error it serialized first ("error serializing
    // property ..."), on the one error object every value built from the
    // address shares.
    expect(String((rejection as Error)?.message)).toContain(NO_MASTER_ADDRESS);
    expect(caught.length).toBeGreaterThan(0);
    for (const reason of caught) {
      expect(String((reason as Error)?.message ?? reason)).toContain(NO_MASTER_ADDRESS);
    }
  });

  it('the database node: the program fails, naming why', async () => {
    const { rejection, caught } = await withHiddenAddress('db', 'dbPrivateIp');
    expect(String((rejection as Error)?.message)).toContain(NO_DB_ADDRESS);
    for (const reason of caught) {
      expect(String((reason as Error)?.message ?? reason)).toContain(NO_DB_ADDRESS);
    }
  });
});

describe('buildScalewayK8sProgram with existingSshKeyId', () => {
  it('creates no SSH key and reports the given id', async () => {
    const { outputs, resources } = await run({ ...baseConfig, existingSshKeyId: 'shared-key' });
    expect(byType(resources, SSH_KEY)).toHaveLength(0);
    expect(outputs.sshKeyId).toBe('shared-key');
  });
});

/** A worker's join trigger, resolved. */
async function triggerOf(objects: Built[], name: string): Promise<string> {
  const trigger = objects.find((o) => o.name === name)?.opts?.replacementTrigger;
  expect(trigger, name).toBeDefined();
  return (await pulumi.output(trigger).promise()) as string;
}

// converge-cluster.js hands a scale or failover the master as prior state
// records it (priorMasterFrom), read from the masterId output.
describe('the join trigger names the master by its bare id on deploy and on scale', () => {
  it('gives the same string both ways, and masterId is the bare id', async () => {
    const deployed = await run({ ...baseConfig, minWorkers: 1 });
    expect(deployed.outputs.masterId).toBe(MASTER_UUID);
    const fromDeploy = await triggerOf(deployed.objects, 'worker-1');
    expect(fromDeploy).toBe(
      `master=${MASTER_UUID}@${deployed.outputs.masterPrivateIp} k3s=${baseConfig.k3sVersion}`,
    );

    const scaled = await run({
      ...baseConfig,
      minWorkers: 1,
      k3sToken: 'replayed',
      k3sTokenReplayed: true,
      priorMaster: { id: deployed.outputs.masterId, privateIp: deployed.outputs.masterPrivateIp },
    });
    expect(await triggerOf(scaled.objects, 'worker-1')).toBe(fromDeploy);
    expect(scaled.outputs.masterId).toBe(MASTER_UUID);
  });
});

describe('buildScalewayK8sProgram for a scale or failover (priorMaster)', () => {
  const PRIOR = { id: MASTER_UUID, privateIp: '10.179.75.99' };
  let resources: Captured[];
  let objects: Built[];

  beforeAll(async () => {
    ({ resources, objects } = await run({
      ...baseConfig,
      k3sToken: 'replayed',
      k3sTokenReplayed: true,
      priorMaster: PRIOR,
    }));
  });

  it('renders the db and worker user data with the recorded master address', () => {
    for (const name of ['db', 'worker-1', 'worker-2']) {
      expect(userData(server(resources, name)), name).toContain(
        `K3S_URL="https://${PRIOR.privateIp}:6443"`,
      );
    }
  });

  it('does not make the db or a worker wait on the master', () => {
    const master = objects.find((o) => o.name === 'master')?.resource;
    expect(master).toBeDefined();
    for (const node of ['db', 'worker-1', 'worker-2']) {
      const deps = objects.find((o) => o.name === node)?.opts?.dependsOn ?? [];
      expect(deps, node).not.toContain(master);
    }
  });
});

describe('a deploy (no priorMaster) makes the db and workers wait on the master', () => {
  it('lists the master in their dependencies', async () => {
    const { objects } = await run(baseConfig);
    const master = objects.find((o) => o.name === 'master')?.resource;
    expect(master).toBeDefined();
    for (const node of ['db', 'worker-1', 'worker-2']) {
      const deps = objects.find((o) => o.name === node)?.opts?.dependsOn ?? [];
      expect(deps, node).toContain(master);
    }
  });
});
