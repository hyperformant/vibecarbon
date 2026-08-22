/**
 * Pulumi program for a single Hetzner Docker Compose VPS.
 *
 * Much simpler than the k8s program — one server, one firewall, optional
 * floating IP. Cloud-init installs Docker via the shipped docker-ce-setup.yaml
 * (carbon/cloud-init/), which is reused as-is (no templating needed).
 *
 * Outputs: serverIp, serverId, firewallId, sshKeyId.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hcloud from '@pulumi/hcloud';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLOUD_INIT_PATH = join(__dirname, '../../../../carbon/cloud-init/docker-ce-setup.yaml');

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
  const userData = readFileSync(CLOUD_INIT_PATH, 'utf-8');

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
          // Supavisor pooler (compose prod overlay publishes 5432/6543).
          // Operator-CIDR-scoped like SSH — NEVER world-open: this is
          // password auth straight into Postgres. `vibecarbon access
          // add/remove/prune` rewrites these in lockstep with the SSH rule
          // (providers' applyOperatorCidrs OPERATOR_LOCKED_PORTS).
          {
            direction: 'in',
            protocol: 'tcp',
            port: '5432',
            sourceIps: allowedSshIps,
            description: 'Supavisor session pooler (operator CIDRs)',
          },
          {
            direction: 'in',
            protocol: 'tcp',
            port: '6543',
            sourceIps: allowedSshIps,
            description: 'Supavisor transaction pooler (operator CIDRs)',
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

    const server = new hcloud.Server('server', {
      name,
      serverType: config.serverType,
      // Hetzner-maintained app image: Ubuntu LTS with docker + the
      // docker-compose plugin pre-installed. Matches the contract in
      // carbon/cloud-init/docker-ce-setup.yaml ("VPS boot time in parallel
      // with Hetzner's default docker-ce app"). Plain `ubuntu-24.04` leaves
      // the VM without docker and the deploy hits `docker: command not
      // found` on the first `docker compose up` call.
      image: 'docker-ce',
      location: config.location,
      sshKeys: [sshKeyId],
      firewallIds: [firewall.id.apply((id) => Number.parseInt(id, 10))],
      labels: { ...labels, role: 'compose' },
      userData,
    });

    return {
      serverIp: server.ipv4Address,
      serverId: server.id.apply((id) => String(id)),
      firewallId: firewall.id.apply((id) => String(id)),
      sshKeyId: typeof sshKeyId === 'string' ? sshKeyId : sshKeyId.apply((id) => String(id)),
    };
  };
}
