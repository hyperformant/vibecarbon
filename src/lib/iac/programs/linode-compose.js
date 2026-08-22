/**
 * Pulumi program for a single Linode Docker Compose instance.
 *
 * Mirrors hetzner-compose.js / digitalocean-compose.js: one server, one
 * firewall, no floating IP.
 *
 * Cloud-init: `linode/ubuntu24.04` ships no Docker (Linode's Marketplace
 * Docker app is a StackScript, not an image — linode-step0-audit.md), so
 * this program renders an extended user-data via renderLinodeUserData():
 * the shared file's `runcmd:` block gets the official-Docker-apt-repo
 * install sequence spliced in immediately after the `runcmd:` key — same
 * splice as digitalocean-compose.js (keep DOCKER_INSTALL_RUNCMD in
 * lockstep with that module's copy; not imported from it because the DO
 * program's module graph top-level-imports @pulumi/digitalocean, which a
 * Linode deploy has no reason to load).
 *
 * NO ASCII transliteration here, unlike the DO program: Linode user-data
 * is delivered base64-encoded (`metadatas[].userData`, caller-encoded —
 * verified 2026-08-07 on the Pulumi registry), and base64 is 7-bit clean
 * end-to-end, so DO's double-encoding failure class cannot occur. Bytes are
 * preserved verbatim; the l1 e2e run's ready-marker is the fidelity proof.
 *
 * Outputs: serverIp, serverId, firewallId, sshKeyId.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as linode from '@pulumi/linode';
import { APT_LOCK_OPT } from '../../deploy/apt.js';
import {
  encodeLabels,
  splitCidrsByFamily,
  squeezeLinodeInstanceLabel,
  squeezeLinodeLabel,
} from '../../providers/linode.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLOUD_INIT_PATH = join(__dirname, '../../../../carbon/cloud-init/docker-ce-setup.yaml');

// Official Docker apt-repo install — keep in LOCKSTEP with
// digitalocean-compose.js's DOCKER_INSTALL_RUNCMD (same idempotency
// argument; see that module's comment for the marketplace-image decision
// record, which applies here unchanged: no 24.04-based Docker image exists
// on Linode either).
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
 * `runcmd:` list, immediately after the `runcmd:` key — so the install
 * steps run BEFORE the shared file's own `systemctl enable --now docker`
 * step. Throws (fail loud, not silent) if the shared file's shape ever
 * changes such that the anchor can't be found — same contract as
 * renderDoUserData.
 * @param {string} sharedYaml - carbon/cloud-init/docker-ce-setup.yaml content
 * @returns {string}
 */
export function renderLinodeUserData(sharedYaml) {
  const anchor = '\nruncmd:\n';
  const idx = sharedYaml.indexOf(anchor);
  if (idx === -1) {
    throw new Error(
      'renderLinodeUserData: `runcmd:` block not found in shared cloud-init ' +
        '(carbon/cloud-init/docker-ce-setup.yaml), file shape changed, update the splice anchor',
    );
  }
  const insertAt = idx + anchor.length;
  return `${sharedYaml.slice(0, insertAt)}${DOCKER_INSTALL_RUNCMD}\n${sharedYaml.slice(insertAt)}`;
}

/**
 * Load and render this provider's compose-tier boot user-data (RAW YAML —
 * base64 encoding happens at the wire boundaries: this module's Pulumi
 * program below, and LinodeProvider.createServer's REST path). Single
 * source of truth for BOTH consumers, same contract as
 * loadDoComposeUserData.
 * @returns {string}
 */
