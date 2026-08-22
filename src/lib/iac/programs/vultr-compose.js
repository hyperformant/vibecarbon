/**
 * Pulumi program for a single Vultr Docker Compose instance.
 *
 * Mirrors the hetzner/digitalocean/linode compose programs: one server,
 * one firewall group, no floating IP.
 *
 * Cloud-init: no Docker-preinstalled os_id exists on Vultr (Marketplace
 * Docker is an app, not an OS), so the shared file gets the
 * official-Docker-apt-repo install spliced into `runcmd:` — keep
 * DOCKER_INSTALL_RUNCMD in lockstep with the digitalocean/linode copies
 * (not imported: each program's module graph must only load its own
 * @pulumi provider package).
 *
 * userData ENCODING — VERIFIED at the first live v1 run (2026-08-12,
 * full lifecycle green): @ediri/vultr's `userData` input takes RAW
 * cloud-init YAML (the provider base64-encodes for Vultr's REST API,
 * the common TF-provider convention). Keep passing RAW; a pre-encoded
 * payload would double-encode and break cloud-init.
 *
 * Firewall shape: Vultr rules are INBOUND-ONLY, one subnet per rule
 * resource (world-open ports need one v4 + one v6 rule; operator-scoped
 * ports need one rule per CIDR), attached to a FirewallGroup whose
 * identity field is `description`. Instances attach the group at create
 * via `firewallGroupId` — no unfirewalled window. Group default is DENY
 * for inbound once attached, so no explicit drop rules are needed;
 * outbound is unrestricted by design on Vultr.
 *
 * Outputs: serverIp, serverId, firewallId, sshKeyId.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vultr from '@ediri/vultr';
import { APT_LOCK_OPT } from '../../deploy/apt.js';
import { cidrToVultrRuleFields, encodeLabels } from '../../providers/vultr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLOUD_INIT_PATH = join(__dirname, '../../../../carbon/cloud-init/docker-ce-setup.yaml');

// Official Docker apt-repo install — LOCKSTEP with the digitalocean-compose
// and linode-compose copies (see digitalocean-compose.js for the
// marketplace-image decision record, unchanged here).
const DOCKER_INSTALL_RUNCMD = [
  "  - [sh, -c, 'install -m 0755 -d /etc/apt/keyrings']",
  "  - [sh, -c, 'curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc']",
  "  - [sh, -c, 'chmod a+r /etc/apt/keyrings/docker.asc']",
  '  - [sh, -c, \'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null\']',
  // Lock timeout, not bare apt-get: runcmd runs while unattended-upgrades
  // is still holding dpkg's lock-frontend on first boot, and apt's default
  // is to fail on contention rather than wait. See src/lib/deploy/apt.js.
  // ASCII-only by construction, so the DO/Scaleway cloud-init asserts hold.
  `  - [sh, -c, 'apt-get ${APT_LOCK_OPT} update -y']`,
  `  - [sh, -c, 'apt-get ${APT_LOCK_OPT} install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin']`,
].join('\n');

/**
 * Splice the Docker-CE install block into the shared compose cloud-init's
 * `runcmd:` list — same fail-loud anchor contract as the sibling renderers.
 * @param {string} sharedYaml
 * @returns {string}
 */
export function renderVultrUserData(sharedYaml) {
  const anchor = '\nruncmd:\n';
  const idx = sharedYaml.indexOf(anchor);
  if (idx === -1) {
    throw new Error(
      'renderVultrUserData: `runcmd:` block not found in shared cloud-init ' +
        '(carbon/cloud-init/docker-ce-setup.yaml), file shape changed, update the splice anchor',
    );
  }
  const insertAt = idx + anchor.length;
  return `${sharedYaml.slice(0, insertAt)}${DOCKER_INSTALL_RUNCMD}\n${sharedYaml.slice(insertAt)}`;
}

/**
 * Load and render this provider's compose-tier boot user-data (RAW YAML —
 * see the module doc's encoding VERIFY note; the REST path in
 * VultrProvider.createServer base64s at its own wire boundary). Single
 * source of truth for both consumers.
 * @returns {string}
 */
