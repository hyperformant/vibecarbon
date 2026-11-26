/**
 * Pulumi program for a single Scaleway k3s cluster.
 *
 * Same config contract and output names as vultr-k8s.js, with the ways
 * Scaleway differs:
 *
 *   - A `network.Vpc` and its one `network.PrivateNetwork` per cluster, both
 *     named `${clusterName}-network`, in the zone's region, the network on
 *     the cluster's /24 (vpcCidrForCluster). Routing is on in every new VPC,
 *     and an instance's security group never filters its Private Network
 *     NIC (only a group applied to that NIC would, and none is), so the VPC
 *     is the isolation: two environments in one VPC would reach each other's
 *     kubelet, flannel and database ports.
 *   - Dynamic private addresses. Every server joins the network at create
 *     (`privateNetworks`), and Scaleway's DHCP gives the NIC an address. The
 *     master's is the first IPv4 inside the subnet among `master.privateIps`
 *     (IPAM's view of the NIC), so the db and worker user data wait on the
 *     master, as on DigitalOcean and Vultr. The network gets no Public
 *     Gateway and no default route: the boot refuses a Private Network NIC
 *     that carries the default route (_scaleway-metadata.sh).
 *   - Every node holds its own flexible IP (`instance.Ip`), attached at
 *     create (`ipIds`). The master's is the cluster's ingress address. A
 *     flexible IP stays with its server, where a dynamic one is released on
 *     every stop, and the db's public address is its WireGuard endpoint. One
 *     IP holds one server, so every node is replaced delete-first.
 *   - The firewall is an `instance.SecurityGroup` with its rules inline, as
 *     on compose, and it declares every rule REST writes too: 22 and 6443
 *     from the saved operator CIDRs (deployK3s and converge-cluster pass
 *     them), and, on a k8s-ha side with a peer on record, UDP 51821 from the
 *     peer's database node (replicationPeerIpFor). Every up refreshes first,
 *     then resets the group to these rules, and the provider compares the
 *     list in order. So they are declared in the one order the REST writers
 *     (ScalewayProvider.applyOperatorCidrs, buildReplicationFirewallRules)
 *     produce: the web, the replication rule, then 22, then 6443
 *     (tests/unit/iac/k8s-firewall-round-trip-census.test.ts). The next up
 *     then plans no rule change after any REST write.
 *   - A zoned resource's id is `<zone>/<uuid>` and a regional one's
 *     `<region>/<uuid>` (the bridged provider's form). The outputs the REST
 *     paths read (masterId, networkId) are bare UUIDs, and so is the master
 *     id in the workers' join trigger, so a scale's priorMaster (read from
 *     masterId) spells it as a deploy did.
 *
 * Outputs: masterIp, masterPrivateIp, dbIp, dbPrivateIp, workerIps,
 * floatingIp, networkId, sshKeyId, k3sToken, clusterName, vpcCidr, masterId.
 */

import { isIPv4 } from 'node:net';
import * as pulumi from '@pulumi/pulumi';
import * as scaleway from '@pulumiverse/scaleway';
import { cidrContainsIp } from '../../cidr.js';
import { encodeLabels, ScalewayProvider } from '../../providers/scaleway.js';
import { serverResourceOptions, workerResourceOptions } from '../create-timeout.js';
import { requireK3sToken } from '../k3s-token.js';
import {
  requireK8sNodeNamesFit,
  requireOperatorCidrs,
  sshKeyIdOutput,
  stackIdentity,
} from '../program-inputs.js';
import { vpcCidrForCluster } from '../vpc-cidr.js';

const SERVER = ScalewayProvider.SERVER_RESOURCE_TYPE;

/** The replication rule's port: WireGuard between the k8s-ha database nodes. */
const REPLICATION_PORT = 51821;

const IPAM_HINT =
  "If your API key's policy lacks IPAMReadOnly, Scaleway hides that address; add it and deploy again.";

/** A zoned or regional Scaleway id (`<zone>/<uuid>`) as the bare UUID the REST API takes. */
const bareId = (id) => String(id).split('/').pop();

/**
 * A server's address in the cluster's Private Network: the `address` of the
 * first entry of `privateIps` (IPAM's view of the server's NICs, IPv6 among
 * them) that is IPv4 and inside `cidr`. Null when none is, which is also what
 * an API key without IPAM read access sees.
 * @param {Array<{address?: string}>|undefined} privateIps
 * @param {string} cidr the cluster's subnet
 * @returns {string|null}
 */
