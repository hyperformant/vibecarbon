import * as hcloud from '@pulumi/hcloud';
import { loadComposeCloudInit } from '../compose-cloud-init.js';
import { serverResourceOptions } from '../create-timeout.js';
import { spliceDockerInstall } from '../docker-install.js';

/**
 * Splice the shared Docker install into the shared compose cloud-init, the
 * same way the other four providers' renderers do (see ../docker-install.js).
 * @param {string} sharedYaml
 * @returns {string}
 */
export function renderHetznerUserData(sharedYaml) {
  return spliceDockerInstall(sharedYaml, 'renderHetznerUserData');
}

/**
 * This provider's compose-tier boot user-data. Single source of truth for this
 * module's Pulumi program and HetznerProvider.getComposeUserData (the scale
 * and HA replacement path).
 * @returns {string}
 */
export function loadHetznerComposeUserData() {
  return renderHetznerUserData(loadComposeCloudInit());
}

/**
 * @typedef {Object} ComposeStackConfig
 * @property {string} projectName
 * @property {string} environment
 * @property {string} sshPublicKey
 * @property {string} [existingSshKeyId]
 * @property {string} location
 * @property {string} serverType
 * @property {Record<string,string>} [labels]
 * @property {string[]} [allowedSshIps]
 */

/**
 * @param {ComposeStackConfig} config
 * @returns {() => Promise<Record<string, unknown>>}
 */
export function buildHetznerComposeProgram(config) {
  const name = `${config.projectName}-${config.environment}`;
  const labels = {
    project: config.projectName,
    environment: config.environment,
    ...(config.labels ?? {}),
  };
  // Operator-IP firewall lock (H-2). The deploy flow populates this from
  // projectConfig.operatorCidrs; an empty list = nothing can SSH in. We
  // refuse to build a program that would silently apply an open default.
  if (!config.allowedSshIps?.length) {
    throw new Error(
      'allowedSshIps required (no default; pass operatorCidrs from .vibecarbon.json or set ALLOWED_SSH_IPS=...)',
    );
  }
  const allowedSshIps = config.allowedSshIps;
  const userData = loadHetznerComposeUserData();

  return async () => {
    let sshKeyId;
    if (config.existingSshKeyId) {
      sshKeyId = config.existingSshKeyId;
    } else {
      // Name includes region so parallel or re-deploys across regions don't
      // collide in Hetzner's per-project SSH-key namespace.
      const sshKey = new hcloud.SshKey('ssh-key', {
        name: `${name}-${config.location}-key`,
        publicKey: config.sshPublicKey,
        labels,
      });
      sshKeyId = sshKey.id;
    }

    const firewall = new hcloud.Firewall(
      'firewall',
      {
        name: `${name}-firewall`,
        labels,
        rules: [
          {
            direction: 'in',
            protocol: 'tcp',
            port: '22',
            sourceIps: allowedSshIps,
            description: 'SSH',
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
        ],
      },
      // Force recreate instead of an in-place Update: upstream
      // hetznercloud/terraform-provider-hcloud#931 silently drops EVERY rule
      // from a live firewall on an in-place update (open + maintainer-pinned
      // since 2024-05-22; regression from upstream PR #874 / provider
      // v1.46.0; we bridge v1.68.0 and there is still no fix release).
      // `deleteBeforeReplace` is required because Hetzner firewall names are
      // unique per project — create-before-delete would fail with
      // `uniqueness_error`. See the long-form note in hetzner-k8s.js.
      { replaceOnChanges: ['*'], deleteBeforeReplace: true },
    );

    const server = new hcloud.Server(
      'server',
      {
        name,
        serverType: config.serverType,
        // Plain Ubuntu 26.04, like every other provider: the latest Docker
        // is installed by the cloud-init user data (../docker-install.js), not
        // by Hetzner's prebuilt `docker-ce` app image, which ships an older
        // Docker (27.5.1) than the deploy's `docker save --platform` needs.
        image: 'ubuntu-26.04',
        location: config.location,
        sshKeys: [sshKeyId],
        firewallIds: [firewall.id.apply((id) => Number.parseInt(id, 10))],
        labels: { ...labels, role: 'compose' },
        userData,
      },
      // Bounded create: a provider host that never finishes the create fails the
      // deploy at 15 minutes instead of holding it forever (see create-timeout.js).
      serverResourceOptions('hcloud:index/server:Server'),
    );

    return {
      serverIp: server.ipv4Address,
      serverId: server.id.apply((id) => String(id)),
      firewallId: firewall.id.apply((id) => String(id)),
      sshKeyId: typeof sshKeyId === 'string' ? sshKeyId : sshKeyId.apply((id) => String(id)),
    };
  };
}
