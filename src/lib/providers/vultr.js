/**
 * Vultr Cloud Provider
 *
 * Compose + compose-ha provider (PR 2 of the 2026-08 provider expansion +
 * tier-parity wave 1 — see
 * the vultr-provider-step0-audit plan for the
 * sourced capability audit and live-probe results). The k8s statics throw
 * provider-specific errors (Vultr's k8s tier is unbuilt, not forgotten —
 * 4-mode headroom is recorded in the audit).
 *
 * Vultr-shape notes (vs the Hetzner/DO/Linode templates):
 * - API v2 uses CURSOR pagination (`meta.links.next` → `&cursor=`), not
 *   page/pages — every listing routes through `_walkCursor`.
 * - Firewalls are GROUPS (identity field `description`, not label) whose
 *   rules are INBOUND-ONLY, separate resources with no replace-all PUT —
 *   see setFirewallRules' delete-then-recreate design.
 * - Instances attach at most ONE firewall group (`firewall_group_id`).
 * - Object-storage keys are per-subscription (see vultr-objectstorage.js).
 * - Rate limit: 400-request burst bucket, 1s reset (live headers
 *   2026-08-08); fetch-retry's 429 backoff covers overruns.
 *
 * API Documentation: https://www.vultr.com/api/
 */

import { fetchWithRetry } from '../fetch-retry.js';
import { pollUntil } from '../retry.js';
import { BaseProvider } from './base.js';

// Ports whose inbound rules applyOperatorCidrs rewrites — same set as the
// sibling providers (SSH, k8s API for future parity, Supavisor poolers).
const SSH_PORT = '22';
const K8S_API_PORT = '6443';
const POOLER_SESSION_PORT = '5432';
const POOLER_TRANSACTION_PORT = '6543';
const OPERATOR_LOCKED_PORTS = new Set([
  SSH_PORT,
  K8S_API_PORT,
  POOLER_SESSION_PORT,
  POOLER_TRANSACTION_PORT,
]);

// WireGuard replication port (wireguard.js WG_PORT) — only reachable via
// compose-ha (declared since tier-parity wave 1); the member is
// contract-required and unit-pinned.
const WG_PORT = '51821';

/**
 * Encode a label key/value pair into a Vultr tag string — same `key:value`
 * wire encoding as the DO/Linode tag-based providers (byte-compatible so
 * the destroy-sweep/listing matchers behave identically). Conservative
 * charset for round-trip safety.
 * Named export for the Pulumi IaC program (vultr-compose.js).
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
export function encodeLabel(key, value) {
  return `${key}:${value}`.replace(/[^A-Za-z0-9:_-]/g, '-');
}

/**
 * Encode a labels object into an array of Vultr tag strings.
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
 * Decode a Vultr tag array back into a flat label map — inverse of
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

/**
 * Split a CIDR into Vultr's `{subnet, subnet_size, ip_type}` rule fields.
 * A bare IP gets /32 (v4) or /128 (v6) — same normalization the sibling
 * providers apply when they append `/32` to peer IPs.
 * @param {string} cidr
 * @returns {{ip_type: 'v4'|'v6', subnet: string, subnet_size: number}}
 */
export function cidrToVultrRuleFields(cidr) {
  const isV6 = cidr.includes(':');
  const [subnet, sizeStr] = cidr.split('/');
  const subnet_size = sizeStr !== undefined ? Number(sizeStr) : isV6 ? 128 : 32;
  return { ip_type: isV6 ? 'v6' : 'v4', subnet, subnet_size };
}

export class VultrProvider extends BaseProvider {
  /**
   * Object-storage operational limits (verified 2026-08-15). Vultr claims
   * strong consistency ONLY on marketing/product pages — no authoritative doc
   * states it, which is why this is 'strong-claimed' and must not be upgraded
   * without a documentation citation. No request-rate ceilings published.
   */
  static OBJECT_STORAGE_LIMITS = {
    requestsPerSecondPerBucket: null,
    requestsPerSecondPerSourceIp: null,
    parallelConnectionsPerSourceIp: null,
    consistency: 'strong-claimed',
    evidenceUrl: 'https://www.vultr.com/products/object-storage/',
    verifiedOn: '2026-08-15',
  };

  static NAME = 'Vultr';
  static API_BASE = 'https://api.vultr.com/v2';
  // Ours (env-first token env var) — see resolveProviderToken (index.js).
  static TOKEN_ENV = 'VULTR_API_TOKEN';
  // Read by @ediri/vultr (verified 2026-08-07 on the Pulumi Registry
  // installation-configuration page) — never derive/rename.
  static CLI_TOKEN_ENV = 'VULTR_API_KEY';
  // Per-SUBSCRIPTION credentials (one subscription = one cluster) — see
  // vultr-objectstorage.js's key-model doc; the region env below is
  // effectively required alongside them.
  static OBJECT_STORAGE_ENV = ['VULTR_ACCESS_KEY', 'VULTR_SECRET_KEY'];
  // The providerID scheme Vultr's CCM stamps on nodes — relevant only at
  // the (unbuilt) k8s tier, pinned now for uniqueness.
  static PROVIDER_ID_PREFIX = 'vultr://';
  static DEFAULT_REGION = 'ewr';
  static PRICING_URL = 'https://www.vultr.com/pricing/';

