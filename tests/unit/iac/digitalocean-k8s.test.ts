/**
 * M3 Task 5 — buildDigitalOceanK8sProgram program-shape tests.
 *
 * Unlike digitalocean-compose.test.ts / hetzner-k8s.js's own tests (which
 * only exercise the synchronous config-guard + "returns an async function"
 * shape, never actually invoking the program), this file runs the program
 * for real through `pulumi.runtime.setMocks` — the standard Pulumi
 * unit-test harness (no prior precedent in this repo). Mocks return
 * synthetic ids/computed fields (ipv4Address, ipv4AddressPrivate, vpc id,
 * reserved-ip address) so the program's actual resource graph — including
 * the master-private-IP-dependent supabase/worker user-data `.apply()`
 * chains — executes end to end, letting these tests assert on REAL
 * resolved resource inputs rather than re-deriving them by hand.
 */
import * as pulumi from '@pulumi/pulumi';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildDigitalOceanK8sProgram,
  vpcCidrForCluster,
} from '../../../src/lib/iac/programs/digitalocean-k8s.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';

type CapturedResource = { type: string; name: string; inputs: Record<string, unknown> };

const capturedResources: CapturedResource[] = [];
let dropletCounter = 0;

pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs) {
      capturedResources.push({ type: args.type, name: args.name, inputs: args.inputs });
      switch (args.type) {
        case 'digitalocean:index/droplet:Droplet': {
          dropletCounter += 1;
          // Numeric-string ids (mirrors real DO droplet ids) — the program
          // does `master.id.apply((id) => Number.parseInt(id, 10))` for the
          // ReservedIpAssignment, so a non-numeric mock id would silently
          // produce NaN and mask a real bug.
          const id = String(9_000_000 + dropletCounter);
          return {
            id,
            state: {
              ...args.inputs,
              ipv4Address: `203.0.113.${dropletCounter}`,
              ipv4AddressPrivate: `10.10.0.${10 + dropletCounter}`,
            },
          };
        }
        case 'digitalocean:index/vpc:Vpc':
          return { id: 'vpc-mock-id', state: { ...args.inputs } };
        case 'digitalocean:index/reservedIp:ReservedIp':
          return { id: '203.0.113.250', state: { ...args.inputs, ipAddress: '203.0.113.250' } };
        case 'digitalocean:index/reservedIpAssignment:ReservedIpAssignment':
          return { id: 'assignment-mock-id', state: { ...args.inputs } };
        case 'digitalocean:index/sshKey:SshKey':
          return { id: '999888', state: { ...args.inputs } };
        case 'digitalocean:index/firewall:Firewall':
          return { id: 'fw-mock-id', state: { ...args.inputs } };
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
  sshPublicKey: 'ssh-ed25519 AAAAtest test@example.com',
  location: 'nyc3',
  masterServerType: 's-2vcpu-4gb',
  supabaseServerType: 's-2vcpu-4gb',
  workerServerType: 's-2vcpu-4gb',
  minWorkers: 2,
  maxWorkers: 3,
  k3sVersion: 'v1.31.5+k3s1',
  apiToken: 'dop_v1_test_token_1234',
  allowedSshIps: ['203.0.113.5/32'],
  allowedK8sApiIps: ['203.0.113.5/32'],
  labels: { 'managed-by': 'vibecarbon', 'os-flavor': 'k3s' },
};

const CLUSTER_NAME = 'acme-prod';

/**
 * Calling the program directly (bypassing the real Automation API's
 * `stack.up()`, which internally waits for the WHOLE resource graph to
 * settle before returning) means `program()`'s own returned promise
 * resolves as soon as the top-level async function body returns — NOT once
 * every constructed resource has finished registering against the mock
 * monitor. Supabase/worker droplets in particular depend on an async
 * `.apply()` chain (dynamic-imports the cloud-init renderer), so their
 * `newResource` calls can still be in flight after `program()` resolves.
 * Poll `capturedResources` until the expected count lands rather than
 * asserting against a still-filling array.
 */
async function waitForResourceCount(min: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (capturedResources.length < min) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out waiting for ${min} captured resources (got ${capturedResources.length})`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('buildDigitalOceanK8sProgram — config guard (H-2, byte-parity with hetzner-k8s.js/digitalocean-compose.js)', () => {
  it('throws synchronously when allowedSshIps is empty', () => {
    expect(() => buildDigitalOceanK8sProgram({ ...baseConfig, allowedSshIps: [] })).toThrow(
      /allowedSshIps required/,
    );
  });

  it('throws synchronously when allowedSshIps is omitted entirely', () => {
    const { allowedSshIps: _drop, ...withoutIps } = baseConfig;
    expect(() => buildDigitalOceanK8sProgram(withoutIps)).toThrow(/allowedSshIps required/);
  });

  it('throws synchronously when allowedK8sApiIps is empty', () => {
    expect(() => buildDigitalOceanK8sProgram({ ...baseConfig, allowedK8sApiIps: [] })).toThrow(
      /allowedK8sApiIps required/,
    );
  });

  it('returns an async program function when config is valid (does not invoke Pulumi yet)', () => {
    const program = buildDigitalOceanK8sProgram(baseConfig);
    expect(typeof program).toBe('function');
    expect(program.constructor.name).toBe('AsyncFunction');
    // No resources registered just from building the program.
    expect(capturedResources.length).toBe(0);
  });
});

describe('buildDigitalOceanK8sProgram — resource graph (via Pulumi mocks)', () => {
  let outputs: Record<string, unknown>;

  beforeAll(async () => {
    const program = buildDigitalOceanK8sProgram(baseConfig);
    const rawOutputs = await program();
    // sshKey, vpc, tag, firewall, master, reservedIp, reservedIpAssignment,
    // supabase, worker-1, worker-2 = 10 resources for this config (M3 Task
    // 9b added the pre-created cluster Tag the firewall dependsOn).
    await waitForResourceCount(10);
    // pulumi.output(...).promise() deeply resolves every nested Output
    // (including the workerIps array) into a plain value tree — the
    // program's raw return contains live Output instances, not resolved
    // strings, since we bypass the Automation API's own output-flattening.
    outputs = (await pulumi.output(rawOutputs).promise()) as Record<string, unknown>;
  });

  function byType(type: string): CapturedResource[] {
    return capturedResources.filter((r) => r.type === type);
  }

  it('names every resource with the cluster-name parity strings renderCarbonAutoscalerConfig expects (wire contract)', () => {
    const vpc = byType('digitalocean:index/vpc:Vpc')[0];
    expect(vpc.inputs.name).toBe(`${CLUSTER_NAME}-network`);

    const firewall = byType('digitalocean:index/firewall:Firewall')[0];
    expect(firewall.inputs.name).toBe(`${CLUSTER_NAME}-firewall`);

    const sshKey = byType('digitalocean:index/sshKey:SshKey')[0];
    expect(sshKey.inputs.name).toBe(`${CLUSTER_NAME}-nyc3-key`);

    const dropletNames = byType('digitalocean:index/droplet:Droplet')
      .map((d) => d.inputs.name)
      .sort();
    expect(dropletNames).toEqual(
      [
        `${CLUSTER_NAME}-master`,
        `${CLUSTER_NAME}-supabase`,
        `${CLUSTER_NAME}-worker-1`,
        `${CLUSTER_NAME}-worker-2`,
      ].sort(),
    );
  });

  it('exports EXACTLY the frozen output-contract keys, plus the DO-only vpcCidr addition (M3 Task 9c)', () => {
    expect(Object.keys(outputs).sort()).toEqual(
      [
        'masterIp',
        'masterPrivateIp',
        'supabaseIp',
        'supabasePrivateIp',
        'workerIps',
        'floatingIp',
        'networkId',
        'sshKeyId',
        'k3sToken',
        'clusterName',
        'vpcCidr',
      ].sort(),
    );
    expect(outputs.clusterName).toBe(CLUSTER_NAME);
    expect(outputs.k3sToken).toBeTypeOf('string');
    expect((outputs.k3sToken as string).length).toBeGreaterThan(0);
    expect(Array.isArray(outputs.workerIps)).toBe(true);
    expect((outputs.workerIps as string[]).length).toBe(2);
  });

  it('vpcCidr is the Vpc.ipRange actually used — the per-cluster derived range when vpcIpRange is omitted', () => {
    // baseConfig never sets vpcIpRange, so this pins the SAME default value
    // buildDigitalOceanK8sProgram falls back to internally
    // (vpcCidrForCluster — DO enforces account-wide CIDR uniqueness, so the
    // default is derived per cluster, never a fixed literal), proving the
    // output is the value actually applied to the Vpc resource, not a
    // separately-typed literal.
    const vpc = byType('digitalocean:index/vpc:Vpc')[0];
    expect(outputs.vpcCidr).toBe(vpc.inputs.ipRange);
    expect(outputs.vpcCidr).toBe(vpcCidrForCluster(CLUSTER_NAME));
    expect(outputs.vpcCidr).not.toBe('10.10.0.0/20');
  });

  it('masterPrivateIp/supabasePrivateIp are the REAL Pulumi-resolved addresses, not Hetzner-style hardcoded literals', () => {
    expect(outputs.masterPrivateIp).toBe('10.10.0.11');
    expect(outputs.masterIp).toBe('203.0.113.1');
    expect(outputs.masterPrivateIp).not.toBe('10.0.1.1');
    expect(outputs.supabasePrivateIp).not.toBe('10.0.1.2');
    expect(outputs.supabasePrivateIp).not.toBe(outputs.masterPrivateIp);
  });

  it('floatingIp output is the Reserved IP address; networkId is the Vpc id; sshKeyId the SshKey id', () => {
    expect(outputs.floatingIp).toBe('203.0.113.250');
    expect(outputs.networkId).toBe('vpc-mock-id');
    expect(outputs.sshKeyId).toBe('999888');
  });

  it('threads the SAME vpcUuid (the Vpc id) to master, supabase, and every worker droplet', () => {
    const droplets = byType('digitalocean:index/droplet:Droplet');
    expect(droplets.length).toBe(4);
    for (const d of droplets) {
      expect(d.inputs.vpcUuid).toBe('vpc-mock-id');
    }
  });

  it('uses DigitalOceanProvider.K8S_IMAGE as the default droplet image for every role', () => {
    const droplets = byType('digitalocean:index/droplet:Droplet');
    for (const d of droplets) {
      expect(d.inputs.image).toBe(DigitalOceanProvider.K8S_IMAGE);
    }
  });

  it('assigns the Reserved IP to the master droplet (ReservedIpAssignment)', () => {
    const master = byType('digitalocean:index/droplet:Droplet').find(
      (d) => d.inputs.name === `${CLUSTER_NAME}-master`,
    );
    const assignment = byType('digitalocean:index/reservedIpAssignment:ReservedIpAssignment')[0];
    expect(assignment.inputs.ipAddress).toBe('203.0.113.250');
    // master is always the first Droplet-type resource registered (supabase
    // and every worker's inputs depend on master.ipv4AddressPrivate, so
    // Pulumi cannot resolve them before master resolves) — id 9000001.
    expect(assignment.inputs.dropletId).toBe(9_000_001);
    expect(master?.inputs).toBeDefined();
  });

  it('tags every droplet with the canonical role/node-pool/cluster tags (Task 1 encodeLabel contract)', () => {
    const droplets = byType('digitalocean:index/droplet:Droplet');
    const master = droplets.find((d) => d.inputs.name === `${CLUSTER_NAME}-master`);
    const supabase = droplets.find((d) => d.inputs.name === `${CLUSTER_NAME}-supabase`);
    const workers = droplets.filter((d) => (d.inputs.name as string).includes('-worker-'));

    expect(master?.inputs.tags).toEqual(
      expect.arrayContaining(['role:master', `cluster:${CLUSTER_NAME}`, 'managed-by:vibecarbon']),
    );
    expect(supabase?.inputs.tags).toEqual(
      expect.arrayContaining([
        'role:supabase',
        'node-pool:supabase-pool',
        `cluster:${CLUSTER_NAME}`,
      ]),
    );
    for (const w of workers) {
      // '/' -> '-' encoding (Task 1 canonical contract): distinguishes
      // Pulumi-static workers from CA-spawned ones for the destroy sweep.
      expect(w.inputs.tags).toEqual(
        expect.arrayContaining([
          'role:worker',
          'node-pool:worker-pool',
          'cluster-autoscaler-node:static',
          `cluster:${CLUSTER_NAME}`,
        ]),
      );
    }
  });

  it('firewall attaches by the cluster tag (not a droplet-id list)', () => {
    const firewall = byType('digitalocean:index/firewall:Firewall')[0];
    expect(firewall.inputs.tags).toEqual([`cluster:${CLUSTER_NAME}`]);
    expect(firewall.inputs.dropletIds).toBeUndefined();
  });

  // M3 Task 9b — DO's firewall-create API 422s ("tag ... does not exist")
  // unless every tag it references already exists as a real Tag resource
  // (verified against the DigitalOcean OpenAPI spec — see the program's
  // module doc). This pins that EVERY tag string in the firewall's `tags`
  // array has a matching `digitalocean.Tag` resource with that exact name,
  // so a future tag addition to the firewall without a matching Tag
  // resource fails this test instead of 422ing against the real API.
  it('pre-creates a digitalocean.Tag resource for every tag the firewall references', () => {
    const firewall = byType('digitalocean:index/firewall:Firewall')[0];
    const firewallTags = firewall.inputs.tags as string[];
    const tagResourceNames = byType('digitalocean:index/tag:Tag').map((t) => t.inputs.name);

    expect(firewallTags.length).toBeGreaterThan(0);
    for (const wireTag of firewallTags) {
      expect(tagResourceNames).toContain(wireTag);
    }
  });

  it('restricts 22 (SSH) and 6443 (k8s API) to the operator CIDRs, opens 80/443 publicly', () => {
    const firewall = byType('digitalocean:index/firewall:Firewall')[0];
    const rules = firewall.inputs.inboundRules as Array<Record<string, unknown>>;

    const sshRule = rules.find((r) => r.portRange === '22');
    const apiRule = rules.find((r) => r.portRange === '6443');
    const httpRule = rules.find((r) => r.portRange === '80');
    const httpsRule = rules.find((r) => r.portRange === '443');

    expect(sshRule?.sourceAddresses).toEqual(baseConfig.allowedSshIps);
    expect(apiRule?.sourceAddresses).toEqual(baseConfig.allowedK8sApiIps);
    expect(httpRule?.sourceAddresses).toEqual(['0.0.0.0/0', '::/0']);
    expect(httpsRule?.sourceAddresses).toEqual(['0.0.0.0/0', '::/0']);
  });

  it('scopes internal cluster traffic (tcp/udp/icmp) to the VPC CIDR, not 0.0.0.0/0', () => {
    const firewall = byType('digitalocean:index/firewall:Firewall')[0];
    const rules = firewall.inputs.inboundRules as Array<Record<string, unknown>>;
    // The internal rules must scope to the SAME derived range the Vpc uses.
    const vpcCidr = vpcCidrForCluster(CLUSTER_NAME);

    const internalTcp = rules.find((r) => r.protocol === 'tcp' && r.portRange === '1-65535');
    const internalUdp = rules.find((r) => r.protocol === 'udp' && r.portRange === '1-65535');
    const internalIcmp = rules.find((r) => r.protocol === 'icmp');

    expect(internalTcp?.sourceAddresses).toEqual([vpcCidr]);
    expect(internalUdp?.sourceAddresses).toEqual([vpcCidr]);
    expect(internalIcmp?.sourceAddresses).toEqual([vpcCidr]);
  });

  // M3 Task 5b (Fix D.2) — exact-total resource-count pin. Catches a
  // silent resource add/drop (e.g. a future edit that stops creating the
  // ReservedIpAssignment, or accidentally doubles up a Droplet) that none
  // of the by-type/by-name assertions above would notice on their own.
  // M3 Task 9b bumped 9 -> 10 (added the pre-created cluster Tag).
  it('registers EXACTLY 10 resources for minWorkers:2 (sshKey, vpc, tag, firewall, master, reservedIp, reservedIpAssignment, supabase, 2x worker)', () => {
    expect(capturedResources.length).toBe(10);
  });

  // M3 Task 5b (Fix D.2) — the outbound rules were declared but never
  // pinned by a test; a future edit that silently dropped them would leave
  // the cluster unable to reach the internet (package installs, the k3s
  // installer's github.com fetch, DO's own metadata/API endpoints) with no
  // test catching the regression.
  it('declares the firewall outbound rules allowing all egress (tcp/udp/icmp to 0.0.0.0/0 and ::/0)', () => {
    const firewall = byType('digitalocean:index/firewall:Firewall')[0];
    const rules = firewall.inputs.outboundRules as Array<Record<string, unknown>>;

    expect(rules).toEqual([
      { protocol: 'tcp', portRange: '1-65535', destinationAddresses: ['0.0.0.0/0', '::/0'] },
      { protocol: 'udp', portRange: '1-65535', destinationAddresses: ['0.0.0.0/0', '::/0'] },
      { protocol: 'icmp', destinationAddresses: ['0.0.0.0/0', '::/0'] },
    ]);
  });

  it('renders master user-data through DigitalOceanProvider.getK8sMasterUserData + transliterateToAscii (do_token embedded, no placeholders)', () => {
    const master = byType('digitalocean:index/droplet:Droplet').find(
      (d) => d.inputs.name === `${CLUSTER_NAME}-master`,
    );
    const userData = master?.inputs.userData as string;
    expect(userData).toContain('--from-literal=access-token="dop_v1_test_token_1234"');
    expect(userData).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
    expect([...userData].every((ch) => (ch.codePointAt(0) ?? 0) <= 0x7f)).toBe(true);
  });

  it('renders supabase/worker user-data with the REAL master private IP (not a placeholder or the master literal)', () => {
    const droplets = byType('digitalocean:index/droplet:Droplet');
    const supabase = droplets.find((d) => d.inputs.name === `${CLUSTER_NAME}-supabase`);
    const worker1 = droplets.find((d) => d.inputs.name === `${CLUSTER_NAME}-worker-1`);

    const supabaseUserData = supabase?.inputs.userData as string;
    const workerUserData = worker1?.inputs.userData as string;

    expect(supabaseUserData).toContain('K3S_URL="https://10.10.0.11:6443"');
    expect(supabaseUserData).toContain('--node-taint="dedicated=supabase:NoSchedule"');
    expect(workerUserData).toContain('K3S_URL="https://10.10.0.11:6443"');
    expect(workerUserData).not.toContain('--node-taint="dedicated=supabase:NoSchedule"');
    expect(supabaseUserData).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
    expect(workerUserData).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
  });
});

describe('buildDigitalOceanK8sProgram — existingSshKeyId reuse (HA shared key)', () => {
  let outputs: Record<string, unknown>;
  // NOTE: must be captured inside beforeAll, not at describe-body eval
  // time — vitest evaluates every describe() callback body up front during
  // test collection (before any beforeAll runs), so `capturedResources` is
  // still empty at that point regardless of run order.
  let runStart = 0;

  beforeAll(async () => {
    runStart = capturedResources.length;
    const program = buildDigitalOceanK8sProgram({
      ...baseConfig,
      existingSshKeyId: '424242',
    });
    const rawOutputs = await program();
    // vpc, tag, firewall, master, reservedIp, reservedIpAssignment, supabase,
    // worker-1, worker-2 = 9 resources (no SshKey — existingSshKeyId reused;
    // M3 Task 9b bumped 8 -> 9 for the pre-created cluster Tag).
    await waitForResourceCount(runStart + 9);
    outputs = (await pulumi.output(rawOutputs).promise()) as Record<string, unknown>;
  });

  it('does not create a new SshKey resource and reuses the id verbatim in outputs + droplet sshKeys', () => {
    const thisRun = capturedResources.slice(runStart);
    const sshKeys = thisRun.filter((r) => r.type === 'digitalocean:index/sshKey:SshKey');
    expect(sshKeys.length).toBe(0);
    expect(outputs.sshKeyId).toBe('424242');

    const droplets = thisRun.filter((r) => r.type === 'digitalocean:index/droplet:Droplet');
    for (const d of droplets) {
      expect(d.inputs.sshKeys).toEqual(['424242']);
    }
  });
});
