/**
 * Pulumi program for a single Vultr k3s cluster.
 *
 * Same config contract and output names as linode-k8s.js, with the ways
 * Vultr differs:
 *
 *   - A `vultr.Vpc` with a per-cluster /24 (vpcCidrForCluster), and each
 *     instance attached to exactly that one VPC (`vpcIds`). Vultr sets
 *     `internal_ip` only when an instance holds one VPC (terraform-provider-
 *     vultr issue 173). It picks the addresses itself, so as on DigitalOcean
 *     the db and worker user data wait on the master's VPC address.
 *   - The ingress address is a `vultr.ReservedIp`, given to the master at
 *     create as its main IP (`reservedIpId`), so it never moves to another
 *     instance and needs no assignment resource. `reservedIpId` is ForceNew:
 *     the master is replaced delete-first, so the old instance frees the
 *     address before the new one asks for it.
 *   - The firewall is a `vultr.FirewallGroup` whose rules are separate
 *     `vultr.FirewallRule` resources, one per (rule, source), as on compose
 *     (vultr-compose.js). Instances attach the group at create
 *     (`firewallGroupId`). UFW is off on every node (_host-firewall-off.sh),
 *     so the group is each node's one network filter, and Vultr does not
 *     enforce a group until it has a rule: every instance waits on the
 *     rules, so none boots behind an empty group.
 *   - Vultr's metadata names each node (its `hostname`), which becomes its
 *     k8s node name, so every instance sets `hostname` to its label.
 *
 * Outputs: masterIp, masterPrivateIp, dbIp, dbPrivateIp, workerIps,
 * floatingIp, networkId, sshKeyId, k3sToken, clusterName, vpcCidr, masterId.
 */

import * as vultr from '@ediri/vultr';
import * as pulumi from '@pulumi/pulumi';
import { cidrToVultrRuleFields, encodeLabels, VultrProvider } from '../../providers/vultr.js';
import { serverResourceOptions, workerResourceOptions } from '../create-timeout.js';
import { requireK3sToken } from '../k3s-token.js';
import { requireOperatorCidrs, sshKeyIdOutput, stackIdentity } from '../program-inputs.js';
import { vpcCidrForCluster } from '../vpc-cidr.js';

/** Kubernetes node names are DNS labels here (the hostname): 63 at most. */
const K8S_NODE_NAME_MAX = 63;

const INSTANCE = 'vultr:index/instance:Instance';

/**
 * @typedef {Object} K8sStackConfig
 * @property {string} projectName
 * @property {string} environment
 * @property {string} sshPublicKey       OpenSSH-format public key
 * @property {string} [existingSshKeyId] k8s-ha's shared key: reuse, create nothing
 * @property {string} k3sToken          The stack's recorded token, or one
 *                                       derived from the state passphrase.
 *                                       Required.
 * @property {boolean} [k3sTokenReplayed] The token is the stack's recorded
 *                                       one. Unused here: every worker keeps
 *                                       its join trigger.
 * @property {{id: string, privateIp: string}} [priorMaster] The master as the
 *   prior state records it. Set only by converge-cluster.js (scale and
 *   failover), whose preview refuses any plan that replaces the master; the
 *   db and workers are built from it so they resize alongside the master.
 * @property {string} location           Vultr region id (e.g. ewr)
 * @property {string} masterServerType
 * @property {string} dbServerType
 * @property {string} workerServerType
 * @property {number} [minWorkers]       Default 1
 * @property {string} k3sVersion
 * @property {Record<string,string>} [labels]
 * @property {string[]} allowedSshIps    CIDR list, required
 * @property {string[]} allowedK8sApiIps CIDR list, required
 *
 * No API token: no node's user data carries it. deployK3s hands it to the
 * cluster's `vultr-csi` kube-system Secret, the CSI driver's credential,
 * itself (applyCloudSecrets).
 */

/**
 * @param {K8sStackConfig} config
 * @returns {() => Promise<Record<string, unknown>>}
 */
