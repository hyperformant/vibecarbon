/**
 * Linode (Akamai) Cloud Provider
 *
 * Compose + compose-ha provider (PR 1 of the 2026-08 provider expansion +
 * tier-parity wave 1 — see
 * the linode-provider-step0-audit plan for the sourced
 * capability audit). The k8s user-data / program statics throw
 * provider-specific errors (Linode's k8s tier is unbuilt, not forgotten —
 * 4-mode headroom is recorded in the audit).
 *
 * API Documentation: https://techdocs.akamai.com/linode-api/reference/
 * Rate limits (audit 2026-08-07): paginated GETs 200/min, other ops
 * 1600/min, instance create 20 per 15s — the guarded page walks below all
 * fit; fetch-retry's 429 backoff covers the rest.
 */

import { fetchWithRetry } from '../fetch-retry.js';
import { pollUntil } from '../retry.js';
import { cheapestStandbyRegion, regionRoleDefaults, standbyStandIn } from '../sizing.js';
import { BaseProvider, deleteFailure, deleteRefused, replaceWireguardPeerRules } from './base.js';

// Ports whose inbound rules applyOperatorCidrs rewrites — same set as
// HetznerProvider/DigitalOceanProvider (SSH, k8s API for future parity).
const SSH_PORT = '22';
const K8S_API_PORT = '6443';
const OPERATOR_LOCKED_PORTS = new Set([SSH_PORT, K8S_API_PORT]);
// Inbound DB ports a retired external pooler once opened to the operator
// CIDRs; applyOperatorCidrs deletes any such rule (the database has no
// public port).
const RETIRED_DB_PORTS = new Set(['5432', '6543']);

// The single replication port for the WireGuard tunnel (wireguard.js,
// WG_PORT=51821). buildReplicationFirewallRules opens it to the peer site's
// server for compose-ha (compose/ha.js) and to the peer cluster's db for
// k8s-ha (deploy/effects/k8s-ha.js); the rule shape is pinned by unit tests.
const WG_PORT = '51821';

/**
 * Linode caps every tag at 3-50 characters (live 2026-11-07: POST /v4/tags
 * with a 55-character label returned 400 "Length must be 3-50 characters").
 * @type {number}
 */
const TAG_MAX = 50;

/**
 * Encode a label key/value pair into a Linode tag string. Same `key:value`
 * wire encoding as DigitalOcean's encodeLabel for tags of 50 characters or
 * fewer, so the destroy-sweep and listing matchers behave alike on the two
 * tag-based providers. Characters outside [A-Za-z0-9:_-] become `-` (Linode
 * allows more, but DO's charset keeps the encoding round-trippable on both).
 *
 * A tag of 50 or fewer characters is returned as is. A longer one becomes
 * exactly 50: the `key:` head, a prefix of the value, `-`, and an 8-hex
 * FNV-1a hash of the full value, the shape squeezeLinodeLabel uses. It is
 * deterministic, so every writer (the IaC programs, createServer, the CSI
 * StorageClass volumeTags) and every selector (listServers, the reserved IP
 * matchers) derive the same tag from the same name. A squeezed tag decodes to
 * the squeezed value, never the raw name, so an ownership check compares the
 * decoded label against provider.labelValue(key, raw).
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
export function encodeLabel(key, value) {
  const tag = `${key}:${value}`.replace(/[^A-Za-z0-9:_-]/g, '-');
  if (tag.length <= TAG_MAX) return tag;
  const head = tag.slice(0, tag.indexOf(':') + 1);
  const room = TAG_MAX - head.length - 9;
  return `${head}${tag.slice(head.length, head.length + room)}-${fnv1a32hex(String(value))}`;
}

/**
 * Encode a labels object into an array of Linode tag strings.
 * @param {Object<string,string>} [labels]
 * @returns {string[]}
 */
export function encodeLabels(labels = {}) {
  return Object.entries(labels).map(([k, v]) => encodeLabel(k, v));
}

/**
 * See DigitalOcean's KNOWN_MANGLED_LABEL_KEYS — same single known collision
 * (`cluster-autoscaler/node` → `cluster-autoscaler-node` on the wire), same
 * unambiguity argument within this codebase's fixed tag-key set.
 * @type {Object<string,string>}
 */
const KNOWN_MANGLED_LABEL_KEYS = { 'cluster-autoscaler-node': 'cluster-autoscaler/node' };

/**
 * Decode a Linode tag array back into a flat label map — inverse of
 * encodeLabels for this codebase's known key set. Splits on the FIRST `:`;
 * tags without `:` (e.g. hand-added console tags) are skipped, not guessed.
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

/**
 * Linode caps FIREWALL labels at 32 chars (3-32; instance labels allow 64
 * and profile SSH-key labels accepted 43 chars in live use — the firewall
 * cap is the only one our naming templates can exceed; live l1 failure
 * 2026-08-08: `${project}-${env}-firewall` = 48 chars → Pulumi-provider
 * validation error pre-create).
 * @type {number}
 */
const FIREWALL_LABEL_MAX = 32;

/**
 * FNV-1a 32-bit hash, hex-encoded to 8 chars — tiny, dependency-free, and
 * stable across processes (used only for label disambiguation, never
 * security).
 * @param {string} input
 * @returns {string}
 */
