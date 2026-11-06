import * as digitalocean from '@pulumi/digitalocean';
import { encodeLabels } from '../../providers/digitalocean.js';
import { loadComposeCloudInit } from '../compose-cloud-init.js';
import { serverResourceOptions } from '../create-timeout.js';
import { spliceDockerInstall } from '../docker-install.js';

// The Docker install spliced into the user data is the one shared by every
// compose provider: see ../docker-install.js (why the latest Docker, why no
// prebuilt Docker image).

// DO's user-data delivery pipeline double-encodes non-ASCII (RCA
// 2026-07-25, droplet evidence: a rendered em-dash — UTF-8 `E2 80 94` —
// arrived on the droplet as `C3 A2 C2 80 C2 94`, i.e. the UTF-8 bytes were
// reinterpreted as Latin-1 and re-encoded to UTF-8 a second time). Decoded,
// that sequence contains U+0080, a C1 control character the YAML spec
// forbids anywhere, including comments — DO's cloud-init (PyYAML) rejects
// the ENTIRE #cloud-config part with SCHEMA_ERROR, silently dropping the
// Docker install steps and the ready-marker. b257af8's byte-fidelity pin
// proved this repo's read -> splice -> Droplet-userData-input pipeline
// emits clean, single-encoded UTF-8 throughout, so the mangling happens
// downstream — most likely the vendored @pulumi/digitalocean /
// terraform-bridge marshaling layer, or DO's own user-data ingestion —
// neither of which is reachable or fixable from this repo.
//
// The durable sidestep, correct regardless of which downstream layer is
// responsible: never hand DO user-data any non-ASCII byte in the first
// place. ASCII-only output is the wire contract for DO user-data. Known
// typography used in the shared cloud-init template is transliterated
// explicitly below; anything else non-ASCII (unexpected today — the
// shared file is maintained outside this program) falls back to '?'
// rather than risk shipping bytes the downstream pipeline can mangle into
// invalid YAML. The Hetzner path is untouched: its user-data goes to the
// Hetzner API directly with no observed mangling, so byte-identity there
// is preserved.
export const ASCII_TRANSLITERATION_MAP = {
  '—': '--', // em dash
  '–': '-', // – en dash
  '‘': "'", // ' left single quote
  '’': "'", // ' right single quote
  '“': '"', // " left double quote
  '”': '"', // " right double quote
  '…': '...', // … ellipsis
};

/**
 * Transliterate a string to pure ASCII using ASCII_TRANSLITERATION_MAP,
 * with a '?' fallback for any non-ASCII character the map doesn't cover.
 * @param {string} input
 * @returns {string}
 */
export function transliterateToAscii(input) {
  let out = '';
  for (const ch of input) {
    if (ch.codePointAt(0) <= 0x7f) {
      out += ch;
      continue;
    }
    out += ASCII_TRANSLITERATION_MAP[ch] ?? '?';
  }
  return out;
}

/**
 * Splice the Docker-CE install block into the shared compose cloud-init's
 * `runcmd:` list, immediately after the `runcmd:` key — so the install
 * steps run BEFORE the shared file's own `systemctl enable --now docker`
 * step. Throws (fail loud, not silent) if the shared file's shape ever
 * changes such that the `runcmd:` anchor can't be found, since a silent
 * no-op splice would ship a droplet that fails at `docker compose up` with
 * no diagnostic pointing back here. The final render is transliterated to
 * pure ASCII — see ASCII_TRANSLITERATION_MAP above for why.
 * @param {string} sharedYaml - carbon/cloud-init/docker-ce-setup.yaml content
 * @returns {string}
 */
export function renderDoUserData(sharedYaml) {
  return transliterateToAscii(spliceDockerInstall(sharedYaml, 'renderDoUserData'));
}

/**
 * Load and render this provider's compose-tier boot user-data: read the
 * shared cloud-init file and run it through renderDoUserData(). Single
 * source of truth for BOTH this module's own Pulumi program
 * (buildDigitalOceanComposeProgram, below) and
 * DigitalOceanProvider.getComposeUserData (the scale/replacement path's
 * direct createServer() call, providers/digitalocean.js) — neither
 * duplicates the file read or the splice/transliteration.
 * @returns {string}
 */