export function buildVultrK8sProgram(config) {
  const { name: clusterName, labels } = stackIdentity(config);
  requireOperatorCidrs(config, { k8sApi: true });
  // Every node's hostname is its k8s node name (see the boot scripts), which
  // Kubernetes caps at 63. The longest is an autoscaler worker:
  // `<cluster>-ca-` plus 8 random characters.
  const longestNodeName = `${clusterName}-ca-xxxxxxxx`;
  if (longestNodeName.length > K8S_NODE_NAME_MAX) {
    throw new Error(
      `Kubernetes on Vultr cannot give this cluster's nodes a node name: the longest, ` +
        `"${clusterName}-ca-<8 characters>", is ${longestNodeName.length} characters and ` +
        `Kubernetes allows ${K8S_NODE_NAME_MAX}. Use a shorter project or environment name.`,
    );
  }
  // Always the CLI's: the stack's recorded token or the one derived from the
  // state passphrase (lib/iac/k3s-token.js). Never made here.
  const k3sToken = requireK3sToken(config, 'buildVultrK8sProgram');
  const vpcCidr = vpcCidrForCluster(clusterName, 24);
  const osId = Number(VultrProvider.K8S_IMAGE);
  const minWorkers = config.minWorkers ?? 1;

  // One rule per (port, source): Vultr keeps one subnet per rule. The
  // operator ports carry the notes applyOperatorCidrs writes when it
  // rewrites them over REST (operator-ip.js), so a rewrite and a fresh deploy
  // leave the same rules.
  const WORLD = ['0.0.0.0/0', '::/0'];
  const ruleSpecs = [
    ...config.allowedSshIps.map((cidr) => ({
      protocol: 'tcp',
      port: '22',
      cidr,
      notes: 'operator-22',
    })),
    ...config.allowedK8sApiIps.map((cidr) => ({
      protocol: 'tcp',
      port: '6443',
      cidr,
      notes: 'operator-6443',
    })),
    ...WORLD.map((cidr) => ({ protocol: 'tcp', port: '80', cidr, notes: 'http' })),
    ...WORLD.map((cidr) => ({ protocol: 'tcp', port: '443', cidr, notes: 'https' })),
    // Internal cluster traffic (flannel VXLAN, kubelet, registry mirror),
    // scoped to the VPC. Vultr's docs do not say whether a group filters VPC
    // traffic; accepting it explicitly is correct either way.
    { protocol: 'tcp', port: '1:65535', cidr: vpcCidr, notes: 'vpc-tcp' },
    { protocol: 'udp', port: '1:65535', cidr: vpcCidr, notes: 'vpc-udp' },
    { protocol: 'icmp', cidr: vpcCidr, notes: 'vpc-icmp' },
  ];

  return async () => {
    let sshKeyId; // frozen-contract shape: string | Output<string>
    if (config.existingSshKeyId) {
      sshKeyId = config.existingSshKeyId;
    } else {
      // @ediri/vultr spells it `SSHKey` (see vultr-compose.js).
      const sshKey = new vultr.SSHKey('ssh-key', {
        name: `${clusterName}-${config.location}-key`,
        sshKey: config.sshPublicKey.trim(),
      });
      sshKeyId = sshKey.id;
    }
    const sshKeyIds = [sshKeyId];

    const [vpcSubnet, vpcMask] = vpcCidr.split('/');
    const network = new vultr.Vpc('network', {
      description: `${clusterName}-network`,
      region: config.location,
      v4Subnet: vpcSubnet,
      v4SubnetMask: Number(vpcMask),
    });

    // Autoscaled workers attach this same group: the autoscaler resolves
    // `${clusterName}-firewall` to its id (renderCarbonAutoscalerConfig's
    // firewallName) and VultrProvider.createServer sends it as
    // `firewall_group_id`. operator-ip.js finds it by the same description
    // (firewallName) to rewrite the operator ports.
    const firewall = new vultr.FirewallGroup('firewall', {
      description: `${clusterName}-firewall`,
    });

    const rules = ruleSpecs.map((spec, i) => {
      const fields = cidrToVultrRuleFields(spec.cidr);
      // `source` is deliberately NOT set here, and must not be: a refresh
      // imports a CIDR into it that the provider rejects as input. Repaired
      // centrally by repairVultrFirewallRuleInputs (lib/iac/index.js), which
      // carries the full RCA; see vultr-compose.js.
      return new vultr.FirewallRule(`rule-${i}`, {
        firewallGroupId: firewall.id,
        ipType: fields.ip_type,
        protocol: spec.protocol,
        ...(spec.port ? { port: spec.port } : {}),
        subnet: fields.subnet,
        subnetSize: fields.subnet_size,
        notes: spec.notes,
      });
    });

    const reservedIp = new vultr.ReservedIp('ingress', {
      region: config.location,
      ipType: 'v4',
      label: `${clusterName}-ingress`,
    });

    /** What every instance shares: region, image, key, the one VPC, the group. */
    const node = (label, plan) => ({
      label,
      hostname: label,
      region: config.location,
      plan,
      osId,
      sshKeyIds,
      vpcIds: [network.id],
      firewallGroupId: firewall.id,
    });

    // Master. Its boot script reads its own addresses and instance id from
    // Vultr's metadata, so its user data needs neither.
    const masterUserData = await VultrProvider.getK8sMasterUserData({
      k3s_version: config.k3sVersion,
      k3s_token: k3sToken,
    });
    const master = new vultr.Instance(
      'master',
      {
        ...node(`${clusterName}-master`, config.masterServerType),
        reservedIpId: reservedIp.id,
        userData: pulumi.secret(masterUserData),
        tags: encodeLabels({ ...labels, role: 'master', cluster: clusterName }),
      },
      serverResourceOptions(INSTANCE, { deleteBeforeReplace: true, dependsOn: rules }),
    );

    // The master's private address, and what its db and workers wait on. A
    // deploy reads both off the live master. A scale or failover names the
    // master from prior state (config.priorMaster, see converge-cluster.js
    // priorMasterFrom), where it cannot be replaced, so the db and workers
    // resize alongside it rather than after it.
    const masterPrivateIp =
      config.priorMaster?.privateIp ??
      master.internalIp.apply((ip) => {
        if (!ip) {
          throw new Error(
            'Vultr gave the master no VPC address (internal_ip is empty), so the other ' +
              'nodes cannot join it over the private network.',
          );
        }
        return ip;
      });
    const masterDeps = config.priorMaster ? [firewall, ...rules] : [master, firewall, ...rules];

    const dbUserData = pulumi.all([masterPrivateIp]).apply(([ip]) =>
      VultrProvider.getK8sDbUserData({
        k3s_version: config.k3sVersion,
        k3s_token: k3sToken,
        master_ip: ip,
      }),
    );
    const dbServer = new vultr.Instance(
      'db',
      {
        ...node(`${clusterName}-db`, config.dbServerType),
        userData: pulumi.secret(dbUserData),
        tags: encodeLabels({
          ...labels,
          role: 'db',
          'node-pool': 'db-pool',
          cluster: clusterName,
        }),
      },
      serverResourceOptions(INSTANCE, { dependsOn: masterDeps }),
    );

    // Every worker joins the same master over the same address, so the user
    // data is rendered once.
    const workerUserData = pulumi.all([masterPrivateIp]).apply(([ip]) =>
      VultrProvider.getK8sWorkerUserData({
        k3s_version: config.k3sVersion,
        k3s_token: k3sToken,
        master_ip: ip,
      }),
    );
    const workers = [];
    for (let i = 0; i < minWorkers; i++) {
      workers.push(
        new vultr.Instance(
          `worker-${i + 1}`,
          {
            ...node(`${clusterName}-worker-${i + 1}`, config.workerServerType),
            userData: pulumi.secret(workerUserData),
            // 'cluster-autoscaler/node': 'static' marks Pulumi-owned workers
            // apart from autoscaler-spawned ones for the destroy sweep.
            tags: encodeLabels({
              ...labels,
              role: 'worker',
              'node-pool': 'worker-pool',
              'cluster-autoscaler/node': 'static',
              cluster: clusterName,
            }),
          },
          // The join trigger stays on a first deploy too: the worker waits
          // on the master's address anyway, so leaving it out would gain
          // nothing (see workerResourceOptions).
          workerResourceOptions(INSTANCE, {
            dependsOn: masterDeps,
            joinTarget: {
              masterId: config.priorMaster?.id ?? master.id,
              masterPrivateIp,
              k3sVersion: config.k3sVersion,
            },
          }),
        ),
      );
    }

    return {
      masterIp: reservedIp.subnet,
      // Read back by a scale or failover (converge-cluster.js priorMasterFrom).
      masterId: master.id,
      masterPrivateIp,
      dbIp: dbServer.mainIp,
      dbPrivateIp: dbServer.internalIp,
      workerIps: workers.map((w) => w.mainIp),
      floatingIp: reservedIp.subnet,
      networkId: network.id,
      sshKeyId: sshKeyIdOutput(sshKeyId),
      k3sToken: pulumi.secret(k3sToken),
      clusterName,
      vpcCidr,
    };
  };
}