  // Cluster slug of the operator's object-storage SUBSCRIPTION (e.g.
  // `ewr1`) — effectively REQUIRED config on Vultr, see
  // vultr-objectstorage.js.
  static S3_REGION_ENV = 'VULTR_STORAGE_REGION';

  // Compose tiers only (compose-ha added in the 2026-08 tier-parity wave 1 —
  // the HA surface below was contract-complete since PR 2; effects/compose-ha
  // is provider-generic). 4-mode headroom (CCM/CSI/block-storage/DNS-flip)
  // recorded in the audit; the k8s tiers are not yet built or declared.
  static SUPPORTED_TIERS = ['compose', 'compose-ha'];

  // Compute regions WITH a co-located Object Storage cluster (same
  // in-region-backup doctrine as the sibling providers; live cluster
  // listing 2026-08-08 — note the cluster slugs are NOT these ids, see
  // vultr-objectstorage.js COMPUTE_TO_S3). Labels from GET /v2/regions.
  static REGIONS = {
    ewr: 'New Jersey, USA',
    ord: 'Chicago, USA',
    lax: 'Los Angeles, USA',
    sjc: 'Silicon Valley, USA',
    ams: 'Amsterdam, Netherlands',
    lhr: 'London, United Kingdom',
    sgp: 'Singapore',
    syd: 'Sydney, Australia',
  };

  // Continent grouping for standby selection (getDefaultStandbyRegion).
  static REGION_CONTINENT = {
    ewr: 'na',
    ord: 'na',
    lax: 'na',
    sjc: 'na',
    ams: 'eu',
    lhr: 'eu',
    sgp: 'ap',
    syd: 'ap',
  };

  static HA_REGIONS = ['ewr', 'ord'];

  // Offline fallback catalog — vc2 shared line, live-verified 2026-08-08
  // via the public GET /v2/plans (ram is MB on the wire; stored as GB).
  static FALLBACK_SERVER_TYPES = {
    'vc2-1c-2gb': { vcpu: 1, ram: 2, disk: 55 },
    'vc2-2c-4gb': { vcpu: 2, ram: 4, disk: 80 },
    'vc2-4c-8gb': { vcpu: 4, ram: 8, disk: 160 },
  };

  // Live catalog populated by fetchServerTypes(); object map (name → spec).
  static SERVER_TYPES = { ...VultrProvider.FALLBACK_SERVER_TYPES };

  // Per-region availability populated by fetchServerTypes(). Vultr's plans
  // carry a real per-region axis (`plan.locations[]`) — unlike Linode's
  // global catalog — so this map is genuine data, same shape as DO's.
  static _locationTypes = null;

  static DEFAULT_TYPE = 'vc2-2c-4gb';

  // ── Engine-literal statics ──────────────────────────────────────────────
  static DEFAULT_COMPOSE_TYPE = 'vc2-2c-4gb';
  // Pinned for EXPECTED-table completeness; unread while compose-only.
  static DEFAULT_K8S_NODE_TYPE = 'vc2-2c-4gb';

  // No Docker-preinstalled OS on Vultr (Marketplace Docker is an app, not
  // an os_id) — cloud-init installs docker-ce, same 3-5min budget class as
  // DO/Linode.
  static CLOUD_INIT_READY_TIMEOUT_MS = 600_000;

  // Vultr reports OS readiness (`server_status`) separately from subscription
  // state, and the OS leg is the slow one: CI run 31663154544 took ~295s from
  // create to sshd on a vc2-4c-8gb in ewr. waitForServer is where that wait
  // now happens (see the method), so the shared 300s default would have put a
  // routine boot within seconds of a hard timeout. 600s matches the
  // cloud-init budget above, which was widened for the same reason.
  static WAIT_FOR_SERVER_TIMEOUT_MS = 600_000;

  /**
   * Empty at the compose-only tier — no CCM/CSI deployed; real values come
   * from vultr-cloud-controller-manager / vultr-csi manifests when the k8s
   * tier is built (audit headroom record).
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
   * vultr-csi's DEFAULT StorageClass (verified 2026-08-08 against the
   * driver's docs/kubernetes manifests: `vultr-block-storage` is default,
   * Delete policy; `-retain` also installed). Unread while compose-only;
   * the literal-guard census requires distinctness + residence here.
   * @type {string}
   */
  static K8S_STORAGE_CLASS = 'vultr-block-storage';

  /** Compose-only: no k8s program exists to pin a VPC CIDR against. @type {string} */
  static DEFAULT_VPC_CIDR = '';

  /** Compose-only: no k8s program/image literal to byte-match. @type {string} */
  static K8S_IMAGE = '';

  // ── k8s statics — compose-only, provider-specific throws ────────────────

  /** @returns {Promise<never>} */
  static async getK8sMasterUserData() {
    throw new Error("Vultr's k8s tier is not built — SUPPORTED_TIERS is compose-only");
  }

  /** @returns {Promise<never>} */
  static async getK8sWorkerUserData() {
    throw new Error("Vultr's k8s tier is not built — SUPPORTED_TIERS is compose-only");
  }

  /** @returns {Promise<never>} */
  static async getK8sSupabaseUserData() {
    throw new Error("Vultr's k8s tier is not built — SUPPORTED_TIERS is compose-only");
  }

  /** @returns {Promise<never>} */
  static async getK8sProgram() {
    throw new Error("Vultr's k8s tier is not built — SUPPORTED_TIERS is compose-only");
  }

