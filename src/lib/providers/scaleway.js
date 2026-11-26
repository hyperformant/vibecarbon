/**
 * Scaleway Cloud Provider
 *
 * Compose + compose-ha provider (PR 3 of the 2026-08 provider expansion +
 * tier-parity wave 1 — see
 * the scaleway-provider-step0-audit plan for the
 * live-API-verified capability audit). The k8s statics throw
 * provider-specific errors (Scaleway's k8s tier is unbuilt, not forgotten —
 * 4-mode headroom is recorded in the audit).
 *
 * Scaleway-shape notes (vs the Hetzner/DO/Linode/Vultr templates):
 *
 * - THE API IS ZONE-SCOPED. Every Instance-API path embeds a zone
 *   (`/instance/v1/zones/{zone}/…`), and resource UUIDs only resolve in
 *   their own zone. REGIONS is therefore keyed on ZONES (fr-par-1 …), and
 *   listings walk every REGIONS zone; id-scoped operations resolve the
 *   zone by probing (cached per instance in `_zoneCache`). Security groups
 *   and SBS volumes are zone-scoped too — compose is single-zone so one
 *   security group per deploy, and compose-ha's two zones are satisfied by
 *   construction: each stack creates its own group, never one shared.
 * - AUTH is `X-Auth-Token: <secret key>` (SCALEWAY_SECRET_KEY alone; the access
 *   key is never sent on the REST path — it exists for the Pulumi/S3
 *   sides, see buildIacEnv). apiRequest is overridden accordingly.
 * - THREE credentials, not one: the Pulumi provider requires
 *   SCALEWAY_ACCESS_KEY + SCALEWAY_SECRET_KEY + SCALEWAY_DEFAULT_PROJECT_ID — see the
 *   buildIacEnv override, which fails at deploy start naming the missing
 *   var instead of mid-`pulumi up`.
 * - SSH KEYS ARE PROJECT-SCOPED AND REWRITTEN EVERY BOOT: there is no
 *   per-instance key resource; `scw-fetch-ssh-keys` regenerates
 *   /root/.ssh/authorized_keys at every boot from ALL of the Project's IAM
 *   keys. Creating our deploy key therefore grants access to every other
 *   instance in the operator's Project, and deleting it on destroy revokes
 *   access to unrelated servers — so vibecarbon REQUIRES A DEDICATED
 *   SCALEWAY PROJECT PER VIBECARBON PROJECT (same isolation doctrine as
 *   Hetzner's per-project API tokens; guided setup says this too).
 *   `createServer` consequently takes no ssh-key field at all — the
 *   Project's keys are the mechanism (audit design flag 1).
 * - TERMINATE ONLY DETACHES SBS VOLUMES (SDK verbatim: "The `terminate`
 *   action will result in the deletion of `l_ssd` and `scratch` volumes
 *   types, `sbs_volume` volumes will only be detached"), and BASIC3/
 *   COMPUTE3 types cannot use local SSD at all — so every root volume here
 *   is SBS and a naive delete leaks a billed volume every time. Flexible
 *   IPv4s likewise survive server deletion and keep billing. deleteServer
 *   is therefore a full teardown chain (terminate → wait gone → delete
 *   detached SBS volumes → release surviving flexible IPs), not a bare
 *   DELETE — billing-leak safety is first-class, not best-effort.
 * - STALE-DOCS HAZARD: Scaleway's prose docs measurably lag its live APIs
 *   (audit design flag 6). Every literal in this class was pinned from the
 *   live public catalog/availability APIs or the Go SDK source, never from
 *   a rendered docs page.
 *
 * API Documentation: https://www.scaleway.com/en/developers/api/instance/
 */

import { canonicalIpRange } from '../cidr.js';
import { fetchWithRetry } from '../fetch-retry.js';
import { readOperatorVar } from '../operator-env.js';
import { pollUntil } from '../retry.js';
import {
  BaseProvider,
  deleteFailure,
  deleteNetworkAt,
  deleteRefused,
  networkListingWhole,
  normalizePublicKey,
  replaceWireguardPeerRules,
  standbyPairOrNeighbour,
  sweepLabels,
  waitUntilServerUp,
} from './base.js';
import { transliterateWith } from './cloud-init-ascii.js';
import { decodeLabels, withAllTags } from './tag-labels.js';

// Ports whose inbound rules applyOperatorCidrs rewrites — same set as the
// sibling providers (SSH, k8s API for future parity).
// Numeric: Scaleway rules carry dest_port_from/dest_port_to as numbers.
const SSH_PORT = 22;
const K8S_API_PORT = 6443;
const OPERATOR_LOCKED_PORTS = new Set([SSH_PORT, K8S_API_PORT]);

/**
 * A security group rule in one form, however it is spelled: what every
 * comparison of a listed rule reads, never the raw fields. The Instance API
 * lists a rule in its own form: a host range bare (`1.2.3.0` for
 * `1.2.3.0/32`, an IPv6 /128 as the bare address) and a single port as
 * `dest_port_to: null` (terraform-provider-scaleway v2.92.1 cassettes,
 * internal/services/instance/testdata/security-group-basic and
 * security-group-rules-ip-ranges). The CLI writes `/32` and both ports. So
 * the range is canonicalIpRange's (null when it is none), and a missing
 * `dest_port_to` is `dest_port_from`. Ports are numbers, or null.
 * @param {{action?: string, protocol?: string, direction?: string, ip_range?: string,
 *   dest_port_from?: number|string|null, dest_port_to?: number|string|null}} rule
 * @returns {{action?: string, protocol?: string, direction?: string, ip_range: string|null,
 *   dest_port_from: number|null, dest_port_to: number|null}}
 */
export function canonicalScalewayRule(rule) {
  const port = (value) => (value === null || value === undefined ? null : Number(value));
  const from = port(rule.dest_port_from);
  return {
    action: rule.action,
    protocol: rule.protocol,
    direction: rule.direction,
    ip_range: canonicalIpRange(rule.ip_range),
    dest_port_from: from,
    dest_port_to: port(rule.dest_port_to) ?? from,
  };
}

/**
 * An inbound TCP rule on an operator-locked port: the rules
 * applyOperatorCidrs rebuilds, and writes after every other.
 * @param {object} rule a rule as listed or as built
 * @returns {boolean}
 */
function isOperatorLockedRule(rule) {
  const r = canonicalScalewayRule(rule);
  return (
    r.direction === 'inbound' && r.protocol === 'TCP' && OPERATOR_LOCKED_PORTS.has(r.dest_port_from)
  );
}

// Inbound DB ports a retired external pooler once opened to the operator
// CIDRs; applyOperatorCidrs deletes any such rule (the database has no
// public port).
const RETIRED_DB_PORTS = new Set([5432, 6543]);

// WireGuard replication port (wireguard.js WG_PORT) — only reachable via
// compose-ha (declared since tier-parity wave 1). Numeric (see above).
const WG_PORT = 51821;

// GB on Scaleway's wire is 10^9 bytes (the live catalog reports
// volumes_constraint.max_size = 40000000000 for DEV1-M's 40 GB).
const GB = 1_000_000_000;

/**
 * How long deleteServer waits for a terminated server's record to go.
 */
const TERMINATE_WAIT_MS = 120_000;

/** How long deleteServer keeps trying to delete a detached SBS volume. */
const SBS_DELETE_WAIT_MS = 60_000;

/**
 * Servers this process asked Scaleway to terminate that were still there
 * when deleteServer stopped waiting (TERMINATE_WAIT_MS). Module-level, not
 * per instance: destroy deletes servers and sweeps flexible IPs through
 * different provider instances (compose-ha). The label sweep reads it, so an
 * IP still attached to one is reported as waiting on a termination the next
 * destroy finds finished, not as held by a server nobody deleted.
 * @type {Set<string>}
 */
const serversStillTerminating = new Set();

/**
 * One listing over several scopes (the zones, or the VPC API's regions),
 * merged: complete only when every scope's walk completed, with the status
 * of the last scope that answered non-ok.
 * @param {string[]} scopes
 * @param {(scope: string) => Promise<{items: object[], complete: boolean, status?: number}>} walkOne
 * @returns {Promise<{items: object[], complete: boolean, status?: number}>}
 */
async function mergeWalks(scopes, walkOne) {
  const items = [];
  let complete = true;
  let status;
  for (const scope of scopes) {
    const res = await walkOne(scope);
    items.push(...res.items);
    if (!res.complete) {
      complete = false;
      if (res.status !== undefined) status = res.status;
    }
  }
  return status === undefined ? { items, complete } : { items, complete, status };
}

/**
 * The error for a server no zone showed (_probeServerZone): not found, with
 * status 404, when every zone answered 404; a refusal, worded as one, with
 * status 403, when a zone answered 403. A server a zone refused to show may
 * be in that zone, so a refusal is never "not found" or "already gone".
 * @param {string} failure - what failed, e.g. 'Failed to get server'
 * @param {string} serverId
 * @param {string[]} refusedIn - the zones that answered 403
 * @returns {Error & {status: number}}
 */
function serverZoneError(failure, serverId, refusedIn) {
  const message =
    refusedIn.length === 0
      ? `server ${serverId} not found in any zone`
      : refusedIn.length === ScalewayProvider._zones().length
        ? `every zone refused the read of server ${serverId} (HTTP 403)`
        : `${refusedIn.join(', ')} refused the read of server ${serverId} (HTTP 403), ` +
          'and no other zone has it';
  return Object.assign(new Error(`${failure}: ${message}`), {
    status: refusedIn.length === 0 ? 404 : 403,
  });
}

/**
 * The tags a stack's flexible IPs and servers carry for `labels`: the
 * project and the environment, each its own tag (encodeLabel). null unless
 * both have a value, so no partial label set matches anything.
 * @param {Object<string,string>|undefined} labels
 * @returns {string[]|null}
 */
function stackTags(labels) {
  const { project, environment } = labels ?? {};
  if (!project || !environment) return null;
  return [encodeLabel('project', project), encodeLabel('environment', environment)];
}

/**
 * The operator's Scaleway access key and project id: what the Pulumi
 * provider (buildIacEnv) and the cluster's CSI controller (k8sCloudSecrets)
 * take with the secret key. The token resolution chain carries only the
 * secret key, so these ride from process.env (the shell, or the project's
 * .env.local via bootstrapOperatorEnv). Missing either throws, naming it.
 * @returns {{accessKey: string, projectId: string}}
 */
function scalewayOperatorIds() {
  const accessKey = readOperatorVar('SCALEWAY_ACCESS_KEY').value;
  const projectId = readOperatorVar('SCALEWAY_DEFAULT_PROJECT_ID').value;
  const missing = [];
  if (!accessKey) missing.push('SCALEWAY_ACCESS_KEY');
  if (!projectId) missing.push('SCALEWAY_DEFAULT_PROJECT_ID');
  if (missing.length > 0) {
    throw new Error(
      `Scaleway needs ${missing.join(' and ')} set alongside SCALEWAY_SECRET_KEY: Scaleway ` +
        'takes the access key, secret key and project id together. Set ' +
        `${missing.join(' and ')} in your shell or the project's .env.local (vibecarbon ` +
        'configure, then Providers, then Scaleway, collects all three).',
    );
  }
  return { accessKey, projectId };
}

/**
 * Encode a label key/value pair into a Scaleway tag string — same
 * `key:value` wire encoding as the DO/Linode/Vultr tag-based providers
 * (byte-compatible so the destroy-sweep/listing matchers behave
 * identically). Conservative charset for round-trip safety. NOTE: Scaleway
 * has a special `AUTHORIZED_KEY=…` instance-tag convention for
 * per-instance SSH keys — we deliberately never use it (see the class
 * header's dedicated-Project doctrine), so our `key:value` tags can never
 * collide with it (`=` is not in our charset).
 * Named export for the Pulumi IaC program (scaleway-compose.js).
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
export function encodeLabel(key, value) {
  return `${key}:${value}`.replace(/[^A-Za-z0-9:_-]/g, '-');
}

/**
 * Encode a labels object into an array of Scaleway tag strings.
 * @param {Object<string,string>} [labels]
 * @returns {string[]}
 */
export function encodeLabels(labels = {}) {
  return Object.entries(labels).map(([k, v]) => encodeLabel(k, v));
}