export function loadLinodeComposeUserData() {
  return renderLinodeUserData(readFileSync(CLOUD_INIT_PATH, 'utf-8'));
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
export function buildLinodeComposeProgram(config) {
  const name = `${config.projectName}-${config.environment}`;
  const labels = {
    project: config.projectName,
    environment: config.environment,
    ...(config.labels ?? {}),
  };
  // Operator-IP firewall lock (mirrors the H-2 guard in both sibling
  // programs) — an empty list would silently apply an open default.
  if (!config.allowedSshIps?.length) {
    throw new Error(
      'allowedSshIps required (no default; pass operatorCidrs from .vibecarbon.json or set ALLOWED_SSH_IPS=...)',
    );
  }
  const allowedSshIps = config.allowedSshIps;
  // splitCidrsByFamily returns the REST wire shape ({ipv4, ipv6}); the
  // Pulumi provider's rule properties are the PLURAL `ipv4s`/`ipv6s` —
  // spreading the wire shape into an inbound rule silently drops the
  // addresses entirely and the API 400s with "addresses: Must be one of:
  // ipv4, ipv6" (live l1 failure 2026-08-08, attempt 3). Adapt here, once.
  const operatorWire = splitCidrsByFamily(allowedSshIps);
  const operatorAddresses = {
    ...(operatorWire.ipv4 ? { ipv4s: operatorWire.ipv4 } : {}),
    ...(operatorWire.ipv6 ? { ipv6s: operatorWire.ipv6 } : {}),
  };
  const worldAddresses = { ipv4: ['0.0.0.0/0'], ipv6: ['::/0'] };
  const userData = loadLinodeComposeUserData();
  const userDataB64 = Buffer.from(userData, 'utf-8').toString('base64');

  return async () => {
    // Profile-level SSH key resource: Linode instances take raw key
    // MATERIAL (authorizedKeys below), not key ids — the SshKey resource
    // exists so the frozen `sshKeyId` output contract stays real and so
    // destroy's deleteSSHKeyByName has something to reap. Name includes
    // region for parity with the sibling programs' account-wide-namespace
    // reasoning.
    let sshKeyId; // frozen-contract shape: string | Output<string>
    if (config.existingSshKeyId) {
      sshKeyId = config.existingSshKeyId;
    } else {
      const sshKey = new linode.SshKey('ssh-key', {
        label: `${name}-${config.location}-key`,
        sshKey: config.sshPublicKey.trim(),
      });
      sshKeyId = sshKey.id;
    }

    // Firewall FIRST — the instance attaches at create time via
    // `firewallId` (Linode supports create-time attach, so there is no
    // unfirewalled window and no DO-style two-step). Rule shape: Linode
    // keeps ipv4/ipv6 sources in separate arrays and requires a per-rule
    // label + action; policies are the default verdicts.
    const firewall = new linode.Firewall('firewall', {
      // Squeezed into Linode's 32-char firewall-label cap — MUST stay the
      // same derivation findFirewallByName uses (match-Pulumi-names
      // doctrine; see squeezeLinodeLabel's doc).
      label: squeezeLinodeLabel(`${name}-firewall`),
      inboundPolicy: 'DROP',
      outboundPolicy: 'ACCEPT',
      inbounds: [
        { label: 'ssh', action: 'ACCEPT', protocol: 'TCP', ports: '22', ...operatorAddresses },
        {
          label: 'http',
          action: 'ACCEPT',
          protocol: 'TCP',
          ports: '80',
          ipv4s: worldAddresses.ipv4,
          ipv6s: worldAddresses.ipv6,
        },
        {
          label: 'https',
          action: 'ACCEPT',
          protocol: 'TCP',
          ports: '443',
          ipv4s: worldAddresses.ipv4,
          ipv6s: worldAddresses.ipv6,
        },
        // Supavisor pooler ports — operator-CIDR-scoped like SSH, NEVER
        // world-open (password auth straight into Postgres). Kept in
        // lockstep with SSH by applyOperatorCidrs (OPERATOR_LOCKED_PORTS).
        {
          label: 'pooler-session',
          action: 'ACCEPT',
          protocol: 'TCP',
          ports: '5432',
          ...operatorAddresses,
        },
        {
          label: 'pooler-transaction',
          action: 'ACCEPT',
          protocol: 'TCP',
          ports: '6543',
          ...operatorAddresses,
        },
      ],
      tags: encodeLabels(labels),
    });

    const instance = new linode.Instance('server', {
      // Squeezed to Linode's 3-50 instance cap through the shared helper, so
      // findServersByName (and the destroy path behind it) derives the same
      // wire label. compose-HA's `-primary`/`-standby` suffix is what pushes
      // realistic project names past 50 — live CI failure 2026-08-20.
      label: squeezeLinodeInstanceLabel(name),
      region: config.location,
      type: config.serverType,
      // Plain Ubuntu LTS — see the module doc comment (no Docker image on
      // Linode; cloud-init installs it).
      image: 'linode/ubuntu24.04',
      // Raw OpenSSH key material — Linode's create contract (ids/names are
      // a REST-path resolution concern, see LinodeProvider._resolveSshKeyMaterial).
      authorizedKeys: [config.sshPublicKey.trim()],
      // Base64-encoded by US (the provider does not encode) — verified on
      // the registry's instance docs 2026-08-07.
      metadatas: [{ userData: userDataB64 }],
      firewallId: firewall.id.apply((id) => Number.parseInt(id, 10)),
      tags: encodeLabels({ ...labels, role: 'compose' }),
    });

    return {
      serverIp: instance.ipAddress,
      serverId: instance.id.apply((id) => String(id)),
      firewallId: firewall.id.apply((id) => String(id)),
      sshKeyId: typeof sshKeyId === 'string' ? sshKeyId : sshKeyId.apply((id) => String(id)),
    };
  };
}