  // ── Compose-tier replacement-server identity ────────────────────────────

  /**
   * Vultr images are numeric os_ids, not slugs — `2284` = "Ubuntu 24.04
   * LTS x64" (live GET /v2/os, 2026-08-08). Stored as a STRING for
   * interface parity; both wire boundaries (createServer's REST body and
   * vultr-compose.js's `osId`) convert with Number(). MUST byte-match the
   * program's literal.
   * @type {string}
   */
  static COMPOSE_IMAGE = '2284';

  /**
   * Same rendered user-data vultr-compose.js's Pulumi program uses —
   * delegates to that module's loader (single source of truth for the
   * Docker-install splice). Returned RAW; base64 applied at wire
   * boundaries.
   * @returns {Promise<string>}
   */
  static async getComposeUserData() {
    const { loadVultrComposeUserData } = await import('../iac/programs/vultr-compose.js');
    return loadVultrComposeUserData();
  }

  /**
   * Fetch the Vultr plan catalog (public endpoint; Bearer sent when given
   * for rate-limit accounting). Cursor-paginated walk with the shared
   * ≤20-page guard; incomplete/empty walks return false so the fallback
   * catalog survives. Populates the REAL per-region availability axis from
   * each plan's `locations[]`.
   * @param {string} apiToken
   * @returns {Promise<boolean>} true if live data was loaded
   */
  static async fetchServerTypes(apiToken) {
    if (VultrProvider._locationTypes) return true; // already fetched

    try {
      const plans = [];
      let cursor = '';
      let complete = false;
      for (let guard = 0; guard < 20; guard++) {
        const response = await fetchWithRetry(
          `${VultrProvider.API_BASE}/plans?per_page=500${cursor ? `&cursor=${cursor}` : ''}`,
          apiToken ? { headers: { Authorization: `Bearer ${apiToken}` } } : {},
        );
        if (!response.ok) return false;
        const data = await response.json();
        plans.push(...(data.plans || []));
        const next = data.meta?.links?.next;
        if (!next) {
          complete = true;
          break;
        }
        cursor = next;
      }
      if (!complete) return false;
      if (plans.length === 0) return false;

      const types = {};
      const locationTypes = {};
      for (const plan of plans) {
        types[plan.id] = {
          vcpu: plan.vcpu_count,
          ram: plan.ram / 1024,
          disk: plan.disk,
        };
        for (const region of plan.locations || []) {
          if (!locationTypes[region]) locationTypes[region] = new Set();
          locationTypes[region].add(plan.id);
        }
      }
      if (Object.keys(types).length === 0) return false;

      VultrProvider.SERVER_TYPES = types;
      VultrProvider._locationTypes = locationTypes;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Server types available in a region — live per-region data when fetched
   * (plan.locations is a real axis on Vultr), fallback catalog otherwise.
   * `architecture: 'x86'` constant: Vultr's cloud-compute lines are x86.
   * @param {string} region
   * @returns {Array<{name: string, vcpu: number, ram: number, disk: number, architecture: string}>}
   */
  static getServerTypesForRegion(region) {
    const available = VultrProvider._locationTypes?.[region];

    if (available) {
      return [...available]
        .filter((name) => name in VultrProvider.SERVER_TYPES)
        .map((name) => ({
          name,
          ...VultrProvider.SERVER_TYPES[name],
          architecture: 'x86',
        }))
        .sort((a, b) => a.vcpu - b.vcpu || a.ram - b.ram);
    }

    return Object.entries(VultrProvider.FALLBACK_SERVER_TYPES).map(([name, info]) => ({
      name,
      ...info,
      architecture: 'x86',
    }));
  }

  /**
   * Region-appropriate default server types — fixed roles (the vc2 line is
   * near-uniform; per-region gaps are handled by resolveServerTypeForRegion).
   * @param {string} _region - interface parity; unused
   * @returns {{masterType: string, supabaseType: string, workerType: string}}
   */
  static getRegionDefaults(_region) {
    return {
      masterType: 'vc2-1c-2gb',
      supabaseType: VultrProvider.DEFAULT_TYPE,
      workerType: 'vc2-1c-2gb',
    };
  }

  /**
   * Default HA standby region — conventional pairs, then same-continent,
   * mirroring the sibling providers' contract (contract-tested for every
   * region even while compose-only).
   * @param {string} primaryRegion
   * @returns {string}
   */
  static getDefaultStandbyRegion(primaryRegion) {
    const PAIRS = {
      ewr: 'ord',
      ord: 'ewr',
      lax: 'sjc',
      sjc: 'lax',
      ams: 'lhr',
      lhr: 'ams',
      sgp: 'syd',
      syd: 'sgp',
    };
    if (PAIRS[primaryRegion]) return PAIRS[primaryRegion];

    const continent = VultrProvider.REGION_CONTINENT[primaryRegion];
    const sameContinent = Object.keys(VultrProvider.REGION_CONTINENT).filter(
      (r) => r !== primaryRegion && VultrProvider.REGION_CONTINENT[r] === continent,
    );
    if (sameContinent.length > 0) return sameContinent[0];
    return primaryRegion === 'ewr' ? 'ord' : 'ewr';
  }

  /**
   * Equivalent plan in a target region, using the live per-region axis when
   * available (same walk shape as DO's).
   * @param {string} serverType
   * @param {string} targetRegion
   * @returns {string}
   */
  static resolveServerTypeForRegion(serverType, targetRegion) {
    const available = VultrProvider._locationTypes?.[targetRegion];

    if (available) {
      if (available.has(serverType)) return serverType;
      const defaults = VultrProvider.getRegionDefaults(targetRegion);
      if (serverType === defaults.supabaseType) return defaults.supabaseType;
      return defaults.masterType;
    }

    return serverType;
  }

  /**
   * Public IPv4 of an instance. Vultr reports `main_ip` — with the
   * PLACEHOLDER '0.0.0.0' until assignment completes, which must read as
   * "no IP yet" (waitForServer polls on it), never as an address.
   * @param {object} server - Vultr API instance object
   * @returns {string|null}
   */
  static getPublicIP(server) {
    const ip = server?.main_ip;
    if (!ip || ip === '0.0.0.0') return null;
    return ip;
  }

  /**
   * Public IPv6 of an instance (`v6_main_ip`, empty string until/unless
   * assigned).
   * @param {object} server
   * @returns {string|null}
   */
  static getPublicIPv6(server) {
    return server?.v6_main_ip || null;
  }

  // ── Instance methods ────────────────────────────────────────────────────
  // Transport split mirrors the sibling providers: CRUD via this.apiRequest,
  // listings/teardown via fetchWithRetry (all through _walkCursor),
  // getServerSummary a raw fetch with a hard 5s abort.

  /**
   * Cursor-paginated collection walk (Vultr's `meta.links.next` idiom) —
   * the single pagination implementation every listing below shares.
   * Same ≤20-page guard and completeness semantics as the sibling
   * providers' page walks.
   * @param {string} path - e.g. '/instances' (may carry its own query)
   * @param {string} key - response array key (e.g. 'instances')
   * @returns {Promise<{items: object[], complete: boolean, status?: number}>}
   */
  async _walkCursor(path, key) {
    const items = [];
    const sep = path.includes('?') ? '&' : '?';
    let cursor = '';
    for (let guard = 0; guard < 20; guard++) {
      const response = await fetchWithRetry(
        `${VultrProvider.API_BASE}${path}${sep}per_page=500${cursor ? `&cursor=${cursor}` : ''}`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!response.ok) return { items, complete: false, status: response.status };
      const data = await response.json();
      if (Array.isArray(data[key])) items.push(...data[key]);
      const next = data.meta?.links?.next;
      if (!next) return { items, complete: true };
      cursor = next;
    }
    return { items, complete: false };
  }

  /**
   * Resolve one `createServer` `sshKeys`/`sshKeyId` entry to a Vultr
   * ssh-key UUID. Vultr's instance-create `sshkey_id` field takes key ids
   * (account-level keys, like DO) — a name entry is resolved against
   * GET /v2/ssh-keys by `name`. Throws loudly on no match.
   * @param {string} entry
   * @returns {Promise<string>}
   */
  async _resolveSshKeyId(entry) {
    const s = String(entry);
    // Vultr key ids are UUIDs — anything UUID-shaped passes through.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s;

    const { items, complete } = await this._walkCursor('/ssh-keys', 'ssh_keys');
    const match = items.find((k) => k.name === s);
    if (match) return match.id;
    if (!complete) {
      throw new Error(`Vultr ssh key listing incomplete while resolving "${entry}" to an id`);
    }
    throw new Error(
      `Vultr ssh key "${entry}" not found — cannot resolve to an id for instance create`,
    );
  }

  /**
   * Create a new Vultr instance. Labels are not unique on Vultr, so the
   * findServersByName-first reuse pattern (DO's) prevents duplicate
   * creation on resume. The FIRST firewall attaches atomically at create
   * time (`firewall_group_id`); Vultr instances support at most ONE
   * firewall group, so additional entries are refused loudly rather than
   * silently dropped.
   * @param {object} config
   * @param {string} config.name - instance `label`
   * @param {string} config.region
   * @param {string} config.serverType - plan id (e.g. vc2-2c-4gb)
   * @param {string} config.image - numeric os_id as a string ('2284')
   * @param {(string|number)[]} [config.sshKeys] - key UUIDs or names
   * @param {string|number} [config.sshKeyId] - single-entry fallback
   * @param {object} [config.labels]
   * @param {string} [config.userData] - RAW cloud-init YAML; base64'd here
   * @param {(string|number)[]} [config.networks] - interface parity; Vultr
   *   compose instances join no VPC (documented no-op)
   * @param {(string|number)[]} [config.firewalls]
   * @returns {Promise<{id: string, server: object, reused?: boolean}>}
   */
  async createServer(config) {
    const { name, region, serverType, image, sshKeys, sshKeyId, labels, userData, firewalls } =
      config;

    const [existing] = await this.findServersByName(name);
    if (existing) {
      return { id: existing.id, server: existing, reused: true };
    }

    const rawSshKeys = sshKeys || (sshKeyId ? [sshKeyId] : []);
    const resolvedSshKeys = [];
    for (const entry of rawSshKeys) {
      resolvedSshKeys.push(await this._resolveSshKeyId(entry));
    }

    const fwList = Array.isArray(firewalls) ? firewalls : [];
    if (fwList.length > 1) {
      throw new Error(
        `Vultr instances support at most ONE firewall group; got ${fwList.length}. ` +
          'Refusing rather than silently dropping the extras.',
      );
    }

    const body = {
      label: name,
      region,
      plan: serverType,
      os_id: Number(image),
      sshkey_id: resolvedSshKeys,
      tags: encodeLabels(labels),
    };
    if (userData) {
      body.user_data = Buffer.from(userData, 'utf-8').toString('base64');
    }
    if (fwList.length === 1) {
      body.firewall_group_id = String(fwList[0]);
    }

    const response = await this.apiRequest('/instances', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Vultr API error: ${error.error || 'Unknown error'}`);
    }

    const { instance } = await response.json();
    return { id: instance.id, server: instance };
  }

  /**
   * Delete an instance — same two-mode contract as the sibling providers
   * (default: fire-and-return; waitUntilGone: poll GET until 404).
   * @param {string} serverId
   * @param {{waitUntilGone?: boolean}} [options]
   * @returns {Promise<void|boolean>}
   */
  async deleteServer(serverId, { waitUntilGone = false } = {}) {
    const response = await fetchWithRetry(`${VultrProvider.API_BASE}/instances/${serverId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Failed to delete server: ${error.error || 'Unknown error'}`);
    }

    if (!waitUntilGone) return;

    if (response.status !== 404) {
      await pollUntil(
        async () => {
          const probe = await fetch(`${VultrProvider.API_BASE}/instances/${serverId}`, {
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
   * Rename an instance — PATCH of the `label` field.
   * @param {string} serverId
   * @param {string} name
   * @returns {Promise<void>}
   */
  async renameServer(serverId, name) {
    const response = await this.apiRequest(`/instances/${serverId}`, {
      method: 'PATCH',
      body: JSON.stringify({ label: name }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Failed to rename server: ${error.error || 'Unknown error'}`);
    }
  }

  /**
   * Get instance details (`{instance}` wrapper).
   * @param {string} serverId
   * @returns {Promise<object>}
   */
  async getServer(serverId) {
    const response = await this.apiRequest(`/instances/${serverId}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Failed to get server: ${error.error || 'Unknown error'}`);
    }
    const { instance } = await response.json();
    return instance;
  }

  /**
   * Wait for an instance to be ready: `server_status === 'ok'` AND a real
   * public IPv4 (getPublicIP treats Vultr's '0.0.0.0' placeholder as absent).
   *
   * READ THE RIGHT FIELD. Vultr exposes three status-ish fields and only
   * `server_status` describes the operating system:
   *
   *   status        pending|active|suspended|resizing  — SUBSCRIPTION state
   *   power_status  running|stopped                    — 'running' at create time
   *   server_status none|locked|installingbooting|ok   — OS state
   *
   * Vultr's own POST /v2/instances 202 example returns `status: "pending"`,
   * `power_status: "running"`, `server_status: "none"` for a machine that does
   * not exist yet: `status` flips to `active` once the subscription is
   * provisioned and an IP is assigned, minutes before the OS is up.
   *
   * This gate previously read `status === 'active'`, copied verbatim from the
   * DigitalOcean provider — where `active` genuinely IS the droplet's running
   * state. Same spelling, different meaning. It returned after 22s in CI run
   * 31663154544 while the instance was still `installingbooting`, so scale
   * handed an unroutable IP to waitForSSH, which spent 273s on "Connection
   * timed out" then "Connection refused" and came within a few attempts of
   * exhausting its 40-probe budget and failing the scale outright.
   *
   * Sibling gates, for the record: Hetzner `status === 'running'`, Linode
   * `status === 'running'`, Scaleway `state === 'running'` — all OS-level.
   * Vultr was the only provider gating on a non-OS field.
   *
   * @param {string} serverId
   * @param {number} [timeout=VultrProvider.WAIT_FOR_SERVER_TIMEOUT_MS]
   * @returns {Promise<object>}
   */
  async waitForServer(serverId, timeout = VultrProvider.WAIT_FOR_SERVER_TIMEOUT_MS) {
    const startTime = Date.now();
    const pollInterval = 5000;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await this.apiRequest(`/instances/${serverId}`);
        const { instance } = await response.json();

        if (instance.server_status === 'ok' && VultrProvider.getPublicIP(instance)) {
          return instance;
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
   * Lightweight status summary — single raw fetch, hard 5s abort,
   * null-on-any-failure (same never-retry contract as the siblings).
   * @param {string} serverId
   * @returns {Promise<{status: string, serverType: string|null}|null>}
   */
  async getServerSummary(serverId) {
    try {
      const response = await fetch(`${VultrProvider.API_BASE}/instances/${serverId}`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return null;

      const { instance } = await response.json();
      return {
        status: instance.status,
        serverType: instance.plan || null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch a single plan's specs by exact id — GET /v2/plans has no by-id
   * endpoint, so this walks the (public) cursor-paginated catalog and
   * matches client-side, same shape as DO's getServerType.
   * @param {string} name - plan id (e.g. "vc2-2c-4gb")
   * @returns {Promise<{cores: number, memoryGb: number, architecture: string, disk: number}>}
   */
  async getServerType(name) {
    const { items, complete } = await this._walkCursor('/plans', 'plans');
    const match = items.find((p) => p.id === name);
    if (match) {
      return {
        cores: match.vcpu_count,
        memoryGb: match.ram / 1024,
        architecture: 'x86',
        disk: match.disk,
      };
    }
    if (!complete) throw new Error(`Failed to fetch server type "${name}": listing incomplete`);
    throw new Error(`Server type "${name}" not found`);
  }

  /**
   * Register an SSH key — reuse-or-create by key MATERIAL, the lesson the
   * first full Linode lifecycle taught (a scale-path re-registration under
   * a different name leaked past destroy). Same proactive dedupe: walk
   * /v2/ssh-keys, same material (type + base64 body, comment/whitespace
   * ignored) → return the existing key's id without POSTing; a failed
   * listing degrades to create-anyway (worst case = a swept duplicate,
   * never a missing key).
   * @param {string} name
   * @param {string} publicKey
   * @returns {Promise<string>} SSH key UUID
   */
  async createSSHKey(name, publicKey) {
    const normalize = (key) => {
      const [type, body] = (key || '').trim().split(/\s+/);
      return `${type || ''} ${body || ''}`.trim();
    };
    const targetMaterial = normalize(publicKey);

    const { items } = await this._walkCursor('/ssh-keys', 'ssh_keys');
    const match = items.find((k) => normalize(k.ssh_key) === targetMaterial);
    if (match) return match.id;

    const response = await this.apiRequest('/ssh-keys', {
      method: 'POST',
      body: JSON.stringify({ name, ssh_key: publicKey.trim() }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Failed to create SSH key: ${error.error || 'Unknown error'}`);
    }

    const { ssh_key } = await response.json();
    return ssh_key.id;
  }

  /**
   * List ALL instances, optionally filtered by labels — client-side tag
   * matching via the SAME encodeLabel encoding createServer tags with.
   * @param {object} [labels]
   * @returns {Promise<object[]>}
   */
  async listServers(labels = {}) {
    return (await this.listServersDetailed(labels)).items;
  }

  /**
   * Instance listing preserving the walk's completeness signal — see
   * BaseProvider.listServersDetailed.
   * @param {object} [labels]
   * @returns {Promise<{ items: object[], complete: boolean, status?: number }>}
   */
  async listServersDetailed(labels = {}) {
    const { items, complete, status } = await this._walkCursor('/instances', 'instances');

    const wantedTags = Object.entries(labels).map(([k, v]) => encodeLabel(k, v));
    const filtered =
      wantedTags.length === 0
        ? items
        : items.filter((i) => wantedTags.every((tag) => (i.tags || []).includes(tag)));

    return status === undefined
      ? { items: filtered, complete }
      : { items: filtered, complete, status };
  }

  /**
   * Find instances by exact label (client-side; soft-fail [] on non-ok).
   * @param {string} name
   * @returns {Promise<object[]>}
   */
  async findServersByName(name) {
    const { items, status } = await this._walkCursor('/instances', 'instances');
    if (status !== undefined) return [];
    return items.filter((i) => i.label === name);
  }

  /**
   * Look up a firewall GROUP by its exact description (Vultr's identity
   * field for groups). The returned object is AUGMENTED with `rules` (the
   * group's inbound rule list, fetched here) so
   * buildReplicationFirewallRules/applyOperatorCidrs can operate on it —
   * Vultr keeps rules as separate sub-resources, unlike the siblings'
   * embedded rule arrays.
   * @param {string} name
   * @returns {Promise<object|null>}
   */
  async findFirewallByName(name) {
    const { items, status } = await this._walkCursor('/firewalls', 'firewall_groups');
    if (status !== undefined) return null;
    const group = items.find((g) => g.description === name);
    if (!group) return null;

    const rulesWalk = await this._walkCursor(`/firewalls/${group.id}/rules`, 'firewall_rules');
    return { ...group, rules: rulesWalk.items };
  }

  /**
   * Replace a firewall group's INBOUND rule set. Vultr has NO replace-all
   * endpoint and rules are immutable sub-resources — the only faithful
   * implementation of the cross-provider "total inbound replace" contract
   * is delete-then-recreate. Ordering safety: a group with fewer/no rules
   * DENIES inbound (Vultr firewall groups are default-deny), so the
   * transient mid-replace state locks DOWN, never exposes — the same
   * fail-closed direction every sibling's atomic replace guarantees.
   * @param {string} firewallId - group id
   * @param {object[]} rules - full replacement INBOUND rule list, Vultr
   *   shape: {ip_type, protocol, port, subnet, subnet_size, notes?}
   * @returns {Promise<void>}
   */
  async setFirewallRules(firewallId, rules) {
    // Project every row to the documented create shape BEFORE the first
    // delete. Both in-repo rule builders (buildReplicationFirewallRules,
    // applyOperatorCidrs) recycle rows read back from the rules listing,
    // and the READ shape carries fields the create endpoint rejects —
    // `source: "0.0.0.0/0"` draws "Invalid source group" (live v2 RCA
    // 2026-08-19: deletes succeeded, recreates 400'd, both HA firewalls
    // were left holding only the WG rule and 443 went dark). Because this
    // replace is delete-then-recreate, a row that cannot be recreated must
    // abort HERE, while the live rules are still intact.
    const toCreate = rules.map((r) => {
      for (const key of ['ip_type', 'protocol', 'subnet']) {
        if (r[key] === undefined || r[key] === null || r[key] === '') {
          throw new Error(
            `Vultr firewall rule missing ${key}; refusing to replace rules on ` +
              `${firewallId} with a set it could not recreate: ${JSON.stringify(r)}`,
          );
        }
      }
      if (!Number.isInteger(r.subnet_size)) {
        throw new Error(
          `Vultr firewall rule missing integer subnet_size; refusing to replace rules on ` +
            `${firewallId} with a set it could not recreate: ${JSON.stringify(r)}`,
        );
      }
      return {
        ip_type: r.ip_type,
        protocol: r.protocol,
        subnet: r.subnet,
        subnet_size: r.subnet_size,
        ...(r.port !== undefined && r.port !== '' ? { port: String(r.port) } : {}),
        ...(r.notes ? { notes: r.notes } : {}),
      };
    });

    const existing = await this._walkCursor(`/firewalls/${firewallId}/rules`, 'firewall_rules');
    if (!existing.complete) {
      throw new Error(
        `Vultr firewall ${firewallId} rules listing incomplete, refusing a partial replace`,
      );
    }

    for (const rule of existing.items) {
      const res = await fetchWithRetry(
        `${VultrProvider.API_BASE}/firewalls/${firewallId}/rules/${rule.id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!res.ok && res.status !== 404) {
        const body = await res.text().catch(() => '');
        throw new Error(`Vultr firewall rule delete failed (${res.status}): ${body}`);
      }
    }

    for (const rule of toCreate) {
      const res = await this.apiRequest(`/firewalls/${firewallId}/rules`, {
        method: 'POST',
        body: JSON.stringify(rule),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(
          `Vultr firewall rule create failed: ${error.error || 'unknown error'} ` +
            `(rule ${JSON.stringify(rule)})`,
        );
      }
    }
  }

  /**
   * Vultr-shaped replication-rule builder — see BaseProvider's abstract
   * doc. Operates on the AUGMENTED firewall object findFirewallByName
   * returns (rules attached). Idempotent: null when the peer's UDP/51821
   * rule is already present.
   * @param {object} firewall - augmented group ({...group, rules})
   * @param {string} peerIp
   * @returns {object[]|null}
   */
  buildReplicationFirewallRules(firewall, peerIp) {
    const existingRules = firewall.rules || [];
    const hasExactRule = existingRules.some(
      (r) =>
        r.protocol === 'udp' &&
        String(r.port) === WG_PORT &&
        r.subnet === peerIp &&
        r.subnet_size === 32,
    );
    if (hasExactRule) return null;
    return [
      ...existingRules.map(({ id: _id, ...rest }) => rest),
      {
        ...cidrToVultrRuleFields(`${peerIp}/32`),
        protocol: 'udp',
        port: WG_PORT,
        notes: 'wg-replication',
      },
    ];
  }

  /**
   * Rewrite the operator-locked ports' inbound rules to the given CIDR
   * list, leaving every other rule unchanged. Vultr keeps one subnet per
   * rule, so each locked port gets one rule PER CIDR (the same expansion
   * the compose program applies at create time).
   * @param {{firewallName: string, cidrs: string[]}} args
   * @returns {Promise<boolean>} true if found and updated
   */
  async applyOperatorCidrs({ firewallName, cidrs }) {
    const fw = await this.findFirewallByName(firewallName);
    if (!fw) return false;

    const kept = (fw.rules || [])
      .filter((r) => !(r.protocol === 'tcp' && OPERATOR_LOCKED_PORTS.has(String(r.port))))
      .map(({ id: _id, ...rest }) => rest);
    const lockedPorts = [
      ...new Set(
        (fw.rules || [])
          .filter((r) => r.protocol === 'tcp' && OPERATOR_LOCKED_PORTS.has(String(r.port)))
          .map((r) => String(r.port)),
      ),
    ];
    const rebuilt = lockedPorts.flatMap((port) =>
      cidrs.map((cidr) => ({
        ...cidrToVultrRuleFields(cidr),
        protocol: 'tcp',
        port,
        notes: `operator-${port}`,
      })),
    );

    await this.setFirewallRules(fw.id, [...kept, ...rebuilt]);
    return true;
  }

  /**
   * Delete a firewall group by its exact description.
   * @param {string} name
   * @returns {Promise<{deleted: boolean, everExisted: boolean, apiError: (Error|null)}>}
   */
  async deleteFirewallByName(name) {
    let everExisted = false;
    try {
      const { items, status } = await this._walkCursor('/firewalls', 'firewall_groups');
      if (status !== undefined) return { deleted: false, everExisted: false, apiError: null };
      const group = items.find((g) => g.description === name);
      if (!group) return { deleted: false, everExisted: false, apiError: null };
      everExisted = true;
      const res = await fetchWithRetry(`${VultrProvider.API_BASE}/firewalls/${group.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });
      return { deleted: res.ok || res.status === 404, everExisted, apiError: null };
    } catch (err) {
      return { deleted: false, everExisted, apiError: err };
    }
  }

  /**
   * Delete an SSH key by its exact name. Never throws; false on no match.
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  async deleteSSHKeyByName(name) {
    const { items, status } = await this._walkCursor('/ssh-keys', 'ssh_keys');
    if (status !== undefined) return false;
    const match = items.find((k) => k.name === name);
    if (!match) return false;

    const response = await fetchWithRetry(`${VultrProvider.API_BASE}/ssh-keys/${match.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    return response.ok || response.status === 404;
  }

  /**
   * List ALL VPCs (soft-fail []) — never provisioned by the compose tier,
   * enumerated so a future tier's leak can't hide behind a stub.
   * @returns {Promise<object[]>}
   */
  async listNetworks() {
    const { items, status } = await this._walkCursor('/vpcs', 'vpcs');
    return status === undefined ? items : [];
  }

  /**
   * List ALL block-storage volumes (soft-fail contract matching
   * listServers).
   * @returns {Promise<object[]>}
   */
  async listVolumes() {
    return (await this.listVolumesDetailed()).items;
  }

  /**
   * Volume listing preserving the completeness signal.
   * @returns {Promise<{ items: object[], complete: boolean, status?: number }>}
   */
  async listVolumesDetailed() {
    return this._walkCursor('/blocks', 'blocks');
  }

  /**
   * Delete a block-storage volume by id.
   * @param {string} volumeId
   * @returns {Promise<boolean>} true on success or already gone (404)
   */
  async deleteVolume(volumeId) {
    const response = await fetchWithRetry(`${VultrProvider.API_BASE}/blocks/${volumeId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    return response.ok || response.status === 404;
  }

  /**
   * List ALL load balancers (soft-fail []).
   * @returns {Promise<object[]>}
   */
  async listLoadBalancers() {
    const { items, status } = await this._walkCursor('/load-balancers', 'load_balancers');
    return status === undefined ? items : [];
  }

  /**
   * Delete a load balancer by id.
   * @param {string} lbId
   * @returns {Promise<boolean>} true on success or already gone (404)
   */
  async deleteLoadBalancer(lbId) {
    const response = await fetchWithRetry(`${VultrProvider.API_BASE}/load-balancers/${lbId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    return response.ok || response.status === 404;
  }

  // ── Destroy-sweep field accessors ───────────────────────────────────────

  /**
   * Compose-tier Vultr instances join no VPC — always [] (VPC attribution
   * lives on the VPC side of Vultr's API anyway).
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
   * Vultr's instance object carries no attached-volume ids — the
   * volume → `attached_to_instance` direction is authoritative (see
   * volumeAttachedServerIds). Always [].
   * @param {object} _server
   * @returns {string[]}
   */
  serverVolumeIds(_server) {
    return [];
  }

  /**
   * Plain region-id string.
   * @param {object} server
   * @returns {string|null}
   */
  serverRegion(server) {
    return server.region ?? null;
  }

  /**
   * A Vultr block volume attaches to at most one instance
   * (`attached_to_instance`, empty string when detached).
   * @param {object} volume
   * @returns {string[]}
   */
  volumeAttachedServerIds(volume) {
    return volume.attached_to_instance ? [volume.attached_to_instance] : [];
  }

  /**
   * @param {object} volume
   * @returns {string|null}
   */
  volumeRegion(volume) {
    return volume.region ?? null;
  }

  /**
   * Vultr block volumes carry no tags — {} always (decodeLabels of the
   * absent field). The sweep's pvc-* ownership rule therefore can never
   * match by tag on Vultr; the label-prefix rule is the only owned-name
   * signal (pinned in the per-provider accessor tests).
   * @param {object} volume
   * @returns {Object<string,string>}
   */
  volumeLabels(volume) {
    return decodeLabels(volume.tags);
  }

  /**
   * ISO `date_created` field.
   * @param {object} volume
   * @returns {string|null}
   */
  volumeCreatedAt(volume) {
    return volume.date_created ?? null;
  }

  // ── Object storage dispatch ─────────────────────────────────────────────

  /**
   * Lazily resolve the Vultr Object Storage provider class (dynamic
   * import, never top-level).
   * @returns {Promise<typeof import('./vultr-objectstorage.js').VultrObjectStorageProvider>}
   */
  static async getObjectStorageProviderClass() {
    const { VultrObjectStorageProvider } = await import('./vultr-objectstorage.js');
    return VultrObjectStorageProvider;
  }

  // ── Guided setup delegation ─────────────────────────────────────────────

  /**
   * @param {string} [projectName]
   * @param {{ save?: boolean }} [options]
   * @returns {Promise<string|null>}
   */
  static async promptApiToken(projectName, options) {
    const { getApiToken } = await import('../vultr-guided-setup.js');
    return getApiToken(projectName, options);
  }

  /**
   * @param {string} [projectName]
   * @param {{ save?: boolean, force?: boolean, skipPrompts?: boolean }} [options]
   * @returns {Promise<{accessKey: string, secretKey: string}|null>}
   */
  static async promptObjectStorageCredentials(projectName, options) {
    const { getS3Credentials } = await import('../vultr-guided-setup.js');
    return getS3Credentials(projectName, options);
  }

  // ── IaC program dispatch ────────────────────────────────────────────────

  /**
   * Lazily build the Pulumi Automation-API program for a single Vultr
   * Docker-Compose instance (dynamic import, never top-level).
   * @param {object} config
   * @returns {Promise<() => Promise<{serverIp: string, serverId: string, firewallId: string, sshKeyId: string}>>}
   */
  static async getComposeProgram(config) {
    const { buildVultrComposeProgram } = await import('../iac/programs/vultr-compose.js');
    return buildVultrComposeProgram(config);
  }
}