// decodeLabels, the inverse of encodeLabels, is the same for the four
// tag-string providers (tag-labels.js); re-exported for the e2e sweeps.
export { decodeLabels };

// The shared cloud-init template carries typographic characters in its
// comments (em-dashes, live as of 2026-08-09), and Scaleway user data
// crosses the wire as PLAIN TEXT with NO base64 leg (unlike Linode/Vultr)
// and no gzip — so there is no 7-bit-clean safety net between us and
// whatever the Pulumi bridge / Scaleway ingestion does with non-ASCII
// bytes. Same wire-contract decision as DigitalOcean's (see the RCA in
// digitalocean-compose.js — a mangled em-dash there produced a C1 control
// char that made cloud-init reject the ENTIRE #cloud-config part): never
// hand the wire a non-ASCII byte. Known typography is transliterated
// explicitly, with the map DigitalOcean uses (cloud-init-ascii.js);
// anything unmapped falls through to assertAsciiCloudInit's loud refusal
// rather than a silent '?'.

/**
 * Transliterate known typographic characters to ASCII — the Scaleway leg
 * of DO's wire-contract decision (see the comment above). Applied by
 * loadScalewayComposeUserData BEFORE assertAsciiCloudInit, so mapped
 * typography degrades deterministically and anything unmapped still fails
 * loudly. A missing input reads as empty.
 * @param {string} input
 * @returns {string}
 */
export function transliterateCloudInitToAscii(input) {
  return transliterateWith(input ?? '', (ch) => ch);
}

/**
 * Byte-fidelity guard for the cloud-init payload — the backstop behind
 * transliterateCloudInitToAscii: any non-ASCII byte the map doesn't cover
 * is refused loudly instead of shipped with unverified fidelity.
 * Consumed by BOTH wire boundaries (scaleway-compose.js's Pulumi program
 * and createServer's REST PATCH) — single definition here so they cannot
 * drift.
 * @param {string} userData
 * @returns {string} userData, unchanged, when ASCII-clean
 * @throws {Error} naming the first offending character when not
 */
export function assertAsciiCloudInit(userData) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate — the guard's whole job is byte-range policing
  const m = /[^\x00-\x7F]/.exec(userData ?? '');
  if (m) {
    throw new Error(
      `Scaleway cloud-init payload contains a non-ASCII character (${JSON.stringify(m[0])} at ` +
        `offset ${m.index}). Scaleway user data is delivered as plain text with no base64 leg, ` +
        'so non-ASCII bytes have no verified fidelity guarantee: keep ' +
        'carbon/cloud-init/docker-ce-setup.yaml ASCII-only, or verify the byte survives the ' +
        'wire and update this guard (see the step-0 audit, "User data / cloud-init").',
    );
  }
  return userData;
}

export class ScalewayProvider extends BaseProvider {
  /**
   * Documented object-storage operational limits (scaleway.com docs FAQ,
   * verified 2026-08-15). Scaleway documents read-after-write consistency for
   * PUT and DELETE in all regions, explicitly including overwrites of existing
   * objects. No request-rate ceilings published.
   */
  static OBJECT_STORAGE_LIMITS = {
    requestsPerSecondPerBucket: null,
    requestsPerSecondPerSourceIp: null,
    parallelConnectionsPerSourceIp: null,
    consistency: 'strong-documented',
    evidenceUrl: 'https://www.scaleway.com/en/docs/object-storage/faq/',
    verifiedOn: '2026-08-15',
  };

  static NAME = 'Scaleway';
  static API_BASE = 'https://api.scaleway.com';
  // Ours — the SPELLED-OUT operator-facing env var, and what the REST path
  // sends as X-Auth-Token (the secret key alone authenticates the Instance
  // API). Follows the sibling convention (HETZNER_API_TOKEN, etc.): a
  // human-legible name that buildIacEnv translates to the plugin's native
  // one below.
  static TOKEN_ENV = 'SCALEWAY_SECRET_KEY';
  // The PLUGIN's native name — what the Pulumi/Terraform Scaleway provider
  // actually reads (scw/env.go: SCW_SECRET_KEY). DISTINCT from TOKEN_ENV by
  // the same operator-vs-plugin split every sibling has
  // (HETZNER_API_TOKEN→HCLOUD_TOKEN, VULTR_API_TOKEN→VULTR_API_KEY). The
  // provider additionally requires SCW_ACCESS_KEY + SCW_DEFAULT_PROJECT_ID,
  // which buildIacEnv EMITS (translated from the operator's SCALEWAY_*
  // values) — this static names only the token var.
  static CLI_TOKEN_ENV = 'SCW_SECRET_KEY';
  // The SAME IAM key pair signs both the Instance API and S3
  // (audit-verified) — no separate object-storage credential exists.
  static OBJECT_STORAGE_ENV = ['SCALEWAY_ACCESS_KEY', 'SCALEWAY_SECRET_KEY'];
  // Scaleway Object Storage REJECTS the `x-amz-checksum-sha256:
  // UNSIGNED-PAYLOAD` sentinel that Pulumi 3.256.0 + its vendored gocloud.dev
  // send for `request_checksum_calculation=when_required` — the mode Pulumi
  // injects into every custom-endpoint s3:// backend URL. Result: 400
  // InvalidRequest on the FIRST state write, before any Scaleway-provider code
  // runs (CI run 31663154544). Pinning `when_supported` suppresses Pulumi's
  // injection and restores a real computed checksum; Scaleway's own
  // supported-checksums reference lists CRC32 (the SDK's default algorithm) as
  // a supported FULL-OBJECT checksum, which is what a single-part PutObject
  // needs. See BaseProvider.STATE_BACKEND_CHECKSUM_CALCULATION for the full
  // RCA and for why this is opt-in per provider rather than a global flip.
  static STATE_BACKEND_CHECKSUM_CALCULATION = 'when_supported';
  // The providerID scheme Scaleway's CCM stamps on nodes
  // (`scaleway://instance/<zone>/<uuid>` — note TWO path segments between
  // prefix and UUID, unlike hcloud://<id>). Relevant only at the (unbuilt)
  // k8s tier; pinned now for uniqueness.
  static PROVIDER_ID_PREFIX = 'scaleway://';
  static DEFAULT_REGION = 'fr-par-1'; // a ZONE — see the class header
  static PRICING_URL = 'https://www.scaleway.com/en/pricing/';

  // Object-storage REGION override (fr-par / nl-ams — NOT a zone). Usually
  // derived by stripping the zone's trailing `-N`
  // (scaleway-objectstorage.js zoneToS3Region); optional override for
  // parity with the sibling providers.
  static S3_REGION_ENV = 'SCALEWAY_STORAGE_REGION';

  // Compose tiers only (compose-ha added in the 2026-08 tier-parity wave 1 —
  // the HA surface here was contract-complete since expansion PR 3;
  // effects/compose-ha is provider-generic). 4-mode headroom
  // (CCM/CSI/block-storage/DNS-flip) recorded in the audit. The k8s tiers'
  // code lands ahead of them, part by part (boot scripts, the program);
  // they are not declared until all of it has.
  static SUPPORTED_TIERS = ['compose', 'compose-ha'];

  static SERVER_RESOURCE_TYPE = 'scaleway:instance/server:Server';

  /**
   * The compose program gives the server a flexible IP, made before the
   * server: destroy looks for one by the environment's labels
   * (deleteReservedIpsByLabels). See BaseProvider.COMPOSE_FLOATING_IP.
   * @type {boolean}
   */
  static COMPOSE_FLOATING_IP = true;

  static RESERVED_IP_NAME = 'flexible IP';

  /**
   * IaC env bag — the three-credential seam (audit design flag 2), AND the
   * one and only place the plugin-native SCW_* names appear. Operators set
   * the spelled-out SCALEWAY_* triple (matching the sibling convention and
   * the names Brandon uses); this reads those and EMITS the SCW_*
   * (SCW_SECRET_KEY/SCW_ACCESS_KEY/SCW_DEFAULT_PROJECT_ID) that the Pulumi
   * Scaleway provider actually reads (scw/env.go +
   * terraform-provider-scaleway docs/index.md, all three required). The
   * token resolution chain carries only the secret key (from TOKEN_ENV =
   * SCALEWAY_SECRET_KEY), so the two companions ride from process.env
   * (shell or the project's .env.local via bootstrapOperatorEnv). Missing
   * either is a deploy-START failure naming the missing SCALEWAY_* var,
   * never a mid-Pulumi auth error.
   * @param {string} token - The SCALEWAY_SECRET_KEY value.
   * @returns {{SCW_SECRET_KEY: string, SCW_ACCESS_KEY: string, SCW_DEFAULT_PROJECT_ID: string}}
   */
  static buildIacEnv(token) {
    const { accessKey, projectId } = scalewayOperatorIds();
    // EMIT the plugin-native names — this is the operator→plugin
    // translation the sibling providers do via CLI_TOKEN_ENV alone; ours
    // needs a bag because the plugin wants three vars, not one.
    return {
      SCW_SECRET_KEY: token,
      SCW_ACCESS_KEY: accessKey,
      SCW_DEFAULT_PROJECT_ID: projectId,
    };
  }

  // ZONES carrying both BASIC3-X2C-4G and the DEV1-M fallback, whose S3
  // regions (fr-par, nl-ams) carry all three storage classes — the audited
  // default set. NO instance type exists in all ten Scaleway zones (audit:
  // per-zone catalog divergence), so widening this list requires re-walking
  // the live per-zone catalog, not just appending a zone name.
  static REGIONS = {
    'fr-par-1': 'Paris 1, France',
    'fr-par-2': 'Paris 2, France',
    'nl-ams-1': 'Amsterdam 1, Netherlands',
    'nl-ams-2': 'Amsterdam 2, Netherlands',
  };

  // Continent grouping for standby selection (getDefaultStandbyRegion).
  static REGION_CONTINENT = {
    'fr-par-1': 'eu',
    'fr-par-2': 'eu',
    'nl-ams-1': 'eu',
    'nl-ams-2': 'eu',
  };

  static HA_REGIONS = ['fr-par-1', 'nl-ams-1'];

  // Offline fallback catalog — live-verified 2026-08-09 via the public
  // per-zone GET /products/servers (all three present in every REGIONS
  // zone). BASIC3 cannot use local SSD (l_ssd max 0) — its root volume is
  // always SBS, provisioned at COMPOSE_ROOT_VOLUME_GB by our compose
  // program, hence that `disk` value; DEV1-M's 40 GB is its own bundled
  // volume constraint. PLAY2-NANO (the third compose candidate, l_ssd max 0
  // like BASIC3, so an SBS root too) from the same endpoint on 2026-10-22.
  // DEV1-L (4 vCPU, 8 GB, an 80 GB bundled volume) is DEV1-M's next size
  // up, the type `scale -type` moves a default box to; same endpoint and
  // date, x86_64 in all four REGIONS zones.
  static FALLBACK_SERVER_TYPES = {
    'BASIC3-X2C-4G': { vcpu: 2, ram: 4, disk: 40 },
    'BASIC3-X4C-8G': { vcpu: 4, ram: 8, disk: 40 },
    'DEV1-M': { vcpu: 3, ram: 4, disk: 40 },
    'DEV1-L': { vcpu: 4, ram: 8, disk: 80 },
    'PLAY2-NANO': { vcpu: 2, ram: 4, disk: 40 },
  };

  // Live catalog populated by fetchServerTypes(); object map (name → spec).
  static SERVER_TYPES = { ...ScalewayProvider.FALLBACK_SERVER_TYPES };

  // Per-zone availability populated by fetchServerTypes(). Scaleway's
  // catalog is genuinely per-zone (no type spans all zones — audit), so
  // this map is real data, same shape as DO's/Vultr's.
  static _locationTypes = null;

  // Monthly prices captured by fetchServerTypes() from the same payload
  // (`monthly_price`, EUR): type → zone → price. null until a live fetch.
  static _prices = null;

  // Compose candidates (see BaseProvider.ROLE_CANDIDATES). Offline keeps
  // the audited default first; live, the cheapest orderable one wins
  // (DEV1-M at €14.74 on 2026-10-22, with BASIC3-X2C-4G `scarce` in both
  // Paris zones). DEV1-M takes the 40 GB SBS root the compose program
  // provisions: its volumes_constraint.min_size is 0 (no local volume
  // required) and it has block bandwidth.
  static ROLE_CANDIDATES = {
    compose: ['BASIC3-X2C-4G', 'DEV1-M', 'PLAY2-NANO'],
  };

