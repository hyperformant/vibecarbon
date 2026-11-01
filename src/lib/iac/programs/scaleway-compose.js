import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as scaleway from '@pulumiverse/scaleway';
import { APT_LOCK_OPT } from '../../deploy/apt.js';
import {
  assertAsciiCloudInit,
  encodeLabels,
  transliterateCloudInitToAscii,
} from '../../providers/scaleway.js';
import { loadComposeCloudInit } from '../compose-cloud-init.js';
import { serverResourceOptions } from '../create-timeout.js';

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
    transliterateCloudInitToAscii(renderScalewayUserData(loadComposeCloudInit())),
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
  // World-open ports get the v4+v6 pair; the operator-scoped SSH port (kept
  // in lockstep by applyOperatorCidrs' OPERATOR_LOCKED_PORTS) one rule per
  // CIDR. Ports are NUMBERS in the
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

    const server = new scaleway.instance.Server(
      'server',
      {
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
      },
      // Bounded create: a provider host that never finishes the create fails the
      // deploy at 15 minutes instead of holding it forever (see create-timeout.js).
      serverResourceOptions('scaleway:instance/server:Server'),
    );

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
