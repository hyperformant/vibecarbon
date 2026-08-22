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

import { fetchWithRetry } from '../fetch-retry.js';
import { pollUntil } from '../retry.js';
import { BaseProvider } from './base.js';

// Ports whose inbound rules applyOperatorCidrs rewrites — same set as the
// sibling providers (SSH, k8s API for future parity, Supavisor poolers).
// Numeric: Scaleway rules carry dest_port_from/dest_port_to as numbers.
const SSH_PORT = 22;
const K8S_API_PORT = 6443;
const POOLER_SESSION_PORT = 5432;
const POOLER_TRANSACTION_PORT = 6543;
const OPERATOR_LOCKED_PORTS = new Set([
  SSH_PORT,
  K8S_API_PORT,
  POOLER_SESSION_PORT,
  POOLER_TRANSACTION_PORT,
]);

// WireGuard replication port (wireguard.js WG_PORT) — only reachable via
// compose-ha (declared since tier-parity wave 1). Numeric (see above).
const WG_PORT = 51821;

// GB on Scaleway's wire is 10^9 bytes (the live catalog reports
// volumes_constraint.max_size = 40000000000 for DEV1-M's 40 GB).
const GB = 1_000_000_000;

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

/**
 * See DigitalOcean's KNOWN_MANGLED_LABEL_KEYS — same single known collision,
 * same unambiguity argument within this codebase's fixed tag-key set.
 * @type {Object<string,string>}
 */
const KNOWN_MANGLED_LABEL_KEYS = { 'cluster-autoscaler-node': 'cluster-autoscaler/node' };

/**
 * Decode a Scaleway tag array back into a flat label map — inverse of
 * encodeLabels for this codebase's known key set.
 * @param {string[]|null} [tags]
 * @returns {Object<string,string>}
 */
export function decodeLabels(tags = []) {
  const out = {};
  for (const tag of tags || []) {
    const sep = tag.indexOf(':');
    if (sep === -1) continue;
    const wireKey = tag.slice(0, sep);
    out[KNOWN_MANGLED_LABEL_KEYS[wireKey] ?? wireKey] = tag.slice(sep + 1);
  }
  return out;
}

// The shared cloud-init template carries typographic characters in its
// comments (em-dashes, live as of 2026-08-09), and Scaleway user data
// crosses the wire as PLAIN TEXT with NO base64 leg (unlike Linode/Vultr)
// and no gzip — so there is no 7-bit-clean safety net between us and
// whatever the Pulumi bridge / Scaleway ingestion does with non-ASCII
// bytes. Same wire-contract decision as DigitalOcean's (see
// digitalocean-compose.js's ASCII_TRANSLITERATION_MAP RCA — a mangled
// em-dash there produced a C1 control char that made cloud-init reject the
// ENTIRE #cloud-config part): never hand the wire a non-ASCII byte.
// Known typography is transliterated explicitly; anything unmapped falls
// through to assertAsciiCloudInit's loud refusal rather than a silent '?'.
const ASCII_TRANSLITERATION_MAP = {
  '—': '--', // em dash
  '–': '-', // en dash
  '‘': "'", // left single quote
  '’': "'", // right single quote
  '“': '"', // left double quote
  '”': '"', // right double quote
  '…': '...', // ellipsis
};

/**
 * Transliterate known typographic characters to ASCII — the Scaleway leg
 * of DO's wire-contract decision (see the map comment above). Applied by
 * loadScalewayComposeUserData BEFORE assertAsciiCloudInit, so mapped
 * typography degrades deterministically and anything unmapped still fails
 * loudly.
 * @param {string} input
 * @returns {string}
 */