  // x86 CPU classes (see BaseProvider.CPU_CLASSES): the instance families,
  // ranked by price (DEV1-M €14.74, PLAY2-NANO €20.10, BASIC3-X2C-4G €28.80
  // on 2026-10-22). No run has measured a speed gap between them, so an HA
  // pair keeps the cheapest family both zones sell, on both sides.
  static CPU_CLASSES = ['DEV1', 'PLAY2', 'BASIC3'];

  /**
   * @param {string} type
   * @returns {string|null}
   */
  static cpuClassOf(type) {
    const family = typeof type === 'string' ? type.split('-')[0] : '';
    return ScalewayProvider.CPU_CLASSES.includes(family) ? family : null;
  }

  // Billed flexible IPv4 per server per month, EUR: zonal flexible IPv4 at
  // €0.005/h x 730 h (scaleway.com/en/pricing, read 2026-10-22).
  static IPV4_MONTHLY = 3.65;

  // Prices are in EUR.
  static CURRENCY = '€';

  static DEFAULT_TYPE = 'BASIC3-X2C-4G';

  // ── Engine-literal statics ──────────────────────────────────────────────
  static DEFAULT_COMPOSE_TYPE = 'BASIC3-X2C-4G';
  // Pinned for EXPECTED-table completeness; unread while compose-only.
  static DEFAULT_K8S_NODE_TYPE = 'BASIC3-X2C-4G';

  /**
   * SBS root-volume size (GB) the compose tier provisions. BASIC3 bundles
   * no local disk (l_ssd max 0), so the root size is OUR choice — 40 GB
   * matches the Hetzner cx23 baseline the compose stack is sized against.
   * MUST stay in lockstep with scaleway-compose.js's rootVolume.sizeInGb
   * (unit-pinned there) — the REST replacement path below derives its
   * volume template from this same static.
   * @type {number}
   */
  static COMPOSE_ROOT_VOLUME_GB = 40;

  // No Docker-preinstalled Ubuntu image on Scaleway (the Docker InstantApp
  // exists but its base OS version is unpinnable from any API surface —
  // audit) — cloud-init installs docker-ce, same 3-5min budget class as
  // DO/Linode/Vultr.
  static CLOUD_INIT_READY_TIMEOUT_MS = 600_000;

  /**
   * Kubernetes cluster-addon asset identity. The CSI names come from
   * scaleway-csi v0.3.6, rendered from its Helm chart
   * (carbon/cloud-init/k3s/_scaleway-csi.yaml): a Deployment controller and a
   * DaemonSet node plugin, both labelled with a bare `app=` key. No CCM:
   * k3s's embedded cloud controller runs instead, so the CCM entries stay
   * empty.
   * @type {{
   *   csiNodeDaemonSet: string,
   *   csiControllerSelector: string,
   *   ccmDeployment: string,
   *   ccmSelector: string,
   *   networkEnvVar: string,
   * }}
   */
  static K8S_ASSETS = {
    csiNodeDaemonSet: 'daemonset/scaleway-csi-node',
    csiControllerSelector: 'app=scaleway-csi-controller',
    ccmDeployment: '',
    ccmSelector: '',
    networkEnvVar: '',
  };

  /**
   * The StorageClass the k3s master boot script creates for scaleway-csi:
   * the driver's default block storage, Delete reclaim, expandable, bound
   * where the pod lands. The chart's own classes are not rendered. The
   * literal-guard census requires every registered provider's value to be
   * distinct and to live in this file.
   * @type {string}
   */
  static K8S_STORAGE_CLASS = 'scaleway-block-vibecarbon';

  /**
   * scaleway-csi passes a claim's request through unrounded
   * (pkg/driver/helpers.go). The driver and the SDK floor a Block volume at
   * 1 GB (pkg/scaleway/scaleway.go, block_sdk.go), Scaleway's console and
   * docs at 5 GB; which one the Block API holds a request to is unconfirmed,
   * so the larger. See BaseProvider.K8S_MIN_VOLUME_GI.
   * @type {number}
   */
  static K8S_MIN_VOLUME_GI = 5;

  /**
   * The `scaleway-csi-secret` Secret the CSI controller reads whole
   * (envFrom): the secret key, which is the token, with the operator's
   * access key and project id (scalewayOperatorIds, as buildIacEnv takes
   * them) and the cluster's zone as the default the driver works in. Throws
   * without a zone or either companion: the controller would start without
   * a credential it can use. See BaseProvider.k8sCloudSecrets.
   * @param {{token: string, region?: string}} values - region is the
   *   cluster's zone, as REGIONS keys it
   * @returns {Array<{namespace: string, name: string, stringData: Record<string, string>}>}
   */
  static k8sCloudSecrets({ token, region }) {
    if (!region) {
      throw new Error(
        "Can't hand your Scaleway API token to the cluster: this deploy names no zone for " +
          'it, and the CSI driver needs one.',
      );
    }
    const { accessKey, projectId } = scalewayOperatorIds();
    return [
      {
        namespace: 'kube-system',
        name: 'scaleway-csi-secret',
        stringData: {
          SCW_ACCESS_KEY: accessKey,
          SCW_SECRET_KEY: token,
          SCW_DEFAULT_PROJECT_ID: projectId,
          SCW_DEFAULT_ZONE: region,
        },
      },
    ];
  }

  /**
   * What the deploy.yml of an earlier vibecarbon's GitOps layer wrote into
   * every cluster, whatever the provider (`configure cicd`): kube-system/hcloud,
   * from the repo's HETZNER_API_TOKEN Actions secret. Nothing on a Scaleway
   * cluster reads it. No Scaleway boot script ever wrote a cloud Secret, so
   * there is none of those to retire. See BaseProvider.K8S_RETIRED_CLOUD_SECRETS.
   */
  static K8S_RETIRED_CLOUD_SECRETS = Object.freeze([
    {
      namespace: 'kube-system',
      name: 'hcloud',
      copyOf: "your repo's HETZNER_API_TOKEN Actions secret",
    },
  ]);

  /**
   * scaleway-csi creates a Block volume with a name and nothing else (no
   * tags), so a detached `pvc-*` volume in the cluster's zone could be any
   * cluster's: destroy reports one no capture names instead of deleting it
   * (BaseProvider.ORPHAN_VOLUME_REGION_GUESS).
   * @type {boolean}
   */
  static ORPHAN_VOLUME_REGION_GUESS = false;

  /**
   * A deploy that failed partway (the flexible IPs, VPC and Private Network
   * made, the master never ready) can leave them, the security group and
   * the SSH key outside what `pulumi destroy` removes, as on DigitalOcean,
   * Linode and Vultr, so destroy also removes them by name, address and tag
   * (sweepK8sBackstopTargets, destroy.js). @type {boolean}
   */
  static K8S_DESTROY_BACKSTOP = true;

  /**
   * No fixed range: scaleway-k8s.js derives a /24 per cluster
   * (vpcCidrForCluster) for its Private Network and exports it as `vpcCidr`,
   * the value deployK3s reads. @type {string}
   */
  static DEFAULT_VPC_CIDR = '';

  /**
   * The k8s nodes' marketplace label: the compose image (COMPOSE_IMAGE says
   * why a label, not a UUID). scaleway-k8s.js reads it.
   * @type {string}
   */
  static K8S_IMAGE = 'ubuntu_resolute';

  // ── ARM guard ───────────────────────────────────────────────────────────
  // Scaleway sells real arm64 lines. The catalog names them with an 'A'
  // core letter where the x86 twin has 'X' (BASIC2-A2C-4G vs BASIC3-X2C-4G,
  // STANDARD2-A2C-8G vs STANDARD3-X2C-8G), and the older COPARM1 line.
  // The authoritative answer is the `arch` field the products/servers
  // catalog reports for each commercial type: fetchServerTypes() records it
  // for EVERY type (arm64 included) in _typeArch, and isArmServerType reads
  // that first. The name rule below is the fallback for when the catalog
  // was not (or could not be) fetched, or does not list the type. It covers
  // every arm64 family seen in the live catalog (2026-10-16: BASIC2-A*,
  // STANDARD2-A*; COPARM1 historically) and any future `<FAMILY><n>-A<n>C-`
  // line, and matches no x86 type in that catalog.

  /** @type {RegExp} */
  static ARM_NAME_RULE = /^(?:[A-Z]+\d*-A\d+C-|COPARM)/i;

  /**
   * Commercial type → `arch` as reported by the live catalog (`x86_64`,
   * `arm64`), across every REGIONS zone. null until fetchServerTypes()
   * completes a full walk.
   * @type {Record<string, string>|null}
   */
  static _typeArch = null;

  /**
   * @param {string} serverType
   * @returns {boolean}
   */
  static isArmServerType(serverType) {
    if (!serverType) return false;
    const arch = ScalewayProvider._typeArch?.[serverType.toUpperCase()];
    if (arch) return arch !== 'x86_64';
    return ScalewayProvider.ARM_NAME_RULE.test(serverType);
  }

  /**
   * Size-preserving ARM→x86 map: the arm64 BASIC2/STANDARD2 types share
   * their core/RAM shape with the x86 BASIC3/STANDARD3 types (live
   * catalog: BASIC2-A2C-4G and BASIC3-X2C-4G are both 2c/4G,
   * STANDARD2-A2C-8G and STANDARD3-X2C-8G are both 2c/8G), so swap the
   * family and keep the shape when that type is in the catalog. Anything
   * else (COPARM, unknown ARM spellings) falls back to DEFAULT_TYPE.
   * @param {string} serverType
   * @returns {string}
   */
  static armToAmd64Equivalent(serverType) {
    const m = /^(BASIC|STANDARD)\d+-A(\d+C-\d+G)$/i.exec(serverType || '');
    if (m) {
      const candidate = `${m[1].toUpperCase()}3-X${m[2].toUpperCase()}`;
      if (candidate in ScalewayProvider.SERVER_TYPES) return candidate;
    }
    return ScalewayProvider.DEFAULT_TYPE;
  }

  // ── k8s boot user-data (carbon/cloud-init/k3s/scaleway-*-init.sh) ───────

  /**
   * Render the k3s master boot script. No API token: deployK3s hands the
   * cluster its cloud credential itself (applyCloudSecrets, k8sCloudSecrets).
   * The node finds its own identity and Private Network interface at boot
   * (_scaleway-metadata.sh), so no address or subnet is rendered in.
   * @param {{
   *   k3s_version: string,
   *   k3s_token: string,
   * }} vars - The caller's whole share of the template's var set. The
   *   rest, the CSI install's image rewrites (`csi_image_rewrites`) and the
   *   CSI manifest it carries (`scaleway_csi_manifest`), is added here
   *   (masterAddedVars).
   * @returns {Promise<string>}
   */
  static async getK8sMasterUserData(vars) {
    const { loadCloudInit, masterAddedVars, renderScript } = await import('../iac/cloud-init.js');
    return renderScript(loadCloudInit('scaleway-master-init.sh'), {
      ...vars,
      ...masterAddedVars('scaleway'),
    });
  }

  /**
   * Render the k3s worker boot script. The autoscaler's workers boot from
   * this same render (renderCarbonAutoscalerConfig).
   * @param {{
   *   k3s_version: string,
   *   k3s_token: string,
   *   master_ip: string,
   * }} vars - master_ip is the master's Private Network address.
   * @returns {Promise<string>}
   */
  static async getK8sWorkerUserData(vars) {
    const { loadCloudInit, renderScript } = await import('../iac/cloud-init.js');
    return renderScript(loadCloudInit('scaleway-worker-init.sh'), vars);
  }

  /**
   * Render the k3s database-node boot script: the worker script loaded as
   * the db role, which adds the dedicated=db label and taint at join time
   * (AGENT_ROLES in cloud-init.js).
   * @param {{
   *   k3s_version: string,
   *   k3s_token: string,
   *   master_ip: string,
   * }} vars - Same set as getK8sWorkerUserData.
   * @returns {Promise<string>}
   */
  static async getK8sDbUserData(vars) {
    const { loadCloudInit, renderScript } = await import('../iac/cloud-init.js');
    return renderScript(loadCloudInit('scaleway-worker-init.sh', { role: 'db' }), vars);
  }

