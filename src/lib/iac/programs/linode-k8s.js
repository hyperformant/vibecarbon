/**
 * Pulumi program for a single Linode k3s cluster.
 *
 * Same config contract and output names as digitalocean-k8s.js, with the
 * ways Linode differs:
 *
 *   - A `linode.Vpc` plus one `VpcSubnet` (10.0.1.0/24). Instances take
 *     static VPC addresses, so the master (10.0.1.2), db (10.0.1.3) and
 *     workers (10.0.1.10+) are known at declare time. The db and worker
 *     user data can therefore be rendered without waiting for the master.
 *   - The firewall attaches at create time through `firewallId`, so no
 *     server is ever up unfirewalled.
 *   - The ingress address is a `linode.ReservedIp`, bound to the master at
 *     create time through `ipv4s` (no separate assignment resource).
 *   - Instances use legacy config interfaces: eth0 public, eth1 VPC. The
 *     boot scripts pin flannel to eth1.
 *   - Instances take SSH key material (authorizedKeys), not key ids. The
 *     SshKey resource exists so the `sshKeyId` output is real and destroy
 *     has something to reap.
 *
 * Firewall and instance labels are squeezed into Linode's caps (32 and 50)
 * with the same helpers the REST lookups use. The VPC, subnet and SSH key
 * labels go out as plain names, as on DigitalOcean: Linode allows 64
 * characters there, and the autoscaler config, destroy and the e2e sweep
 * look them up by the plain name. A cluster whose plain name would pass 64
 * is refused when the program is built, before anything is created.
 *
 * Outputs: masterIp, masterPrivateIp, dbIp, dbPrivateIp, workerIps,
 * floatingIp, networkId, sshKeyId, k3sToken, clusterName, vpcCidr.
 */

import { randomBytes } from 'node:crypto';
import * as linode from '@pulumi/linode';
import {
  encodeLabels,
  LinodeProvider,
  splitCidrsByFamily,
  squeezeLinodeInstanceLabel,
  squeezeLinodeLabel,
} from '../../providers/linode.js';
import { serverResourceOptions, workerResourceOptions } from '../create-timeout.js';

const VPC_CIDR = LinodeProvider.DEFAULT_VPC_CIDR;
const MASTER_IP = '10.0.1.2';
const DB_IP = '10.0.1.3';
const WORKER_IP_BASE = 10;

/**
 * Linode's cap on VPC, VPC subnet and SSH key labels. Source: Linode API
 * OpenAPI spec, `POST /vpcs` and `POST /vpcs/{vpcId}/subnets` `label`
 * (maxLength 64, letters, digits and single hyphens) and
 * `POST /profile/sshkeys` `label` (maxLength 64). The Pulumi provider
 * (terraform-provider-linode v4.9.0, bundled by @pulumi/linode 6.9.0) adds
 * no tighter limit for VPCs and checks 64 for SSH keys.
 */
const LINODE_LABEL_MAX = 64;

/**
 * Refuse, before any resource exists, a label Linode would reject. These
 * labels are not squeezed: the autoscaler config, destroy and the e2e sweep
 * find them by the plain name, so a squeezed copy would orphan them.
 * @param {Array<[string, string]>} labels  [what, label] pairs
 */
function assertLabelsFit(labels) {
  for (const [what, label] of labels) {
    if (label.length > LINODE_LABEL_MAX) {
      throw new Error(
        `Kubernetes on Linode cannot name this cluster's ${what} "${label}": ` +
          `it is ${label.length} characters and Linode allows ${LINODE_LABEL_MAX}. ` +
          'Use a shorter project or environment name.',
      );
    }
  }
}

/**
 * @typedef {Object} K8sStackConfig
 * @property {string} projectName
 * @property {string} environment
 * @property {string} sshPublicKey       OpenSSH-format public key
 * @property {string} [existingSshKeyId] k8s-ha's shared key: reuse, create nothing
 * @property {string} [k3sToken]         Auto-generated if omitted
 * @property {string} location           Linode region slug (e.g. us-east)
 * @property {string} masterServerType
 * @property {string} dbServerType
 * @property {string} workerServerType
 * @property {number} [minWorkers]       Default 1
 * @property {string} k3sVersion
 * @property {Record<string,string>} [labels]
 * @property {string[]} allowedSshIps    CIDR list, required
 * @property {string[]} allowedK8sApiIps CIDR list, required
 * @property {string} apiToken           Linode API token (the CSI driver's credential)
 */

