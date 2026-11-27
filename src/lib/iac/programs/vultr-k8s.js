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
 *   - No reserved IP, as on DigitalOcean: the cluster's domain points at the
 *     master's own public IPv4 (clusterIngressIp, lib/deploy/k8s/ingress-ip.js),
 *     as Vultr compose's does. A reserved IP would never move: failover flips
 *     DNS between the two clusters, a resize keeps the instance's address,
 *     and scale and failover never replace the master (priorMaster). Given
 *     to the master as its main IP, it also broke every destroy: Vultr
 *     refuses to detach a main IP until its server is gone ("The server must
 *     be closed to detach this IP because it is being used as the main IP",
 *     400), and the provider's instance delete returns before the server is
 *     gone, so `pulumi destroy` deleted the master and then failed on the IP
 *     (e2e run 45922250720, vultr k8s and k8s-ha).
 *   - The firewall is a `vultr.FirewallGroup` whose rules are separate
 *     `vultr.FirewallRule` resources, one per (rule, source), as on compose
 *     (vultr-compose.js). Instances attach the group at create
 *     (`firewallGroupId`). UFW is off on every node (_host-firewall-off.sh),
 *     so the group is each node's one network filter, and Vultr does not
 *     enforce a group until it has a rule: every instance waits on the
 *     rules, so none boots behind an empty group.
 *   - One writer per rule. The program declares only the rules nothing else
 *     writes: the web (80, 443) and the VPC. The operator ports (22, 6443)
 *     are REST's: deployK3s writes them right after the up, before its first
 *     ssh (writeOperatorRulesAfterUp, VultrProvider.K8S_OPERATOR_RULES_AFTER_UP),
 *     and `vibecarbon access` rewrites them. So is the k8s-ha replication
 *     rule (UDP 51821). Each REST writer changes only its own rules
 *     (VultrProvider.setFirewallRules is a minimal diff), so the program's
 *     keep their ids and every later up (a scale, a failover, the next
 *     deploy) finds them as it left them. A rule both wrote got a new id from
 *     each REST rewrite, and the next up created it again, which Vultr
 *     refuses ("This rule is already defined").
 *   - Vultr's metadata names each node (its `hostname`), which becomes its
 *     k8s node name, so every instance sets `hostname` to its label.
 *
 * Outputs: masterIp, masterPrivateIp, dbIp, dbPrivateIp, workerIps,
 * networkId, sshKeyId, k3sToken, clusterName, vpcCidr, masterId. No
 * `floatingIp`: VultrProvider.K8S_FLOATING_IP is false, and the domain points
 * at masterIp.
 */

import * as vultr from '@ediri/vultr';
import * as pulumi from '@pulumi/pulumi';
import { cidrToVultrRuleFields, encodeLabels, VultrProvider } from '../../providers/vultr.js';
import { serverResourceOptions, workerResourceOptions } from '../create-timeout.js';
import { requireK3sToken } from '../k3s-token.js';
import {
  requireK8sNodeNamesFit,
  requireOperatorCidrs,
  sshKeyIdOutput,
  stackIdentity,
} from '../program-inputs.js';
import { vpcCidrForCluster } from '../vpc-cidr.js';

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
 * @property {string[]} allowedSshIps    CIDR list, required. Not a rule
 *                                       here: deployK3s writes it after the up.
 * @property {string[]} allowedK8sApiIps CIDR list, required, as allowedSshIps
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
  // The program writes no operator rule (deployK3s does, after the up), but a
  // deploy with no list would make a cluster no operator can reach: refused
  // here, before any server exists.
  requireOperatorCidrs(config, { k8sApi: true });
  // Every node's hostname is its k8s node name (see the boot scripts).
  requireK8sNodeNamesFit(clusterName, VultrProvider.NAME);
  // Always the CLI's: the stack's recorded token or the one derived from the
  // state passphrase (lib/iac/k3s-token.js). Never made here.
  const k3sToken = requireK3sToken(config, 'buildVultrK8sProgram');
  const vpcCidr = vpcCidrForCluster(clusterName, 24);
  const osId = Number(VultrProvider.K8S_IMAGE);
  const minWorkers = config.minWorkers ?? 1;

  // One rule per (port, source): Vultr keeps one subnet per rule. No
  // operator port: those rules are REST's (see the header).
  const WORLD = ['0.0.0.0/0', '::/0'];
  const ruleSpecs = [
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
    // (firewallName) to write the operator ports.
    const firewall = new vultr.FirewallGroup('firewall', {
      description: `${clusterName}-firewall`,
    });

    const rules = ruleSpecs.map((spec) => {
      const fields = cidrToVultrRuleFields(spec.cidr);
      // `source` is deliberately NOT set here, and must not be: a refresh
      // imports a CIDR into it that the provider rejects as input. Repaired
      // centrally by repairVultrFirewallRuleInputs (lib/iac/index.js), which
      // carries the full RCA; see vultr-compose.js.
      // Named by what the rule admits (its notes, one per port and scope, and
      // its family), never by its place in the list: a rule that comes or
      // goes would rename every rule after it, and Pulumi deletes a renamed
      // rule and makes it again.
      return new vultr.FirewallRule(`rule-${spec.notes}-${fields.ip_type}`, {
        firewallGroupId: firewall.id,
        ipType: fields.ip_type,
        protocol: spec.protocol,
        ...(spec.port ? { port: spec.port } : {}),
        subnet: fields.subnet,
        subnetSize: fields.subnet_size,
        notes: spec.notes,
      });
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
    // Vultr's metadata, so its user data needs neither. Replaced
    // create-first, as on DigitalOcean: it holds no address a successor needs
    // freed first, and Vultr picks every VPC address itself.
    const masterUserData = await VultrProvider.getK8sMasterUserData({
      k3s_version: config.k3sVersion,
      k3s_token: k3sToken,
    });
    const master = new vultr.Instance(
      'master',
      {
        ...node(`${clusterName}-master`, config.masterServerType),
        userData: pulumi.secret(masterUserData),
        tags: encodeLabels({ ...labels, role: 'master', cluster: clusterName }),
      },
      serverResourceOptions(INSTANCE, { dependsOn: rules }),
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
      // The cluster's ingress: its domain points here (clusterIngressIp).
      masterIp: master.mainIp,
      // Read back by a scale or failover (converge-cluster.js priorMasterFrom).
      masterId: master.id,
      masterPrivateIp,
      dbIp: dbServer.mainIp,
      dbPrivateIp: dbServer.internalIp,
      workerIps: workers.map((w) => w.mainIp),
      networkId: network.id,
      sshKeyId: sshKeyIdOutput(sshKeyId),
      k3sToken: pulumi.secret(k3sToken),
      clusterName,
      vpcCidr,
    };
  };
}