  // ── k8s program (iac/programs/scaleway-k8s.js) ─────────────────────────

  /**
   * Build the k8s Pulumi program, built ahead of the tier (SUPPORTED_TIERS
   * turns it on).
   * @param {object} config
   * @returns {Promise<() => Promise<Record<string, unknown>>>}
   */
  static async getK8sProgram(config) {
    const { buildScalewayK8sProgram } = await import('../iac/programs/scaleway-k8s.js');
    return buildScalewayK8sProgram(config);
  }

  // ── Compose-tier replacement-server identity ────────────────────────────

  /**
   * Marketplace LABEL, deliberately not a UUID: Scaleway image UUIDs are
   * per-zone AND per-volume-type (`ubuntu_resolute` in fr-par-1 alone
   * resolves to six local-image UUIDs), and the Instance API + Pulumi
   * provider both accept the label and resolve the right variant for the
   * zone/volume-type (BASIC3 → the `instance_sbs` x86 variant). A UUID pin
   * would break on the first zone change. MUST byte-match the program's
   * literal (scaleway-compose.js).
   * @type {string}
   */
  static COMPOSE_IMAGE = 'ubuntu_resolute';

  /**
   * Same rendered user-data scaleway-compose.js's Pulumi program uses —
   * delegates to that module's loader (single source of truth for the
   * Docker-install splice). Returned RAW (plain text is also the wire
   * encoding on Scaleway — no base64 leg anywhere).
   * @returns {Promise<string>}
   */
  static async getComposeUserData() {
    const { loadScalewayComposeUserData } = await import('../iac/programs/scaleway-compose.js');
    return loadScalewayComposeUserData();
  }

  /**
   * Fetch the per-zone server-type catalog from the PUBLIC
   * `GET /instance/v1/zones/{zone}/products/servers` endpoint and its
   * `/availability` twin, for every REGIONS zone (the audit's "no type
   * exists everywhere" finding makes the zone axis real data). All eight
   * walks start together under one Promise.all. Each is page-walked at
   * per_page=100 (the fr-par-1 catalog is 136 types, so a single page
   * silently truncates). Any failed page fails the whole fetch, so the
   * fallback catalog survives an incomplete walk; so does an empty one.
   * @param {string} apiToken - sent as X-Auth-Token when given (the
   *   endpoint is public; the header only aids rate-limit accounting)
   * @returns {Promise<boolean>} true if live data was loaded
   */
  static async fetchServerTypes(apiToken) {
    if (ScalewayProvider._locationTypes) return true; // already fetched

    const init = apiToken ? { headers: { 'X-Auth-Token': apiToken } } : {};
    // One paged `{servers: {...}}` listing; null when a page fails.
    const walk = async (path) => {
      const servers = {};
      for (let page = 1; page <= 20; page++) {
        const response = await fetchWithRetry(
          `${ScalewayProvider.API_BASE}${path}?per_page=100&page=${page}`,
          init,
        );
        if (!response.ok) return null;
        const data = await response.json();
        const pageServers = data.servers || {};
        Object.assign(servers, pageServers);
        if (Object.keys(pageServers).length < 100) return servers;
      }
      return null; // never reached the last page
    };

    try {
      const zones = Object.keys(ScalewayProvider.REGIONS);
      const walked = await Promise.all(
        zones.map(async (zone) => {
          const base = `/instance/v1/zones/${zone}/products/servers`;
          const [servers, availability] = await Promise.all([
            walk(base),
            walk(`${base}/availability`),
          ]);
          return { zone, servers, availability };
        }),
      );
      if (walked.some((z) => z.servers === null || z.availability === null)) return false;

      const catalog = ScalewayProvider.parseCatalog(
        Object.fromEntries(
          walked.map(({ zone, servers, availability }) => [
            zone,
            {
              servers,
              availability: Object.fromEntries(
                Object.entries(availability).map(([name, a]) => [name, a?.availability]),
              ),
            },
          ]),
        ),
      );
      if (Object.keys(catalog.SERVER_TYPES).length === 0) return false;

      Object.assign(ScalewayProvider, catalog);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The catalog statics fetchServerTypes sets, from each zone's
   * products/servers map and availability map. Pure, so the unit fixtures
   * load through the same filters as the live path
   * (tests/unit/helpers/catalog-fixtures.ts).
   *
   * Records every type's arch (arm64 too) in `_typeArch`, so
   * isArmServerType can classify a typed-in SKU by what Scaleway says it is.
   * arm64 and end-of-service types are EXCLUDED from SERVER_TYPES
   * (vibecarbon is amd64-only and the catalog invariants require an
   * ARM-free own catalog). A type whose availability is `shortage` is left
   * out of that zone's orderable set; `scarce` can still be placed.
   *
   * @param {Record<string, {servers: Record<string, object>, availability: Record<string, string>}>} zones
   * @returns {{SERVER_TYPES: object, _locationTypes: Record<string, Set<string>>, _prices: Record<string, Record<string, number|null>>, _typeArch: Record<string, string>}}
   */
  static parseCatalog(zones) {
    const types = {};
    const locationTypes = {};
    const prices = {};
    const typeArch = {};
    for (const [zone, { servers, availability }] of Object.entries(zones)) {
      for (const [name, spec] of Object.entries(servers)) {
        if (spec.arch) typeArch[name.toUpperCase()] = spec.arch;
        if (spec.arch !== 'x86_64') continue; // amd64-only catalog
        if (spec.end_of_service) continue;
        types[name] = {
          vcpu: spec.ncpus,
          ram: spec.ram / 2 ** 30,
          // SBS-only types (BASIC3/COMPUTE3) bundle no disk — surface the
          // root-volume size the compose tier provisions instead of 0.
          disk:
            Math.round((spec.volumes_constraint?.max_size ?? 0) / GB) ||
            ScalewayProvider.COMPOSE_ROOT_VOLUME_GB,
        };
        if (!prices[name]) prices[name] = {};
        prices[name][zone] = typeof spec.monthly_price === 'number' ? spec.monthly_price : null;
        if (availability?.[name] === 'shortage') continue;
        if (!locationTypes[zone]) locationTypes[zone] = new Set();
        locationTypes[zone].add(name);
      }
    }
    return {
      SERVER_TYPES: types,
      _locationTypes: locationTypes,
      _prices: prices,
      _typeArch: typeArch,
    };
  }

  // getServerTypesForRegion and resolveServerTypeForRegion are the base's
  // (base.js): live per-zone data when fetched (the zone axis is real on
  // Scaleway), the fallback catalog otherwise (all three fallback types are
  // live-verified present in every REGIONS zone), with `architecture: 'x86'`
  // on every entry.

  /**
   * The static HA standby pair — cross-country pairs (fr-par ↔ nl-ams, same
   * AZ ordinal so both sides carry the same catalog subset), then
   * same-continent, mirroring the sibling providers' contract. DEV1-M is
   * the documented type fallback if BASIC3 is ever absent from a chosen
   * zone (audit: capacityPreferences zone set).
   * @param {string} primaryRegion - zone
   * @returns {string} the static pair, before prices
   */
  static conventionalStandbyRegion(primaryRegion) {
    const PAIRS = {
      'fr-par-1': 'nl-ams-1',
      'fr-par-2': 'nl-ams-2',
      'nl-ams-1': 'fr-par-1',
      'nl-ams-2': 'fr-par-2',
    };
    return (
      standbyPairOrNeighbour(ScalewayProvider.REGION_CONTINENT, primaryRegion, PAIRS) ??
      (primaryRegion === 'fr-par-1' ? 'nl-ams-1' : 'fr-par-1')
    );
  }

  /**
   * Public IPv4 of a server. Routed-IP era: `public_ips[]` entries carry a
   * `family` ('inet'/'inet6'); prefer the first inet address, fall back to
   * the legacy scalar `public_ip.address`.
   * @param {object} server - Scaleway API server object
   * @returns {string|null}
   */
  static getPublicIP(server) {
    const ips = server?.public_ips;
    if (Array.isArray(ips)) {
      const v4 = ips.find((ip) => ip?.family === 'inet' && ip?.address);
      if (v4) return v4.address;
    }
    return server?.public_ip?.address ?? null;
  }

  // ── Instance methods ────────────────────────────────────────────────────
  // Transport split mirrors the sibling providers: CRUD via this.apiRequest,
  // listings/teardown bare (this.bareRequest, or fetchWithRetry in the
  // zone-walking helpers), getServerSummary raw fetches with a hard 5s abort.

  /**
   * Scaleway authenticates with `X-Auth-Token: <secret key>`, not a Bearer
   * header; apiRequest and bareRequest (base.js) send these.
   * @returns {Record<string, string>}
   */
  authHeaders() {
    return { 'X-Auth-Token': this.apiToken };
  }

  /** Zones this provider operates in (REGIONS keys — see class header). */
  static _zones() {
    return Object.keys(ScalewayProvider.REGIONS);
  }

  /**
   * Page-walk one `page`/`page_size` listing (the IAM, VPC, Block Storage
   * and Load Balancer APIs; a page shorter than page_size ends the walk).
   * Soft completeness signal like the zone walks: a non-ok page returns the
   * rows read so far with its `status`.
   * @param {string} path - full API path, e.g. '/iam/v1alpha1/ssh-keys'
   * @param {string} key - response array key (e.g. 'ssh_keys')
   * @param {string} [query] - extra query (e.g. 'project_id=…'), no '?'
   * @returns {Promise<{items: object[], complete: boolean, status?: number}>}
   */
  async _walkPageSize(path, key, query = '') {
    const items = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.bareRequest(
        `${path}?page_size=100&page=${page}${query ? `&${query}` : ''}`,
      );
      if (!res.ok) return { items, complete: false, status: res.status };
      const data = await res.json().catch(() => ({}));
      const pageItems = data[key] || [];
      items.push(...pageItems);
      if (pageItems.length < 100) return { items, complete: true };
    }
    return { items, complete: false };
  }

  /**
   * Page-walk one zone-scoped listing (`page`/`per_page`; Scaleway v1 has
   * no cursor — a page shorter than per_page ends the walk). Same ≤20-page
   * guard and completeness semantics as the sibling providers' walks.
   * @param {string} path - zone-relative path WITH leading slash and any
   *   query of its own (e.g. '/servers' or '/servers?name=x')
   * @param {string} key - response array key (e.g. 'servers')
   * @param {string} zone
   * @returns {Promise<{items: object[], complete: boolean, status?: number}>}
   */
  async _walkZone(path, key, zone) {
    const items = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= 20; page++) {
      const response = await this.bareRequest(
        `/instance/v1/zones/${zone}${path}${sep}per_page=100&page=${page}`,
      );
      if (!response.ok) return { items, complete: false, status: response.status };
      const data = await response.json();
      const pageItems = Array.isArray(data[key]) ? data[key] : [];
      // Stamp the zone: it is path data on Scaleway, and every id-scoped
      // follow-up (delete/action) needs it back.
      items.push(...pageItems.map((it) => ({ zone, ...it })));
      if (pageItems.length < 100) return { items, complete: true };
    }
    return { items, complete: false };
  }

  /**
   * Walk a listing across ALL zones, merging items; complete only when
   * every zone's walk completed.
   * @param {string} path
   * @param {string} key
   * @returns {Promise<{items: object[], complete: boolean, status?: number}>}
   */
  async _walkAllZones(path, key) {
    return mergeWalks(ScalewayProvider._zones(), (zone) => this._walkZone(path, key, zone));
  }

  /** The VPC API's regions: the REGIONS zones' distinct regions (fr-par-1 is in fr-par). */
  static _regions() {
    return [...new Set(ScalewayProvider._zones().map((z) => z.replace(/-\d+$/, '')))];
  }

  /**
   * Walk one VPC API collection (`private-networks`, `vpcs`) in every
   * region, merged as _walkAllZones does, each row stamped with its region:
   * a delete goes to the region it is listed in. Scoped to
   * SCALEWAY_DEFAULT_PROJECT_ID when it is set, as deleteSSHKeyByName is, so
   * another project's network of the same name is never listed.
   * @param {string} collection - 'private-networks' or 'vpcs'
   * @param {string} key - response array key ('private_networks', 'vpcs')
   * @returns {Promise<{items: object[], complete: boolean, status?: number}>}
   */
  async _walkVpcApi(collection, key) {
    const projectId = readOperatorVar('SCALEWAY_DEFAULT_PROJECT_ID').value;
    const query = projectId ? `project_id=${encodeURIComponent(projectId)}` : '';
    return mergeWalks(ScalewayProvider._regions(), async (region) => {
      const walk = await this._walkPageSize(`/vpc/v2/regions/${region}/${collection}`, key, query);
      return { ...walk, items: walk.items.map((row) => ({ region, ...row })) };
    });
  }