// Pulumi's rule properties are the plural `ipv4s`/`ipv6s`; splitCidrsByFamily
// returns the REST wire shape (`ipv4`/`ipv6`). Adapt once, here.
function pulumiAddresses(cidrs) {
  const wire = splitCidrsByFamily(cidrs);
  return {
    ...(wire.ipv4 ? { ipv4s: wire.ipv4 } : {}),
    ...(wire.ipv6 ? { ipv6s: wire.ipv6 } : {}),
  };
}

/**
 * @param {K8sStackConfig} config
 * @returns {() => Promise<Record<string, unknown>>}
 */
export function buildLinodeK8sProgram(config) {
  const clusterName = `${config.projectName}-${config.environment}`;
  const labels = {
    project: config.projectName,
    environment: config.environment,
    ...(config.labels ?? {}),
  };
  if (!config.allowedSshIps?.length) {
    throw new Error(
      'allowedSshIps required (no default; pass operatorCidrs from .vibecarbon.json or set ALLOWED_SSH_IPS=...)',
    );
  }
  if (!config.allowedK8sApiIps?.length) {
    throw new Error(
      'allowedK8sApiIps required (no default; pass operatorCidrs from .vibecarbon.json or set ALLOWED_SSH_IPS=...)',
    );
  }
  const networkLabel = `${clusterName}-network`;
  const subnetLabel = `${clusterName}-subnet`;
  const sshKeyLabel = `${clusterName}-${config.location}-key`;
  assertLabelsFit([
    ['private network', networkLabel],
    ['subnet', subnetLabel],
    ...(config.existingSshKeyId ? [] : [['SSH key', sshKeyLabel]]),
  ]);
  const k3sToken = config.k3sToken ?? randomBytes(32).toString('hex');
  const image = LinodeProvider.K8S_IMAGE;
  const minWorkers = config.minWorkers ?? 1;
  const world = { ipv4s: ['0.0.0.0/0'], ipv6s: ['::/0'] };
  const toB64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

  return async () => {
    let sshKeyId;
    if (config.existingSshKeyId) {
      sshKeyId = config.existingSshKeyId;
    } else {
      const sshKey = new linode.SshKey('ssh-key', {
        label: sshKeyLabel,
        sshKey: config.sshPublicKey.trim(),
      });
      sshKeyId = sshKey.id;
    }

    const network = new linode.Vpc('network', {
      label: networkLabel,
      region: config.location,
    });
    const subnet = new linode.VpcSubnet('subnet', {
      vpcId: network.id.apply((id) => Number.parseInt(id, 10)),
      label: subnetLabel,
      ipv4: VPC_CIDR,
    });

    const firewall = new linode.Firewall('firewall', {
      label: squeezeLinodeLabel(`${clusterName}-firewall`),
      inboundPolicy: 'DROP',
      outboundPolicy: 'ACCEPT',
      inbounds: [
        {
          label: 'ssh',
          action: 'ACCEPT',
          protocol: 'TCP',
          ports: '22',
          ...pulumiAddresses(config.allowedSshIps),
        },
        { label: 'http', action: 'ACCEPT', protocol: 'TCP', ports: '80', ...world },
        { label: 'https', action: 'ACCEPT', protocol: 'TCP', ports: '443', ...world },
        {
          label: 'k8s-api',
          action: 'ACCEPT',
          protocol: 'TCP',
          ports: '6443',
          ...pulumiAddresses(config.allowedK8sApiIps),
        },
        // Internal cluster traffic (flannel VXLAN, kubelet, registry mirror),
        // scoped to the VPC.
        {
          label: 'vpc-tcp',
          action: 'ACCEPT',
          protocol: 'TCP',
          ports: '1-65535',
          ipv4s: [VPC_CIDR],
        },
        {
          label: 'vpc-udp',
          action: 'ACCEPT',
          protocol: 'UDP',
          ports: '1-65535',
          ipv4s: [VPC_CIDR],
        },
        { label: 'vpc-icmp', action: 'ACCEPT', protocol: 'ICMP', ipv4s: [VPC_CIDR] },
      ],
      tags: encodeLabels(labels),
    });

    const reservedIp = new linode.ReservedIp('ingress', {
      region: config.location,
      tags: encodeLabels(labels),
    });

    const firewallId = firewall.id.apply((id) => Number.parseInt(id, 10));
    const subnetId = subnet.id.apply((id) => Number.parseInt(id, 10));
    const vpcId = network.id.apply((id) => Number.parseInt(id, 10));
    const interfaces = (vpcAddress) => [
      { purpose: 'public', primary: true },
      { purpose: 'vpc', vpcId, subnetId, ipv4: { vpc: vpcAddress } },
    ];
    const authorizedKeys = [config.sshPublicKey.trim()];

    const masterUserData = await LinodeProvider.getK8sMasterUserData({
      k3s_version: config.k3sVersion,
      k3s_token: k3sToken,
      linode_token: config.apiToken ?? '',
      project_name: config.projectName,
    });
    const master = new linode.Instance(
      'master',
      {
        label: squeezeLinodeInstanceLabel(`${clusterName}-master`),
        region: config.location,
        type: config.masterServerType,
        image,
        authorizedKeys,
        interfaceGeneration: 'legacy_config',
        interfaces: interfaces(MASTER_IP),
        ipv4s: [reservedIp.address],
        metadatas: [{ userData: toB64(masterUserData) }],
        firewallId,
        tags: encodeLabels({ ...labels, role: 'master', cluster: clusterName }),
      },
      serverResourceOptions('linode:index/instance:Instance', { deleteBeforeReplace: true }),
    );

    const dbUserData = await LinodeProvider.getK8sDbUserData({
      k3s_version: config.k3sVersion,
      k3s_token: k3sToken,
      master_ip: MASTER_IP,
    });
    const dbServer = new linode.Instance(
      'db',
      {
        label: squeezeLinodeInstanceLabel(`${clusterName}-db`),
        region: config.location,
        type: config.dbServerType,
        image,
        authorizedKeys,
        interfaceGeneration: 'legacy_config',
        interfaces: interfaces(DB_IP),
        metadatas: [{ userData: toB64(dbUserData) }],
        firewallId,
        tags: encodeLabels({
          ...labels,
          role: 'db',
          'node-pool': 'db-pool',
          cluster: clusterName,
        }),
      },
      serverResourceOptions('linode:index/instance:Instance', { deleteBeforeReplace: true }),
    );

    const workerUserData = await LinodeProvider.getK8sWorkerUserData({
      k3s_version: config.k3sVersion,
      k3s_token: k3sToken,
      master_ip: MASTER_IP,
    });
    const workers = [];
    for (let i = 0; i < minWorkers; i++) {
      workers.push(
        new linode.Instance(
          `worker-${i + 1}`,
          {
            label: squeezeLinodeInstanceLabel(`${clusterName}-worker-${i + 1}`),
            region: config.location,
            type: config.workerServerType,
            image,
            authorizedKeys,
            interfaceGeneration: 'legacy_config',
            interfaces: interfaces(`10.0.1.${WORKER_IP_BASE + i}`),
            metadatas: [{ userData: toB64(workerUserData) }],
            firewallId,
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
          workerResourceOptions('linode:index/instance:Instance', {
            deleteBeforeReplace: true,
            joinTarget: {
              masterId: master.id,
              masterPrivateIp: MASTER_IP,
              k3sVersion: config.k3sVersion,
            },
          }),
        ),
      );
    }

    return {
      masterIp: reservedIp.address,
      masterPrivateIp: MASTER_IP,
      dbIp: dbServer.ipAddress,
      dbPrivateIp: DB_IP,
      workerIps: workers.map((w) => w.ipAddress),
      floatingIp: reservedIp.address,
      networkId: network.id.apply((id) => String(id)),
      sshKeyId: typeof sshKeyId === 'string' ? sshKeyId : sshKeyId.apply((id) => String(id)),
      k3sToken,
      clusterName,
      vpcCidr: VPC_CIDR,
    };
  };
}