export function loadVultrComposeUserData() {
  return renderVultrUserData(readFileSync(CLOUD_INIT_PATH, 'utf-8'));
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
export function buildVultrComposeProgram(config) {
  const name = `${config.projectName}-${config.environment}`;
  const labels = {
    project: config.projectName,
    environment: config.environment,
    ...(config.labels ?? {}),
  };
  // Operator-IP firewall lock (H-2 guard, all sibling programs).
  if (!config.allowedSshIps?.length) {
    throw new Error(
      'allowedSshIps required (no default; pass operatorCidrs from .vibecarbon.json or set ALLOWED_SSH_IPS=...)',
    );
  }
  const allowedSshIps = config.allowedSshIps;
  const userData = loadVultrComposeUserData();

  // One rule resource per (port × source) — Vultr's one-subnet-per-rule
  // shape. World-open ports get the v4+v6 pair; operator ports one rule
  // per CIDR.
  const WORLD = ['0.0.0.0/0', '::/0'];
  const ruleSpecs = [
    ...allowedSshIps.map((cidr) => ({ port: '22', cidr, notes: 'operator-22' })),
    ...WORLD.map((cidr) => ({ port: '80', cidr, notes: 'http' })),
    ...WORLD.map((cidr) => ({ port: '443', cidr, notes: 'https' })),
    // Supavisor pooler ports — operator-scoped like SSH, NEVER world-open;
    // kept in lockstep by applyOperatorCidrs (OPERATOR_LOCKED_PORTS).
    ...allowedSshIps.map((cidr) => ({ port: '5432', cidr, notes: 'operator-5432' })),
    ...allowedSshIps.map((cidr) => ({ port: '6543', cidr, notes: 'operator-6543' })),
  ];

  return async () => {
    // Account-level SSH key resource (Vultr keys are id-referenced at
    // create, like DO/Hetzner — the frozen sshKeyId output is real).
    let sshKeyId; // frozen-contract shape: string | Output<string>
    let sshKeyIdForInstance;
    if (config.existingSshKeyId) {
      sshKeyId = config.existingSshKeyId;
      sshKeyIdForInstance = config.existingSshKeyId;
    } else {
      // NOTE the class casing: @ediri/vultr exports `SSHKey` (all-caps
      // SSH), unlike @pulumi/linode's `SshKey` — live-verified against the
      // installed package's exports after the first v1 attempt failed with
      // "vultr.SshKey is not a constructor".
      const sshKey = new vultr.SSHKey('ssh-key', {
        name: `${name}-${config.location}-key`,
        sshKey: config.sshPublicKey.trim(),
      });
      sshKeyId = sshKey.id;
      sshKeyIdForInstance = sshKey.id;
    }

    // Group first; instance attaches at create (no unfirewalled window).
    // No description squeeze needed: a 62-char description round-tripped
    // exactly in the live probe (2026-08-08) — Vultr has no Linode-style
    // 32-char cap at our name lengths.
    const firewall = new vultr.FirewallGroup('firewall', {
      description: `${name}-firewall`,
    });

    ruleSpecs.forEach((spec, i) => {
      const fields = cidrToVultrRuleFields(spec.cidr);
      // Resource name carries index for uniqueness; the wire identity is
      // the rule's own tuple.
      // `source` is deliberately NOT set here, and must not be. The
      // provider schema takes `"" | "cloudflare"` (a rule SOURCE TYPE),
      // while the Vultr API's READ derives a CIDR and returns it in that
      // same field — so a refresh imports a value the provider itself
      // rejects as input. Repaired centrally by
      // repairVultrFirewallRuleInputs (lib/iac/index.js), which carries the
      // full RCA. Do NOT "fix" it here: declaring source fails validation
      // (invalid value), and ignoreChanges feeds the poisoned state value
      // straight back in — both were tried live on 2026-08-20 and failed.
      new vultr.FirewallRule(`rule-${i}`, {
        firewallGroupId: firewall.id,
        ipType: fields.ip_type,
        protocol: 'tcp',
        port: spec.port,
        subnet: fields.subnet,
        subnetSize: fields.subnet_size,
        notes: spec.notes,
      });
    });

    const instance = new vultr.Instance('server', {
      label: name,
      region: config.location,
      plan: config.serverType,
      // MUST byte-match VultrProvider.COMPOSE_IMAGE ('2284' — Ubuntu 24.04
      // LTS x64; Vultr images are numeric os_ids).
      osId: 2284,
      sshKeyIds: [sshKeyIdForInstance],
      // RAW — see the module doc's encoding VERIFY note.
      userData,
      firewallGroupId: firewall.id,
      tags: encodeLabels({ ...labels, role: 'compose' }),
    });

    return {
      serverIp: instance.mainIp,
      serverId: instance.id.apply((id) => String(id)),
      firewallId: firewall.id.apply((id) => String(id)),
      sshKeyId: typeof sshKeyId === 'string' ? sshKeyId : sshKeyId.apply((id) => String(id)),
    };
  };
}