  /**
   * Resolve which zone a server UUID lives in (UUIDs are zone-scoped —
   * class header). Probes GET per zone, caching hits for the lifetime of
   * this provider instance. A zone that answers 404 does not have it; one
   * that answers 403 is a zone the token may not read, named in `refusedIn`,
   * so a caller never reads a server it hid as gone (serverZoneError). Any
   * other failure throws at once, with its HTTP status on the error.
   * @param {string} serverId
   * @returns {Promise<{zone: string} | {zone: null, refusedIn: string[]}>} the
   *   zone, or none, with the zones that answered 403
   */
  async _probeServerZone(serverId) {
    this._zoneCache ??= new Map();
    const cached = this._zoneCache.get(serverId);
    if (cached) return { zone: cached };
    /** @type {string[]} */
    const refusedIn = [];
    for (const zone of ScalewayProvider._zones()) {
      const res = await this.bareRequest(`/instance/v1/zones/${zone}/servers/${serverId}`);
      if (res.ok) {
        this._zoneCache.set(serverId, zone);
        return { zone };
      }
      if (res.status === 403) refusedIn.push(zone);
      else if (res.status !== 404) {
        const body = await res.text().catch(() => '');
        throw Object.assign(
          new Error(`Scaleway API error resolving server ${serverId} (${res.status}): ${body}`),
          { status: res.status },
        );
      }
    }
    return { zone: null, refusedIn };
  }

