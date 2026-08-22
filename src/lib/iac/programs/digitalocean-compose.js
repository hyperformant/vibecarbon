/**
 * Pulumi program for a single DigitalOcean Docker Compose droplet.
 *
 * Mirrors hetzner-compose.js: one server, one firewall, no floating IP.
 *
 * Cloud-init parity (Step 1, blocking): Hetzner uses the `docker-ce`
 * marketplace image, which ships Docker pre-installed, so
 * carbon/cloud-init/docker-ce-setup.yaml can assume `docker.service`
 * already exists (its own comment: "Ensure Docker is running (docker-ce
 * app usually starts it, but be defensive)" — a bare `systemctl enable
 * --now docker` with no install step). DigitalOcean's `docker-ce` slug
 * situation could not be verified against the real Marketplace API (no DO
 * credentials in this environment yet — see the TODO(B7) below), so this
 * program uses the plain `ubuntu-24-04-x64` base image and renders an
 * extended user-data via renderDoUserData(): the shared file's `runcmd:`
 * block gets an official-Docker-apt-repo install sequence spliced in
 * immediately after the `runcmd:` key, so it runs BEFORE the shared file's
 * `systemctl enable --now docker` step. Every other line of the shared
 * file (ufw rules, unattended-upgrades, the ready-marker) is reused as-is.
 *
 * Outputs: serverIp, serverId, firewallId, sshKeyId.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as digitalocean from '@pulumi/digitalocean';
import { APT_LOCK_OPT } from '../../deploy/apt.js';
import { encodeLabels } from '../../providers/digitalocean.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLOUD_INIT_PATH = join(__dirname, '../../../../carbon/cloud-init/docker-ce-setup.yaml');

// Official Docker apt-repo install, spliced into the shared cloud-init's
// `runcmd:` list (see renderDoUserData). Idempotent / safe to re-run:
// `install -m` re-applies the same mode, the curl step overwrites the
// keyring file with identical bytes, and `apt-get install -y` on
// already-installed packages is a no-op — matching the "runcmd-safe"
// idempotency the shared file's own `mkdir -p` step already relies on.
//
// Why install Docker rather than start from a prebuilt image: a DigitalOcean
// Docker 1-Click marketplace app DOES exist (slug `docker-20-04`, listed as
// current in DO's catalog docs, re-verified 2026-07-30) — an earlier comment
// here asserted the opposite and told the next engineer not to look, which was
// wrong. The reason we don't use it is that despite the slug it is built on
// Ubuntu 22.04, while this program pins `ubuntu-24-04-x64` (line ~204) to stay
// on the same OS as the Hetzner path. Adopting the 1-Click image would mean an
// OS downgrade plus cross-provider divergence, which costs more than this
// install block does.
//
// What would change the decision: DigitalOcean publishing a 24.04-based Docker
// image. At that point prefer it — it removes an apt fetch + install from every
// droplet's first boot, which is the least stable moment to depend on network.
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
  const anchor = '\nruncmd:\n';
  const idx = sharedYaml.indexOf(anchor);
  if (idx === -1) {
    throw new Error(
      'renderDoUserData: `runcmd:` block not found in shared cloud-init ' +
        '(carbon/cloud-init/docker-ce-setup.yaml), file shape changed, update the splice anchor',
    );
  }
  const insertAt = idx + anchor.length;
  const spliced = `${sharedYaml.slice(0, insertAt)}${DOCKER_INSTALL_RUNCMD}\n${sharedYaml.slice(insertAt)}`;
  return transliterateToAscii(spliced);
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
  return renderDoUserData(readFileSync(CLOUD_INIT_PATH, 'utf-8'));
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

    const droplet = new digitalocean.Droplet('server', {
      name,
      region: config.location,
      size: config.serverType,
      // Plain Ubuntu LTS — see the module doc comment for why this isn't
      // a docker-preinstalled marketplace image yet (Step 1 parity note).
      image: 'ubuntu-24-04-x64',
      // Despite DO's REST API using numeric key IDs, @pulumi/digitalocean's
      // DropletArgs.sshKeys type is Input<string>[] — the TF-bridged
      // provider does its own string/id marshaling internally, so this
      // must NOT be parseInt'd (unlike dropletIds below, which the SDK
      // types as number[]).
      sshKeys: [sshKeyIdForDroplet],
      tags: encodeLabels({ ...labels, role: 'compose' }),
      userData,
    });

    const firewall = new digitalocean.Firewall('firewall', {
      name: `${name}-firewall`,
      dropletIds: [droplet.id.apply((id) => Number.parseInt(id, 10))],
      inboundRules: [
        { protocol: 'tcp', portRange: '22', sourceAddresses: allowedSshIps },
        { protocol: 'tcp', portRange: '80', sourceAddresses: ['0.0.0.0/0', '::/0'] },
        { protocol: 'tcp', portRange: '443', sourceAddresses: ['0.0.0.0/0', '::/0'] },
        // Supavisor pooler ports — operator-CIDR-scoped like SSH, NEVER
        // world-open (password auth straight into Postgres). Kept in
        // lockstep with SSH by applyOperatorCidrs (OPERATOR_LOCKED_PORTS).
        { protocol: 'tcp', portRange: '5432', sourceAddresses: allowedSshIps },
        { protocol: 'tcp', portRange: '6543', sourceAddresses: allowedSshIps },
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
