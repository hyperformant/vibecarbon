/**
 * Pulumi program for a single Scaleway Docker Compose instance.
 *
 * Mirrors the hetzner/digitalocean/linode/vultr compose programs: one
 * server, one security group, one flexible IP.
 *
 * EXPORT CASINGS — enumerated from the installed @pulumiverse/scaleway
 * 1.54.0 type declarations, per the step-0 audit (the @ediri/vultr SSHKey
 * casing bug cost a live run; never guess these):
 *   - `scaleway.instance.Server` / `scaleway.instance.SecurityGroup` /
 *     `scaleway.instance.Ip` — note `Ip`, not `IP`.
 *   - `scaleway.iam.SshKey` — note `SshKey`, not `SSHKey`; prefer the iam
 *     namespace over the flat deprecated `AccountSshKey`.
 *   The flat top-level exports (`scaleway.InstanceServer`, …) are
 *   DEPRECATED in favor of these namespaced paths — do not use them.
 *
 * SSH KEYS ARE PROJECT-SCOPED (the audit's biggest design flag): Scaleway
 * has no per-instance key resource; `scw-fetch-ssh-keys` rewrites
 * /root/.ssh/authorized_keys from ALL of the Project's IAM keys at every
 * boot. The iam.SshKey below therefore grants access to EVERY instance in
 * the Project and its deletion on destroy revokes access to unrelated
 * servers — which is exactly why vibecarbon requires a DEDICATED Scaleway
 * Project per vibecarbon project (guided setup enforces the message; the
 * provider class header carries the doctrine). The frozen `sshKeyId`
 * output is that Project-level iam.SshKey's id.
 *
 * Cloud-init: `ubuntu_noble` ships no Docker (the Docker InstantApp's base
 * OS is unpinnable — audit), so the shared file gets the
 * official-Docker-apt-repo install spliced into `runcmd:` — keep
 * DOCKER_INSTALL_RUNCMD in lockstep with the digitalocean/linode/vultr
 * copies (not imported: each program's module graph must only load its own
 * Pulumi provider package).
 *
 * userData ENCODING: plain text under the `cloud-init` user-data key —
 * Scaleway has NO base64 leg (unlike Linode/Vultr) and gzip is explicitly
 * unsupported, so there is no 7-bit-clean safety net; assertAsciiCloudInit
 * (providers/scaleway.js — shared with the REST path) refuses non-ASCII
 * payloads loudly instead of trusting fidelity (DO precedent).
 *
 * Root volume: BASIC3 admits no local SSD (l_ssd max 0), so the root is an
 * SBS volume — with `deleteOnTermination: true` set EXPLICITLY, never
 * default-trusted: the API's `terminate` action only DETACHES sbs_volume
 * (SDK verbatim, audit), and a billed orphan volume per deploy is the
 * failure mode if this pin ever regresses.
 *
 * Security group: created first, attached at create via `securityGroupId`
 * (no unfirewalled window — the provider otherwise auto-creates an
 * untracked default group). Zone-scoped: compose is single-zone so ONE
 * group; a multi-zone tier needs one per zone. `stateful: true` pinned
 * explicitly (API-created groups default stateful, the per-AZ default
 * group is stateless — never rely on the default). Rules carry one
 * ipRange each, so operator-scoped ports expand to one rule per CIDR;
 * inbound default drop / outbound accept per the H-2 operator-lock
 * doctrine.
 *
 * Outputs: serverIp, serverId, firewallId, sshKeyId.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as scaleway from '@pulumiverse/scaleway';
import { APT_LOCK_OPT } from '../../deploy/apt.js';
import {
  assertAsciiCloudInit,
  encodeLabels,
  transliterateCloudInitToAscii,
} from '../../providers/scaleway.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLOUD_INIT_PATH = join(__dirname, '../../../../carbon/cloud-init/docker-ce-setup.yaml');

// SBS root-volume size — MUST byte-match
// ScalewayProvider.COMPOSE_ROOT_VOLUME_GB (the REST replacement path
// derives its volume template from that static; unit-pinned).
const ROOT_VOLUME_GB = 40;

// Official Docker apt-repo install — LOCKSTEP with the
// digitalocean/linode/vultr compose copies (see digitalocean-compose.js
// for the marketplace-image decision record, unchanged here).
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
export function renderScalewayUserData(sharedYaml) {
  const anchor = '\nruncmd:\n';
  const idx = sharedYaml.indexOf(anchor);
  if (idx === -1) {
    throw new Error(
      'renderScalewayUserData: `runcmd:` block not found in shared cloud-init ' +
        '(carbon/cloud-init/docker-ce-setup.yaml), file shape changed, update the splice anchor',
    );
  }
  const insertAt = idx + anchor.length;
  return `${sharedYaml.slice(0, insertAt)}${DOCKER_INSTALL_RUNCMD}\n${sharedYaml.slice(insertAt)}`;
}

/**
 * Load and render this provider's compose-tier boot user-data. RAW plain
 * text is also the WIRE encoding on Scaleway (no base64 leg anywhere), so
 * the transliterate-then-assert pipeline applies here at the single source
 * of truth for both consumers (this program and
 * ScalewayProvider.createServer's REST path): known typography in the
 * shared template's comments degrades deterministically to ASCII, anything
 * unmapped fails loudly (see the map's RCA in providers/scaleway.js).
 * @returns {string}
 */
export function loadScalewayComposeUserData() {
  return assertAsciiCloudInit(
    transliterateCloudInitToAscii(renderScalewayUserData(readFileSync(CLOUD_INIT_PATH, 'utf-8'))),
  );
}