export function privateIpv4In(privateIps, cidr) {
  for (const entry of privateIps ?? []) {
    const address = entry?.address;
    if (typeof address === 'string' && isIPv4(address) && cidrContainsIp(cidr, address, 4)) {
      return address;
    }
  }
  return null;
}

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
 *   prior state records it (its bare id, from the masterId output). Set only
 *   by converge-cluster.js (scale and failover), whose preview refuses any
 *   plan that replaces the master; the db and workers are built from it so
 *   they resize alongside the master.
 * @property {string} location           Scaleway zone (e.g. fr-par-1)
 * @property {string} masterServerType
 * @property {string} dbServerType
 * @property {string} workerServerType
 * @property {number} [minWorkers]       Default 1
 * @property {string} k3sVersion
 * @property {Record<string,string>} [labels]
 * @property {string[]} allowedSshIps    CIDR list, required: TCP 22, one rule per CIDR
 * @property {string[]} allowedK8sApiIps CIDR list, required: TCP 6443, one rule per CIDR
 * @property {string} [replicationPeerIp] k8s-ha: the peer cluster's database
 *                                       node public IPv4, as recorded
 *                                       (replicationPeerIpFor)
 *
 * No API token: no node's user data carries it. deployK3s hands the cluster
 * its cloud credential itself (applyCloudSecrets).
 */

/**
 * @param {K8sStackConfig} config
 * @returns {() => Promise<Record<string, unknown>>}
 */