function fnv1a32hex(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Deterministically squeeze a logical resource name into Linode's firewall
 * label cap: identity when it already fits, otherwise a truncated stem plus
 * an 8-hex FNV-1a hash of the FULL name (so near-identical long names —
 * e2e's timestamped project names — stay distinct). Every consumer derives
 * the wire label through this ONE helper: the Pulumi program's Firewall
 * label and findFirewallByName (which deleteFirewallByName,
 * applyOperatorCidrs, and the destroy path all route through) — the
 * match-Pulumi-names doctrine, one function instead of discipline. Sweep
 * ownership of squeezed labels falls back to the firewall's `project:` tag
 * (sweep-linode.ts), since a truncated stem is no longer a full
 * projectName prefix.
 * @param {string} name - Logical label (e.g. `${project}-${env}-firewall`)
 * @param {number} [max]
 * @returns {string}
 */
export function squeezeLinodeLabel(name, max = FIREWALL_LABEL_MAX) {
  if (name.length <= max) return name;
  return `${name.slice(0, max - 9)}-${fnv1a32hex(name)}`;
}

/**
 * Linode's INSTANCE label cap — a DIFFERENT limit from the firewall's 32, and
 * the reason this needs its own helper rather than the bare default.
 *
 * Live evidence (CI l2 leg, 2026-08-20): the instance label went to the wire
 * unsqueezed and Linode rejected the create outright —
 *
 *   expected length of label to be in the range (3 - 50), got
 *   citest-compose-ha-1787258789210-0typg2-cil2-primary        (51 chars)
 *
 * Only compose-HA trips it: the `-primary`/`-standby` role suffix is what
 * pushes past 50, and CI's longer `citest-`/`cil2` names cross the line where
 * a laptop's `testapp-`/`l2` names land on exactly 50 and squeak under. That
 * is why local runs were green and this only surfaced in CI.
 */
const INSTANCE_LABEL_MAX = 50;

/**
 * The instance-label twin of squeezeLinodeLabel, same doctrine: the Pulumi
 * program's `linode.Instance` label AND findServersByName (which the destroy
 * path routes through) derive the wire label from this ONE function, so a
 * squeezed server can still be found and deleted. Squeezing only the create
 * side would swap a loud deploy failure for silently orphaned, billing
 * instances — strictly worse.
 * @param {string} name
 * @returns {string}
 */
export function squeezeLinodeInstanceLabel(name) {
  return squeezeLinodeLabel(name, INSTANCE_LABEL_MAX);
}

/**
 * Split a CIDR list into Linode's `{ipv4, ipv6}` addresses shape — Linode
 * firewall rules keep the two stacks in separate arrays (unlike DO's single
 * `sources.addresses` list). Either key is omitted when its list is empty:
 * Linode's API rejects `ipv4: []` on a rule with a 400.
 *
 * This is the REST WIRE shape (`rules.inbound[].addresses.{ipv4,ipv6}`),
 * consumed by applyOperatorCidrs/buildReplicationFirewallRules. The Pulumi
 * provider's rule properties are the PLURAL `ipv4s`/`ipv6s` — do NOT
 * spread this object into a `linode.Firewall` inbound rule; adapt the key
 * names first (see linode-compose.js's operatorAddresses, and the live
 * 2026-08-08 400 that pinned this).
 * @param {string[]} cidrs
 * @returns {{ipv4?: string[], ipv6?: string[]}}
 */
export function splitCidrsByFamily(cidrs) {
  const ipv4 = cidrs.filter((c) => !c.includes(':'));
  const ipv6 = cidrs.filter((c) => c.includes(':'));
  const out = {};
  if (ipv4.length > 0) out.ipv4 = ipv4;
  if (ipv6.length > 0) out.ipv6 = ipv6;
  return out;
}

/**
 * The pure rule rewrite behind LinodeProvider.applyOperatorCidrs: drop any
 * inbound TCP/5432 or TCP/6543 rule (RETIRED_DB_PORTS), point the
 * operator-locked ports (SSH 22, k8s API 6443) at `cidrs`, and leave every
 * other rule as it is. Takes and returns the API rule shape
 * (`addresses: {ipv4, ipv6}`).
 * @param {object[]} rules - a firewall's inbound rules, API shape
 * @param {string[]} cidrs
 * @returns {object[]}
 */
export function rewriteOperatorRules(rules, cidrs) {
  const addresses = splitCidrsByFamily(cidrs);
  return rules
    .filter((rule) => !(rule.protocol === 'TCP' && RETIRED_DB_PORTS.has(String(rule.ports))))
    .map((rule) => {
      if (rule.protocol === 'TCP' && OPERATOR_LOCKED_PORTS.has(rule.ports)) {
        return { ...rule, addresses };
      }
      return rule;
    });
}

export class LinodeProvider extends BaseProvider {
  /**
   * Documented object-storage operational limits (techdocs.akamai.com,
   * verified 2026-08-15). Akamai documents "strong read-after-write
   * consistency for PUT and DELETE operations on objects" and publishes no
   * request-rate ceilings on the product page.
   */
  static OBJECT_STORAGE_LIMITS = {
    requestsPerSecondPerBucket: null,
    requestsPerSecondPerSourceIp: null,
    parallelConnectionsPerSourceIp: null,
    consistency: 'strong-documented',
    evidenceUrl: 'https://techdocs.akamai.com/cloud-computing/docs/object-storage',
    verifiedOn: '2026-08-15',
  };

  static NAME = 'Linode';
  static API_BASE = 'https://api.linode.com/v4';
  // Ours (env-first token env var) — see resolveProviderToken (index.js).
  // Deliberately matches the secret name Linode's own CSI/CCM manifests
  // expect (linode-step0-audit.md), for operator ergonomics at the k8s tier.
  static TOKEN_ENV = 'LINODE_API_TOKEN';
  // Read by @pulumi/linode (verified 2026-08-07 on the Pulumi Registry
  // installation-configuration page) — never derive/rename.
  static CLI_TOKEN_ENV = 'LINODE_TOKEN';
  // The pair getS3Credentials (linode-guided-setup.js) reads before
  // prompting. Linode Object Storage keys are separate credentials minted
  // via POST /object-storage/keys (secret shown once).
  static OBJECT_STORAGE_ENV = ['LINODE_ACCESS_KEY', 'LINODE_SECRET_KEY'];
  // The providerID on Linode k8s nodes (`linode://<id>`). There is no Linode
  // CCM: the k3s boot scripts pre-seed it with the kubelet's `provider-id`
  // flag, and the autoscaler strips the prefix to find the instance.
  static PROVIDER_ID_PREFIX = 'linode://';
  static DEFAULT_REGION = 'us-iad';
  static PRICING_URL = 'https://www.linode.com/pricing/';

  // Env var override name for the Object Storage (S3-compatible) client's
  // region — takes the ENDPOINT-slug form (e.g. `us-iad-1`), see
  // linode-objectstorage.js's REGIONS doc.
  static S3_REGION_ENV = 'LINODE_STORAGE_REGION';

  // All four tiers. The slate was chosen for 4-mode headroom — CCM/CSI/
  // DNS-flip feasibility is recorded in linode-step0-audit.md. The k8s tiers
  // need a VPC, which two regions lack (K8S_UNSUPPORTED_REGIONS).
  static SUPPORTED_TIERS = ['compose', 'compose-ha', 'k8s', 'k8s-ha'];

  /**
   * Regions with no VPC, which the k8s tiers need for node-to-node traffic.
   * k8s and k8s-ha refuse them (k8sRegionProblem) and the region lists omit
   * them; compose tiers use them freely.
   * @type {string[]}
   */
  static K8S_UNSUPPORTED_REGIONS = ['us-east', 'us-southeast'];

  /**
   * @param {string} region
   * @returns {string|null}
   */
  static k8sRegionProblem(region) {
    if (!LinodeProvider.K8S_UNSUPPORTED_REGIONS.includes(region)) return null;
    const city = LinodeProvider.REGIONS[region]?.split(',')[0] ?? region;
    return (
      `Kubernetes on Linode does not run in ${city} (${region}): Linode has no VPC there ` +
      "for the cluster's private network. Use us-iad, us-ord or another region."
    );
  }

  /** Pulumi destroy leaves the k8s reserved IP, VPC, firewall and key; destroy sweeps them by name. */
  static K8S_DESTROY_BACKSTOP = true;

  // Instance regions with Object Storage (same doctrine as
  // DigitalOceanProvider.REGIONS). All 16 verified 2026-08-07 via GET
  // /v4/regions capabilities — every one also carries the Metadata capability
  // cloud-init user-data requires. Seven hold only E3 storage, which cannot
  // take browser uploads: their files go to the nearest region with E0 or E1,
  // and the deploy says so (linode-objectstorage.js COMPUTE_TO_S3).
  // Labels are the API's own `label` field values.
  static REGIONS = {
    'us-iad': 'Washington, DC',
    'us-iad-2': 'Washington 2, DC',
    'us-ord': 'Chicago, IL',
    'us-sea': 'Seattle, WA',
    'us-lax': 'Los Angeles, CA',
    'us-mia': 'Miami, FL',
    'us-east': 'Newark, NJ',
    'us-southeast': 'Atlanta, GA',
    'fr-par': 'Paris, FR',
    'gb-lon': 'London 2, UK',
    'de-fra-2': 'Frankfurt 2, DE',
    'in-maa': 'Chennai, IN',
    'sg-sin-2': 'Singapore 2, SG',
    'jp-tyo-3': 'Tokyo 3, JP',
    'id-cgk': 'Jakarta, ID',
    'br-gru': 'Sao Paulo, BR',
  };

  // Continent grouping for standby selection — same purpose as the Hetzner/
  // DO REGION_CONTINENT maps (getDefaultStandbyRegion below).
  static REGION_CONTINENT = {
    'us-iad': 'na',
    'us-iad-2': 'na',
    'us-ord': 'na',
    'us-sea': 'na',
    'us-lax': 'na',
    'us-mia': 'na',
    'us-east': 'na',
    'us-southeast': 'na',
    'fr-par': 'eu',
    'gb-lon': 'eu',
    'de-fra-2': 'eu',
    'in-maa': 'ap',
    'sg-sin-2': 'ap',
    'jp-tyo-3': 'ap',
    'id-cgk': 'ap',
    'br-gru': 'sa',
  };

  static HA_REGIONS = ['us-iad', 'us-ord'];

  // Offline fallback catalog — shared-CPU Standard line, specs live-verified
  // 2026-08-07 via GET /v4/linode/types/{id} (memory/disk are MB on the
  // wire; stored here as GB, matching the other providers' shape). Prices
  // deliberately not hard-coded (PRICING_URL); note id-cgk/br-gru carry
  // region-price uplifts (audit doc).
  static FALLBACK_SERVER_TYPES = {
    'g6-standard-1': { vcpu: 1, ram: 2, disk: 50 },
    'g6-standard-2': { vcpu: 2, ram: 4, disk: 80 },
    'g6-standard-4': { vcpu: 4, ram: 8, disk: 160 },
  };

  // Live catalog populated by fetchServerTypes(); object map (name -> spec),
  // same contract note as DigitalOceanProvider.SERVER_TYPES.
  static SERVER_TYPES = { ...LinodeProvider.FALLBACK_SERVER_TYPES };

  // Per-region availability populated by fetchServerTypes(). Linode's type
  // catalog is global (GET /linode/types carries no region axis), so this
  // maps every REGIONS key to the same full slug set — kept in the shared
  // `_locationTypes` shape so getServerTypesForRegion /
  // resolveServerTypeForRegion stay structurally identical to DO's, and so
  // the "already fetched" short-circuit works the same way.
  static _locationTypes = null;

  // Monthly prices captured by fetchServerTypes() from the same payload
  // (USD): type → region → price, `price.monthly` for every REGIONS key,
  // overridden by the type's `region_prices` (id-cgk, br-gru). Dedicated
  // plans carry null. null until a live fetch.
  static _prices = null;

  // Compose candidates (see BaseProvider.ROLE_CANDIDATES).
  static ROLE_CANDIDATES = {
    compose: ['g6-standard-2'],
    master: ['g6-standard-2', 'g6-standard-4'],
    db: ['g6-standard-1', 'g6-standard-2'],
    worker: ['g6-standard-2', 'g6-standard-4'],
  };

  // Every Linode's public IPv4 is included in its plan price
  // (linode.com/pricing, read 2026-10-22).
  static IPV4_MONTHLY = 0;

  // Prices are in USD.
  static CURRENCY = '$';

  static DEFAULT_TYPE = 'g6-standard-2';

  // ── Engine-literal statics ──────────────────────────────────────────────
  static DEFAULT_COMPOSE_TYPE = 'g6-standard-2';
  // Pinned to the compose default for EXPECTED-table completeness.
  static DEFAULT_K8S_NODE_TYPE = 'g6-standard-2';

  // `linode/ubuntu26.04` ships no Docker (Linode's Marketplace Docker is a
  // StackScript, not an image — audit doc), so cloud-init installs docker-ce
  // inside the boot script, same as DigitalOcean: 3-5 min realistic budget.
  static CLOUD_INIT_READY_TIMEOUT_MS = 600_000;

  /**
   * Kubernetes cluster-addon asset identity. The CSI names come from
   * linode-blockstorage-csi-driver v1.1.5: a StatefulSet controller and a
   * DaemonSet node plugin, both labelled with a bare `app=` key. CCM entries
   * stay empty until Linode's CCM is wired.
   * @type {{
   *   csiNodeDaemonSet: string,
   *   csiControllerSelector: string,
   *   ccmDeployment: string,
   *   ccmSelector: string,
   *   networkEnvVar: string,
   * }}
   */
  static K8S_ASSETS = {
    csiNodeDaemonSet: 'daemonset/csi-linode-node',
    csiControllerSelector: 'app=csi-linode-controller',
    ccmDeployment: '',
    ccmSelector: '',
    networkEnvVar: '',
  };

  /**
   * The Delete-reclaim StorageClass the k3s master boot script creates for
   * linode-blockstorage-csi-driver (the driver itself ships
   * `linode-block-storage-retain`, its default, and `linode-block-storage`;
   * the Delete-policy class matches hcloud-volumes/do-block-storage
   * semantics). The literal-guard census requires every registered
   * provider's value to be distinct and to live in this file.
   * @type {string}
   */
  static K8S_STORAGE_CLASS = 'linode-block-storage-vibecarbon';

  /**
   * The VPC subnet the k8s Pulumi program (iac/programs/linode-k8s.js)
   * creates for the cluster's nodes.
   * @type {string}
   */
  static DEFAULT_VPC_CIDR = '10.0.1.0/24';

  /**
   * The image every k8s node boots (byte-matched by the k8s program's image
   * literal). Ubuntu 26.04: Linode ships it, and k3s needs no Docker.
   * @type {string}
   */
  static K8S_IMAGE = 'linode/ubuntu26.04';

  // ── k8s boot user-data (carbon/cloud-init/k3s/linode-*-init.sh) ─────────

  /**
   * Render the k3s master boot script. The Linode API token is the CSI
   * driver's credential; project_tag is the project tag on every volume the
   * CSI driver creates, `encodeLabel('project', projectName)`.
   * @param {{
   *   k3s_version: string,
   *   k3s_token: string,
   *   linode_token: string,
   *   project_tag: string,
   * }} vars - The template's complete var set.
   * @returns {Promise<string>}
   */
  static async getK8sMasterUserData(vars) {
    const { loadCloudInit, renderScript } = await import('../iac/cloud-init.js');
    return renderScript(loadCloudInit('linode-master-init.sh'), vars);
  }

  /**
   * Render the k3s worker boot script.
   * @param {{
   *   k3s_version: string,
   *   k3s_token: string,
   *   master_ip: string,
   * }} vars - master_ip is the master's private (VPC) IP.
   * @returns {Promise<string>}
   */
  static async getK8sWorkerUserData(vars) {
    const { loadCloudInit, renderScript } = await import('../iac/cloud-init.js');
    return renderScript(loadCloudInit('linode-worker-init.sh'), vars);
  }

  /**
   * Render the k3s database-node boot script: the worker script plus the
   * dedicated=db label and taint, applied at join time.
   * @param {{
   *   k3s_version: string,
   *   k3s_token: string,
   *   master_ip: string,
   * }} vars - Same set as getK8sWorkerUserData.
   * @returns {Promise<string>}
   */
  static async getK8sDbUserData(vars) {
    const { loadCloudInit, renderScript } = await import('../iac/cloud-init.js');
    return renderScript(loadCloudInit('linode-db-init.sh'), vars);
  }

  /**
   * @param {object} config - see linode-k8s.js's K8sStackConfig
   * @returns {Promise<() => Promise<Record<string, unknown>>>}
   */
  static async getK8sProgram(config) {
    const { buildLinodeK8sProgram } = await import('../iac/programs/linode-k8s.js');
    return buildLinodeK8sProgram(config);
  }

  // ── Compose-tier replacement-server identity ────────────────────────────

  /**
   * Matches linode-compose.js's buildLinodeComposeProgram
   * `image: 'linode/ubuntu26.04'` literal exactly (the scale/replacement
   * path bypasses Pulumi and must create byte-identical servers).
   * @type {string}
   */
  static COMPOSE_IMAGE = 'linode/ubuntu26.04';

  /**
   * Returns the SAME rendered user-data linode-compose.js's Pulumi program
   * uses — delegates to that module's `loadLinodeComposeUserData` (dynamic
   * import), the single source of truth for the file read + Docker-install
   * splice. Returned RAW (not base64): base64 is a wire-encoding concern,
   * applied at the two wire boundaries (createServer below, and the Pulumi
   * program's `metadatas[].userData` input).
   * @returns {Promise<string>}
   */
  static async getComposeUserData() {
    const { loadLinodeComposeUserData } = await import('../iac/programs/linode-compose.js');
    return loadLinodeComposeUserData();
  }

  /**
   * Fetch the Linode type catalog. Populates SERVER_TYPES with live data.
   * Mirrors the other providers' fallback contract: never throws, returns
   * false (leaving SERVER_TYPES as the fallback) on any failure.
   * GET /linode/types is Linode-paginated (`{data, page, pages}`) — walked
   * with the same ≤20-page guard as every listing below; an incomplete walk
   * returns false so a truncated catalog can never pose as live truth.
   * @param {string} apiToken - Linode API token (the endpoint is public,
   *   but the token is sent when present for parity/rate-limit accounting)
   * @returns {Promise<boolean>} true if live data was loaded
   */
  static async fetchServerTypes(apiToken) {
    if (LinodeProvider._locationTypes) return true; // already fetched

    try {
      const types = [];
      let page = 1;
      let complete = false;
      for (let guard = 0; guard < 20; guard++) {
        const response = await fetchWithRetry(
          `${LinodeProvider.API_BASE}/linode/types?page=${page}&page_size=200`,
          apiToken ? { headers: { Authorization: `Bearer ${apiToken}` } } : {},
        );
        if (!response.ok) return false;
        const data = await response.json();
        types.push(...(data.data || []));
        if (!data.pages || page >= data.pages) {
          complete = true;
          break;
        }
        page++;
      }
      if (!complete) return false;
      // Empty-catalog guard — same reasoning as the DO twin: Linode's type
      // catalog is never legitimately empty, so empty means failure and the
      // populated fallback must survive.
      if (types.length === 0) return false;

      const catalog = LinodeProvider.parseCatalog(types);
      if (Object.keys(catalog.SERVER_TYPES).length === 0) return false;

      Object.assign(LinodeProvider, catalog);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The catalog statics fetchServerTypes sets, from the `/linode/types`
   * entries it walked. Pure, so the unit fixtures load through the same
   * filter as the live path (tests/unit/helpers/catalog-fixtures.ts).
   *
   * GPU/accelerated lines are excluded: irrelevant to this workload shape,
   * and their per-region scarcity would need an availability axis
   * GET /linode/types doesn't carry. The catalog is global, so every REGIONS
   * key maps to the same full slug set (see _locationTypes' doc for why the
   * shared shape is kept).
   * @param {object[]} types
   * @returns {{SERVER_TYPES: object, _locationTypes: Record<string, Set<string>>, _prices: Record<string, Record<string, number|null>>}}
   */
  static parseCatalog(types) {
    const catalog = {};
    const prices = {};
    const regions = Object.keys(LinodeProvider.REGIONS);
    for (const t of types) {
      if (t.class === 'gpu' || t.class === 'accelerated') continue;
      catalog[t.id] = {
        vcpu: t.vcpus,
        ram: t.memory / 1024,
        disk: t.disk / 1024,
      };
      const overrides = Object.fromEntries((t.region_prices || []).map((r) => [r.id, r.monthly]));
      prices[t.id] = Object.fromEntries(
        regions.map((region) => {
          const monthly = region in overrides ? overrides[region] : t.price?.monthly;
          return [region, typeof monthly === 'number' ? monthly : null];
        }),
      );
    }

    const allSlugs = new Set(Object.keys(catalog));
    const locationTypes = {};
    for (const region of regions) locationTypes[region] = allSlugs;

    return { SERVER_TYPES: catalog, _locationTypes: locationTypes, _prices: prices };
  }

  /**
   * Returns server types available in the given region — the full catalog
   * (Linode types are global), live when fetched, fallback otherwise.
   * `architecture: 'x86'` is constant: Linode sells no ARM instances
   * (audit 2026-08-07), matching DigitalOcean's constant-field precedent.
   * @param {string} region - Region slug
   * @returns {Array<{name: string, vcpu: number, ram: number, disk: number, architecture: string}>}
   */
  static getServerTypesForRegion(region) {
    const available = LinodeProvider._locationTypes?.[region];

    if (available) {
      return [...available]
        .filter((name) => name in LinodeProvider.SERVER_TYPES)
        .map((name) => ({
          name,
          ...LinodeProvider.SERVER_TYPES[name],
          architecture: 'x86',
        }))
        .sort((a, b) => a.vcpu - b.vcpu || a.ram - b.ram);
    }

    return Object.entries(LinodeProvider.FALLBACK_SERVER_TYPES).map(([name, info]) => ({
      name,
      ...info,
      architecture: 'x86',
    }));
  }

  /**
   * Default type per role in `region` (compose-only: all four are the
   * compose pick) — the cheapest orderable ROLE_CANDIDATES entry that meets
   * the RAM floor (src/lib/sizing.js).
   * @param {string} region
   * @returns {{composeType: string|null, masterType: string|null, dbType: string|null, workerType: string|null}}
   */
  static getRegionDefaults(region) {
    return regionRoleDefaults(LinodeProvider, region);
  }

  /**
   * Default HA standby region for a given primary: the cheapest
   * same-continent partner where every standby role is orderable right now
   * (src/lib/sizing.js cheapestStandbyRegion), ties and offline keeping
   * conventionalStandbyRegion's pair. The pre-selected value in the
   * interactive standby prompt and the headless default.
   * @param {string} primaryRegion
   * @param {string[]} [roles] - the roles the standby places
   * @param {Record<string, string|undefined>} [primaryTypes] - the primary's
   *   type by role: a partner must fit each without shrinking it
   * @returns {string}
   */
  static getDefaultStandbyRegion(primaryRegion, roles = ['compose'], primaryTypes = {}) {
    return cheapestStandbyRegion(
      LinodeProvider,
      primaryRegion,
      roles,
      LinodeProvider.conventionalStandbyRegion(primaryRegion),
      primaryTypes,
    );
  }

  /**
   * The static HA standby pair: a DIFFERENT region on the same continent
   * (conventional pairs first), mirroring the DO/Hetzner contract. Only
   * reachable once compose-ha is declared, but contract-tested for every
   * region regardless.
   * @param {string} primaryRegion
   * @returns {string} the static pair, before prices
   */
  static conventionalStandbyRegion(primaryRegion) {
    const PAIRS = {
      'us-iad': 'us-ord',
      'us-ord': 'us-iad',
      'us-east': 'us-southeast',
      'us-southeast': 'us-east',
      'us-sea': 'us-lax',
      'us-lax': 'us-sea',
      'fr-par': 'de-fra-2',
      'de-fra-2': 'fr-par',
      'sg-sin-2': 'jp-tyo-3',
      'jp-tyo-3': 'sg-sin-2',
    };
    if (PAIRS[primaryRegion]) return PAIRS[primaryRegion];

    const continent = LinodeProvider.REGION_CONTINENT[primaryRegion];
    const sameContinent = Object.keys(LinodeProvider.REGION_CONTINENT).filter(
      (r) => r !== primaryRegion && LinodeProvider.REGION_CONTINENT[r] === continent,
    );
    if (sameContinent.length > 0) return sameContinent[0];

    // Single-region continent (br-gru is alone in `sa`) → nearest-hub
    // fallback, never the primary.
    return primaryRegion === 'us-iad' ? 'us-ord' : 'us-iad';
  }

  /**
   * Equivalent server type in a target region. Linode's global catalog
   * means the requested type is available everywhere the live data says it
   * exists; the role-pick fallback mirrors DO's shape for the (unlikely)
   * case a future per-region axis appears in the live data.
   * @param {string} serverType
   * @param {string} targetRegion
   * @param {string} [role] - the role the node plays (compose, master, db,
   *   worker): a type not stocked there is re-picked for that role
   *   (src/lib/sizing.js standbyStandIn), never smaller than `serverType`
   * @returns {string|null} null when nothing fits, for the caller to refuse
   */
  static resolveServerTypeForRegion(serverType, targetRegion, role) {
    // A live catalog that does not list the location stocks nothing there:
    // the stand-in below then answers null, as cheapestRoleSet does.
    const live = LinodeProvider._locationTypes;
    const available = live ? (live[targetRegion] ?? new Set()) : undefined;

    if (available) {
      if (available.has(serverType)) return serverType;
      return standbyStandIn(LinodeProvider, serverType, targetRegion, role);
    }

    return serverType;
  }

  /**
   * Public IPv4 of an instance. Linode's instance shape carries a flat
   * `ipv4: string[]` whose first entry is the public address (private
   * addresses, when enabled, follow it).
   * @param {object} server - Linode API instance object
   * @returns {string|null}
   */
  static getPublicIP(server) {
    return server?.ipv4?.[0] ?? null;
  }

  /**
   * Public IPv6 of an instance. Linode reports a single SLAAC address in
   * CIDR form (`2600:...::/128`) — returned bare, matching the other
   * providers' address-only contract.
   * @param {object} server - Linode API instance object
   * @returns {string|null}
   */
  static getPublicIPv6(server) {
    const raw = server?.ipv6;
    if (!raw || typeof raw !== 'string') return null;
    return raw.split('/')[0] || null;
  }

  // ── Instance methods ────────────────────────────────────────────────────
  // Transport split mirrors hetzner.js/digitalocean.js method-for-method:
  // original CRUD surface through `this.apiRequest`; list/firewall/teardown
  // methods through direct `fetchWithRetry`; getServerSummary a single raw
  // `fetch` with a hard 5s abort.

  /**
   * Resolve one `createServer` `sshKeys`/`sshKeyId` entry to PUBLIC KEY
   * MATERIAL. Linode's instance-create `authorized_keys` field takes raw
   * OpenSSH public keys — never ids or names (the exact inverse of DO's
   * numeric-ids-only field). Raw key material passes through unchanged; a
   * numeric id or name is resolved against the account's profile SSH keys
   * (POST /profile/sshkeys is where createSSHKey below registers them).
   * Throws loudly on no match — a silent skip would create an instance
   * nobody can SSH into.
   * @param {string|number} entry
   * @returns {Promise<string>}
   */
  async _resolveSshKeyMaterial(entry) {
    const s = String(entry).trim();
    // Raw OpenSSH public key material (ssh-ed25519 / ssh-rsa / ecdsa-…).
    if (/^(ssh|ecdsa)-/.test(s)) return s;

    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const res = await fetchWithRetry(
        `${LinodeProvider.API_BASE}/profile/sshkeys?page=${page}&page_size=100`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!res.ok) {
        throw new Error(
          `Linode ssh key lookup failed (${res.status}) while resolving "${entry}" to key material`,
        );
      }
      const data = await res.json();
      const match = (data.data || []).find((k) => k.label === s || String(k.id) === s);
      if (match) return match.ssh_key;
      if (!data.pages || page >= data.pages) break;
      page++;
    }
    throw new Error(
      `Linode ssh key "${entry}" not found — cannot resolve to key material for instance create`,
    );
  }

  /**
   * Create a new Linode instance. Linode labels are account-unique (a
   * duplicate-label POST 400s), but the reuse-first shape is kept identical
   * to DigitalOcean's: findServersByName FIRST and short-circuit with the
   * existing instance (reused:true), so a create-then-resume path never
   * trips the duplicate-label error at all.
   *
   * `root_pass` is deliberately omitted: Linode's API documents it as
   * required for image deploys ONLY when no SSH keys are provided
   * (techdocs POST /linode/instances, audit 2026-08-07), and every caller
   * here supplies keys. No password exists to store or leak.
   * @param {object} config
   * @param {string} config.name - becomes the instance `label`
   * @param {string} config.region
   * @param {string} config.serverType - Linode type id (e.g. g6-standard-2)
   * @param {string} config.image
   * @param {(string|number)[]} [config.sshKeys] - raw public key material,
   *   profile-key names, or profile-key ids (resolved to material — see
   *   _resolveSshKeyMaterial)
   * @param {string|number} [config.sshKeyId] - single entry fallback
   * @param {object} [config.labels]
   * @param {string} [config.userData] - RAW cloud-init YAML; base64-encoded
   *   here at the wire (`metadata.user_data`), matching Linode's contract
   * @param {(string|number)[]} [config.networks] - accepted for interface
   *   parity; Linode compose instances join no VPC (documented no-op)
   * @param {(string|number)[]} [config.firewalls] - Firewall id(s); the
   *   FIRST attaches atomically at create time via `firewall_id` (no
   *   unfirewalled window, unlike DO's two-step), any extras attach via
   *   /networking/firewalls/{id}/devices afterwards
   * @returns {Promise<{id: number, server: object, reused?: boolean}>}
   */
  async createServer(config) {
    const {
      name,
      region,
      serverType,
      image,
      sshKeys,
      sshKeyId,
      labels,
      userData,
      firewalls,
      networks,
    } = config;

    const [existing] = await this.findServersByName(name);
    if (existing) {
      return { id: existing.id, server: existing, reused: true };
    }

    const rawSshKeys = sshKeys || (sshKeyId ? [sshKeyId] : []);
    const authorizedKeys = [];
    for (const entry of rawSshKeys) {
      authorizedKeys.push(await this._resolveSshKeyMaterial(entry));
    }

    const body = {
      label: name,
      region,
      type: serverType,
      image,
      authorized_keys: authorizedKeys,
      tags: encodeLabels(labels),
      booted: true,
    };
    if (userData) {
      body.metadata = { user_data: Buffer.from(userData, 'utf-8').toString('base64') };
    }
    const vpcId = Array.isArray(networks) ? networks[0] : undefined;
    if (vpcId !== undefined && vpcId !== null) {
      // Same shape linode-k8s.js gives its Pulumi-made instances: legacy
      // config interfaces, public first, then the VPC's first subnet. The
      // generation is pinned because new accounts default to Linode
      // Interfaces, which take a different body.
      const subnetId = await this._firstSubnetId(vpcId);
      body.interface_generation = 'legacy_config';
      body.interfaces = [{ purpose: 'public' }, { purpose: 'vpc', subnet_id: subnetId }];
    }
    const [firstFirewall, ...extraFirewalls] = Array.isArray(firewalls) ? firewalls : [];
    if (firstFirewall !== undefined) {
      body.firewall_id = Number(firstFirewall);
    }

    const response = await this.apiRequest('/linode/instances', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const reason = error.errors?.map((e) => e.reason).join('; ') || 'Unknown error';
      throw new Error(`Linode API error: ${reason}`);
    }

    const instance = await response.json();

    if (extraFirewalls.length > 0) {
      try {
        await this._attachServerToFirewalls(instance.id, extraFirewalls);
      } catch (err) {
        await this.deleteServer(instance.id).catch(() => {});
        throw new Error(
          `Instance ${name} was created but could not be attached to firewall(s) ` +
            `${extraFirewalls.join(', ')}: ${err.message}. The instance has been deleted rather ` +
            'than left running without its full firewall set.',
        );
      }
    }
    return { id: instance.id, server: instance };
  }

  /**
   * The id of a VPC's first subnet (GET /vpcs/{id}/subnets). Throws when the
   * VPC has none, so a node is never created into a network it cannot join.
   * @param {number|string} vpcId
   * @returns {Promise<number>}
   */
  async _firstSubnetId(vpcId) {
    const response = await this.apiRequest(`/vpcs/${vpcId}/subnets`);
    if (!response.ok) {
      throw new Error(`Linode VPC ${vpcId} subnet lookup failed (HTTP ${response.status})`);
    }
    const data = await response.json();
    const subnet = (data.data || [])[0];
    if (!subnet?.id) throw new Error(`Linode VPC ${vpcId} has no subnet`);
    return subnet.id;
  }

  /**
   * Attach an instance to each of the given firewalls as a device.
   * POST /networking/firewalls/{id}/devices — a duplicate attach 400s
   * ("already exists"), treated as already-attached success so a resumed
   * create stays idempotent.
   * @param {number|string} instanceId
   * @param {(string|number)[]} firewallIds
   * @returns {Promise<void>}
   */
  async _attachServerToFirewalls(instanceId, firewallIds) {
    for (const firewallId of firewallIds) {
      const response = await this.apiRequest(`/networking/firewalls/${firewallId}/devices`, {
        method: 'POST',
        body: JSON.stringify({ id: Number(instanceId), type: 'linode' }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const reason = error.errors?.map((e) => e.reason).join('; ') || 'unknown error';
        if (response.status === 400 && /already/i.test(reason)) continue;
        throw new Error(
          `firewall ${firewallId} attach failed (HTTP ${response.status}): ${reason}`,
        );
      }
    }
  }

  /**
   * Delete an instance. Same two-mode contract as the Hetzner/DO twins:
   * default fires the DELETE and returns once accepted; `waitUntilGone`
   * polls GET until 404 so a destroy→re-deploy cycle never races Linode's
   * async teardown.
   * @param {number|string} serverId
   * @param {{waitUntilGone?: boolean}} [options]
   * @returns {Promise<void|boolean>}
   */
  async deleteServer(serverId, { waitUntilGone = false } = {}) {
    if (!waitUntilGone) {
      const response = await this.apiRequest(`/linode/instances/${serverId}`, {
        method: 'DELETE',
      });
      if (!response.ok && response.status !== 404) {
        const error = await response.json().catch(() => ({}));
        const reason = error.errors?.map((e) => e.reason).join('; ') || 'Unknown error';
        throw new Error(`Failed to delete server: ${reason}`);
      }
      return;
    }

    const response = await fetchWithRetry(
      `${LinodeProvider.API_BASE}/linode/instances/${serverId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.apiToken}` },
      },
    );

    if (!response.ok && response.status !== 404) {
      const error = await response.json().catch(() => ({}));
      const reason = error.errors?.map((e) => e.reason).join('; ') || 'Unknown error';
      throw new Error(`Failed to delete server: ${reason}`);
    }

    if (response.status !== 404) {
      await pollUntil(
        async () => {
          const probe = await fetch(`${LinodeProvider.API_BASE}/linode/instances/${serverId}`, {
            headers: { Authorization: `Bearer ${this.apiToken}` },
          });
          return probe.status === 404;
        },
        {
          budgetMs: 60_000,
          initialDelayMs: 2_000,
          backoffFactor: 1,
          description: `server ${serverId} deletion`,
        },
      ).catch(() => {});
    }

    return response.status !== 404;
  }

  /**
   * Rename an instance — a direct PUT of the `label` field (no Actions
   * detour like DO's rename).
   * @param {number|string} serverId
   * @param {string} name
   * @returns {Promise<void>}
   */
  async renameServer(serverId, name) {
    const response = await this.apiRequest(`/linode/instances/${serverId}`, {
      method: 'PUT',
      body: JSON.stringify({ label: name }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const reason = error.errors?.map((e) => e.reason).join('; ') || 'Unknown error';
      throw new Error(`Failed to rename server: ${reason}`);
    }
  }

  /**
   * Get instance details. Linode returns the instance object directly (no
   * `{droplet: ...}`-style wrapper).
   * @param {number|string} serverId
   * @returns {Promise<object>}
   */
  async getServer(serverId) {
    const response = await this.apiRequest(`/linode/instances/${serverId}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const reason = error.errors?.map((e) => e.reason).join('; ') || 'Unknown error';
      throw new Error(`Failed to get server: ${reason}`);
    }
    return response.json();
  }

  // Statuses an instance stays in when it failed to boot (Linode API
  // `status`): it is not coming up by itself.
  static FAILED_BOOT_STATUSES = ['offline', 'stopped', 'billing_suspension'];

  /**
   * Wait for an instance to be ready: status 'running' AND a public IPv4
   * (assigned at create on Linode, but guarded the same as DO's contract).
   * @param {number|string} serverId
   * @param {number} [timeout=300000]
   * @returns {Promise<object>}
   */
  async waitForServer(serverId, timeout = this.constructor.WAIT_FOR_SERVER_TIMEOUT_MS) {
    const startTime = Date.now();
    const pollInterval = 5000;
    let settledDown = 0;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await this.apiRequest(`/linode/instances/${serverId}`);
        const instance = await response.json();

        if (instance.status === 'running' && LinodeProvider.getPublicIP(instance)) {
          return instance;
        }
        // A create that boots goes provisioning -> booting -> running. An
        // instance that settles in offline or stopped did not boot, and
        // waiting longer changes nothing. Two reads in a row, so the gap
        // between create and boot is not mistaken for it.
        if (LinodeProvider.FAILED_BOOT_STATUSES.includes(instance.status)) {
          settledDown += 1;
          if (settledDown >= 2) {
            throw new LinodeBootFailure(
              `Linode instance ${serverId} did not boot: it is ${instance.status}. ` +
                `Check its Lish console in the Linode Cloud Manager, then run the command again.`,
            );
          }
        } else {
          settledDown = 0;
        }
      } catch (error) {
        if (error instanceof LinodeBootFailure) throw error;
        if (Date.now() - startTime >= timeout - pollInterval) {
          throw new Error(`Failed to check server status: ${error.message}`);
        }
      }

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error('Server creation timed out');
  }

  /**
   * Lightweight status summary: {status, serverType}. Single raw `fetch`
   * with a hard 5s abort and null-on-any-failure — same never-retry
   * contract as the other providers (status runs this on every invocation).
   * @param {number|string} serverId
   * @returns {Promise<{status: string, serverType: string|null}|null>}
   */
  async getServerSummary(serverId) {
    try {
      const response = await fetch(`${LinodeProvider.API_BASE}/linode/instances/${serverId}`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return null;

      const instance = await response.json();
      return {
        status: instance.status,
        serverType: instance.type || null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch a single type's specs by exact id — Linode has a direct
   * GET /linode/types/{id} (no paginated walk needed, unlike DO).
   * @param {string} name - Exact type id (e.g. "g6-standard-2")
   * @returns {Promise<{cores: number, memoryGb: number, architecture: string, disk: number}>}
   */
  async getServerType(name) {
    const response = await fetchWithRetry(
      `${LinodeProvider.API_BASE}/linode/types/${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${this.apiToken}` } },
    );
    if (response.status === 404) {
      throw new Error(`Server type "${name}" not found`);
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch server type "${name}": ${response.status}`);
    }
    const t = await response.json();
    return {
      cores: t.vcpus,
      memoryGb: t.memory / 1024,
      architecture: 'x86',
      disk: t.disk / 1024,
    };
  }

  /**
   * Register an SSH key on the account profile — reuse-or-create by key
   * MATERIAL. Linode imposes no material uniqueness (the same public key
   * may be registered under many labels), which the first full l1
   * lifecycle proved the hard way: the scale path registered the deploy
   * key's material again under its own label, destroy never derived that
   * second label, and the teardown sweep flagged the orphan. DigitalOcean
   * gets the same reuse behavior from its API's fingerprint dedupe
   * (422-recovery walk); here the dedupe is PROACTIVE — walk the profile
   * keys, and same material (type + base64 body, comment/whitespace
   * ignored) → return the existing key's id without POSTing.
   * @param {string} name - key label (used only when a new key is created)
   * @param {string} publicKey
   * @returns {Promise<number>} SSH key ID
   */
  async createSSHKey(name, publicKey) {
    const normalize = (key) => {
      const [type, body] = (key || '').trim().split(/\s+/);
      return `${type || ''} ${body || ''}`.trim();
    };
    const targetMaterial = normalize(publicKey);

    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const res = await fetchWithRetry(
        `${LinodeProvider.API_BASE}/profile/sshkeys?page=${page}&page_size=100`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      // A failed listing degrades to create-anyway rather than blocking the
      // caller — worst case is the pre-fix behavior (a duplicate key the
      // sweep reports), never a missing key.
      if (!res.ok) break;
      const data = await res.json();
      const match = (data.data || []).find((k) => normalize(k.ssh_key) === targetMaterial);
      if (match) return match.id;
      if (!data.pages || page >= data.pages) break;
      page++;
    }

    const response = await this.apiRequest('/profile/sshkeys', {
      method: 'POST',
      body: JSON.stringify({ label: name, ssh_key: publicKey.trim() }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const reason = error.errors?.map((e) => e.reason).join('; ') || 'Unknown error';
      throw new Error(`Failed to create SSH key: ${reason}`);
    }

    const key = await response.json();
    return key.id;
  }

  /**
   * List ALL instances, optionally filtered by labels — client-side tag
   * matching via the SAME encodeLabel encoding createServer tags with
   * (Linode's list filtering can't AND arbitrary tag sets server-side any
   * more than DO's can; the full paginated walk stays inside the 200/min
   * paginated-GET budget).
   * @param {object} [labels]
   * @returns {Promise<object[]>}
   */
  async listServers(labels = {}) {
    const { items, membershipError } = await this.listServersDetailed(labels);
    // An unfiltered listing is destroy's: a node whose VPC membership could
    // not be read would be silently skipped by the cluster sweeps, so reject
    // (destroy's callers report a rejection loudly) instead of returning it
    // looking VPC-less.
    if (membershipError) throw membershipError;
    return items;
  }

  /**
   * Instance listing that preserves the page-walk's completeness signal —
   * see BaseProvider.listServersDetailed. Linode pagination is
   * `{data, page, pages}`: complete when the walk reaches `page >= pages`.
   * @param {object} [labels]
   * @returns {Promise<{ items: object[], complete: boolean, status?: number }>}
   */
  async listServersDetailed(labels = {}) {
    const instances = [];
    let page = 1;
    let complete = false;
    let status;
    for (let guard = 0; guard < 20; guard++) {
      const response = await fetchWithRetry(
        `${LinodeProvider.API_BASE}/linode/instances?page=${page}&page_size=100`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!response.ok) {
        status = response.status;
        break;
      }
      const data = await response.json();
      if (Array.isArray(data.data)) instances.push(...data.data);
      if (!data.pages || page >= data.pages) {
        complete = true;
        break;
      }
      page++;
    }

    const wantedTags = Object.entries(labels).map(([k, v]) => encodeLabel(k, v));
    const items =
      wantedTags.length === 0
        ? instances
        : instances.filter((i) => wantedTags.every((tag) => (i.tags || []).includes(tag)));

    // VPC membership is read only for an UNFILTERED listing, which is the
    // destroy sweep's. The autoscaler always lists with a selector and never
    // reads membership, so it pays no extra request.
    let membershipError;
    if (status === undefined && wantedTags.length === 0) {
      membershipError = await this._attachVpcMembership(items);
    }
    if (membershipError) return { items, complete: false, membershipError };
    return status === undefined ? { items, complete } : { items, complete, status };
  }

  /**
   * Attach `vpc_ids` (numeric VPC ids) to each instance, so the synchronous
   * serverNetworkIds accessor can read VPC membership; the instance object
   * carries none. One account-wide GET /vpcs/ips walk (rows carry `linode_id`
   * and `vpc_id`), not a request per instance.
   * @param {object[]} instances
   * @returns {Promise<Error|undefined>} the failure, or undefined when read
   */
  async _attachVpcMembership(instances) {
    const byLinode = new Map();
    try {
      let page = 1;
      for (let guard = 0; guard < 50; guard++) {
        const res = await fetchWithRetry(
          `${LinodeProvider.API_BASE}/vpcs/ips?page=${page}&page_size=100`,
          { headers: { Authorization: `Bearer ${this.apiToken}` } },
        );
        if (!res.ok) {
          return new Error(`Linode VPC membership read failed (HTTP ${res.status})`);
        }
        const data = await res.json();
        for (const row of data.data || []) {
          if (row.linode_id == null || row.vpc_id == null) continue;
          const ids = byLinode.get(row.linode_id) || [];
          if (!ids.includes(row.vpc_id)) ids.push(row.vpc_id);
          byLinode.set(row.linode_id, ids);
        }
        if (!data.pages || page >= data.pages) break;
        page++;
      }
    } catch (err) {
      return new Error(`Linode VPC membership read failed: ${err.message}`);
    }
    for (const instance of instances) instance.vpc_ids = byLinode.get(instance.id) || [];
    return undefined;
  }

  /**
   * Find instances by exact label. Full paginated walk + client-side match
   * (soft-fail [] on a non-ok response, same contract as the DO twin).
   * @param {string} name
   * @returns {Promise<object[]>}
   */
  async findServersByName(name) {
    const instances = [];
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const response = await fetchWithRetry(
        `${LinodeProvider.API_BASE}/linode/instances?page=${page}&page_size=100`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!response.ok) return [];
      const data = await response.json();
      if (Array.isArray(data.data)) instances.push(...data.data);
      if (!data.pages || page >= data.pages) break;
      page++;
    }
    // Compare against the WIRE label, not the logical name: the Pulumi
    // program squeezes long names to fit Linode's 3-50 instance cap, so a
    // literal comparison would silently fail to find exactly the servers whose
    // names needed squeezing — and destroy would leave them running.
    const wireLabel = squeezeLinodeInstanceLabel(name);
    return instances.filter((i) => i.label === wireLabel);
  }

  /**
   * Look up a firewall by its logical name (guarded paginated walk; null on
   * non-ok or no match). The wire label is derived via squeezeLinodeLabel —
   * identity for names within the 32-char firewall cap, truncated+hashed
   * beyond it — so callers keep passing the same long logical names they
   * pass every other provider.
   * @param {string} name
   * @returns {Promise<object|null>}
   */
  async findFirewallByName(name) {
    const wireLabel = squeezeLinodeLabel(name);
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const res = await fetchWithRetry(
        `${LinodeProvider.API_BASE}/networking/firewalls?page=${page}&page_size=100`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!res.ok) return null;
      const data = await res.json();
      const match = (data.data || []).find((f) => f.label === wireLabel);
      if (match) return match;
      if (!data.pages || page >= data.pages) break;
      page++;
    }
    return null;
  }

  /**
   * Replace a firewall's INBOUND rule set. Linode's PUT
   * /networking/firewalls/{id}/rules replaces the whole ruleset (inbound
   * AND outbound), so the current outbound side is fetched first and PUT
   * back unchanged — same preserve-the-rest contract as the DO twin.
   * @param {string|number} firewallId
   * @param {object[]} rules - full replacement INBOUND rule list
   * @returns {Promise<void>}
   */
  async setFirewallRules(firewallId, rules) {
    const headers = { Authorization: `Bearer ${this.apiToken}` };

    const getRes = await fetchWithRetry(
      `${LinodeProvider.API_BASE}/networking/firewalls/${firewallId}/rules`,
      { headers },
    );
    if (!getRes.ok) {
      const body = await getRes.text().catch(() => '');
      throw new Error(`Linode firewall rules lookup failed (${getRes.status}): ${body}`);
    }
    const current = await getRes.json();

    const putRes = await fetchWithRetry(
      `${LinodeProvider.API_BASE}/networking/firewalls/${firewallId}/rules`,
      {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inbound: rules,
          inbound_policy: current.inbound_policy,
          outbound: current.outbound,
          outbound_policy: current.outbound_policy,
        }),
      },
    );
    if (!putRes.ok) {
      const body = await putRes.text().catch(() => '');
      throw new Error(`Linode firewall update failed (${putRes.status}): ${body}`);
    }
  }

  /**
   * Linode-shaped replication-firewall rule builder — see BaseProvider's
   * abstract doc. Takes the firewall OBJECT (findFirewallByName's return);
   * Linode's inbound rules live under `firewall.rules.inbound` with shape
   * `{protocol, ports, addresses: {ipv4, ipv6}, action, label}`. The reconcile
   * is the shared replaceWireguardPeerRules: the UDP/51821 rule follows the
   * current peer (an old peer's rule is dropped), null when already correct.
   * @param {object} firewall
   * @param {string} peerIp - the peer node's public IPv4
   * @returns {object[]|null}
   */
  buildReplicationFirewallRules(firewall, peerIp) {
    return replaceWireguardPeerRules(firewall.rules?.inbound || [], peerIp, {
      isWireguardRule: (r) => r.protocol === 'UDP' && String(r.ports) === WG_PORT,
      admitsOnlyPeer: (r, ip) =>
        r.action === 'ACCEPT' &&
        r.addresses?.ipv4?.length === 1 &&
        r.addresses.ipv4[0] === `${ip}/32` &&
        !r.addresses.ipv6?.length,
      buildPeerRule: (ip) => ({
        label: 'wg-replication',
        action: 'ACCEPT',
        protocol: 'UDP',
        ports: WG_PORT,
        addresses: { ipv4: [`${ip}/32`] },
      }),
    });
  }

  /**
   * Rewrite the operator-locked ports' inbound rules (SSH 22, k8s API 6443)
   * on a named firewall to the given CIDR list, deleting any inbound
   * TCP/5432 or TCP/6543 rule (RETIRED_DB_PORTS), and leaving every other
   * rule unchanged. CIDRs are split into Linode's per-family
   * `{ipv4, ipv6}` arrays (splitCidrsByFamily).
   * @param {{firewallName: string, cidrs: string[]}} args
   * @returns {Promise<boolean>} true if found and updated; false if the
   *   firewall doesn't exist yet (env not deployed)
   */
  async applyOperatorCidrs({ firewallName, cidrs }) {
    const fw = await this.findFirewallByName(firewallName);
    if (!fw) return false;
    const newRules = rewriteOperatorRules(fw.rules?.inbound || [], cidrs);
    await this.setFirewallRules(fw.id, newRules);
    return true;
  }

  /**
   * Delete a firewall by its exact label.
   * @param {string} name
   * @returns {Promise<{deleted: boolean, everExisted: boolean, apiError: (Error|null)}>}
   */
  async deleteFirewallByName(name) {
    let everExisted = false;
    try {
      const fw = await this.findFirewallByName(name);
      if (!fw) return { deleted: false, everExisted: false, apiError: null };
      everExisted = true;
      const res = await fetchWithRetry(`${LinodeProvider.API_BASE}/networking/firewalls/${fw.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });
      return { deleted: res.ok || res.status === 404, everExisted, apiError: null };
    } catch (err) {
      return { deleted: false, everExisted, apiError: err };
    }
  }

  /**
   * Delete a profile SSH key by its exact label. Never throws; false when
   * no key matches.
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  async deleteSSHKeyByName(name) {
    let match = null;
    let page = 1;
    for (let guard = 0; guard < 20 && !match; guard++) {
      const res = await fetchWithRetry(
        `${LinodeProvider.API_BASE}/profile/sshkeys?page=${page}&page_size=100`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!res.ok) return false;
      const data = await res.json();
      match = (data.data || []).find((k) => k.label === name);
      if (match) break;
      if (!data.pages || page >= data.pages) break;
      page++;
    }

    if (!match) return false;

    const response = await fetchWithRetry(
      `${LinodeProvider.API_BASE}/profile/sshkeys/${match.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${this.apiToken}` } },
    );
    return response.ok || response.status === 404;
  }

  /**
   * List ALL VPCs (paginated walk, soft-fail [] on non-ok). The k8s tiers
   * create one VPC per stack, labelled `${clusterName}-network`; destroy
   * finds it here by that exact label.
   * @returns {Promise<object[]>}
   */
  async listNetworks() {
    const vpcs = [];
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const response = await fetchWithRetry(
        `${LinodeProvider.API_BASE}/vpcs?page=${page}&page_size=100`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!response.ok) break;
      const data = await response.json();
      if (Array.isArray(data.data)) vpcs.push(...data.data);
      if (!data.pages || page >= data.pages) break;
      page++;
    }
    // `name` is the provider-neutral identity callers match on
    // (autoscaler groups.js, destroy.js); Linode calls it `label`.
    return vpcs.map((v) => ({ ...v, name: v.label }));
  }

  /**
   * Delete a VPC by its exact label. Linode refuses while an instance still
   * has an interface in it; that comes back as `apiError` (an ordering bug in
   * the caller), never as a not-found.
   * @param {string} name
   * @returns {Promise<{deleted: boolean, everExisted: boolean, apiError: (Error|null)}>}
   */
  async deleteNetworkByName(name) {
    let everExisted = false;
    try {
      const vpcs = await this.listNetworks();
      const vpc = vpcs.find((v) => v.name === name);
      if (!vpc) return { deleted: false, everExisted: false, apiError: null };
      everExisted = true;
      const res = await fetchWithRetry(`${LinodeProvider.API_BASE}/vpcs/${vpc.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });
      if (res.ok || res.status === 404) return { deleted: true, everExisted, apiError: null };
      const body = await res.text().catch(() => '');
      return {
        deleted: false,
        everExisted,
        apiError: new Error(`DELETE /vpcs/${vpc.id} failed: HTTP ${res.status} ${body}`.trim()),
      };
    } catch (err) {
      return { deleted: false, everExisted, apiError: err };
    }
  }

  /**
   * Release a reserved IPv4 by address (DELETE /networking/reserved/ips/{address}),
   * answered as a ReservedIpRelease (providers/base.js) so destroy reads
   * every provider one way. Here the DELETE alone decides: 2xx or 404 is
   * released, a 4xx is a refusal (still held), and any other status, a 5xx
   * that outlasted fetchWithRetry's retries, proves nothing either way
   * (deleteRefused). DigitalOcean's twin reads the address back because DO
   * has kept an IP it answered a DELETE for; nothing like that has been seen
   * on Linode, and destroy reads Linode's listing before it deletes
   * (reservedIpLabelMatch).
   * @param {string} address
   * @returns {Promise<import('./base.js').ReservedIpRelease>}
   */
  async deleteReservedIpByAddress(address) {
    const response = await fetchWithRetry(
      `${LinodeProvider.API_BASE}/networking/reserved/ips/${address}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${this.apiToken}` } },
    );
    if (response.ok || response.status === 404) return { released: true };
    return {
      released: false,
      held: deleteRefused(response.status) ? true : null,
      region: null,
      reason: deleteFailure('Linode', response.status),
    };
  }

  /**
   * Every reserved IPv4 on the account (guarded paginated walk of
   * GET /networking/reserved/ips). An account past the guard is not read in
   * full, and a partial listing must not pass for the whole: destroy reads an
   * address missing from it as already released (reservedIpLabelMatch).
   * @returns {Promise<Array<{ address: string, tags?: string[] }>>}
   * @throws when a page cannot be read, or there are more pages than the guard reads
   */
  async _listReservedIps() {
    const ips = [];
    const pageSize = 100;
    const maxPages = 20;
    for (let page = 1; page <= maxPages; page++) {
      const response = await fetchWithRetry(
        `${LinodeProvider.API_BASE}/networking/reserved/ips?page=${page}&page_size=${pageSize}`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!response.ok) {
        throw new Error(`GET /networking/reserved/ips failed: HTTP ${response.status}`);
      }
      const data = await response.json();
      ips.push(...(data.data ?? []));
      if (!data.pages || page >= data.pages) return ips;
    }
    throw new Error(
      `the Linode account has more than ${maxPages * pageSize} reserved IPs, more than vibecarbon reads`,
    );
  }

  /**
   * Whether the reserved IPv4 at `address` still carries ALL of `labels` as
   * tags (the encodeLabel encoding the k8s program tags with). Destroy asks
   * before it releases an address saved at deploy time: Linode reissues a
   * released address within minutes, so by destroy time the saved address
   * can be another project's. Empty labels match nothing.
   * @param {string} address
   * @param {Object<string,string>} labels
   * @returns {Promise<{ found: false } | { found: true, matches: boolean, tags: string[] }>}
   *   found is false when the account holds no reserved IP at that address
   * @throws when the listing cannot be read
   */
  async reservedIpLabelMatch(address, labels) {
    const wanted = Object.entries(labels ?? {}).map(([k, v]) => encodeLabel(k, v));
    const ip = (await this._listReservedIps()).find((i) => i.address === address);
    if (!ip) return { found: false };
    const tags = ip.tags ?? [];
    return {
      found: true,
      matches: wanted.length > 0 && wanted.every((t) => tags.includes(t)),
      tags,
    };
  }

  /**
   * Release every reserved IPv4 whose tags carry ALL of the given labels
   * (same encodeLabel encoding the k8s Pulumi program tags with). Lists
   * GET /networking/reserved/ips and filters client-side, the way
   * listServersDetailed does, so no server-side filter syntax is relied on.
   * Empty labels match nothing: it never sweeps the whole account.
   * @param {Object<string,string>} labels
   * @returns {Promise<{ deleted: string[], failed: Array<{ address: string }> }>}
   * @throws when the listing cannot be read
   */
  async deleteReservedIpsByLabels(labels) {
    const wanted = Object.entries(labels ?? {}).map(([k, v]) => encodeLabel(k, v));
    if (wanted.length === 0) return { deleted: [], failed: [] };
    const matches = (await this._listReservedIps())
      .filter((ip) => wanted.every((tag) => (ip.tags ?? []).includes(tag)))
      .map((ip) => ip.address);
    const deleted = [];
    const failed = [];
    for (const address of matches) {
      if ((await this.deleteReservedIpByAddress(address)).released) deleted.push(address);
      else failed.push({ address });
    }
    return { deleted, failed };
  }

  /**
   * List ALL volumes (paginated walk, soft-fail contract matching
   * listServers).
   * @returns {Promise<object[]>}
   */
  async listVolumes() {
    return (await this.listVolumesDetailed()).items;
  }

  /**
   * Volume listing preserving the completeness signal — see
   * BaseProvider.listVolumesDetailed.
   * @returns {Promise<{ items: object[], complete: boolean, status?: number }>}
   */
  async listVolumesDetailed() {
    const volumes = [];
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const response = await fetchWithRetry(
        `${LinodeProvider.API_BASE}/volumes?page=${page}&page_size=100`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!response.ok) return { items: volumes, complete: false, status: response.status };
      const data = await response.json();
      if (Array.isArray(data.data)) volumes.push(...data.data);
      if (!data.pages || page >= data.pages) return { items: volumes, complete: true };
      page++;
    }
    return { items: volumes, complete: false };
  }

  /**
   * Delete a volume by ID. Linode refuses to delete an attached volume —
   * that non-2xx surfaces as false (sweep order handles detach-first).
   * @param {number|string} volumeId
   * @returns {Promise<boolean>} true on success or if already gone (404)
   */
  async deleteVolume(volumeId) {
    const response = await fetchWithRetry(`${LinodeProvider.API_BASE}/volumes/${volumeId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    return response.ok || response.status === 404;
  }

  /**
   * List ALL NodeBalancers — Linode's load-balancer product (paginated
   * walk, soft-fail [] on non-ok). Compose deploys create none; enumerated
   * for the same leak-can't-hide reason as listNetworks.
   * @returns {Promise<object[]>}
   */
  async listLoadBalancers() {
    const nodeBalancers = [];
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const response = await fetchWithRetry(
        `${LinodeProvider.API_BASE}/nodebalancers?page=${page}&page_size=100`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!response.ok) break;
      const data = await response.json();
      if (Array.isArray(data.data)) nodeBalancers.push(...data.data);
      if (!data.pages || page >= data.pages) break;
      page++;
    }
    return nodeBalancers;
  }

  /**
   * Delete a NodeBalancer by ID.
   * @param {number|string} lbId
   * @returns {Promise<boolean>} true on success or if already gone (404)
   */
  async deleteLoadBalancer(lbId) {
    const response = await fetchWithRetry(`${LinodeProvider.API_BASE}/nodebalancers/${lbId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    return response.ok || response.status === 404;
  }

  // ── Destroy-sweep field accessors ───────────────────────────────────────
  // See BaseProvider's doc for the cross-provider contract.

  /**
   * VPC ids the instance has an interface in. The instance object carries
   * none; an unfiltered listServersDetailed attaches `vpc_ids` (see
   * _attachVpcMembership). [] for an instance in no VPC (every compose
   * instance).
   * @param {object} server
   * @returns {number[]}
   */
  serverNetworkIds(server) {
    return Array.isArray(server?.vpc_ids) ? [...server.vpc_ids] : [];
  }

  /**
   * @param {object} server
   * @returns {Object<string,string>}
   */
  serverLabels(server) {
    return decodeLabels(server.tags);
  }

  /**
   * The decoded value of this provider's own encoding: the raw value when
   * the tag fits in 50 characters, the squeezed one when encodeLabel had to
   * shorten it.
   * @param {string} key
   * @param {string} value
   * @returns {string}
   */
  labelValue(key, value) {
    return decodeLabels([encodeLabel(key, value)])[key];
  }

  /**
   * Linode's instance object carries NO attached-volume ids (the
   * volume → `linode_id` direction is the authoritative attachment record
   * on this API — see volumeAttachedServerIds). Always [] — the sweep and
   * destroy paths cross-reference from the volume side.
   * @param {object} _server
   * @returns {string[]}
   */
  serverVolumeIds(_server) {
    return [];
  }

  /**
   * Linode's `region` is a plain slug string (not DO's `{slug}` object).
   * @param {object} server
   * @returns {string|null}
   */
  serverRegion(server) {
    return server.region ?? null;
  }

  /**
   * A Linode volume attaches to at most one instance (`linode_id`, null
   * when detached).
   * @param {object} volume
   * @returns {number[]}
   */
  volumeAttachedServerIds(volume) {
    return volume.linode_id != null ? [volume.linode_id] : [];
  }

  /**
   * Linode names a volume with `label`.
   * @param {object} volume
   * @returns {string|null}
   */
  volumeName(volume) {
    return volume.label ?? null;
  }

  /**
   * @param {object} volume
   * @returns {string|null}
   */
  volumeRegion(volume) {
    return volume.region ?? null;
  }

  /**
   * @param {object} volume
   * @returns {Object<string,string>}
   */
  volumeLabels(volume) {
    return decodeLabels(volume.tags);
  }

  /**
   * Linode reports volume creation as an ISO-8601 `created` field.
   * @param {object} volume
   * @returns {string|null}
   */
  volumeCreatedAt(volume) {
    return volume.created ?? null;
  }

  // ── Object storage dispatch ─────────────────────────────────────────────

  /**
   * Lazily resolve the Linode Object Storage (S3-compatible) provider
   * class. Dynamic import (never top-level) — see
   * HetznerProvider.getObjectStorageProviderClass for why.
   * @returns {Promise<typeof import('./linode-objectstorage.js').LinodeObjectStorageProvider>}
   */
  static async getObjectStorageProviderClass() {
    const { LinodeObjectStorageProvider } = await import('./linode-objectstorage.js');
    return LinodeObjectStorageProvider;
  }

  // ── Guided setup delegation ─────────────────────────────────────────────

  /**
   * @param {string} [projectName]
   * @param {{ save?: boolean }} [options]
   * @returns {Promise<string|null>}
   */
  static async promptApiToken(projectName, options) {
    const { getApiToken } = await import('../linode-guided-setup.js');
    return getApiToken(projectName, options);
  }

  /**
   * @param {string} [projectName]
   * @param {{ save?: boolean, force?: boolean, skipPrompts?: boolean }} [options]
   * @returns {Promise<{accessKey: string, secretKey: string}|null>}
   */
  static async promptObjectStorageCredentials(projectName, options) {
    const { getS3Credentials } = await import('../linode-guided-setup.js');
    return getS3Credentials(projectName, options);
  }

  // ── IaC program dispatch ────────────────────────────────────────────────

  /**
   * Lazily build the Pulumi Automation-API program for a single Linode
   * Docker-Compose instance. Dynamic import (never top-level) — see the
   * IAC PROGRAM DISPATCH block in base.js for why.
   * @param {object} config - Linode compose stack config
   * @returns {Promise<() => Promise<{serverIp: string, serverId: string, firewallId: string, sshKeyId: string}>>}
   */
  static async getComposeProgram(config) {
    const { buildLinodeComposeProgram } = await import('../iac/programs/linode-compose.js');
    return buildLinodeComposeProgram(config);
  }
}

class LinodeBootFailure extends Error {}