  /**
   * Create a new Scaleway Instance. The chain is genuinely multi-step on
   * Scaleway (create leaves the server STOPPED, user data is a separate
   * sub-resource, and boot is an explicit action):
   *   POST /servers → PATCH user_data/cloud-init → POST action poweron.
   *
   * No ssh-key field exists — keys are Project-level and auto-propagate at
   * boot (class header; the dedicated-Project doctrine makes that the
   * correct mechanism, so `sshKeys`/`sshKeyId` are accepted for interface
   * parity and deliberately unused). The server gets a flexible IPv4, reserved
   * onto it before first boot, because the compose stack holds its IP as a
   * flexible IP resource and a scale points that resource at this one
   * (lib/iac/server-state.js). `dynamic_ip_required: false` stops a second,
   * dynamic address. deleteServer releases the flexible IP, so no path leaks
   * it. Root volume: explicit SBS template sized at
   * COMPOSE_ROOT_VOLUME_GB — BASIC3 admits no local SSD, and leaving the
   * size to the image default under-provisions the compose stack.
   *
   * @param {object} config
   * @param {string} config.name
   * @param {string} config.region - ZONE (fr-par-1 …)
   * @param {string} config.serverType - commercial type (BASIC3-X2C-4G)
   * @param {string} config.image - marketplace label ('ubuntu_resolute')
   * @param {(string|number)[]} [config.sshKeys] - interface parity; unused
   *   (Project-level keys — see above)
   * @param {string|number} [config.sshKeyId] - interface parity; unused
   * @param {object} [config.labels]
   * @param {string} [config.userData] - RAW cloud-init YAML (plain text on
   *   the wire; ASCII-guarded)
   * @param {(string|number)[]} [config.networks] - interface parity;
   *   compose instances join no private network (documented no-op)
   * @param {(string|number)[]} [config.firewalls] - at most ONE security
   *   group id (attached at create — no unfirewalled window)
   * @returns {Promise<{id: string, server: object, reused?: boolean}>}
   */
  async createServer(config) {
    const { name, region, serverType, image, labels, userData, firewalls } = config;

    const [existing] = await this.findServersByName(name);
    if (existing) {
      return { id: existing.id, server: existing, reused: true };
    }

    const projectId = readOperatorVar('SCALEWAY_DEFAULT_PROJECT_ID').value;
    if (!projectId) {
      throw new Error(
        'SCALEWAY_DEFAULT_PROJECT_ID is not set, Scaleway server creation must target the ' +
          "project's DEDICATED Scaleway Project (SSH keys are Project-scoped; see " +
          "scaleway-guided-setup). Set it in your shell or the project's .env.local.",
      );
    }

    const fwList = Array.isArray(firewalls) ? firewalls : [];
    if (fwList.length > 1) {
      throw new Error(
        `Scaleway instances attach exactly ONE security group; got ${fwList.length}. ` +
          'Refusing rather than silently dropping the extras.',
      );
    }

    const body = {
      name,
      commercial_type: serverType,
      image,
      project: projectId,
      tags: encodeLabels(labels),
      dynamic_ip_required: false,
      volumes: {
        0: {
          volume_type: 'sbs_volume',
          size: ScalewayProvider.COMPOSE_ROOT_VOLUME_GB * GB,
        },
      },
    };
    if (fwList.length === 1) {
      body.security_group = String(fwList[0]);
    }

    const response = await this.apiRequest(`/instance/v1/zones/${region}/servers`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Scaleway API error: ${error.message || 'Unknown error'}`);
    }

    const { server } = await response.json();
    this._zoneCache ??= new Map();
    this._zoneCache.set(server.id, region);

    // User data is a keyed sub-resource; the cloud-init payload lives
    // under the `cloud-init` key, PLAIN TEXT (no base64/gzip leg — hence
    // the ASCII guard). Must be written BEFORE first boot.
    if (userData) {
      const udRes = await this.apiRequest(
        `/instance/v1/zones/${region}/servers/${server.id}/user_data/cloud-init`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'text/plain' },
          body: assertAsciiCloudInit(userData),
        },
      );
      if (!udRes.ok) {
        const detail = await udRes.text().catch(() => '');
        throw new Error(`Scaleway user-data write failed (${udRes.status}): ${detail}`);
      }
    }

    // Before first boot, so the server has its address when cloud-init runs.
    // Without it the server could never be reached, so it does not stay.
    const ipRes = await this.apiRequest(`/instance/v1/zones/${region}/ips`, {
      method: 'POST',
      body: JSON.stringify({
        project: projectId,
        type: 'routed_ipv4',
        tags: encodeLabels(labels),
        server: server.id,
      }),
    });
    if (!ipRes.ok) {
      const error = await ipRes.json().catch(() => ({}));
      await this.deleteServer(server.id).catch(() => {});
      throw new Error(`Scaleway flexible IP failed: ${error.message || 'Unknown error'}`);
    }

    // Create leaves the server stopped — boot it.
    const bootRes = await this.apiRequest(
      `/instance/v1/zones/${region}/servers/${server.id}/action`,
      { method: 'POST', body: JSON.stringify({ action: 'poweron' }) },
    );
    if (!bootRes.ok) {
      const error = await bootRes.json().catch(() => ({}));
      throw new Error(`Scaleway poweron failed: ${error.message || 'Unknown error'}`);
    }

    return { id: server.id, server };
  }

  /**
   * Delete a server — the billing-leak-safe chain (audit design flag 5):
   *   1. Capture the server's volume map + public-IP ids.
   *   2. `terminate` action (falls back to plain DELETE when the state
   *      machine refuses, e.g. a never-booted stopped server).
   *   3. Poll until the server record is gone.
   *   4. Delete every captured `sbs_volume` via the Block Storage API —
   *      terminate only DETACHES SBS volumes (SDK verbatim), and our types
   *      are SBS-only, so skipping this leaks a billed volume EVERY time.
   *   5. Release any captured flexible IP that survived (GET 200 after the
   *      server is gone ⇒ flexible, €0.005/hr forever; dynamic IPs 404
   *      here because Scaleway auto-released them).
   *
   * DIVERGENCE from the two-mode contract, deliberate: steps 3-5 run in
   * BOTH modes. The default "fire and return" mode cannot exist here —
   * the volumes are only deletable after termination completes, so
   * returning early would trade scale-path latency for an unbounded
   * billing leak. `waitUntilGone` only selects the return value.
   *
   * An SBS volume step 4 cannot delete is reported through `onLeftover`
   * (destroy turns it into a ledger leak), or warned on stderr when no one
   * asked. Nothing finds it again: a later deleteServer finds the server
   * gone and reads no volumes, so the line names the console delete.
   *
   * Already gone only when every zone answered 404. A server no zone showed
   * while a zone refused the read (403) may be in that zone, so the delete
   * throws that refusal, with status 403, as a refused DELETE throws on the
   * other providers (deleteServerAt): destroy reports the server, never
   * reads it as deleted (serverZoneError).
   * @param {string} serverId
   * @param {{waitUntilGone?: boolean, onLeftover?: (line: import('./base.js').ServerLeftover) => void}} [options]
   * @returns {Promise<void|boolean>}
   * @throws when a zone refused the read and no zone showed the server
   */
  async deleteServer(serverId, { waitUntilGone = false, onLeftover } = {}) {
    const { zone, refusedIn = [] } = await this._probeServerZone(serverId);
    if (!zone) {
      if (refusedIn.length > 0)
        throw serverZoneError('Failed to delete server', serverId, refusedIn);
      return waitUntilGone ? false : undefined; // already gone
    }

    // 1. Capture teardown targets before the record disappears.
    let sbsVolumeIds = [];
    let publicIpIds = [];
    const getRes = await this.apiRequest(`/instance/v1/zones/${zone}/servers/${serverId}`);
    if (getRes.ok) {
      const { server } = await getRes.json();
      sbsVolumeIds = Object.values(server.volumes ?? {})
        .filter((v) => v?.volume_type === 'sbs_volume' && v?.id)
        .map((v) => v.id);
      publicIpIds = (server.public_ips ?? []).map((ip) => ip?.id).filter(Boolean);
    } else if (getRes.status === 404) {
      return waitUntilGone ? false : undefined;
    }

    // 2. Terminate (poweroff + delete in one action) …
    const termRes = await this.apiRequest(`/instance/v1/zones/${zone}/servers/${serverId}/action`, {
      method: 'POST',
      body: JSON.stringify({ action: 'terminate' }),
    });
    if (!termRes.ok && termRes.status !== 404) {
      // … falling back to a plain DELETE (valid for stopped servers).
      const delRes = await this.bareRequest(`/instance/v1/zones/${zone}/servers/${serverId}`, {
        method: 'DELETE',
      });
      if (!delRes.ok && delRes.status !== 404) {
        const error = await delRes.json().catch(() => ({}));
        throw new Error(`Failed to delete server: ${error.message || 'Unknown error'}`);
      }
    }

    // 3. Wait for the record to disappear — the detached-SBS deletes below
    // are only valid once termination completes, in EITHER mode (see doc).
    // A server still there when the wait runs out is noted, so the label
    // sweep can say its flexible IP waits on the termination.
    const terminated = await pollUntil(
      async () => {
        const probe = await fetch(
          `${ScalewayProvider.API_BASE}/instance/v1/zones/${zone}/servers/${serverId}`,
          { headers: { 'X-Auth-Token': this.apiToken } },
        );
        return probe.status === 404;
      },
      {
        budgetMs: TERMINATE_WAIT_MS,
        initialDelayMs: 2_000,
        backoffFactor: 1,
        description: `server ${serverId} termination`,
      },
    ).then(
      () => true,
      () => false,
    );
    if (terminated) serversStillTerminating.delete(String(serverId));
    else serversStillTerminating.add(String(serverId));

    // 4. Delete the detached SBS volumes (Block Storage API — a different
    // product than the Instance API's legacy volumes endpoint). Brief
    // retry: the detach can trail the server 404 by a few seconds.
    for (const volumeId of sbsVolumeIds) {
      let lastStatus;
      await pollUntil(
        async () => {
          const res = await this.bareRequest(`/block/v1/zones/${zone}/volumes/${volumeId}`, {
            method: 'DELETE',
          });
          lastStatus = res.status;
          return res.ok || res.status === 404;
        },
        {
          budgetMs: SBS_DELETE_WAIT_MS,
          initialDelayMs: 2_000,
          backoffFactor: 1,
          description: `SBS volume ${volumeId} deletion`,
        },
      ).catch((err) => {
        const lastAnswer =
          lastStatus === undefined
            ? `no answer: ${err?.cause?.message ?? err?.message ?? err}`
            : `last answer HTTP ${lastStatus}`;
        const leftover = {
          resourceClass: 'detached-volume',
          resource: `SBS volume ${volumeId} (${zone})`,
          reason:
            `server ${serverId}'s delete left it behind, and deleting it failed for ` +
            `${SBS_DELETE_WAIT_MS / 1000} s (${lastAnswer})` +
            (terminated ? '' : ', while the server was still terminating'),
          hint:
            `Delete it in the Scaleway console under Block Storage, Volumes (zone ${zone}); it ` +
            'bills until removed. Running destroy again does not find it: the server it ' +
            'belonged to is gone.',
        };
        if (onLeftover) onLeftover(leftover);
        else console.warn(`Warning: ${leftover.resource}: ${leftover.reason}. ${leftover.hint}`);
      });
    }

    // 5. Release surviving flexible IPs (dynamic IPs 404 here — released
    // with the server; flexible ones bill €0.005/hr until deleted).
    for (const ipId of publicIpIds) {
      const probe = await this.bareRequest(`/instance/v1/zones/${zone}/ips/${ipId}`);
      if (!probe.ok) continue; // 404 = auto-released dynamic IP
      const del = await this.bareRequest(`/instance/v1/zones/${zone}/ips/${ipId}`, {
        method: 'DELETE',
      });
      if (!del.ok && del.status !== 404) {
        console.warn(
          `Warning: Scaleway flexible IP ${ipId} (zone ${zone}) could not be released; it ` +
            'bills until deleted.',
        );
      }
    }

    if (waitUntilGone) return true;
  }

  /**
   * Rename a server — PATCH of the `name` field. A server no zone showed
   * throws, worded as not found or as the zones' refusal (serverZoneError).
   * @param {string} serverId
   * @param {string} name
   * @returns {Promise<void>}
   */
  async renameServer(serverId, name) {
    const { zone, refusedIn = [] } = await this._probeServerZone(serverId);
    if (!zone) throw serverZoneError('Failed to rename server', serverId, refusedIn);
    const response = await this.apiRequest(`/instance/v1/zones/${zone}/servers/${serverId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Failed to rename server: ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * Get server details (`{server}` wrapper).
   * @param {string} serverId
   * @returns {Promise<object>}
   */
  async getServer(serverId) {
    // A server no zone has throws with the probes' status: 404, or 403 when a
    // zone refused the token, worded as the refusal it is. Either is a token
    // that can't see the server (assertTokenSeesCluster), as a failed probe's
    // own status is.
    const { zone, refusedIn = [] } = await this._probeServerZone(serverId);
    if (!zone) throw serverZoneError('Failed to get server', serverId, refusedIn);
    const response = await this.apiRequest(`/instance/v1/zones/${zone}/servers/${serverId}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      // The status goes with it: a 401, 403 or 404 is a token that can't see
      // the server (assertTokenSeesCluster).
      throw Object.assign(new Error(`Failed to get server: ${error.message || 'Unknown error'}`), {
        status: response.status,
      });
    }
    const { server } = await response.json();
    return { zone, ...server };
  }

  /**
   * Wait for a server to be ready: state 'running' AND a public IPv4.
   * @param {string} serverId
   * @param {number} [timeout=300000]
   * @returns {Promise<object>}
   */
  async waitForServer(serverId, timeout = this.constructor.WAIT_FOR_SERVER_TIMEOUT_MS) {
    return waitUntilServerUp(
      timeout,
      () => this.getServer(serverId),
      (server) => server.state === 'running' && ScalewayProvider.getPublicIP(server),
    );
  }

  /**
   * Lightweight status summary — raw fetch, hard 5s abort per probe,
   * null-on-any-failure (never-retry contract). Zone-scoped twist: with a
   * warm `_zoneCache` this is the single fetch the contract intends; a
   * cold cache probes the (four) REGIONS zones, each under the same 5s
   * abort, still returning null on any failure.
   * @param {string} serverId
   * @returns {Promise<{status: string, serverType: string|null}|null>}
   */
  async getServerSummary(serverId) {
    this._zoneCache ??= new Map();
    const zones = this._zoneCache.has(serverId)
      ? [this._zoneCache.get(serverId)]
      : ScalewayProvider._zones();
    try {
      for (const zone of zones) {
        const response = await fetch(
          `${ScalewayProvider.API_BASE}/instance/v1/zones/${zone}/servers/${serverId}`,
          {
            headers: { 'X-Auth-Token': this.apiToken },
            signal: AbortSignal.timeout(5000),
          },
        );
        if (response.status === 404) continue;
        if (!response.ok) return null;
        const { server } = await response.json();
        this._zoneCache.set(serverId, zone);
        return {
          status: server.state,
          serverType: server.commercial_type || null,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch a single commercial type's specs by exact name — walks the
   * public per-zone catalog (the type may not exist in every zone, so all
   * REGIONS zones are consulted before giving up).
   * @param {string} name - e.g. "BASIC3-X2C-4G"
   * @returns {Promise<{cores: number, memoryGb: number, architecture: string, disk: number}>}
   */
  async getServerType(name) {
    let incomplete = false;
    for (const zone of ScalewayProvider._zones()) {
      for (let page = 1; page <= 20; page++) {
        const response = await this.bareRequest(
          `/instance/v1/zones/${zone}/products/servers?per_page=100&page=${page}`,
        );
        if (!response.ok) {
          incomplete = true;
          break;
        }
        const data = await response.json();
        const servers = data.servers || {};
        const match = servers[name];
        if (match) {
          return {
            cores: match.ncpus,
            memoryGb: match.ram / 2 ** 30,
            architecture: match.arch === 'x86_64' ? 'x86' : match.arch,
            disk:
              Math.round((match.volumes_constraint?.max_size ?? 0) / GB) ||
              ScalewayProvider.COMPOSE_ROOT_VOLUME_GB,
          };
        }
        if (Object.keys(servers).length < 100) break;
      }
    }
    if (incomplete) throw new Error(`Failed to fetch server type "${name}": listing incomplete`);
    throw new Error(`Server type "${name}" not found`);
  }

  /**
   * Register an SSH key — Project-level IAM resource (global API), scoped
   * to the operator's DEDICATED Scaleway Project (class header). Reuse-or-
   * create by key MATERIAL (the Linode lifecycle lesson): same material →
   * return the existing key's id without POSTing; a failed listing
   * degrades to create-anyway.
   * @param {string} name
   * @param {string} publicKey
   * @returns {Promise<string>} SSH key UUID
   */
  async createSSHKey(name, publicKey) {
    const projectId = readOperatorVar('SCALEWAY_DEFAULT_PROJECT_ID').value;
    const targetMaterial = normalizePublicKey(publicKey);

    const { items: existingKeys } = await this._walkPageSize(
      '/iam/v1alpha1/ssh-keys',
      'ssh_keys',
      projectId ? `project_id=${projectId}` : '',
    );
    const match = existingKeys.find((k) => normalizePublicKey(k.public_key) === targetMaterial);
    if (match) return match.id;

    const body = { name, public_key: publicKey.trim() };
    if (projectId) body.project_id = projectId;
    const response = await this.apiRequest('/iam/v1alpha1/ssh-keys', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Failed to create SSH key: ${error.message || 'Unknown error'}`);
    }

    const key = await response.json();
    return key.id;
  }

  /**
   * Server listing preserving the completeness signal — see
   * BaseProvider.listServersDetailed. Complete only when EVERY zone's walk
   * completed (a truncated zone hides residue exactly like a truncated
   * page).
   * @param {object} [labels]
   * @returns {Promise<{ items: object[], complete: boolean, status?: number }>}
   */
  async listServersDetailed(labels = {}) {
    const { items, complete, status } = await this._walkAllZones('/servers', 'servers');

    const filtered = withAllTags(items, labels, encodeLabel);

    return status === undefined
      ? { items: filtered, complete }
      : { items: filtered, complete, status };
  }

  /**
   * Find servers by exact name (Scaleway's server-side `name=` filter is
   * a contains-match, so exact matching happens client-side; soft-fail []
   * on non-ok).
   * @param {string} name
   * @param {{ strict?: boolean }} [options] - reject rather than answer `[]`
   *   when the listing isn't complete (BaseProvider.findServersByName)
   * @returns {Promise<object[]>}
   */
  async findServersByName(name, { strict = false } = {}) {
    const { items, complete, status } = await this._walkAllZones(
      `/servers?name=${encodeURIComponent(name)}`,
      'servers',
    );
    if (strict && !complete) throw this.serverLookupError(name, status);
    if (status !== undefined) return [];
    return items.filter((s) => s.name === name);
  }

  /**
   * Look up a security group by its exact name (server-side contains
   * filter + client-side exact match, per zone). The returned object is
   * AUGMENTED with `rules` (fetched here) and `zone` so the rule-rewrite
   * methods can operate on it — Scaleway keeps rules as a sub-resource.
   *
   * Null only when every zone's listing came back whole and none has the
   * name. A walk that stopped early (an error page, or the page cap) throws
   * instead, for the zone's groups and for the group's rules alike: read as
   * whole, a short group listing told destroy a live group never existed,
   * and a short rules listing had applyOperatorCidrs and the replication
   * write PUT back a rule set missing whatever the listing dropped, 80 and
   * 443 among them. Every caller catches the throw or passes it on.
   * @param {string} name
   * @returns {Promise<object|null>}
   */
  async findFirewallByName(name) {
    const partial = (what, walk) =>
      new Error(
        `Scaleway listed only part of ${what}` +
          `${walk.status === undefined ? '' : ` (HTTP ${walk.status})`}, so nothing was changed`,
      );
    for (const zone of ScalewayProvider._zones()) {
      const walk = await this._walkZone(
        `/security_groups?name=${encodeURIComponent(name)}`,
        'security_groups',
        zone,
      );
      if (!walk.complete) throw partial(`zone ${zone}'s security groups`, walk);
      const group = walk.items.find((g) => g.name === name);
      if (!group) continue;
      const rulesWalk = await this._walkZone(`/security_groups/${group.id}/rules`, 'rules', zone);
      if (!rulesWalk.complete) throw partial(`${name}'s rules`, rulesWalk);
      this._sgZoneCache ??= new Map();
      this._sgZoneCache.set(group.id, zone);
      // Strip the zone stamp _walkZone put on each rule — rules are pure
      // wire objects the replace path sends back verbatim (minus ids).
      return { ...group, zone, rules: rulesWalk.items.map(({ zone: _z, ...r }) => r) };
    }
    return null;
  }

  /** Resolve a security group's zone (cache-first, probe fallback). */
  async _findSecurityGroupZone(firewallId) {
    this._sgZoneCache ??= new Map();
    const cached = this._sgZoneCache.get(firewallId);
    if (cached) return cached;
    for (const zone of ScalewayProvider._zones()) {
      const res = await this.bareRequest(
        `/instance/v1/zones/${zone}/security_groups/${firewallId}`,
      );
      if (res.ok) {
        this._sgZoneCache.set(firewallId, zone);
        return zone;
      }
    }
    return null;
  }

  /**
   * Replace a security group's rule set wholesale — Scaleway's TRUE atomic
   * replace: `PUT /security_groups/{id}/rules` "replaces the existing
   * rules … creation of new rules and deletion of existing rules when they
   * are not passed" (SDK verbatim; audit-verified). One call, one
   * transaction, no mid-replace window — do NOT port Vultr's
   * delete-then-recreate loop here, and no diff-and-apply.
   * @param {string} firewallId - security group UUID
   * @param {object[]} rules - full replacement rule list, Scaleway wire
   *   shape: {action, protocol, direction, ip_range, dest_port_from,
   *   dest_port_to, position?, editable?}
   * @returns {Promise<void>}
   */
  async setFirewallRules(firewallId, rules) {
    const zone = await this._findSecurityGroupZone(firewallId);
    if (!zone) {
      throw new Error(`Scaleway security group ${firewallId} not found in any zone`);
    }
    // Scaleway's own rules (the six outbound SMTP drops every group lists
    // first, `editable: false`) are never sent back. A PUT that leaves them
    // out keeps them, as Terraform's do (its cassettes' PUT bodies carry only
    // its own rules), and they count positions of their own: the editable
    // rules number theirs from 1.
    // Normalize: fresh rules carry no id (null ⇒ create), editable defaults
    // true (the API ignores a non-editable rule, so pinning it avoids a
    // silently-dropped rule), and each rule's position is its place in the
    // list. Set last: a kept rule still carries the position it was read
    // with, and two rules on one position leave their order to the API, so
    // the order the caller built would not be the order on the group.
    const wireRules = rules
      .filter((rule) => rule.editable !== false)
      .map((rule, i) => ({
        id: null,
        editable: true,
        ...rule,
        position: i + 1,
      }));
    const response = await this.apiRequest(
      `/instance/v1/zones/${zone}/security_groups/${firewallId}/rules`,
      { method: 'PUT', body: JSON.stringify({ rules: wireRules }) },
    );
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        `Scaleway security-group rules replace failed (${response.status}): ${error.message || 'unknown error'}`,
      );
    }
  }

  /**
   * Scaleway-shaped replication-rule builder — see BaseProvider's abstract
   * doc. Operates on the AUGMENTED group object findFirewallByName returns
   * (rules attached). The reconcile is the shared replaceWireguardPeerRules:
   * the UDP/51821 rule follows the current peer (an old peer's rule is
   * dropped), null when already correct.
   *
   * The shared reconcile appends the peer's rule; this then moves the
   * operator-locked rules after every other, each group in its order, so the
   * list lands in the order applyOperatorCidrs writes (the rest as read,
   * then 22, then 6443) and a k8s program declares
   * (iac/programs/scaleway-k8s.js). Left at the end, the peer's rule would
   * follow 6443 after a first deploy, and the next up would reorder the
   * group.
   * @param {object} firewall - augmented group ({...group, zone, rules})
   * @param {string} peerIp
   * @returns {object[]|null}
   */
  buildReplicationFirewallRules(firewall, peerIp) {
    const rules = replaceWireguardPeerRules(firewall.rules || [], peerIp, {
      isWireguardRule: (rule) => {
        const r = canonicalScalewayRule(rule);
        return r.protocol === 'UDP' && r.direction === 'inbound' && r.dest_port_from === WG_PORT;
      },
      // The peer's rule as listed reads `<ip>` with no dest_port_to; as
      // built, `<ip>/32` and 51821. Both are the one rule.
      admitsOnlyPeer: (rule, ip) => {
        const r = canonicalScalewayRule(rule);
        return (
          r.action === 'accept' && r.ip_range === canonicalIpRange(ip) && r.dest_port_to === WG_PORT
        );
      },
      buildPeerRule: (ip) => ({
        action: 'accept',
        protocol: 'UDP',
        direction: 'inbound',
        ip_range: `${ip}/32`,
        dest_port_from: WG_PORT,
        dest_port_to: WG_PORT,
      }),
    });
    if (rules === null) return null;
    return [
      ...rules.filter((r) => !isOperatorLockedRule(r)),
      ...rules.filter(isOperatorLockedRule),
    ].map(({ id: _id, ...rest }) => rest);
  }

  /**
   * Rewrite the operator-locked ports' inbound rules to the given CIDR
   * list, deleting any inbound TCP/5432 or TCP/6543 rule (RETIRED_DB_PORTS),
   * and leaving every other rule unchanged. Scaleway rules carry ONE
   * ip_range each, so each locked port gets one rule PER CIDR (the same
   * expansion the compose program applies at create time); the whole set
   * lands in one atomic PUT (closest in shape to Hetzner's
   * read-filter-rebuild — audit's firewall verdict). CIDR-count ceiling to
   * respect: 500 Security Rules per Organization. The kept rules go first,
   * as read, then the rebuilt ones, 22 before 6443: the one order every k8s
   * writer keeps (buildReplicationFirewallRules, iac/programs/scaleway-k8s.js).
   * @param {{firewallName: string, cidrs: string[]}} args
   * @returns {Promise<boolean>} true if found and updated
   */
  async applyOperatorCidrs({ firewallName, cidrs }) {
    const fw = await this.findFirewallByName(firewallName);
    if (!fw) return false;

    const isRetiredDbPort = (rule) => {
      const r = canonicalScalewayRule(rule);
      return (
        r.direction === 'inbound' && r.protocol === 'TCP' && RETIRED_DB_PORTS.has(r.dest_port_from)
      );
    };
    const kept = (fw.rules || [])
      .filter((r) => !isOperatorLockedRule(r) && !isRetiredDbPort(r))
      .map(({ id: _id, ...rest }) => rest);
    const lockedPorts = [
      ...new Set(
        (fw.rules || [])
          .filter(isOperatorLockedRule)
          .map((r) => canonicalScalewayRule(r).dest_port_from),
      ),
    ];
    const rebuilt = lockedPorts.flatMap((port) =>
      cidrs.map((cidr) => ({
        action: 'accept',
        protocol: 'TCP',
        direction: 'inbound',
        ip_range: cidr,
        dest_port_from: port,
        dest_port_to: port,
      })),
    );

    await this.setFirewallRules(fw.id, [...kept, ...rebuilt]);
    return true;
  }

  /**
   * Delete a security group by its exact name. The per-AZ auto-created
   * default group can never match: our names are project-prefixed and the
   * exact-name lookup below never touches `project_default` groups by
   * construction (their name is Scaleway's own "Default security group").
   * @param {string} name
   * @returns {Promise<{deleted: boolean, everExisted: boolean, apiError: (Error|null)}>}
   */
  async deleteFirewallByName(name) {
    let everExisted = false;
    try {
      const fw = await this.findFirewallByName(name);
      if (!fw) return { deleted: false, everExisted: false, apiError: null };
      everExisted = true;
      const res = await this.bareRequest(`/instance/v1/zones/${fw.zone}/security_groups/${fw.id}`, {
        method: 'DELETE',
      });
      return { deleted: res.ok || res.status === 404, everExisted, apiError: null };
    } catch (err) {
      return { deleted: false, everExisted, apiError: err };
    }
  }

  /**
   * Delete a Project-level IAM SSH key by its exact name. Never throws;
   * false on no match. Scoped to SCALEWAY_DEFAULT_PROJECT_ID when set — the
   * dedicated-Project doctrine makes that the deploy's own key namespace.
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  async deleteSSHKeyByName(name) {
    const projectId = readOperatorVar('SCALEWAY_DEFAULT_PROJECT_ID').value;
    const res = await this.bareRequest(
      `/iam/v1alpha1/ssh-keys?page_size=100&name=${encodeURIComponent(name)}${
        projectId ? `&project_id=${projectId}` : ''
      }`,
    );
    if (!res.ok) return false;
    const { ssh_keys } = await res.json().catch(() => ({ ssh_keys: [] }));
    const match = (ssh_keys || []).find((k) => k.name === name);
    if (!match) return false;

    return this.deleteGone(`/iam/v1alpha1/ssh-keys/${match.id}`);
  }

  /**
   * List ALL Private Networks (soft-fail []). The k8s tiers make one per
   * stack, named `${clusterName}-network` (scaleway-k8s.js), in a VPC of the
   * same name; destroy and the autoscaler find it by that name, and destroy
   * reads cluster membership from servers' private_nics (serverNetworkIds).
   * The compose tier makes none.
   * @returns {Promise<object[]>}
   */
  async listNetworks() {
    const { items, status } = await this.listNetworksDetailed();
    return status === undefined ? items : [];
  }

  /**
   * listNetworks with the walk's completeness signal, for a caller that must
   * not read part of the list as the whole (deleteNetworkByName). Region-
   * scoped API (VPC), walked over every region and project-scoped
   * (_walkVpcApi); each row carries its `region`.
   * @returns {Promise<{items: object[], complete: boolean, status?: number}>}
   */
  async listNetworksDetailed() {
    return this._walkVpcApi('private-networks', 'private_networks');
  }

  /**
   * Delete a cluster's network by its exact name: the Private Network, then
   * the VPC holding it (scaleway-k8s.js names both `${clusterName}-network`),
   * since a VPC holding a Private Network cannot go. Both listings are read
   * whole before any DELETE, and each object is deleted in the region it is
   * listed in. A project's default VPC (`is_default`) is never matched,
   * whatever it is named. The shared contract of deleteVpcByName otherwise:
   * a 2xx or 404 is deleted, any other answer is `apiError` and stops there
   * (deleteNetworkAt), and a listing that cannot be read whole throws
   * (networkListingWhole), so destroy reports it could not confirm the
   * network is gone.
   * @param {string} name
   * @returns {Promise<{deleted: boolean, everExisted: boolean, apiError: (Error|null)}>}
   * @throws when the Private Network or VPC listing cannot be read whole
   */
  async deleteNetworkByName(name) {
    const networks = networkListingWhole(await this.listNetworksDetailed(), 'Private Network');
    const vpcs = networkListingWhole(await this._walkVpcApi('vpcs', 'vpcs'), 'VPC');
    const targets = [
      ['private-networks', networks.find((n) => n.name === name)],
      ['vpcs', vpcs.find((v) => v.name === name && v.is_default !== true)],
    ].filter(([, row]) => row);
    if (targets.length === 0) return { deleted: false, everExisted: false, apiError: null };
    for (const [collection, row] of targets) {
      const apiError = await deleteNetworkAt(
        this,
        `/vpc/v2/regions/${row.region}/${collection}/${row.id}`,
      );
      if (apiError) return { deleted: false, everExisted: true, apiError };
    }
    return { deleted: true, everExisted: true, apiError: null };
  }

  /**
   * Volume listing preserving the completeness signal. Walks BOTH volume
   * products per zone: the legacy Instance-API volumes endpoint (l_ssd)
   * AND the Block Storage API (`/block/v1/…` — where every SBS volume,
   * i.e. every root volume of our SBS-only types, actually lives). A sweep
   * that read only the Instance API would report "no volumes" over a
   * dead-certain SBS leak.
   * @returns {Promise<{ items: object[], complete: boolean, status?: number }>}
   */
  async listVolumesDetailed() {
    const instanceWalk = await this._walkAllZones('/volumes', 'volumes');

    const items = [...instanceWalk.items];
    let complete = instanceWalk.complete;
    let status = instanceWalk.status;

    for (const zone of ScalewayProvider._zones()) {
      const walk = await this._walkPageSize(`/block/v1/zones/${zone}/volumes`, 'volumes');
      items.push(...walk.items.map((v) => ({ zone, ...v })));
      if (!walk.complete) {
        complete = false;
        status ??= walk.status;
      }
    }

    return status === undefined ? { items, complete } : { items, complete, status };
  }

  /**
   * Delete a volume by id — probes the Block Storage API first (where our
   * SBS volumes live), then the legacy Instance API, across zones (volume
   * UUIDs are zone-scoped like everything else).
   * @param {string} volumeId
   * @returns {Promise<boolean>} true on success or already gone
   */
  async deleteVolume(volumeId) {
    let sawFailure = false;
    for (const base of ['/block/v1/zones', '/instance/v1/zones']) {
      for (const zone of ScalewayProvider._zones()) {
        const res = await this.bareRequest(`${base}/${zone}/volumes/${volumeId}`, {
          method: 'DELETE',
        });
        if (res.ok) return true;
        if (res.status !== 404) sawFailure = true;
      }
    }
    return !sawFailure; // all-404 ⇒ already gone
  }

  /**
   * List ALL load balancers (soft-fail []) — never provisioned by the
   * compose tier; enumerated for leak-visibility parity.
   * @returns {Promise<object[]>}
   */
  async listLoadBalancers() {
    const items = [];
    for (const zone of ScalewayProvider._zones()) {
      const walk = await this._walkPageSize(`/lb/v1/zones/${zone}/lbs`, 'lbs');
      if (walk.status !== undefined) return [];
      items.push(...walk.items.map((lb) => ({ zone, ...lb })));
    }
    return items;
  }

  /**
   * Delete a load balancer by id (zone-probed like deleteVolume).
   * @param {string} lbId
   * @returns {Promise<boolean>} true on success or already gone
   */
  async deleteLoadBalancer(lbId) {
    let sawFailure = false;
    for (const zone of ScalewayProvider._zones()) {
      const res = await this.bareRequest(`/lb/v1/zones/${zone}/lbs/${lbId}?release_ip=true`, {
        method: 'DELETE',
      });
      if (res.ok) return true;
      if (res.status !== 404) sawFailure = true;
    }
    return !sawFailure;
  }

  /**
   * List flexible IPs across the REGIONS zones WITH the completeness
   * signal — Scaleway-specific teardown surface (not part of the abstract
   * contract): flexible IPv4s survive server deletion at €0.005/hr, so
   * the sweep needs to enumerate them (audit design flag 5). Each item is
   * zone-stamped.
   * @returns {Promise<{items: object[], complete: boolean, status?: number}>}
   */
  async listFlexibleIPsDetailed() {
    return this._walkAllZones('/ips', 'ips');
  }

  /**
   * Release a flexible IP by id (zone known from the listing above, or
   * probed when absent).
   * @param {string} ipId
   * @param {string} [zone]
   * @returns {Promise<boolean>} true on success or already gone
   */
  async releaseFlexibleIP(ipId, zone) {
    const zones = zone ? [zone] : ScalewayProvider._zones();
    let sawFailure = false;
    for (const z of zones) {
      const res = await this.bareRequest(`/instance/v1/zones/${z}/ips/${ipId}`, {
        method: 'DELETE',
      });
      if (res.ok) return true;
      if (res.status !== 404) sawFailure = true;
    }
    return !sawFailure;
  }

  /**
   * Every flexible IP across the REGIONS zones (listFlexibleIPsDetailed),
   * read whole. A partial listing must not pass for the whole: destroy reads
   * an address missing from it as already released, and a label sweep as
   * nothing left.
   * @returns {Promise<Array<{id: string, address: string, zone: string, tags?: string[], server?: {id: string, name?: string}|null}>>}
   * @throws when a zone cannot be read, or holds more than the walk reads
   */
  async _listFlexibleIps() {
    const { items, complete, status } = await this.listFlexibleIPsDetailed();
    if (complete) return items;
    throw new Error(
      status === undefined
        ? 'a zone holds more flexible IPs than vibecarbon reads'
        : `GET /ips failed: HTTP ${status}`,
    );
  }

  /**
   * Delete one listed, unattached flexible IP in its zone, answered as a
   * ReservedIpRelease: 2xx or 404 is released, a 4xx is a refusal (still
   * held), and any other status, a 5xx that outlasted fetchWithRetry's
   * retries, proves nothing either way (deleteRefused). releaseFlexibleIP
   * answers only true or false, so the status would be lost there.
   * @param {{id: string, zone: string}} ip
   * @returns {Promise<import('./base.js').ReservedIpRelease>}
   */
  async _deleteFlexibleIp(ip) {
    const res = await this.bareRequest(`/instance/v1/zones/${ip.zone}/ips/${ip.id}`, {
      method: 'DELETE',
    });
    if (res.ok || res.status === 404) return { released: true };
    return {
      released: false,
      held: deleteRefused(res.status) ? true : null,
      region: ip.zone,
      reason: deleteFailure(ScalewayProvider.NAME, res.status),
    };
  }

  /**
   * Release a flexible IP by address, answered as a ReservedIpRelease
   * (providers/base.js) so destroy reads every provider one way. Scaleway
   * deletes by id in a zone, so this lists and matches `address` first; an
   * address the account no longer holds is already released. One still
   * attached to a server is refused here, with no delete sent: an address is
   * never taken off a server, whoever asks.
   * @param {string} address
   * @returns {Promise<import('./base.js').ReservedIpRelease>}
   * @throws when the listing cannot be read whole
   */
  async deleteReservedIpByAddress(address) {
    const ip = (await this._listFlexibleIps()).find((i) => i.address === address);
    if (!ip) return { released: true };
    if (ip.server) {
      return {
        released: false,
        held: true,
        region: ip.zone,
        reason: `it is still attached to server ${ip.server.name ?? ip.server.id}`,
      };
    }
    return this._deleteFlexibleIp(ip);
  }

  /**
   * Whether the flexible IP at `address` is still this project's and
   * environment's: its tags carry both stackTags(labels), and the server it
   * is attached to, if any, carries the same two (scaleway-k8s.js tags every
   * server with them). Destroy asks before it releases an address saved at
   * deploy time: a released address can be reissued to another account or
   * project by then, and one of ours still attached to a server the teardown
   * did not delete must never be taken off it. Labels without both a project
   * and an environment match nothing. A holding server no zone lists (404)
   * holds it on its way out, so the IP stays this stack's and held; one a
   * zone refused to show is never read as gone, and the match throws.
   * @param {string} address
   * @param {Object<string,string>} labels
   * @returns {Promise<{ found: false } | { found: true, matches: boolean, tags: string[], holder: string|null }>}
   *   found is false when the account holds no flexible IP at that address;
   *   holder names the server it is attached to, null when unattached; tags
   *   are the IP's, and what its holder is when that is someone else
   * @throws when the listing, or the server holding a tagged one, cannot be read
   */
  async reservedIpLabelMatch(address, labels) {
    const wanted = stackTags(labels);
    const ip = (await this._listFlexibleIps()).find((i) => i.address === address);
    if (!ip) return { found: false };
    const tags = ip.tags ?? [];
    const holder = ip.server ? `server ${ip.server.name ?? ip.server.id} (${ip.server.id})` : null;
    if (wanted === null || !wanted.every((t) => tags.includes(t))) {
      return { found: true, matches: false, tags, holder };
    }
    if (!ip.server) return { found: true, matches: true, tags, holder };
    let server;
    try {
      server = await this.getServer(ip.server.id);
    } catch (err) {
      if (err.status === 404) return { found: true, matches: true, tags, holder };
      const why = err.status ? `HTTP ${err.status}` : err.message;
      throw new Error(`could not read ${holder}, which holds it (${why})`);
    }
    const serverTags = server?.tags ?? [];
    if (wanted.every((t) => serverTags.includes(t))) {
      return { found: true, matches: true, tags, holder };
    }
    const { project, environment } = decodeLabels(serverTags);
    const whose = project
      ? `project ${project}, environment ${environment ?? 'none'}`
      : 'no vibecarbon project';
    return {
      found: true,
      matches: false,
      tags: [...tags, `held by ${holder}, which is ${whose}`],
      holder,
    };
  }

  /**
   * Release every flexible IP whose tags carry ALL of the given labels (the
   * encodeLabel encoding the compose and k8s programs tag their IPs with).
   * The compose program creates the IP before the server, and destroy
   * deletes the server by its API, which releases only an IP attached to
   * it: a deploy killed in between leaves the IP attached to nothing and
   * named nowhere but here. Filters client-side over every zone's listing.
   * A label without a value is refused (sweepLabels). One still attached to
   * a server is left alone: destroy runs after the server deletes, so that
   * server is one they did not delete, or one this process asked to
   * terminate that was still terminating when deleteServer stopped waiting
   * (`serverTerminating`: the next destroy finds it gone and releases the IP).
   * @param {Object<string,string>} labels
   * @param {{except?: string[]}} [options] - addresses the caller already handled
   * @returns {Promise<import('./base.js').TaggedReservedIpSweep>}
   * @throws when the listing cannot be read whole
   */
  async deleteReservedIpsByLabels(labels, { except = [] } = {}) {
    const wanted = encodeLabels(Object.fromEntries(sweepLabels(labels)));
    const items = await this._listFlexibleIps();
    const skip = new Set(except);
    const deleted = [];
    const failed = [];
    for (const ip of items) {
      if (!wanted.every((tag) => (ip.tags ?? []).includes(tag)) || skip.has(ip.address)) continue;
      if (ip.server) {
        const server = ip.server.name ?? ip.server.id;
        if (serversStillTerminating.has(String(ip.server.id))) {
          failed.push({
            address: ip.address,
            held: true,
            serverTerminating: true,
            reason:
              `it is still attached to server ${server}, which was still terminating when ` +
              `vibecarbon stopped waiting after ${TERMINATE_WAIT_MS / 60_000} minutes`,
          });
        } else {
          failed.push({
            address: ip.address,
            held: true,
            reason: `it is still attached to server ${server}, which was not deleted`,
          });
        }
        continue;
      }
      const outcome = await this._deleteFlexibleIp(ip);
      if (outcome.released) deleted.push(ip.address);
      else failed.push({ address: ip.address, held: outcome.held, reason: outcome.reason });
    }
    return { deleted, failed };
  }

  // ── Destroy-sweep field accessors ───────────────────────────────────────

  /**
   * Private Network ids the server has a NIC in: Scaleway's server object
   * lists them as `private_nics: [{id, private_network_id, ...}]`
   * (scaleway-sdk-go instance_sdk.go Server.PrivateNics). [] for a server in
   * no Private Network (every compose instance).
   * @param {object} server
   * @returns {string[]}
   */
  serverNetworkIds(server) {
    return (server?.private_nics ?? []).map((n) => n.private_network_id);
  }

  /**
   * @param {object} server
   * @returns {Object<string,string>}
   */
  serverLabels(server) {
    return decodeLabels(server.tags);
  }

  /**
   * Volume ids attached to this server — the server object's `volumes`
   * map ("0" → root volume, …).
   * @param {object} server
   * @returns {string[]}
   */
  serverVolumeIds(server) {
    return Object.values(server.volumes ?? {})
      .map((v) => v?.id)
      .filter(Boolean);
  }

  /**
   * Zone string (stamped by our listings; server objects also carry a
   * `zone` from the wire in newer responses).
   * @param {object} server
   * @returns {string|null}
   */
  serverRegion(server) {
    return server.zone ?? null;
  }

  /**
   * Attached server ids. Handles BOTH volume products' shapes: the
   * Instance API's `server: {id}` and the Block API's
   * `references[]` (product_resource_type 'instance_server').
   * @param {object} volume
   * @returns {string[]}
   */
  volumeAttachedServerIds(volume) {
    if (volume.server?.id) return [volume.server.id];
    return (volume.references ?? [])
      .filter((ref) => ref?.product_resource_type === 'instance_server')
      .map((ref) => ref.product_resource_id)
      .filter(Boolean);
  }

  /**
   * @param {object} volume
   * @returns {string|null}
   */
  volumeRegion(volume) {
    return volume.zone ?? null;
  }

  /**
   * @param {object} volume
   * @returns {Object<string,string>}
   */
  volumeLabels(volume) {
    return decodeLabels(volume.tags);
  }

  /**
   * ISO timestamp — `creation_date` (Instance API volumes) or
   * `created_at` (Block API volumes).
   * @param {object} volume
   * @returns {string|null}
   */
  volumeCreatedAt(volume) {
    return volume.creation_date ?? volume.created_at ?? null;
  }

  // ── Object storage dispatch ─────────────────────────────────────────────

  /**
   * Lazily resolve the Scaleway Object Storage provider class (dynamic
   * import, never top-level).
   * @returns {Promise<typeof import('./scaleway-objectstorage.js').ScalewayObjectStorageProvider>}
   */
  static async getObjectStorageProviderClass() {
    const { ScalewayObjectStorageProvider } = await import('./scaleway-objectstorage.js');
    return ScalewayObjectStorageProvider;
  }

  // ── Guided setup delegation ─────────────────────────────────────────────

  /**
   * @param {string} [projectName]
   * @param {{ save?: boolean }} [options]
   * @returns {Promise<string|null>}
   */
  static async promptApiToken(projectName, options) {
    const { getApiToken } = await import('../scaleway-guided-setup.js');
    return getApiToken(projectName, options);
  }

  /**
   * @param {string} [projectName]
   * @param {{ save?: boolean, force?: boolean, skipPrompts?: boolean }} [options]
   * @returns {Promise<{accessKey: string, secretKey: string}|null>}
   */
  static async promptObjectStorageCredentials(projectName, options) {
    const { getS3Credentials } = await import('../scaleway-guided-setup.js');
    return getS3Credentials(projectName, options);
  }

  // ── IaC program dispatch ────────────────────────────────────────────────

  /**
   * Lazily build the Pulumi Automation-API program for a single Scaleway
   * Docker-Compose instance (dynamic import, never top-level).
   * @param {object} config
   * @returns {Promise<() => Promise<{serverIp: string, serverId: string, firewallId: string, sshKeyId: string}>>}
   */
  static async getComposeProgram(config) {
    const { buildScalewayComposeProgram } = await import('../iac/programs/scaleway-compose.js');
    return buildScalewayComposeProgram(config);
  }
}