export function buildScalewayK8sProgram(config) {
  const { name: clusterName, labels } = stackIdentity(config);
  // A deploy with no list would make a cluster no operator can reach:
  // refused here, before any server exists.
  requireOperatorCidrs(config, { k8sApi: true });
  // Every server's name is its hostname in Scaleway's metadata, and the boot
  // scripts make that the k8s node name.
  requireK8sNodeNamesFit(clusterName, ScalewayProvider.NAME);
  // Always the CLI's: the stack's recorded token or the one derived from the
  // state passphrase (lib/iac/k3s-token.js). Never made here.
  const k3sToken = requireK3sToken(config, 'buildScalewayK8sProgram');
  const zone = config.location;
  // Private Networks and VPCs are regional: fr-par-1 is in fr-par.
  const region = zone.replace(/-\d+$/, '');
  const vpcCidr = vpcCidrForCluster(clusterName, 24);
  const minWorkers = config.minWorkers ?? 1;

  // One rule per (port, source): a Scaleway rule carries one ipRange. Ports
  // are numbers here (dest_port_from and dest_port_to on the wire). No
  // private-network rule: the group never sees that traffic (the header).
  const WORLD = ['0.0.0.0/0', '::/0'];
  const tcp = (port, ipRange) => ({ action: 'accept', protocol: 'TCP', port, ipRange });
  const inboundRules = [
    ...WORLD.map((cidr) => tcp(80, cidr)),
    ...WORLD.map((cidr) => tcp(443, cidr)),
    // Field for field ScalewayProvider.buildReplicationFirewallRules's rule,
    // which has no description. None until the peer is on record: the
    // deploy's REST step opens it then.
    ...(config.replicationPeerIp
      ? [
          {
            action: 'accept',
            protocol: 'UDP',
            port: REPLICATION_PORT,
            ipRange: `${config.replicationPeerIp}/32`,
          },
        ]
      : []),
    ...config.allowedSshIps.map((cidr) => tcp(22, cidr)),
    ...config.allowedK8sApiIps.map((cidr) => tcp(6443, cidr)),
  ];

  /** A node's private address, or the program fails, saying why. */
  const requireAddress = (what, consequence) => (privateIps) => {
    const ip = privateIpv4In(privateIps, vpcCidr);
    if (ip) return ip;
    throw new Error(
      `Scaleway gave ${what} no address in the cluster's Private Network ${vpcCidr}, ` +
        `so ${consequence}. ${IPAM_HINT}`,
    );
  };

  return async () => {
    let sshKeyId; // frozen-contract shape: string | Output<string>
    if (config.existingSshKeyId) {
      sshKeyId = config.existingSshKeyId;
    } else {
      // Scaleway keys are Project-wide: a server takes no key input, and
      // every server in the Project gets every key (see scaleway-compose.js).
      const sshKey = new scaleway.iam.SshKey('ssh-key', {
        name: `${clusterName}-${config.location}-key`,
        publicKey: config.sshPublicKey.trim(),
      });
      sshKeyId = sshKey.id;
    }

    const vpc = new scaleway.network.Vpc('vpc', {
      name: `${clusterName}-network`,
      region,
      tags: encodeLabels(labels),
    });
    // Autoscaled workers join this same network: the autoscaler resolves
    // `${clusterName}-network` to its id (renderCarbonAutoscalerConfig).
    const network = new scaleway.network.PrivateNetwork('network', {
      name: `${clusterName}-network`,
      region,
      vpcId: vpc.id,
      ipv4Subnet: { subnet: vpcCidr },
      tags: encodeLabels(labels),
    });

    // Autoscaled workers attach this same group (renderCarbonAutoscalerConfig's
    // firewallName), and operator-ip.js finds it by the same name to write
    // the operator ports. Servers attach it at create (securityGroupId).
    const firewall = new scaleway.instance.SecurityGroup('firewall', {
      name: `${clusterName}-firewall`,
      zone,
      stateful: true,
      inboundDefaultPolicy: 'drop',
      outboundDefaultPolicy: 'accept',
      inboundRules,
      tags: encodeLabels(labels),
    });

    /**
     * A node's flexible IP, tagged so destroy finds one no record names
     * (deleteReservedIpsByLabels): the project and environment as their own
     * tags.
     */
    const flexibleIp = (name, role) =>
      new scaleway.instance.Ip(name, {
        zone,
        type: 'routed_ipv4',
        tags: encodeLabels({ ...labels, role }),
      });

    /** What every server shares: zone, image, the network, the group, its IP. */
    const node = (name, type, ip) => ({
      name,
      zone,
      type,
      image: ScalewayProvider.K8S_IMAGE,
      securityGroupId: firewall.id,
      ipIds: [ip.id],
      privateNetworks: [{ pnId: network.id }],
      // An SBS root, deleted with the server (terminate only detaches an
      // sbs_volume otherwise), at the size an autoscaled worker gets
      // (ScalewayProvider.createServer).
      rootVolume: {
        volumeType: 'sbs_volume',
        sizeInGb: ScalewayProvider.COMPOSE_ROOT_VOLUME_GB,
        deleteOnTermination: true,
      },
    });

    // Master. Its boot script reads its own identity and finds its Private
    // Network NIC from Scaleway's metadata, so its user data needs neither.
    const ingress = flexibleIp('ingress', 'master');
    const masterUserData = await ScalewayProvider.getK8sMasterUserData({
      k3s_version: config.k3sVersion,
      k3s_token: k3sToken,
    });
    const master = new scaleway.instance.Server(
      'master',
      {
        ...node(`${clusterName}-master`, config.masterServerType, ingress),
        // Plain text under the user-data store's `cloud-init` key.
        userData: pulumi.secret({ 'cloud-init': masterUserData }),
        tags: encodeLabels({ ...labels, role: 'master', cluster: clusterName }),
      },
      serverResourceOptions(SERVER, { deleteBeforeReplace: true }),
    );

    // The master's private address and id, and what its db and workers wait
    // on. A deploy reads both off the live master. A scale or failover names
    // the master from prior state (config.priorMaster, see converge-cluster.js
    // priorMasterFrom), where it cannot be replaced, so the db and workers
    // resize alongside it rather than after it.
    const liveMasterId = master.id.apply(bareId);
    const masterId = config.priorMaster?.id ?? liveMasterId;
    const masterPrivateIp =
      config.priorMaster?.privateIp ??
      master.privateIps.apply(requireAddress('the master', 'the other nodes cannot join it'));
    const masterDeps = config.priorMaster ? [] : [master];

    const dbIp = flexibleIp('db-ip', 'db');
    const dbUserData = pulumi.all([masterPrivateIp]).apply(([ip]) =>
      ScalewayProvider.getK8sDbUserData({
        k3s_version: config.k3sVersion,
        k3s_token: k3sToken,
        master_ip: ip,
      }),
    );
    const db = new scaleway.instance.Server(
      'db',
      {
        ...node(`${clusterName}-db`, config.dbServerType, dbIp),
        userData: pulumi.secret({ 'cloud-init': dbUserData }),
        tags: encodeLabels({
          ...labels,
          role: 'db',
          'node-pool': 'db-pool',
          cluster: clusterName,
        }),
      },
      serverResourceOptions(SERVER, { deleteBeforeReplace: true, dependsOn: masterDeps }),
    );

    // Every worker joins the same master over the same address, so the user
    // data is rendered once.
    const workerUserData = pulumi.all([masterPrivateIp]).apply(([ip]) =>
      ScalewayProvider.getK8sWorkerUserData({
        k3s_version: config.k3sVersion,
        k3s_token: k3sToken,
        master_ip: ip,
      }),
    );
    const workerIps = [];
    for (let i = 0; i < minWorkers; i++) {
      const ip = flexibleIp(`worker-${i + 1}-ip`, 'worker');
      workerIps.push(ip);
      new scaleway.instance.Server(
        `worker-${i + 1}`,
        {
          ...node(`${clusterName}-worker-${i + 1}`, config.workerServerType, ip),
          userData: pulumi.secret({ 'cloud-init': workerUserData }),
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
        // The join trigger stays on a first deploy too: the worker waits on
        // the master's address anyway, so leaving it out would gain nothing
        // (see workerResourceOptions).
        workerResourceOptions(SERVER, {
          deleteBeforeReplace: true,
          dependsOn: masterDeps,
          joinTarget: { masterId, masterPrivateIp, k3sVersion: config.k3sVersion },
        }),
      );
    }

    return {
      masterIp: ingress.address,
      // Read back by a scale or failover (converge-cluster.js priorMasterFrom).
      masterId: liveMasterId,
      masterPrivateIp,
      dbIp: dbIp.address,
      dbPrivateIp: db.privateIps.apply(
        requireAddress('the database node', 'the cluster cannot reach its database'),
      ),
      workerIps: workerIps.map((ip) => ip.address),
      floatingIp: ingress.address,
      networkId: network.id.apply(bareId),
      sshKeyId: sshKeyIdOutput(sshKeyId),
      k3sToken: pulumi.secret(k3sToken),
      clusterName,
      vpcCidr,
    };
  };
}
