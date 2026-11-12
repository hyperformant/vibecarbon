import * as linode from '@pulumi/linode';
import * as pulumi from '@pulumi/pulumi';
import {
  encodeLabels,
  splitCidrsByFamily,
  squeezeLinodeInstanceLabel,
  squeezeLinodeLabel,
} from '../../providers/linode.js';
import { loadComposeCloudInit } from '../compose-cloud-init.js';
import { SERVER_OWNER_LABELS, serverResourceOptions } from '../create-timeout.js';
import { spliceDockerInstall } from '../docker-install.js';

// The Docker install spliced into the user data is the one shared by every
// compose provider: see ../docker-install.js.

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
  return spliceDockerInstall(sharedYaml, 'renderLinodeUserData');
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
  return renderLinodeUserData(loadComposeCloudInit());
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
  // Ownership (SERVER_OWNER_LABELS) before the caller's labels, as every
  // caller has always passed it: the same keys in the same order.
  const labels = {
    project: config.projectName,
    environment: config.environment,
    ...SERVER_OWNER_LABELS,
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
      ],
      tags: encodeLabels(labels),
    });

    const instance = new linode.Instance(
      'server',
      {
        // Squeezed to Linode's 3-50 instance cap through the shared helper, so
        // findServersByName (and the destroy path behind it) derives the same
        // wire label. compose-HA's `-primary`/`-standby` suffix is what pushes
        // realistic project names past 50 — live CI failure 2026-08-20.
        label: squeezeLinodeInstanceLabel(name),
        region: config.location,
        type: config.serverType,
        // Plain Ubuntu LTS — see the module doc comment (no Docker image on
        // Linode; cloud-init installs it).
        image: 'linode/ubuntu26.04',
        // Raw OpenSSH key material — Linode's create contract (ids/names are
        // a REST-path resolution concern, see LinodeProvider._resolveSshKeyMaterial).
        authorizedKeys: [config.sshPublicKey.trim()],
        // Base64-encoded by US (the provider does not encode) — verified on
        // the registry's instance docs 2026-08-07.
        metadatas: pulumi.secret([{ userData: userDataB64 }]),
        firewallId: firewall.id.apply((id) => Number.parseInt(id, 10)),
        tags: encodeLabels({ ...labels, role: 'compose' }),
      },
      // Bounded create: a provider host that never finishes the create fails the
      // deploy at 15 minutes instead of holding it forever (see create-timeout.js).
      serverResourceOptions('linode:index/instance:Instance'),
    );

    return {
      serverIp: instance.ipAddress,
      serverId: instance.id.apply((id) => String(id)),
      firewallId: firewall.id.apply((id) => String(id)),
      sshKeyId: typeof sshKeyId === 'string' ? sshKeyId : sshKeyId.apply((id) => String(id)),
    };
  };
}