export function transliterateCloudInitToAscii(input) {
  let out = '';
  for (const ch of input ?? '') {
    if (/** @type {number} */ (ch.codePointAt(0)) <= 0x7f) {
      out += ch;
      continue;
    }
    out += ASCII_TRANSLITERATION_MAP[ch] ?? ch;
  }
  return out;
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
  // (CCM/CSI/block-storage/DNS-flip) recorded in the audit; the k8s tiers
  // are not yet built or declared.
  static SUPPORTED_TIERS = ['compose', 'compose-ha'];

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
    const accessKey = process.env.SCALEWAY_ACCESS_KEY;
    const projectId = process.env.SCALEWAY_DEFAULT_PROJECT_ID;
    const missing = [];
    if (!accessKey) missing.push('SCALEWAY_ACCESS_KEY');
    if (!projectId) missing.push('SCALEWAY_DEFAULT_PROJECT_ID');
    if (missing.length > 0) {
      throw new Error(
        `Scaleway needs ${missing.join(' and ')} set alongside SCALEWAY_SECRET_KEY — the Pulumi ` +
          'Scaleway provider requires the full access-key/secret-key/project-id triple. Set ' +
          `${missing.join(' and ')} in your shell or the project's .env.local (vibecarbon ` +
          'configure → Providers → Scaleway collects all three).',
      );
    }
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
  // volume constraint.
  static FALLBACK_SERVER_TYPES = {
    'BASIC3-X2C-4G': { vcpu: 2, ram: 4, disk: 40 },
    'BASIC3-X4C-8G': { vcpu: 4, ram: 8, disk: 40 },
    'DEV1-M': { vcpu: 3, ram: 4, disk: 40 },
  };

  // Live catalog populated by fetchServerTypes(); object map (name → spec).
  static SERVER_TYPES = { ...ScalewayProvider.FALLBACK_SERVER_TYPES };

  // Per-zone availability populated by fetchServerTypes(). Scaleway's
  // catalog is genuinely per-zone (no type spans all zones — audit), so
  // this map is real data, same shape as DO's/Vultr's.
  static _locationTypes = null;

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
   * Empty at the compose-only tier — no CCM/CSI deployed; real values come
   * from scaleway-cloud-controller-manager / scaleway-csi manifests when
   * the k8s tier is built (audit headroom record).
   * @type {{
   *   csiNodeDaemonSet: string,
   *   csiControllerSelector: string,
   *   ccmDeployment: string,
   *   ccmSelector: string,
   *   networkEnvVar: string,
   * }}
   */
  static K8S_ASSETS = {
    csiNodeDaemonSet: '',
    csiControllerSelector: '',
    ccmDeployment: '',
    ccmSelector: '',
    networkEnvVar: '',
  };

  /**
   * scaleway-csi's default StorageClass (`sbs-default`, provisioner
   * csi.scaleway.com — audited from Kapsule's default; re-VERIFY against
   * the standalone Helm chart before the k8s tier ships). Unread while
   * compose-only; the literal-guard census requires distinctness +
   * residence here.
   * @type {string}
   */
  static K8S_STORAGE_CLASS = 'sbs-default';

  /** Compose-only: no k8s program exists to pin a VPC CIDR against. @type {string} */
  static DEFAULT_VPC_CIDR = '';

  /** Compose-only: no k8s program/image literal to byte-match. @type {string} */
  static K8S_IMAGE = '';

  // ── ARM guard ───────────────────────────────────────────────────────────
  // Scaleway sells real ARM lines: BASIC2-A* ('A' = arm64 vs BASIC3-X*'s
  // 'X' = x86_64; live catalog arch field) and the COPARM1 line. The
  // fallback catalog is all-x86 and fetchServerTypes() filters arm64 out,
  // but the predicate must still recognize the SKUs so `-type BASIC2-A2C-4G`
  // is rejected with a reason.

  /**
   * @param {string} serverType
   * @returns {boolean}
   */
  static isArmServerType(serverType) {
    return /^(?:BASIC\d+-A|COPARM)/i.test(serverType || '');
  }

  /**
   * Size-preserving ARM→x86 map: BASIC2-A<N>C-<M>G shares its core/RAM
   * shape with BASIC3-X<N>C-<M>G (live catalog: BASIC2-A2C-4G is 2c/4G,
   * BASIC3-X2C-4G is 2c/4G) — swap the family. Anything else (COPARM,
   * unknown ARM spellings) falls back to DEFAULT_TYPE.
   * @param {string} serverType
   * @returns {string}
   */
  static armToAmd64Equivalent(serverType) {
    const m = /^BASIC\d+-A(\d+C-\d+G)$/i.exec(serverType || '');
    if (m) {
      const candidate = `BASIC3-X${m[1].toUpperCase()}`;
      if (candidate in ScalewayProvider.SERVER_TYPES) return candidate;
    }
    return ScalewayProvider.DEFAULT_TYPE;
  }

  // ── k8s statics — compose-only, provider-specific throws ────────────────

  /** @returns {Promise<never>} */
  static async getK8sMasterUserData() {
    throw new Error("Scaleway's k8s tier is not built — SUPPORTED_TIERS is compose-only");
  }

  /** @returns {Promise<never>} */
  static async getK8sWorkerUserData() {
    throw new Error("Scaleway's k8s tier is not built — SUPPORTED_TIERS is compose-only");
  }

  /** @returns {Promise<never>} */
  static async getK8sSupabaseUserData() {
    throw new Error("Scaleway's k8s tier is not built — SUPPORTED_TIERS is compose-only");
  }

  /** @returns {Promise<never>} */
  static async getK8sProgram() {
    throw new Error("Scaleway's k8s tier is not built — SUPPORTED_TIERS is compose-only");
  }

  // ── Compose-tier replacement-server identity ────────────────────────────

  /**
   * Marketplace LABEL, deliberately not a UUID: Scaleway image UUIDs are
   * per-zone AND per-volume-type (`ubuntu_noble` in fr-par-1 alone
   * resolves to six local-image UUIDs), and the Instance API + Pulumi
   * provider both accept the label and resolve the right variant for the
   * zone/volume-type (BASIC3 → the `instance_sbs` x86 variant). A UUID pin
   * would break on the first zone change. MUST byte-match the program's
   * literal (scaleway-compose.js).
   * @type {string}
   */
  static COMPOSE_IMAGE = 'ubuntu_noble';

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
   * `GET /instance/v1/zones/{zone}/products/servers` endpoint (one walk
   * per REGIONS zone — the audit's "no type exists everywhere" finding
   * makes the zone axis real data). Page-walked at per_page=100 (the
   * fr-par-1 catalog is 136 types, so a single page silently truncates).
   * arm64 types are EXCLUDED from SERVER_TYPES — vibecarbon is amd64-only
   * and the catalog invariants require an ARM-free own catalog.
   * Incomplete/empty walks return false so the fallback catalog survives.
   * @param {string} apiToken - sent as X-Auth-Token when given (the
   *   endpoint is public; the header only aids rate-limit accounting)
   * @returns {Promise<boolean>} true if live data was loaded
   */
  static async fetchServerTypes(apiToken) {
    if (ScalewayProvider._locationTypes) return true; // already fetched

    try {
      const types = {};
      const locationTypes = {};
      for (const zone of Object.keys(ScalewayProvider.REGIONS)) {
        const servers = {};
        for (let page = 1; page <= 20; page++) {
          const response = await fetchWithRetry(
            `${ScalewayProvider.API_BASE}/instance/v1/zones/${zone}/products/servers?per_page=100&page=${page}`,
            apiToken ? { headers: { 'X-Auth-Token': apiToken } } : {},
          );
          if (!response.ok) return false;
          const data = await response.json();
          const pageServers = data.servers || {};
          Object.assign(servers, pageServers);
          if (Object.keys(pageServers).length < 100) break;
        }
        for (const [name, spec] of Object.entries(servers)) {
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
          if (!locationTypes[zone]) locationTypes[zone] = new Set();
          locationTypes[zone].add(name);
        }
      }
      if (Object.keys(types).length === 0) return false;

      ScalewayProvider.SERVER_TYPES = types;
      ScalewayProvider._locationTypes = locationTypes;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Server types available in a zone — live per-zone data when fetched
   * (the zone axis is real on Scaleway), fallback catalog otherwise (all
   * three fallback types are live-verified present in every REGIONS zone).
   * @param {string} region - zone (fr-par-1 …)
   * @returns {Array<{name: string, vcpu: number, ram: number, disk: number, architecture: string}>}
   */
  static getServerTypesForRegion(region) {
    const available = ScalewayProvider._locationTypes?.[region];

    if (available) {
      return [...available]
        .filter((name) => name in ScalewayProvider.SERVER_TYPES)
        .map((name) => ({
          name,
          ...ScalewayProvider.SERVER_TYPES[name],
          // fetchServerTypes filtered on arch === 'x86_64'.
          architecture: 'x86',
        }))
        .sort((a, b) => a.vcpu - b.vcpu || a.ram - b.ram);
    }

    return Object.entries(ScalewayProvider.FALLBACK_SERVER_TYPES).map(([name, info]) => ({
      name,
      ...info,
      architecture: 'x86',
    }));
  }

  /**
   * Region-appropriate default server types — fixed roles. DEV1-M is the
   * audited fallback family (present wherever BASIC3 is, in our REGIONS
   * set) and carries the master/worker roles for cost; supabase gets the
   * baseline type.
   * @param {string} _region - interface parity; unused
   * @returns {{masterType: string, supabaseType: string, workerType: string}}
   */
  static getRegionDefaults(_region) {
    return {
      masterType: 'DEV1-M',
      supabaseType: ScalewayProvider.DEFAULT_TYPE,
      workerType: 'DEV1-M',
    };
  }

  /**
   * Default HA standby zone — cross-country pairs (fr-par ↔ nl-ams, same
   * AZ ordinal so both sides carry the same catalog subset), then
   * same-continent, mirroring the sibling providers' contract. DEV1-M is
   * the documented type fallback if BASIC3 is ever absent from a chosen
   * zone (audit: capacityPreferences zone set).
   * @param {string} primaryRegion - zone
   * @returns {string}
   */
  static getDefaultStandbyRegion(primaryRegion) {
    const PAIRS = {
      'fr-par-1': 'nl-ams-1',
      'fr-par-2': 'nl-ams-2',
      'nl-ams-1': 'fr-par-1',
      'nl-ams-2': 'fr-par-2',
    };
    if (PAIRS[primaryRegion]) return PAIRS[primaryRegion];

    const continent = ScalewayProvider.REGION_CONTINENT[primaryRegion];
    const sameContinent = Object.keys(ScalewayProvider.REGION_CONTINENT).filter(
      (r) => r !== primaryRegion && ScalewayProvider.REGION_CONTINENT[r] === continent,
    );
    if (sameContinent.length > 0) return sameContinent[0];
    return primaryRegion === 'fr-par-1' ? 'nl-ams-1' : 'fr-par-1';
  }

  /**
   * Equivalent type in a target zone, using the live per-zone axis when
   * available (same walk shape as DO's/Vultr's).
   * @param {string} serverType
   * @param {string} targetRegion - zone
   * @returns {string}
   */
  static resolveServerTypeForRegion(serverType, targetRegion) {
    const available = ScalewayProvider._locationTypes?.[targetRegion];

    if (available) {
      if (available.has(serverType)) return serverType;
      const defaults = ScalewayProvider.getRegionDefaults(targetRegion);
      if (serverType === defaults.supabaseType) return defaults.supabaseType;
      return defaults.masterType;
    }

    return serverType;
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

  /**
   * Public IPv6 of a server (`public_ips[]` family 'inet6', legacy
   * `ipv6.address` fallback).
   * @param {object} server
   * @returns {string|null}
   */
  static getPublicIPv6(server) {
    const ips = server?.public_ips;
    if (Array.isArray(ips)) {
      const v6 = ips.find((ip) => ip?.family === 'inet6' && ip?.address);
      if (v6) return v6.address;
    }
    return server?.ipv6?.address ?? null;
  }

  // ── Instance methods ────────────────────────────────────────────────────
  // Transport split mirrors the sibling providers: CRUD via this.apiRequest
  // (X-Auth-Token — see the override), listings/teardown via fetchWithRetry
  // through the zone-walking helpers, getServerSummary raw fetches with a
  // hard 5s abort.

  /**
   * Authenticated request — Scaleway auth is `X-Auth-Token: <secret key>`,
   * not a Bearer header, so the base helper is overridden (same
   * fetch-retry envelope).
   * @param {string} endpoint - API path (relative to API_BASE)
   * @param {object} [options={}] - Fetch options
   * @returns {Promise<Response>}
   */
  async apiRequest(endpoint, options = {}) {
    const url = `${ScalewayProvider.API_BASE}${endpoint}`;
    const headers = {
      'X-Auth-Token': this.apiToken,
      'Content-Type': 'application/json',
      ...options.headers,
    };
    return await fetchWithRetry(url, { ...options, headers });
  }

  /** Zones this provider operates in (REGIONS keys — see class header). */
  static _zones() {
    return Object.keys(ScalewayProvider.REGIONS);
  }

  /**
   * Page-walk the global IAM ssh-keys listing (`page`/`page_size`
   * envelope `{ssh_keys}`; a page shorter than page_size ends the walk).
   * Soft completeness signal like the zone walks.
   * @param {string} [query] - extra query (e.g. 'project_id=…'), no '?'
   * @returns {Promise<{items: object[], complete: boolean}>}
   */
  async _walkIamSshKeys(query = '') {
    const items = [];
    for (let page = 1; page <= 20; page++) {
      const res = await fetchWithRetry(
        `${ScalewayProvider.API_BASE}/iam/v1alpha1/ssh-keys?page_size=100&page=${page}${
          query ? `&${query}` : ''
        }`,
        { headers: { 'X-Auth-Token': this.apiToken } },
      );
      if (!res.ok) return { items, complete: false };
      const data = await res.json().catch(() => ({}));
      const pageItems = data.ssh_keys || [];
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
      const response = await fetchWithRetry(
        `${ScalewayProvider.API_BASE}/instance/v1/zones/${zone}${path}${sep}per_page=100&page=${page}`,
        { headers: { 'X-Auth-Token': this.apiToken } },
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
    const items = [];
    let complete = true;
    let status;
    for (const zone of ScalewayProvider._zones()) {
      const res = await this._walkZone(path, key, zone);
      items.push(...res.items);
      if (!res.complete) {
        complete = false;
        if (res.status !== undefined) status = res.status;
      }
    }
    return status === undefined ? { items, complete } : { items, complete, status };
  }

  /**
   * Resolve which zone a server UUID lives in (UUIDs are zone-scoped —
   * class header). Probes GET per zone, caching hits for the lifetime of
   * this provider instance.
   * @param {string} serverId
   * @returns {Promise<string|null>} zone, or null when no zone has it
   */
  async _findServerZone(serverId) {
    this._zoneCache ??= new Map();
    const cached = this._zoneCache.get(serverId);
    if (cached) return cached;
    for (const zone of ScalewayProvider._zones()) {
      const res = await fetchWithRetry(
        `${ScalewayProvider.API_BASE}/instance/v1/zones/${zone}/servers/${serverId}`,
        { headers: { 'X-Auth-Token': this.apiToken } },
      );
      if (res.ok) {
        this._zoneCache.set(serverId, zone);
        return zone;
      }
      if (res.status !== 404 && res.status !== 403) {
        const body = await res.text().catch(() => '');
        throw new Error(`Scaleway API error resolving server ${serverId} (${res.status}): ${body}`);
      }
    }
    return null;
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
   * parity and deliberately unused). `dynamic_ip_required: true` (the API
   * default, pinned explicitly) attaches a dynamic public IPv4 that is
   * auto-released with the server — the replacement path never mints a
   * flexible IP it could leak. Root volume: explicit SBS template sized at
   * COMPOSE_ROOT_VOLUME_GB — BASIC3 admits no local SSD, and leaving the
   * size to the image default under-provisions the compose stack.
   *
   * @param {object} config
   * @param {string} config.name
   * @param {string} config.region - ZONE (fr-par-1 …)
   * @param {string} config.serverType - commercial type (BASIC3-X2C-4G)
   * @param {string} config.image - marketplace label ('ubuntu_noble')
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

    const projectId = process.env.SCALEWAY_DEFAULT_PROJECT_ID;
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
      dynamic_ip_required: true,
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
   * @param {string} serverId
   * @param {{waitUntilGone?: boolean}} [options]
   * @returns {Promise<void|boolean>}
   */
  async deleteServer(serverId, { waitUntilGone = false } = {}) {
    const zone = await this._findServerZone(serverId);
    if (!zone) return waitUntilGone ? false : undefined; // already gone

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
      const delRes = await fetchWithRetry(
        `${ScalewayProvider.API_BASE}/instance/v1/zones/${zone}/servers/${serverId}`,
        { method: 'DELETE', headers: { 'X-Auth-Token': this.apiToken } },
      );
      if (!delRes.ok && delRes.status !== 404) {
        const error = await delRes.json().catch(() => ({}));
        throw new Error(`Failed to delete server: ${error.message || 'Unknown error'}`);
      }
    }

    // 3. Wait for the record to disappear — the detached-SBS deletes below
    // are only valid once termination completes, in EITHER mode (see doc).
    await pollUntil(
      async () => {
        const probe = await fetch(
          `${ScalewayProvider.API_BASE}/instance/v1/zones/${zone}/servers/${serverId}`,
          { headers: { 'X-Auth-Token': this.apiToken } },
        );
        return probe.status === 404;
      },
      {
        budgetMs: 120_000,
        initialDelayMs: 2_000,
        backoffFactor: 1,
        description: `server ${serverId} termination`,
      },
    ).catch(() => {});

    // 4. Delete the detached SBS volumes (Block Storage API — a different
    // product than the Instance API's legacy volumes endpoint). Brief
    // retry: the detach can trail the server 404 by a few seconds.
    for (const volumeId of sbsVolumeIds) {
      await pollUntil(
        async () => {
          const res = await fetchWithRetry(
            `${ScalewayProvider.API_BASE}/block/v1/zones/${zone}/volumes/${volumeId}`,
            { method: 'DELETE', headers: { 'X-Auth-Token': this.apiToken } },
          );
          return res.ok || res.status === 404;
        },
        {
          budgetMs: 60_000,
          initialDelayMs: 2_000,
          backoffFactor: 1,
          description: `SBS volume ${volumeId} deletion`,
        },
      ).catch(() => {
        console.warn(
          `Warning: Scaleway SBS volume ${volumeId} (zone ${zone}) could not be deleted; it ` +
            'bills until removed. Delete it in the console or re-run destroy.',
        );
      });
    }

    // 5. Release surviving flexible IPs (dynamic IPs 404 here — released
    // with the server; flexible ones bill €0.005/hr until deleted).
    for (const ipId of publicIpIds) {
      const probe = await fetchWithRetry(
        `${ScalewayProvider.API_BASE}/instance/v1/zones/${zone}/ips/${ipId}`,
        { headers: { 'X-Auth-Token': this.apiToken } },
      );
      if (!probe.ok) continue; // 404 = auto-released dynamic IP
      const del = await fetchWithRetry(
        `${ScalewayProvider.API_BASE}/instance/v1/zones/${zone}/ips/${ipId}`,
        { method: 'DELETE', headers: { 'X-Auth-Token': this.apiToken } },
      );
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
   * Rename a server — PATCH of the `name` field.
   * @param {string} serverId
   * @param {string} name
   * @returns {Promise<void>}
   */
  async renameServer(serverId, name) {
    const zone = await this._findServerZone(serverId);
    if (!zone) throw new Error(`Failed to rename server: server ${serverId} not found in any zone`);
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
    const zone = await this._findServerZone(serverId);
    if (!zone) throw new Error(`Failed to get server: server ${serverId} not found in any zone`);
    const response = await this.apiRequest(`/instance/v1/zones/${zone}/servers/${serverId}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Failed to get server: ${error.message || 'Unknown error'}`);
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
  async waitForServer(serverId, timeout = 300000) {
    const startTime = Date.now();
    const pollInterval = 5000;

    while (Date.now() - startTime < timeout) {
      try {
        const server = await this.getServer(serverId);
        if (server.state === 'running' && ScalewayProvider.getPublicIP(server)) {
          return server;
        }
      } catch (error) {
        if (Date.now() - startTime >= timeout - pollInterval) {
          throw new Error(`Failed to check server status: ${error.message}`);
        }
      }

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error('Server creation timed out');
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
        const response = await fetchWithRetry(
          `${ScalewayProvider.API_BASE}/instance/v1/zones/${zone}/products/servers?per_page=100&page=${page}`,
          { headers: { 'X-Auth-Token': this.apiToken } },
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
    const projectId = process.env.SCALEWAY_DEFAULT_PROJECT_ID;
    const normalize = (key) => {
      const [type, body] = (key || '').trim().split(/\s+/);
      return `${type || ''} ${body || ''}`.trim();
    };
    const targetMaterial = normalize(publicKey);

    const { items: existingKeys } = await this._walkIamSshKeys(
      projectId ? `project_id=${projectId}` : '',
    );
    const match = existingKeys.find((k) => normalize(k.public_key) === targetMaterial);
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
   * List ALL servers across the REGIONS zones, optionally filtered by
   * labels — client-side tag matching via the SAME encodeLabel encoding
   * createServer tags with.
   * @param {object} [labels]
   * @returns {Promise<object[]>}
   */
  async listServers(labels = {}) {
    return (await this.listServersDetailed(labels)).items;
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

    const wantedTags = Object.entries(labels).map(([k, v]) => encodeLabel(k, v));
    const filtered =
      wantedTags.length === 0
        ? items
        : items.filter((s) => wantedTags.every((tag) => (s.tags || []).includes(tag)));

    return status === undefined
      ? { items: filtered, complete }
      : { items: filtered, complete, status };
  }

  /**
   * Find servers by exact name (Scaleway's server-side `name=` filter is
   * a contains-match, so exact matching happens client-side; soft-fail []
   * on non-ok).
   * @param {string} name
   * @returns {Promise<object[]>}
   */
  async findServersByName(name) {
    const { items, status } = await this._walkAllZones(
      `/servers?name=${encodeURIComponent(name)}`,
      'servers',
    );
    if (status !== undefined) return [];
    return items.filter((s) => s.name === name);
  }

  /**
   * Look up a security group by its exact name (server-side contains
   * filter + client-side exact match, per zone). The returned object is
   * AUGMENTED with `rules` (fetched here) and `zone` so the rule-rewrite
   * methods can operate on it — Scaleway keeps rules as a sub-resource.
   * @param {string} name
   * @returns {Promise<object|null>}
   */
  async findFirewallByName(name) {
    for (const zone of ScalewayProvider._zones()) {
      const walk = await this._walkZone(
        `/security_groups?name=${encodeURIComponent(name)}`,
        'security_groups',
        zone,
      );
      if (!walk.complete) return null;
      const group = walk.items.find((g) => g.name === name);
      if (!group) continue;
      const rulesWalk = await this._walkZone(`/security_groups/${group.id}/rules`, 'rules', zone);
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
      const res = await fetchWithRetry(
        `${ScalewayProvider.API_BASE}/instance/v1/zones/${zone}/security_groups/${firewallId}`,
        { headers: { 'X-Auth-Token': this.apiToken } },
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
    // Normalize: fresh rules carry no id (null ⇒ create), positions are
    // sequential, editable defaults true (non-editable rules are ignored
    // by the API — pinning it avoids a silently-dropped rule).
    const wireRules = rules.map((rule, i) => ({
      id: null,
      position: i + 1,
      editable: true,
      ...rule,
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
   * (rules attached). Idempotent: null when the peer's UDP/51821 rule is
   * already present.
   * @param {object} firewall - augmented group ({...group, zone, rules})
   * @param {string} peerIp
   * @returns {object[]|null}
   */
  buildReplicationFirewallRules(firewall, peerIp) {
    const existingRules = firewall.rules || [];
    const hasExactRule = existingRules.some(
      (r) =>
        r.protocol === 'UDP' &&
        r.direction === 'inbound' &&
        Number(r.dest_port_from) === WG_PORT &&
        r.ip_range === `${peerIp}/32`,
    );
    if (hasExactRule) return null;
    return [
      ...existingRules.map(({ id: _id, ...rest }) => rest),
      {
        action: 'accept',
        protocol: 'UDP',
        direction: 'inbound',
        ip_range: `${peerIp}/32`,
        dest_port_from: WG_PORT,
        dest_port_to: WG_PORT,
      },
    ];
  }

  /**
   * Rewrite the operator-locked ports' inbound rules to the given CIDR
   * list, leaving every other rule unchanged. Scaleway rules carry ONE
   * ip_range each, so each locked port gets one rule PER CIDR (the same
   * expansion the compose program applies at create time); the whole set
   * lands in one atomic PUT (closest in shape to Hetzner's
   * read-filter-rebuild — audit's firewall verdict). CIDR-count ceiling to
   * respect: 500 Security Rules per Organization.
   * @param {{firewallName: string, cidrs: string[]}} args
   * @returns {Promise<boolean>} true if found and updated
   */
  async applyOperatorCidrs({ firewallName, cidrs }) {
    const fw = await this.findFirewallByName(firewallName);
    if (!fw) return false;

    const isLocked = (r) =>
      r.direction === 'inbound' &&
      r.protocol === 'TCP' &&
      OPERATOR_LOCKED_PORTS.has(Number(r.dest_port_from));
    const kept = (fw.rules || []).filter((r) => !isLocked(r)).map(({ id: _id, ...rest }) => rest);
    const lockedPorts = [
      ...new Set((fw.rules || []).filter(isLocked).map((r) => Number(r.dest_port_from))),
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
      const res = await fetchWithRetry(
        `${ScalewayProvider.API_BASE}/instance/v1/zones/${fw.zone}/security_groups/${fw.id}`,
        { method: 'DELETE', headers: { 'X-Auth-Token': this.apiToken } },
      );
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
    const projectId = process.env.SCALEWAY_DEFAULT_PROJECT_ID;
    const res = await fetchWithRetry(
      `${ScalewayProvider.API_BASE}/iam/v1alpha1/ssh-keys?page_size=100&name=${encodeURIComponent(name)}${
        projectId ? `&project_id=${projectId}` : ''
      }`,
      { headers: { 'X-Auth-Token': this.apiToken } },
    );
    if (!res.ok) return false;
    const { ssh_keys } = await res.json().catch(() => ({ ssh_keys: [] }));
    const match = (ssh_keys || []).find((k) => k.name === name);
    if (!match) return false;

    const del = await fetchWithRetry(
      `${ScalewayProvider.API_BASE}/iam/v1alpha1/ssh-keys/${match.id}`,
      { method: 'DELETE', headers: { 'X-Auth-Token': this.apiToken } },
    );
    return del.ok || del.status === 404;
  }

  /**
   * List ALL Private Networks (soft-fail []) — never provisioned by the
   * compose tier, enumerated so a future tier's leak can't hide behind a
   * stub. Region-scoped API (VPC), walked over the REGIONS zones' distinct
   * regions.
   * @returns {Promise<object[]>}
   */
  async listNetworks() {
    const regions = [...new Set(ScalewayProvider._zones().map((z) => z.replace(/-\d+$/, '')))];
    const items = [];
    for (const region of regions) {
      for (let page = 1; page <= 20; page++) {
        const res = await fetchWithRetry(
          `${ScalewayProvider.API_BASE}/vpc/v2/regions/${region}/private-networks?page_size=100&page=${page}`,
          { headers: { 'X-Auth-Token': this.apiToken } },
        );
        if (!res.ok) return [];
        const data = await res.json().catch(() => ({}));
        const pageItems = data.private_networks || [];
        items.push(...pageItems);
        if (pageItems.length < 100) break;
      }
    }
    return items;
  }

  /**
   * List ALL volumes (soft-fail contract matching listServers) — BOTH
   * volume products, see listVolumesDetailed.
   * @returns {Promise<object[]>}
   */
  async listVolumes() {
    return (await this.listVolumesDetailed()).items;
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
      for (let page = 1; page <= 20; page++) {
        const res = await fetchWithRetry(
          `${ScalewayProvider.API_BASE}/block/v1/zones/${zone}/volumes?page_size=100&page=${page}`,
          { headers: { 'X-Auth-Token': this.apiToken } },
        );
        if (!res.ok) {
          complete = false;
          status ??= res.status;
          break;
        }
        const data = await res.json().catch(() => ({}));
        const pageItems = data.volumes || [];
        items.push(...pageItems.map((v) => ({ zone, ...v })));
        if (pageItems.length < 100) break;
        if (page === 20) complete = false;
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
        const res = await fetchWithRetry(
          `${ScalewayProvider.API_BASE}${base}/${zone}/volumes/${volumeId}`,
          { method: 'DELETE', headers: { 'X-Auth-Token': this.apiToken } },
        );
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
      for (let page = 1; page <= 20; page++) {
        const res = await fetchWithRetry(
          `${ScalewayProvider.API_BASE}/lb/v1/zones/${zone}/lbs?page_size=100&page=${page}`,
          { headers: { 'X-Auth-Token': this.apiToken } },
        );
        if (!res.ok) return [];
        const data = await res.json().catch(() => ({}));
        const pageItems = data.lbs || [];
        items.push(...pageItems.map((lb) => ({ zone, ...lb })));
        if (pageItems.length < 100) break;
      }
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
      const res = await fetchWithRetry(
        `${ScalewayProvider.API_BASE}/lb/v1/zones/${zone}/lbs/${lbId}?release_ip=true`,
        { method: 'DELETE', headers: { 'X-Auth-Token': this.apiToken } },
      );
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
      const res = await fetchWithRetry(
        `${ScalewayProvider.API_BASE}/instance/v1/zones/${z}/ips/${ipId}`,
        { method: 'DELETE', headers: { 'X-Auth-Token': this.apiToken } },
      );
      if (res.ok) return true;
      if (res.status !== 404) sawFailure = true;
    }
    return !sawFailure;
  }

  // ── Destroy-sweep field accessors ───────────────────────────────────────

  /**
   * Compose-tier Scaleway instances join no Private Network — always []
   * (private NICs are a separate sub-resource our tiers never create).
   * @param {object} _server
   * @returns {string[]}
   */
  serverNetworkIds(_server) {
    return [];
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
