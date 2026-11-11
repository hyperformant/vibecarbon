/**
 * Pulumi program for a single Hetzner k3s cluster.
 *
 * One call to `buildHetznerK8sProgram(config)` returns a Pulumi inline
 * program (a function) that declares the cloud resources. The Automation
 * API wrapper in `../index.js` runs it.
 *
 * Resources declared:
 *   - SshKey (optional — reuse existing by ID for HA)
 *   - Network + Subnet
 *   - Firewall
 *   - Floating IP
 *   - Master server (cloud-init: master-init.sh)
 *   - Database server (cloud-init: db-init.sh)
 *   - Worker servers × N (cloud-init: worker-init.sh)
 *   - Placement group for workers (spread)
 *
 * Outputs: masterIp, masterPrivateIp, dbIp, workerIps, floatingIp,
 * networkId, sshKeyId, k3sToken.
 */

import * as hcloud from '@pulumi/hcloud';
import * as pulumi from '@pulumi/pulumi';
import { loadCloudInit, renderScript } from '../cloud-init.js';
import {
  SERVER_OWNER_LABELS,
  serverResourceOptions,
  workerResourceOptions,
} from '../create-timeout.js';
import { requireK3sToken } from '../k3s-token.js';

// Hetzner location → private-network zone. Single source of truth: this is
// the ONLY place that derives a networkZone, and it's derived here — inside
// the Pulumi program, from `config.location` — rather than computed by
// producers (deploy's k3s.js, scale's scale-plan.js) and passed in as a
// config field. Deploy and scale now structurally cannot disagree: there is
// exactly one call site (the NetworkSubnet below) and exactly one mapping.
// Previously a two-producer convention; a drift there made Pulumi plan a
// destructive subnet replacement (zone is immutable on an hcloud
// NetworkSubnet) — first hit: 2026-07-10 CI US-region run, k8s scale in ash
// against a deploy-created eu-central subnet.
const REGION_TO_NETWORK_ZONE = {
  nbg1: 'eu-central',
  hel1: 'eu-central',
  fsn1: 'eu-central',
  hil: 'us-west',
  ash: 'us-east',
  sin: 'ap-southeast',
};

/**
 * Private-network zone for a Hetzner location (eu-central fallback).
 * Exported for direct unit-test access (tests/unit/iac); not consumed by any
 * other production module — the program is the single derivation site.
 * @param {string} location
 * @returns {string}
 */
export function networkZoneFor(location) {
  return REGION_TO_NETWORK_ZONE[location] || 'eu-central';
}

/**
 * @typedef {Object} K8sStackConfig
 * @property {string} projectName
 * @property {string} environment      Environment name (used for cluster name + labels)
 * @property {string} sshPublicKey     OpenSSH-format public key
 * @property {string} [existingSshKeyId]  If set, skip creating a new SSH key
 *                                        (HA case: shared key across clusters)
 * @property {string} k3sToken           k3s node-join token: the stack's
 *                                        recorded one, or one derived from
 *                                        the state passphrase. Required.
 * @property {boolean} [k3sTokenReplayed] The token is the stack's recorded
 *                                        one (a cluster exists to protect).
 * @property {{id: string, privateIp: string}} [priorMaster] The master as the
 *   prior state records it. Set only by converge-cluster.js (scale and
 *   failover), whose preview refuses any plan that replaces the master; the
 *   db and workers are built from it so they resize alongside the master.
 * @property {string} location         Hetzner datacenter (nbg1/hel1/fsn1/hil/ash/sin).
 *                                      networkZone is derived from this (see
 *                                      `networkZoneFor` above) — not a config field.
 * @property {string} masterServerType
 * @property {string} dbServerType
 * @property {string} workerServerType
 * @property {number} minWorkers   Static floor of worker servers (provisioned by Pulumi). Default 1.
 * @property {number} maxWorkers   Upper bound for cluster-autoscaler. Not consumed by Pulumi; flows to the CA Deployment in applyK3sManifests. Default 3.
 * @property {string} k3sVersion
 * @property {string} privateNetworkRange   Default 10.0.0.0/8
 * @property {string} subnetRange           Default 10.0.1.0/24
 * @property {Record<string,string>} labels
 * @property {string[]} [allowedSshIps]       CIDR list, defaults to 0.0.0.0/0
 * @property {string[]} [allowedK8sApiIps]    CIDR list, REQUIRED (no default since the H-2 closeout; public 6443 is operator-only — in-cluster + agent-tunnel traffic rides the private advertise-address)
 *
 * No API token: no node's user data carries it. deployK3s hands it to the
 * cluster's `hcloud` kube-system Secret itself (applyCloudSecrets).
 */