export function loadDoComposeUserData() {
  return renderDoUserData(loadComposeCloudInit());
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
export function buildDigitalOceanComposeProgram(config) {
  const name = `${config.projectName}-${config.environment}`;
  const labels = {
    project: config.projectName,
    environment: config.environment,
    ...(config.labels ?? {}),
  };
  // Operator-IP firewall lock (mirrors hetzner-compose.js's H-2 guard) — an
  // empty list would silently apply an open default, so we refuse instead.
  if (!config.allowedSshIps?.length) {
    throw new Error(
      'allowedSshIps required (no default; pass operatorCidrs from .vibecarbon.json or set ALLOWED_SSH_IPS=...)',
    );
  }
  const allowedSshIps = config.allowedSshIps;
  const userData = loadDoComposeUserData();

  return async () => {
    // SshKey has no tags/labels input in @pulumi/digitalocean (DO's SSH-key
    // API is untaggable — see DigitalOceanProvider.createSSHKey, B3, which
    // posts no tags field either).
    let sshKeyId; // frozen-contract shape: string | Output<string>
    let sshKeyIdForDroplet; // Droplet.sshKeys wants Input<string>[] too — see below
    if (config.existingSshKeyId) {
      sshKeyId = config.existingSshKeyId;
      sshKeyIdForDroplet = config.existingSshKeyId;
    } else {
      // Name includes region so parallel or re-deploys across regions don't
      // collide in DigitalOcean's account-wide SSH-key namespace.
      const sshKey = new digitalocean.SshKey('ssh-key', {
        name: `${name}-${config.location}-key`,
        publicKey: config.sshPublicKey,
      });
      sshKeyId = sshKey.id;
      sshKeyIdForDroplet = sshKey.id;
    }

    const droplet = new digitalocean.Droplet(
      'server',
      {
        name,
        region: config.location,
        size: config.serverType,
        // Plain Ubuntu LTS — see the module doc comment for why this isn't
        // a docker-preinstalled marketplace image yet (Step 1 parity note).
        image: 'ubuntu-26-04-x64',
        // Despite DO's REST API using numeric key IDs, @pulumi/digitalocean's
        // DropletArgs.sshKeys type is Input<string>[] — the TF-bridged
        // provider does its own string/id marshaling internally, so this
        // must NOT be parseInt'd (unlike dropletIds below, which the SDK
        // types as number[]).
        sshKeys: [sshKeyIdForDroplet],
        tags: encodeLabels({ ...labels, role: 'compose' }),
        userData,
        // Skip DO's Droplet Console agent (44-68s of vendor cloud-init per boot).
        dropletAgent: false,
      },
      // Bounded create: a provider host that never finishes the create fails the
      // deploy at 15 minutes instead of holding it forever (see create-timeout.js).
      serverResourceOptions('digitalocean:index/droplet:Droplet'),
    );

    const firewall = new digitalocean.Firewall('firewall', {
      name: `${name}-firewall`,
      dropletIds: [droplet.id.apply((id) => Number.parseInt(id, 10))],
      inboundRules: [
        { protocol: 'tcp', portRange: '22', sourceAddresses: allowedSshIps },
        { protocol: 'tcp', portRange: '80', sourceAddresses: ['0.0.0.0/0', '::/0'] },
        { protocol: 'tcp', portRange: '443', sourceAddresses: ['0.0.0.0/0', '::/0'] },
      ],
      outboundRules: [
        { protocol: 'tcp', portRange: '1-65535', destinationAddresses: ['0.0.0.0/0', '::/0'] },
        { protocol: 'udp', portRange: '1-65535', destinationAddresses: ['0.0.0.0/0', '::/0'] },
        { protocol: 'icmp', destinationAddresses: ['0.0.0.0/0', '::/0'] },
      ],
    });

    return {
      serverIp: droplet.ipv4Address,
      serverId: droplet.id.apply((id) => String(id)),
      firewallId: firewall.id.apply((id) => String(id)),
      sshKeyId: typeof sshKeyId === 'string' ? sshKeyId : sshKeyId.apply((id) => String(id)),
    };
  };
}