/**
 * @typedef {Object} ComposeStackConfig
 * @property {string} projectName
 * @property {string} environment
 * @property {string} sshPublicKey
 * @property {string} [existingSshKeyId]
 * @property {string} location - Scaleway ZONE (fr-par-1 …)
 * @property {string} serverType
 * @property {Record<string,string>} [labels]
 * @property {string[]} [allowedSshIps]
 */

/**
 * @param {ComposeStackConfig} config
 * @returns {() => Promise<Record<string, unknown>>}
 */
export function buildScalewayComposeProgram(config) {
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
  const zone = config.location;
  const userData = loadScalewayComposeUserData();

  // One rule per (port × source) — Scaleway rules carry ONE ipRange each.
  // World-open ports get the v4+v6 pair; operator-scoped ports (SSH +
  // Supavisor poolers, kept in lockstep by applyOperatorCidrs'
  // OPERATOR_LOCKED_PORTS) one rule per CIDR. Ports are NUMBERS in the
  // Pulumi shape (dest_port_from/to on the wire).
  const WORLD = ['0.0.0.0/0', '::/0'];
  const inboundRules = [
    ...allowedSshIps.map((cidr) => ({
      action: 'accept',
      protocol: 'TCP',
      port: 22,
      ipRange: cidr,
    })),
    ...WORLD.map((cidr) => ({ action: 'accept', protocol: 'TCP', port: 80, ipRange: cidr })),
    ...WORLD.map((cidr) => ({ action: 'accept', protocol: 'TCP', port: 443, ipRange: cidr })),
    // Supavisor pooler ports — operator-scoped like SSH, NEVER world-open.
    ...allowedSshIps.map((cidr) => ({
      action: 'accept',
      protocol: 'TCP',
      port: 5432,
      ipRange: cidr,
    })),
    ...allowedSshIps.map((cidr) => ({
      action: 'accept',
      protocol: 'TCP',
      port: 6543,
      ipRange: cidr,
    })),
  ];

  return async () => {
    // Project-level IAM SSH key — see the module header's dedicated-Project
    // doctrine. The frozen-contract sshKeyId output is THIS resource's id.
    let sshKeyId; // frozen-contract shape: string | Output<string>
    if (config.existingSshKeyId) {
      sshKeyId = config.existingSshKeyId;
    } else {
      const sshKey = new scaleway.iam.SshKey('ssh-key', {
        name: `${name}-${zone}-key`,
        publicKey: config.sshPublicKey.trim(),
      });
      sshKeyId = sshKey.id;
    }

    // Security group FIRST — the instance attaches at create time via
    // securityGroupId (no unfirewalled window). See the module header for
    // the stateful/zone-scope pins.
    const securityGroup = new scaleway.instance.SecurityGroup('firewall', {
      name: `${name}-firewall`,
      zone,
      stateful: true,
      inboundDefaultPolicy: 'drop',
      outboundDefaultPolicy: 'accept',
      inboundRules,
      tags: encodeLabels(labels),
    });

    // Flexible (routed) IPv4 — survives server replacement and gives the
    // frozen serverIp output a stable source. Tagged so the sweep's
    // flexible-IP arm can attribute ownership (IPs have no name field).
    // Pulumi's delete handles the release; the raw-API teardown path has
    // its own release step (ScalewayProvider.deleteServer step 5).
    const ip = new scaleway.instance.Ip('ip', {
      zone,
      type: 'routed_ipv4',
      tags: encodeLabels(labels),
    });

    const server = new scaleway.instance.Server('server', {
      name,
      zone,
      type: config.serverType,
      // Marketplace LABEL — MUST byte-match ScalewayProvider.COMPOSE_IMAGE
      // ('ubuntu_noble'; UUIDs are per-zone AND per-volume-type, audit).
      image: 'ubuntu_noble',
      securityGroupId: securityGroup.id,
      ipIds: [ip.id],
      // SBS root with EXPLICIT deleteOnTermination — never default-trusted
      // (terminate only detaches sbs_volume; see the module header).
      rootVolume: {
        // Provider ENUM VALUE — snake_case, and not subject to the camelCase
        // conversion Pulumi applies to property NAMES. `sbsVolume` reads
        // plausible next to `volumeType`/`sizeInGb` and is rejected at
        // provision time: "expected volume_type to be one of [... sbs_volume
        // ...], got sbsVolume" (CI run 31706718048).
        volumeType: 'sbs_volume',
        sizeInGb: ROOT_VOLUME_GB,
        deleteOnTermination: true,
      },
      // Plain text under the `cloud-init` user-data key (audit: the
      // key-value user-data store; no base64/gzip leg).
      userData: { 'cloud-init': userData },
      tags: encodeLabels({ ...labels, role: 'compose' }),
    });

    // Zoned Pulumi resources carry COMPOSITE ids (`{zone}/{uuid}` — the
    // bridged TF provider's convention for zone-scoped resources). The
    // frozen outputs feed the provider's REST paths (destroy, scale,
    // status probes), which speak bare UUIDs — strip to the last segment.
    // iam.SshKey is global (bare UUID already); the strip is identity there.
    const bareId = (id) => String(id).split('/').pop();

    return {
      serverIp: ip.address,
      serverId: server.id.apply(bareId),
      firewallId: securityGroup.id.apply(bareId),
      sshKeyId: typeof sshKeyId === 'string' ? sshKeyId : sshKeyId.apply(bareId),
    };
  };
}