/**
 * Build an inline Pulumi program for the given cluster config.
 * @param {K8sStackConfig} config
 * @returns {() => Promise<Record<string, unknown>>}
 */
export function buildHetznerK8sProgram(config) {
  const clusterName = `${config.projectName}-${config.environment}`;
  // Ownership (SERVER_OWNER_LABELS) before the caller's labels, as every
  // caller has always passed it: the same keys in the same order.
  const labels = {
    project: config.projectName,
    environment: config.environment,
    ...SERVER_OWNER_LABELS,
    ...config.labels,
  };
  // Operator-IP firewall lock (H-2). The deploy flow populates these from
  // projectConfig.operatorCidrs; an empty list = nothing can SSH in or hit
  // the k8s API. We refuse to build a program that would do that — far
  // better to fail loudly than to silently apply an open `0.0.0.0/0`.
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
  const allowedSshIps = config.allowedSshIps;
  const allowedK8sApiIps = config.allowedK8sApiIps;
  // Always the CLI's: the stack's recorded token or the one derived from the
  // state passphrase (lib/iac/k3s-token.js). Never made here.
  const k3sToken = requireK3sToken(config, 'buildHetznerK8sProgram');
  const privateNetworkRange = config.privateNetworkRange ?? '10.0.0.0/8';
  const subnetRange = config.subnetRange ?? '10.0.1.0/24';
  const minWorkers = config.minWorkers ?? 1;

  const masterInitTemplate = loadCloudInit('master-init.sh');
  const dbInitTemplate = loadCloudInit('db-init.sh');
  const workerInitTemplate = loadCloudInit('worker-init.sh');

  return async () => {
    // SSH key — either reuse an existing one (HA shared key) or create.
    let sshKeyId;
    if (config.existingSshKeyId) {
      sshKeyId = config.existingSshKeyId;
    } else {
      const sshKey = new hcloud.SshKey('ssh-key', {
        name: `${clusterName}-${config.location}-key`,
        publicKey: config.sshPublicKey,
        labels,
      });
      sshKeyId = sshKey.id;
    }

    // Private network + subnet
    const network = new hcloud.Network('network', {
      name: `${clusterName}-network`,
      ipRange: privateNetworkRange,
      labels,
    });
    const subnet = new hcloud.NetworkSubnet('subnet', {
      networkId: network.id,
      type: 'cloud',
      networkZone: networkZoneFor(config.location),
      ipRange: subnetRange,
    });

    // Firewall. `replaceOnChanges: ['*'] + deleteBeforeReplace` forces a
    // recreate instead of an in-place Update. This avoids an upstream
    // in-place-Update defect that silently drops EVERY rule from a live
    // firewall:
    //
    //   hetznercloud/terraform-provider-hcloud#931 — "Firewall rules DELETED
    //   when name or labels in hcloud_firewall resource are changed". Open
    //   and maintainer-pinned since 2024-05-22, reproduction reconfirmed by
    //   users 2024-12-11. Regression introduced by upstream PR #874 (shipped
    //   in provider v1.46.0); per maintainer @apricote it fires when a
    //   `sourceIps` entry omits its `/32`-`/128` prefix. We bridge provider
    //   v1.68.0 (via @pulumi/hcloud 1.41.0), i.e. we are *past* the release
    //   that introduced it and there is still no fix release.
    //
    // Our own CIDRs normally carry a prefix (`cidrFromIp` appends /32|/128,
    // `access add` rejects prefix-less input), but `ALLOWED_SSH_IPS` is
    // split on commas without prefix validation, so a bare IP can still
    // reach these rules — exactly the reported trigger.
    //
    // `deleteBeforeReplace` is NOT optional here: Hetzner firewall names are
    // unique per project, so create-before-delete would fail the create with
    // `uniqueness_error`.
    //
    // The trade is asymmetric, which is why it lands this way. Keeping the
    // workaround costs a brief window where attached servers have no firewall
    // (Hetzner applies no filtering when none is attached) — a real exposure,
    // bounded by one create+attach. Dropping it risks #931 emptying the rule
    // set on a live firewall, and an empty Hetzner firewall fails CLOSED: per
    // Hetzner's docs, "if you do not set any rule, all inbound traffic will
    // automatically be blocked". That is a total inbound drop on 22/80/443/6443
    // — full outage plus operator lockout, with no self-recovery.
    //
    // Remove this (and drop to a plain in-place Update) once #931 is closed
    // in a release we bridge. Do not "modernise" it away on the strength of
    // a version number alone — an earlier revision of this comment cited a
    // fabricated hcloud-go nil-pointer panic against a version that never
    // existed, and that bogus citation nearly got the workaround deleted.
    const firewall = new hcloud.Firewall(
      'firewall',
      {
        name: `${clusterName}-firewall`,
        labels,
        rules: [
          {
            direction: 'in',
            protocol: 'tcp',
            port: '22',
            sourceIps: allowedSshIps,
            description: 'SSH access',
          },
          {
            direction: 'in',
            protocol: 'tcp',
            port: '80',
            sourceIps: ['0.0.0.0/0', '::/0'],
            description: 'HTTP',
          },
          {
            direction: 'in',
            protocol: 'tcp',
            port: '443',
            sourceIps: ['0.0.0.0/0', '::/0'],
            description: 'HTTPS',
          },
          {
            direction: 'in',
            protocol: 'tcp',
            port: '6443',
            sourceIps: allowedK8sApiIps,
            description: 'Kubernetes API',
          },
          {
            direction: 'in',
            protocol: 'tcp',
            port: 'any',
            sourceIps: [privateNetworkRange],
            description: 'Internal cluster traffic (TCP)',
          },
          {
            direction: 'in',
            protocol: 'udp',
            port: 'any',
            sourceIps: [privateNetworkRange],
            description: 'Internal cluster traffic (UDP)',
          },
        ],
      },
      { replaceOnChanges: ['*'], deleteBeforeReplace: true },
    );

    // Floating IP (stable ingress) — created before master so we can pass
    // its address into the master's cloud-init script. Name includes the
    // region (config.location) so parallel deploys across regions don't
    // collide on the shared-across-project Hetzner namespace.
    const floatingIp = new hcloud.FloatingIp('ingress', {
      type: 'ipv4',
      homeLocation: config.location,
      name: `${clusterName}-${config.location}-ingress`,
      labels,
    });

    // Master server — cloud-init script is rendered with the floating IP. No
    // API token: user data sits in this stack's state in plain text, and the
    // provider hands it to anything on the box. The cloud controller and CSI
    // driver read the token from the `hcloud` kube-system Secret, which
    // deployK3s applies from the operator's machine (applyCloudSecrets).
    const masterUserData = floatingIp.ipAddress.apply((ip) =>
      renderScript(masterInitTemplate, {
        k3s_version: config.k3sVersion,
        k3s_token: k3sToken,
        cluster_name: clusterName,
        disable_traefik: 'true',
        floating_ip: ip,
        // Stamped onto every CSI-created volume (HCLOUD_VOLUME_EXTRA_LABELS)
        // so shared-project enumeration (e2e sweeps) can attribute pvc-*
        // volumes to their owner — same `project` label the servers carry.
        project_name: config.projectName,
      }),
    );

    const master = new hcloud.Server(
      'master',
      {
        name: `${clusterName}-master`,
        serverType: config.masterServerType,
        image: 'ubuntu-26.04',
        location: config.location,
        sshKeys: [sshKeyId],
        firewallIds: [firewall.id.apply((id) => Number.parseInt(id, 10))],
        labels: { ...labels, role: 'master' },
        networks: [
          { networkId: network.id.apply((id) => Number.parseInt(id, 10)), ip: '10.0.1.1' },
        ],
        userData: pulumi.secret(masterUserData),
      },
      serverResourceOptions('hcloud:index/server:Server', { dependsOn: [subnet] }),
    );

    // Attach floating IP to master
    new hcloud.FloatingIpAssignment('ingress-assignment', {
      floatingIpId: floatingIp.id.apply((id) => Number.parseInt(id, 10)),
      serverId: master.id.apply((id) => Number.parseInt(id, 10)),
    });

    // Database server — joins master via k3s agent. master_ip MUST be the
    // master's private IP: Hetzner firewall (above) restricts public 6443
    // to operator IPs only, so the database node cannot reach the master's
    // public IP on 6443 at all. Mirrors the worker-init pattern below.
    // Hardcoding 10.0.1.1 also drops the master.ipv4Address.apply() wrapper,
    // removing a needless cross-resource dep that delayed cloud-init render.
    const dbUserData = renderScript(dbInitTemplate, {
      k3s_version: config.k3sVersion,
      k3s_token: k3sToken,
      master_ip: '10.0.1.1',
    });
    // NOTE: previously `dependsOn: [master]` — we dropped that so Hetzner
    // provisions master + database in parallel, saving ~30-60s on the
    // critical path. The database node's cloud-init (db-init.sh) already
    // polls the master k3s API with a 120-attempt retry loop, so it
    // tolerates master coming up slightly later.
    const dbServer = new hcloud.Server(
      'db',
      {
        name: `${clusterName}-db`,
        serverType: config.dbServerType,
        image: 'ubuntu-26.04',
        location: config.location,
        sshKeys: [sshKeyId],
        firewallIds: [firewall.id.apply((id) => Number.parseInt(id, 10))],
        labels: { ...labels, role: 'db', 'node-pool': 'db-pool' },
        networks: [
          { networkId: network.id.apply((id) => Number.parseInt(id, 10)), ip: '10.0.1.2' },
        ],
        userData: pulumi.secret(dbUserData),
      },
      serverResourceOptions('hcloud:index/server:Server', { dependsOn: [subnet] }),
    );

    // Workers (spread across placement group). Name includes region so
    // re-runs / scale across regions don't collide in Hetzner's per-project
    // placement-group namespace.
    const placementGroup = new hcloud.PlacementGroup('workers-pg', {
      name: `${clusterName}-${config.location}-workers-pg`,
      type: 'spread',
      labels,
    });
    const workerUserData = renderScript(workerInitTemplate, {
      k3s_version: config.k3sVersion,
      k3s_token: k3sToken,
      master_ip: '10.0.1.1',
      cluster_name: clusterName,
    });
    const workers = [];
    for (let i = 0; i < minWorkers; i++) {
      workers.push(
        new hcloud.Server(
          `worker-${i + 1}`,
          {
            name: `${clusterName}-worker-${i + 1}`,
            serverType: config.workerServerType,
            image: 'ubuntu-26.04',
            location: config.location,
            sshKeys: [sshKeyId],
            firewallIds: [firewall.id.apply((id) => Number.parseInt(id, 10))],
            placementGroupId: placementGroup.id.apply((id) => Number.parseInt(id, 10)),
            labels: {
              ...labels,
              role: 'worker',
              'node-pool': 'worker-pool',
              'cluster-autoscaler/node': 'static',
            },
            networks: [
              {
                networkId: network.id.apply((id) => Number.parseInt(id, 10)),
                ip: `10.0.1.${10 + i}`,
              },
            ],
            userData: pulumi.secret(workerUserData),
          },
          workerResourceOptions('hcloud:index/server:Server', {
            dependsOn: [subnet],
            // The master's address is static, so only the join trigger would
            // hold a worker back until the master finished. With no token to
            // replay it has nothing to protect yet: see workerResourceOptions.
            omitJoinTrigger: !config.k3sTokenReplayed,
            joinTarget: {
              // A scale or failover names the master from prior state, so the
              // worker resizes alongside it: see priorMasterFrom.
              masterId: config.priorMaster?.id ?? master.id,
              masterPrivateIp: '10.0.1.1',
              k3sVersion: config.k3sVersion,
            },
          }),
        ),
      );
    }

    return {
      masterIp: master.ipv4Address,
      // Read back by a scale or failover (converge-cluster.js priorMasterFrom).
      masterId: master.id,
      masterPrivateIp: '10.0.1.1',
      dbIp: dbServer.ipv4Address,
      dbPrivateIp: '10.0.1.2',
      workerIps: workers.map((w) => w.ipv4Address),
      floatingIp: floatingIp.ipAddress,
      networkId: network.id,
      sshKeyId: typeof sshKeyId === 'string' ? sshKeyId : sshKeyId.apply((id) => String(id)),
      k3sToken: pulumi.secret(k3sToken),
      clusterName,
    };
  };
}
