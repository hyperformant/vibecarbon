/**
 * buildVultrK8sProgram: program-shape tests through Pulumi mocks, same
 * harness as linode-k8s.test.ts. The resource classes are the real ones,
 * subclassed so each also records its options and the object it built: the
 * mocks do not see resource options, and dependsOn names resource objects.
 */
import * as pulumi from '@pulumi/pulumi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { unsealMockInput } from '../../_shared/pulumi-secrets.js';

type Opts = { dependsOn?: unknown[]; deleteBeforeReplace?: boolean };
type Built = { name: string; resource: object; opts?: Opts };
const { built, net } = vi.hoisted(() => ({
  built: [] as Built[],
  /** Where the provider's REST calls go: a test's Vultr firewall API. */
  net: { fetch: null as null | ((url: string, init?: RequestInit) => Promise<unknown>) },
}));

vi.mock('../../../src/lib/fetch-retry.js', async (orig) => ({
  ...((await orig()) as object),
  fetchWithRetry: (url: string, init?: RequestInit) => {
    if (!net.fetch) throw new Error(`no Vultr API in this test: ${url}`);
    return net.fetch(url, init);
  },
}));

vi.mock('@ediri/vultr', async (orig) => {
  type ResourceClass = new (name: string, args: unknown, opts?: Opts) => object;
  const actual = (await orig()) as Record<string, ResourceClass>;
  const recording = (Base: ResourceClass) =>
    class extends Base {
      constructor(name: string, args: unknown, opts?: Opts) {
        super(name, args, opts);
        built.push({ name, resource: this, opts });
      }
    };
  // Only the classes the program builds: one it reached for beyond these is
  // undefined here, and fails loudly.
  return Object.fromEntries(
    ['SSHKey', 'Vpc', 'FirewallGroup', 'FirewallRule', 'Instance'].map((k) => [
      k,
      recording(actual[k]),
    ]),
  );
});

import { buildVultrK8sProgram } from '../../../src/lib/iac/programs/vultr-k8s.js';
import { vpcCidrForCluster } from '../../../src/lib/iac/vpc-cidr.js';
import { firewallName } from '../../../src/lib/operator-ip.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import { ruleFields, vultrFirewallApi } from '../../_shared/vultr-firewall-api.js';

// biome-ignore lint/suspicious/noExplicitAny: mock inputs of every resource shape
type Captured = { type: string; name: string; inputs: Record<string, any> };
// biome-ignore lint/suspicious/noExplicitAny: the program's outputs, resolved
type Outputs = Record<string, any>;
const captured: Captured[] = [];
let instanceCounter = 0;
/** The master's VPC address the mocks report; a test sets it empty. */
let masterInternalIp = '10.181.32.3';
/** The master's own public address, where the cluster's domain points. */
const MASTER_IP = '203.0.113.250';

pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs) {
      captured.push({ type: args.type, name: args.name, inputs: args.inputs });
      switch (args.type) {
        case 'vultr:index/instance:Instance': {
          instanceCounter += 1;
          const isMaster = args.name === 'master';
          return {
            id: `instance-${instanceCounter}`,
            state: {
              ...args.inputs,
              mainIp: isMaster ? MASTER_IP : `198.51.100.${instanceCounter % 250}`,
              internalIp: isMaster ? masterInternalIp : `10.181.32.${10 + (instanceCounter % 200)}`,
            },
          };
        }
        case 'vultr:index/vpc:Vpc':
          return { id: 'vpc-uuid', state: { ...args.inputs } };
        case 'vultr:index/sSHKey:SSHKey':
          return { id: 'key-uuid', state: { ...args.inputs } };
        case 'vultr:index/firewallGroup:FirewallGroup':
          return { id: 'fwg-uuid', state: { ...args.inputs } };
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
  location: 'ewr',
  masterServerType: 'vc2-2c-4gb',
  dbServerType: 'vc2-1c-2gb',
  workerServerType: 'vc2-2c-4gb',
  minWorkers: 2,
  k3sVersion: 'v1.37.2+k3s1',
  // Programs no longer read it: the census
  // (tests/unit/deploy/k8s-user-data-secret-census.test.ts) passes it to
  // prove no resource gets it.
  apiToken: 'vultr_test_token_1234',
  allowedSshIps: ['203.0.113.5/32', '2001:db8::1/128'],
  allowedK8sApiIps: ['203.0.113.6/32'],
  labels: { 'managed-by': 'vibecarbon' },
  // The CLI always passes one (lib/iac/k3s-token.js). Sentinel only.
  k3sToken: 'SENTINEL-k3s-token',
};
const CLUSTER = 'acme-prod';
const VPC_CIDR = vpcCidrForCluster(CLUSTER, 24);

const INSTANCE = 'vultr:index/instance:Instance';
const RULE = 'vultr:index/firewallRule:FirewallRule';
const GROUP = 'vultr:index/firewallGroup:FirewallGroup';
const VPC = 'vultr:index/vpc:Vpc';
const SSH_KEY = 'vultr:index/sSHKey:SSHKey';

const NO_VPC_ADDRESS =
  'Vultr gave the master no VPC address (internal_ip is empty), so the other nodes cannot join it over the private network.';

const byType = (list: Captured[], t: string) => list.filter((r) => r.type === t);
const instance = (list: Captured[], name: string) =>
  byType(list, INSTANCE).find((i) => i.name === name) as Captured;
const userData = (i: Captured) => unsealMockInput<string>(i.inputs.userData);

/**
 * Run a program to quiescence: every output resolved, then no more
 * resources arriving. The resources and built objects it made.
 */
async function run(config: Record<string, unknown>) {
  const start = captured.length;
  const builtStart = built.length;
  const raw = await buildVultrK8sProgram(config)();
  const outputs = (await pulumi.output(raw).promise()) as Outputs;
  for (let seen = -1; seen !== captured.length; ) {
    seen = captured.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { outputs, resources: captured.slice(start), objects: built.slice(builtStart) };
}

describe('buildVultrK8sProgram config guard', () => {
  it('requires both operator CIDR lists', () => {
    expect(() => buildVultrK8sProgram({ ...baseConfig, allowedSshIps: [] })).toThrow(
      /allowedSshIps required/,
    );
    expect(() => buildVultrK8sProgram({ ...baseConfig, allowedK8sApiIps: [] })).toThrow(
      /allowedK8sApiIps required/,
    );
  });

  it('requires the k3s token the CLI hands it', () => {
    expect(() => buildVultrK8sProgram({ ...baseConfig, k3sToken: '' })).toThrow(
      /k3sToken required/,
    );
  });

  // Each node takes its hostname as its k8s node name, which Kubernetes caps
  // at 63. The longest is an autoscaler worker, `<cluster>-ca-` plus 8.
  it('refuses a cluster whose autoscaler node names would pass 63 characters', () => {
    // 46 + '-prod' = a 51-character cluster: its autoscaler nodes are 63.
    expect(() =>
      buildVultrK8sProgram({ ...baseConfig, projectName: `p${'x'.repeat(45)}` }),
    ).not.toThrow();
    // 51 + '-prod' = a 56-character cluster: 68.
    const projectName = `p${'x'.repeat(50)}`;
    expect(`${projectName}-prod`).toHaveLength(56);
    const build = () => buildVultrK8sProgram({ ...baseConfig, projectName });
    expect(build).toThrow(/Kubernetes on Vultr cannot give this cluster's nodes a node name/);
    expect(build).toThrow(/68 characters/);
    expect(build).toThrow(/allows 63/);
    expect(build).toThrow(/shorter project or environment name/);
  });
});

describe('buildVultrK8sProgram resource graph', () => {
  let outputs: Outputs;
  let resources: Captured[];
  let objects: Built[];

  beforeAll(async () => {
    ({ outputs, resources, objects } = await run(baseConfig));
  });

  it("exports DigitalOcean's output names: no floatingIp, the domain points at the master", () => {
    expect(Object.keys(outputs).sort()).toEqual(
      [
        'masterIp',
        // Read back by a scale or failover (converge-cluster.js priorMasterFrom).
        'masterId',
        'masterPrivateIp',
        'dbIp',
        'dbPrivateIp',
        'workerIps',
        'networkId',
        'sshKeyId',
        'k3sToken',
        'clusterName',
        'vpcCidr',
      ].sort(),
    );
    expect(outputs.clusterName).toBe(CLUSTER);
    // The master's own address (clusterIngressIp, lib/deploy/k8s/ingress-ip.js).
    expect(outputs).not.toHaveProperty('floatingIp');
    expect(VultrProvider.K8S_FLOATING_IP).toBe(false);
    expect(outputs.masterIp).toBe(MASTER_IP);
    expect(outputs.masterPrivateIp).toBe(masterInternalIp);
    // The db's own addresses, not the master's.
    expect(outputs.dbIp).toMatch(/^198\.51\.100\.\d+$/);
    expect(outputs.dbPrivateIp).toMatch(/^10\.181\.32\.\d+$/);
    expect(outputs.dbPrivateIp).not.toBe(masterInternalIp);
    expect(outputs.networkId).toBe('vpc-uuid');
    expect(outputs.sshKeyId).toBe('key-uuid');
    expect(outputs.masterId).toMatch(/^instance-\d+$/);
    expect(outputs.workerIps).toHaveLength(2);
    expect(outputs.k3sToken).toBe('SENTINEL-k3s-token');
  });

  it('registers one key, VPC, group, master, db and two workers, plus seven rules, and no reserved IP', () => {
    const count = (t: string) => byType(resources, t).length;
    expect(count(SSH_KEY)).toBe(1);
    expect(count(VPC)).toBe(1);
    expect(count(GROUP)).toBe(1);
    expect(resources.filter((r) => /reservedIp/i.test(r.type))).toEqual([]);
    expect(
      byType(resources, INSTANCE)
        .map((i) => i.name)
        .sort(),
    ).toEqual(['db', 'master', 'worker-1', 'worker-2']);
    expect(count(RULE)).toBe(7);
    expect(resources).toHaveLength(1 + 1 + 1 + 4 + 7);
  });

  // The master holds no address of its own to free, so nothing makes it
  // replace delete-first (DigitalOcean's master doesn't either).
  it('gives the master no reserved IP, replaces it create-first, and names its host', () => {
    const master = instance(resources, 'master');
    expect(master.inputs).not.toHaveProperty('reservedIpId');
    expect(master.inputs.label).toBe(`${CLUSTER}-master`);
    expect(master.inputs.hostname).toBe(master.inputs.label);
    const opts = objects.find((o) => o.name === 'master')?.opts;
    expect(opts?.deleteBeforeReplace).toBeUndefined();
    // Every other node takes its label as its hostname too (the k8s node name).
    for (const i of byType(resources, INSTANCE)) {
      expect(i.inputs.hostname, i.name).toBe(i.inputs.label);
      expect(i.inputs, i.name).not.toHaveProperty('reservedIpId');
    }
    expect(instance(resources, 'db').inputs.label).toBe(`${CLUSTER}-db`);
    expect(instance(resources, 'worker-2').inputs.label).toBe(`${CLUSTER}-worker-2`);
  });

  it('puts every instance on exactly the one VPC, behind the firewall group, on Ubuntu 26.04', () => {
    for (const i of byType(resources, INSTANCE)) {
      expect(i.inputs.vpcIds, i.name).toEqual(['vpc-uuid']);
      expect(i.inputs.vpc2Ids, i.name).toBeUndefined();
      expect(i.inputs.firewallGroupId, i.name).toBe('fwg-uuid');
      expect(i.inputs.osId, i.name).toBe(2760);
      expect(i.inputs.sshKeyIds, i.name).toEqual(['key-uuid']);
      expect(i.inputs.region, i.name).toBe('ewr');
    }
    expect(instance(resources, 'master').inputs.plan).toBe('vc2-2c-4gb');
    expect(instance(resources, 'db').inputs.plan).toBe('vc2-1c-2gb');
  });

  // UFW is off on every Vultr k8s node (_host-firewall-off.sh), so the group
  // is each node's one network filter, and Vultr does not enforce a group
  // until it has a rule. So the rules come with the group, in this program,
  // and no instance is created before they exist.
  it('creates the group with its rules, and no instance before the rules exist', () => {
    const groups = objects.filter((o) => o.name === 'firewall');
    expect(groups).toHaveLength(1);
    const rules = objects.filter((o) => o.name.startsWith('rule-'));
    expect(rules).toHaveLength(7);
    for (const r of byType(resources, RULE)) {
      expect(r.inputs.firewallGroupId, r.name).toBe('fwg-uuid');
    }
    for (const node of ['master', 'db', 'worker-1', 'worker-2']) {
      const deps = objects.find((o) => o.name === node)?.opts?.dependsOn ?? [];
      for (const rule of rules) {
        expect(deps, `${node} waits on ${rule.name}`).toContain(rule.resource);
      }
    }
  });

  it('declares the VPC with the derived /24, and exports it', () => {
    const [subnet, mask] = VPC_CIDR.split('/');
    const vpc = byType(resources, VPC)[0].inputs;
    expect(vpc).toEqual({
      description: `${CLUSTER}-network`,
      region: 'ewr',
      v4Subnet: subnet,
      v4SubnetMask: Number(mask),
    });
    expect(outputs.vpcCidr).toBe(VPC_CIDR);
  });

  it('names the SSH key for the cluster and the region', () => {
    expect(byType(resources, SSH_KEY)[0].inputs).toEqual({
      name: `${CLUSTER}-ewr-key`,
      sshKey: 'ssh-ed25519 AAAAtest test@example.com',
    });
  });

  // Ruling RV5, one writer per rule: the operator ports (22, 6443) are
  // REST's (the deploy writes them after the up, `vibecarbon access` rewrites
  // them), as is the k8s-ha replication rule. The program declares only the
  // rules nothing else writes.
  it('opens exactly the web and the VPC, one rule per source, and no operator port', () => {
    const rules = byType(resources, RULE).map((r) => r.inputs);
    const [vpcSubnet] = VPC_CIDR.split('/');
    expect(
      rules
        .map((r) => `${r.protocol} ${r.port ?? '-'} ${r.ipType} ${r.subnet}/${r.subnetSize}`)
        .sort(),
    ).toEqual(
      [
        'tcp 80 v4 0.0.0.0/0',
        'tcp 80 v6 ::/0',
        'tcp 443 v4 0.0.0.0/0',
        'tcp 443 v6 ::/0',
        `tcp 1:65535 v4 ${vpcSubnet}/24`,
        `udp 1:65535 v4 ${vpcSubnet}/24`,
        `icmp - v4 ${vpcSubnet}/24`,
      ].sort(),
    );
    expect(rules.filter((r) => ['22', '6443'].includes(String(r.port)))).toEqual([]);
    // `source` is never set: see repairVultrFirewallRuleInputs.
    for (const r of rules) expect(r).not.toHaveProperty('source');
  });

  // A name from the rule's place in a list renames every rule after one that
  // comes or goes, and Pulumi deletes a renamed rule and makes it again.
  it('names each rule by what it admits, not by its place in a list', () => {
    expect(
      byType(resources, RULE)
        .map((r) => r.name)
        .sort(),
    ).toEqual(
      [
        'rule-http-v4',
        'rule-http-v6',
        'rule-https-v4',
        'rule-https-v6',
        'rule-vpc-tcp-v4',
        'rule-vpc-udp-v4',
        'rule-vpc-icmp-v4',
      ].sort(),
    );
  });

  it("renders the db and worker user data against the master's VPC address", () => {
    for (const name of ['db', 'worker-1', 'worker-2']) {
      const ud = userData(instance(resources, name));
      expect(ud, name).toContain(`K3S_URL="https://${masterInternalIp}:6443"`);
      expect(ud, name).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
      expect(ud, name).not.toContain('vultr_test_token_1234');
    }
    const master = userData(instance(resources, 'master'));
    expect(master).toContain('--agent-token');
    expect(master).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
    expect(master).not.toContain('vultr_test_token_1234');
  });

  it('tags each node with its role and the cluster, and the workers as static', () => {
    expect(instance(resources, 'master').inputs.tags).toEqual(
      expect.arrayContaining(['role:master', `cluster:${CLUSTER}`, 'project:acme']),
    );
    expect(instance(resources, 'db').inputs.tags).toEqual(
      expect.arrayContaining(['role:db', 'node-pool:db-pool', `cluster:${CLUSTER}`]),
    );
    expect(instance(resources, 'worker-1').inputs.tags).toEqual(
      expect.arrayContaining([
        'role:worker',
        'node-pool:worker-pool',
        'cluster-autoscaler-node:static',
        `cluster:${CLUSTER}`,
      ]),
    );
  });
});

// Review Focus 3 and ruling RV5: one writer per rule. The program owns the
// web and VPC rules. REST owns the operator ports (the deploy's push after
// the up, then `vibecarbon access`) and the k8s-ha replication rule
// (openReplicationFirewallForPeers: find, build, set). Each writer changes
// only its own rules, so the program's keep their ids, and the next up (a
// scale, a failover, the other side of an HA deploy) finds them as it left
// them. Rewritten wholesale, they took new ids: the next up's refresh lost
// them and it created them again, which Vultr refuses ("This rule is already
// defined"), and the group sat empty, so unenforced, mid-rewrite.
describe('one writer per firewall rule', () => {
  const GROUP_NAME = `${CLUSTER}-firewall`;
  const OPERATOR = ['203.0.113.5/32', '2001:db8::1/128'];
  const ADDED = '198.51.100.9/32';
  const PEER_DB = '198.51.100.7';

  /** A FirewallRule's program inputs as the create body Vultr takes. */
  const createBody = (inputs: Record<string, unknown>) => ({
    ip_type: inputs.ipType,
    protocol: inputs.protocol,
    subnet: inputs.subnet,
    subnet_size: inputs.subnetSize,
    ...(inputs.port ? { port: inputs.port } : {}),
    ...(inputs.notes ? { notes: inputs.notes } : {}),
  });

  /**
   * The up that made the cluster: Vultr makes each of the program's rules,
   * and state records its id under the rule's resource name.
   */
  function deployed(resources: Captured[]) {
    const api = vultrFirewallApi({ groupId: 'fwg-uuid', description: GROUP_NAME });
    const state = new Map<string, number>();
    for (const r of byType(resources, RULE)) {
      const row = api.create(createBody(r.inputs));
      if (!row) throw new Error(`Vultr refused the program's rule ${r.name}`);
      state.set(r.name, row.id);
    }
    // From here on, the calls are the REST writers'.
    api.calls.length = 0;
    net.fetch = api.fetch;
    return { api, state };
  }

  /**
   * What the next up plans for the FirewallRules. Its refresh drops from
   * state a rule whose id Vultr no longer lists. A rule still in state whose
   * live fields differ from the program's is replaced (every FirewallRule
   * field is ForceNew), a declared rule not in state is created, and a rule
   * in state the program no longer declares is deleted.
   */
  function plan(
    state: Map<string, number>,
    api: ReturnType<typeof vultrFirewallApi>,
    resources: Captured[],
  ) {
    const declared = byType(resources, RULE);
    const refreshed = new Map([...state].filter(([, id]) => api.rules.has(id)));
    const out = { create: [] as string[], replace: [] as string[], delete: [] as string[] };
    for (const r of declared) {
      const id = refreshed.get(r.name);
      if (id === undefined) {
        out.create.push(r.name);
        continue;
      }
      const live = api.rules.get(id) as Record<string, unknown>;
      const want = createBody(r.inputs);
      if (ruleFields(live) !== ruleFields(want) || live.notes !== (want.notes ?? '')) {
        out.replace.push(r.name);
      }
    }
    for (const name of refreshed.keys()) {
      if (!declared.some((r) => r.name === name)) out.delete.push(name);
    }
    return out;
  }

  const deletes = (api: ReturnType<typeof vultrFirewallApi>) =>
    api.calls.filter((c) => c.method === 'DELETE');
  const operatorRules = (api: ReturnType<typeof vultrFirewallApi>) =>
    api.summary().filter((r) => / (22|6443) operator-/.test(r));

  it("the deploy's push adds 22 and 6443 to a group with neither, and deletes nothing", async () => {
    const { resources } = await run(baseConfig);
    const { api } = deployed(resources);
    const programRules = new Map(api.rules);

    const provider = new VultrProvider('t');
    expect(
      await provider.applyOperatorCidrs({
        firewallName: GROUP_NAME,
        cidrs: OPERATOR,
        ports: ['22', '6443'],
      }),
    ).toBe(true);

    expect(deletes(api)).toEqual([]);
    for (const [id, row] of programRules) expect(api.rules.get(id), row.notes).toEqual(row);
    expect(operatorRules(api)).toEqual(
      [
        'v4 tcp 203.0.113.5/32 22 operator-22',
        'v6 tcp 2001:db8::1/128 22 operator-22',
        'v4 tcp 203.0.113.5/32 6443 operator-6443',
        'v6 tcp 2001:db8::1/128 6443 operator-6443',
      ].sort(),
    );
  });

  it('an access push changes only the operator rules it adds or drops', async () => {
    const { resources } = await run(baseConfig);
    const { api } = deployed(resources);
    const provider = new VultrProvider('t');
    await provider.applyOperatorCidrs({
      firewallName: GROUP_NAME,
      cidrs: OPERATOR,
      ports: ['22', '6443'],
    });
    const before = new Map(api.rules);
    api.calls.length = 0;

    // An address added: its two rules made, nothing deleted, every id kept.
    await provider.applyOperatorCidrs({ firewallName: GROUP_NAME, cidrs: [...OPERATOR, ADDED] });
    expect(api.calls.map((c) => `${c.method} ${c.rule}`).sort()).toEqual(
      [`POST v4 tcp ${ADDED} 22`, `POST v4 tcp ${ADDED} 6443`].sort(),
    );
    for (const [id, row] of before) expect(api.rules.get(id)).toEqual(row);

    // An address dropped: only its two rules deleted.
    api.calls.length = 0;
    await provider.applyOperatorCidrs({ firewallName: GROUP_NAME, cidrs: [OPERATOR[1], ADDED] });
    expect(api.calls.map((c) => `${c.method} ${c.rule}`).sort()).toEqual(
      ['DELETE v4 tcp 203.0.113.5/32 22', 'DELETE v4 tcp 203.0.113.5/32 6443'].sort(),
    );
    expect(api.state.emptied).toBe(false);
  });

  it('the replication write adds only the peer on UDP 51821', async () => {
    const { resources } = await run(baseConfig);
    const { api } = deployed(resources);
    const before = new Map(api.rules);
    const provider = new VultrProvider('t');

    const fw = await provider.findFirewallByName(GROUP_NAME);
    const rules = provider.buildReplicationFirewallRules(fw, PEER_DB);
    await provider.setFirewallRules(fw.id, rules);

    expect(api.calls).toEqual([
      expect.objectContaining({ method: 'POST', rule: `v4 udp ${PEER_DB}/32 51821` }),
    ]);
    for (const [id, row] of before) expect(api.rules.get(id)).toEqual(row);
  });

  // The pin. A deploy, its push, an access push adding an address and the
  // k8s-ha replication write, then the next program run (a scale, a
  // failover, or the next deploy, handed the saved list with the new
  // address in it): the up plans nothing for any FirewallRule.
  it('after the REST writes, the next up plans no FirewallRule create, replace or delete', async () => {
    const { resources } = await run(baseConfig);
    const { api, state } = deployed(resources);
    const provider = new VultrProvider('t');

    await provider.applyOperatorCidrs({
      firewallName: GROUP_NAME,
      cidrs: OPERATOR,
      ports: ['22', '6443'],
    });
    const saved = [...OPERATOR, ADDED];
    await provider.applyOperatorCidrs({ firewallName: GROUP_NAME, cidrs: saved });
    const fw = await provider.findFirewallByName(GROUP_NAME);
    await provider.setFirewallRules(fw.id, provider.buildReplicationFirewallRules(fw, PEER_DB));

    const next = await run({ ...baseConfig, allowedSshIps: saved, allowedK8sApiIps: saved });
    expect(plan(state, api, next.resources)).toEqual({ create: [], replace: [], delete: [] });
    expect(api.state.emptied).toBe(false);

    // Non-vacuous: REST's rules are all on the group, beside the program's.
    expect(api.summary()).toEqual(
      expect.arrayContaining([
        `v4 tcp ${ADDED} 22 operator-22`,
        `v4 tcp ${ADDED} 6443 operator-6443`,
        `v4 udp ${PEER_DB}/32 51821 wg-replication`,
      ]),
    );
    expect(api.rules.size).toBe(7 + 3 * 2 + 1);
  });
});

describe('the firewall group is the one operator-ip pushes to', () => {
  // A k8s environment, and both sides of a k8s-ha pair.
  it.each(['prod', 'prod-primary', 'prod-standby'])('%s', async (side) => {
    const { resources } = await run({
      ...baseConfig,
      environment: side,
      minWorkers: 0,
      existingSshKeyId: 'shared-key',
    });
    const group = byType(resources, GROUP);
    expect(group).toHaveLength(1);
    expect(group[0].inputs.description).toBe(firewallName(baseConfig.projectName, side));
  });
});

describe('buildVultrK8sProgram with existingSshKeyId', () => {
  it('creates no SSH key and reports the given id', async () => {
    const { outputs, resources } = await run({ ...baseConfig, existingSshKeyId: 'shared-key' });
    expect(byType(resources, SSH_KEY)).toHaveLength(0);
    expect(outputs.sshKeyId).toBe('shared-key');
    for (const i of byType(resources, INSTANCE)) {
      expect(i.inputs.sshKeyIds, i.name).toEqual(['shared-key']);
    }
  });
});

// converge-cluster.js hands a scale or failover the master as prior state
// records it (priorMasterFrom), so the db and workers resize alongside it.
describe('buildVultrK8sProgram for a scale or failover (priorMaster)', () => {
  const PRIOR = { id: 'instance-prior', privateIp: '10.181.32.99' };
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
      expect(userData(instance(resources, name)), name).toContain(
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
      // Non-vacuous: it still waits on the group and its rules.
      expect(deps.length, node).toBeGreaterThan(0);
    }
  });
});

describe('a deploy (no priorMaster) makes the db wait on the master', () => {
  it('lists the master in the db dependencies', async () => {
    const { objects } = await run(baseConfig);
    const master = objects.find((o) => o.name === 'master')?.resource;
    const deps = objects.find((o) => o.name === 'db')?.opts?.dependsOn ?? [];
    expect(deps).toContain(master);
  });
});

describe('a master Vultr gives no VPC address', () => {
  it('fails the program, naming why', async () => {
    // The throw also lands in the db's and the worker's user data, which the
    // runtime serializes as it registers them. A real `pulumi up` fails the
    // program on those unhandled rejections, so this test takes them over
    // from vitest while the program runs, and reads them.
    const caught: unknown[] = [];
    const vitestListeners = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', (reason) => caught.push(reason));
    masterInternalIp = '';
    try {
      const raw = await buildVultrK8sProgram({ ...baseConfig, minWorkers: 1 })();
      await expect(pulumi.output(raw.masterPrivateIp).promise()).rejects.toThrow(NO_VPC_ADDRESS);
      // Until the rejections stop arriving (bounded).
      let stable = 0;
      for (let i = 0; i < 100 && stable < 3; i++) {
        const before = caught.length;
        await new Promise((resolve) => setTimeout(resolve, 20));
        stable = caught.length > 0 && caught.length === before ? stable + 1 : 0;
      }
    } finally {
      masterInternalIp = '10.181.32.3';
      process.removeAllListeners('unhandledRejection');
      for (const listener of vitestListeners) process.on('unhandledRejection', listener);
    }
    expect(caught.length).toBeGreaterThan(0);
    for (const reason of caught) {
      expect(String((reason as Error)?.message ?? reason)).toContain(NO_VPC_ADDRESS);
    }
  });
});
