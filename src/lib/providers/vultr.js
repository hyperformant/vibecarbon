/**
 * Vultr Cloud Provider
 *
 * All four tiers (PR 2 of the 2026-08 provider expansion, tier-parity wave 1,
 * and the k8s tiers of the 2026-11 k8s-everywhere work; see the
 * vultr-provider-step0-audit plan for the sourced capability audit and
 * live-probe results). The k8s user-data statics render the vultr-*-init.sh
 * boot scripts, and getK8sProgram builds iac/programs/vultr-k8s.js. The k8s
 * tiers need NVMe block storage, which one region lacks
 * (K8S_UNSUPPORTED_REGIONS).
 *
 * Vultr-shape notes (vs the Hetzner/DO/Linode templates):
 * - API v2 uses CURSOR pagination (`meta.links.next` → `&cursor=`), not
 *   page/pages — every listing routes through `_walkCursor`.
 * - Firewalls are GROUPS (identity field `description`, not label) whose
 *   rules are INBOUND-ONLY, separate resources with no replace-all PUT:
 *   setFirewallRules is a create-first minimal diff, so a rule it keeps
 *   keeps its id and the group never has none (an empty group is not
 *   enforced), and handed the caller's read it deletes only rules that
 *   read held.
 * - Instances attach at most ONE firewall group (`firewall_group_id`).
 * - Object-storage keys are per-subscription (see vultr-objectstorage.js).
 * - Rate limit: 400-request burst bucket, 1s reset (live headers
 *   2026-08-08); fetch-retry's 429 backoff covers overruns.
 *
 * API Documentation: https://www.vultr.com/api/
 */

import { canonicalCidr } from '../cidr.js';
import { fetchWithRetry } from '../fetch-retry.js';
import {
  BaseProvider,
  deleteVpcByName,
  normalizePublicKey,
  replaceWireguardPeerRules,
  standbyPairOrNeighbour,
  waitUntilServerUp,
} from './base.js';
import { deleteServerAt } from './delete-server.js';
import { decodeLabels, withAllTags } from './tag-labels.js';

// Ports whose inbound rules applyOperatorCidrs rewrites, the same set as the
// sibling providers': SSH, and the Kubernetes API, which a k8s cluster's
// group gets from the deploy after its up (K8S_OPERATOR_RULES_AFTER_UP).
const SSH_PORT = '22';
const K8S_API_PORT = '6443';
const OPERATOR_LOCKED_PORTS = new Set([SSH_PORT, K8S_API_PORT]);
// Inbound DB ports a retired external pooler once opened to the operator
// CIDRs; applyOperatorCidrs deletes any such rule (the database has no
// public port).
const RETIRED_DB_PORTS = new Set(['5432', '6543']);

// WireGuard replication port (wireguard.js WG_PORT): the k8s-ha replication
// rule, written over REST (buildReplicationFirewallRules); the member is
// contract-required and unit-pinned.
const WG_PORT = '51821';

/**
 * What Vultr treats as one firewall rule: it refuses a second with the same
 * fields. Read rows and create bodies give the same key (an icmp rule reads
 * back with port ''). The network is compared canonically (canonicalCidr):
 * `vibecarbon access` takes an IPv4 CIDR with host bits and IPv6 in any
 * spelling, and Vultr may read either back in another form. Matched
 * verbatim, such a rule is never found again, and every push would POST it
 * once more, which Vultr refuses as already defined.
 * @param {{ip_type: string, protocol: string, subnet: string, subnet_size: number, port?: string}} r
 * @returns {string}
 */
function vultrRuleKey(r) {
  const cidr = `${r.subnet}/${r.subnet_size}`;
  return [r.ip_type, r.protocol, canonicalCidr(cidr) ?? cidr, r.port ?? ''].join(' ');
}

/**
 * Refuse to build a rewrite from a firewall whose rules listing broke off.
 * A target built from part of the list misses the rest: handed that part as
 * its basis, setFirewallRules leaves the rules it never saw, an operator
 * address the rewrite was told to drop among them; handed none, it deletes
 * them all.
 * @param {{description?: string, id?: string, rulesComplete?: boolean}} firewall
 *   the group findFirewallByName returns
 */
function requireCompleteRules(firewall) {
  if (firewall.rulesComplete === false) {
    throw new Error(
      `Vultr's rules listing for firewall ${firewall.description ?? firewall.id} came back ` +
        'incomplete, so its rules were left as they are: a rewrite built from part of the ' +
        'list would delete the rules it did not see. Run the command again.',
    );
  }
}

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

// decodeLabels, the inverse of encodeLabels, is the same for the four
// tag-string providers (tag-labels.js); re-exported for the e2e sweeps.
export { decodeLabels };

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

/** walkCursor's page size and page guard: it reads at most 10,000 of a kind. */
const WALK_PAGE_SIZE = 500;
const WALK_MAX_PAGES = 20;

/**
 * Cursor-paginated collection walk (Vultr's `meta.links.next` idiom), the
 * single pagination implementation every listing in this file shares.
 * Same ≤20-page guard and completeness semantics as the sibling
 * providers' page walks.
 * @param {object} init - fetch options carrying the request's headers
 * @param {string} path - e.g. '/instances' (may carry its own query)
 * @param {string} key - response array key (e.g. 'instances')
 * @returns {Promise<{items: object[], complete: boolean, status?: number}>}
 */
async function walkCursor(init, path, key) {
  const items = [];
  const sep = path.includes('?') ? '&' : '?';
  let cursor = '';
  for (let guard = 0; guard < WALK_MAX_PAGES; guard++) {
    const response = await fetchWithRetry(
      `${VultrProvider.API_BASE}${path}${sep}per_page=${WALK_PAGE_SIZE}${cursor ? `&cursor=${cursor}` : ''}`,
      init,
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
  // The providerID on Vultr k8s nodes (`vultr://<instance-v2-id>`). There is
  // no Vultr CCM: the k3s boot scripts pre-seed it with the kubelet's
  // `provider-id` flag, and the autoscaler strips the prefix to find the
  // instance.
  static PROVIDER_ID_PREFIX = 'vultr://';
  static DEFAULT_REGION = 'ewr';
  static PRICING_URL = 'https://www.vultr.com/pricing/';

  // Cluster slug of the operator's object-storage SUBSCRIPTION (e.g.
  // `ewr1`) — effectively REQUIRED config on Vultr, see
  // vultr-objectstorage.js.
  static S3_REGION_ENV = 'VULTR_STORAGE_REGION';

  // All four tiers. compose-ha came in the 2026-08 tier-parity wave 1 (the
  // HA surface below was contract-complete since PR 2; effects/compose-ha is
  // provider-generic), k8s and k8s-ha with the 2026-11 k8s-everywhere work.
  // The k8s tiers need NVMe block storage, which one region lacks
  // (K8S_UNSUPPORTED_REGIONS).
  static SUPPORTED_TIERS = ['compose', 'compose-ha', 'k8s', 'k8s-ha'];

  static SERVER_RESOURCE_TYPE = 'vultr:index/instance:Instance';

  /**
   * Regions with no NVMe block storage, which the k8s tiers' database volume
   * needs (vultr-k8s.js's StorageClass asks for `disk_type: nvme`): sjc sells
   * only HDD block storage (`block_storage_storage_opt`, public GET
   * /v2/regions, 2026-11-25). k8s and k8s-ha refuse it (k8sRegionProblem) and
   * the region lists omit it; compose tiers use it freely.
   * @type {string[]}
   */
  static K8S_UNSUPPORTED_REGIONS = ['sjc'];

  /**
   * @param {string} region
   * @returns {string|null}
   */
  static k8sRegionProblem(region) {
    if (!VultrProvider.K8S_UNSUPPORTED_REGIONS.includes(region)) return null;
    const city = VultrProvider.REGIONS[region]?.split(',')[0] ?? region;
    return (
      `Kubernetes on Vultr does not run in ${city} (${region}): Vultr sells no NVMe block ` +
      "storage there for the cluster's database volume. Use lax, ewr or another region."
    );
  }

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
  // via the public GET /v2/plans (ram is MB on the wire; stored as GB);
  // `vhf-2c-4gb` (the compose fallback candidate) from the same endpoint on
  // 2026-10-22; `vhf-1c-2gb` (the k8s db fallback) and `vhf-3c-8gb` (its
  // scale target) on 2026-11-25.
  static FALLBACK_SERVER_TYPES = {
    'vc2-1c-2gb': { vcpu: 1, ram: 2, disk: 55 },
    'vc2-2c-4gb': { vcpu: 2, ram: 4, disk: 80 },
    'vc2-4c-8gb': { vcpu: 4, ram: 8, disk: 160 },
    'vhf-1c-2gb': { vcpu: 1, ram: 2, disk: 64 },
    'vhf-2c-4gb': { vcpu: 2, ram: 4, disk: 128 },
    'vhf-3c-8gb': { vcpu: 3, ram: 8, disk: 256 },
  };

  // Live catalog populated by fetchServerTypes(); object map (name → spec).
  static SERVER_TYPES = { ...VultrProvider.FALLBACK_SERVER_TYPES };

  // Per-region availability populated by fetchServerTypes(). Vultr's plans
  // carry a real per-region axis (`plan.locations[]`) — unlike Linode's
  // global catalog — so this map is genuine data, same shape as DO's.
  static _locationTypes = null;

  // Monthly prices captured by fetchServerTypes() from the same payload
  // (USD): plan → location → price, for each location the plan is sold in.
  // `monthly_cost` everywhere, except where `location_cost` names a
  // location's own price (sao, 1.5x, on 2026-10-22). null until a live fetch.
  static _prices = null;

  // Role candidates (see BaseProvider.ROLE_CANDIDATES): the regular vc2 plan
  // at each role's RAM floor, then the high-frequency one as its stock-out
  // fallback. The k8s master and worker take 4 GB, the db 2 GB.
  static ROLE_CANDIDATES = {
    compose: ['vc2-2c-4gb', 'vhf-2c-4gb'],
    master: ['vc2-2c-4gb', 'vhf-2c-4gb'],
    worker: ['vc2-2c-4gb', 'vhf-2c-4gb'],
    db: ['vc2-1c-2gb', 'vhf-1c-2gb'],
  };

  // x86 CPU classes (see BaseProvider.CPU_CLASSES): regular `vc2`, then
  // high-frequency `vhf`. Ranked by price: no run has measured a gap that
  // would justify the vhf surcharge, so an HA pair stays on vc2 and moves
  // both sides to vhf only when one location lacks vc2.
  static CPU_CLASSES = ['vc2', 'vhf'];

  static CPU_CLASS_LABELS = { vc2: 'regular (vc2)', vhf: 'high-frequency (vhf)' };

  /**
   * @param {string} type
   * @returns {string|null}
   */
  static cpuClassOf(type) {
    const family = typeof type === 'string' ? type.split('-')[0] : '';
    return VultrProvider.CPU_CLASSES.includes(family) ? family : null;
  }

  // Every instance's public IPv4 is included in its plan price
  // (vultr.com/pricing, read 2026-10-22).
  static IPV4_MONTHLY = 0;

  // Prices are in USD.
  static CURRENCY = '$';

  static DEFAULT_TYPE = 'vc2-2c-4gb';

  // ── Engine-literal statics ──────────────────────────────────────────────
  static DEFAULT_COMPOSE_TYPE = 'vc2-2c-4gb';
  // The k8s node type a k8s-ha standby falls back to when no type was given
  // (effects/k8s-ha.js); the master and worker candidates' first.
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
   * Kubernetes cluster-addon asset identity. The CSI names come from
   * vultr-csi v0.19.1: a StatefulSet controller and a DaemonSet node
   * plugin, both labelled with a bare `app=` key. No CCM: k3s's embedded
   * cloud controller runs instead, so the CCM entries stay empty.
   * @type {{
   *   csiNodeDaemonSet: string,
   *   csiControllerSelector: string,
   *   ccmDeployment: string,
   *   ccmSelector: string,
   *   networkEnvVar: string,
   * }}
   */
  static K8S_ASSETS = {
    csiNodeDaemonSet: 'daemonset/csi-vultr-node',
    csiControllerSelector: 'app=csi-vultr-controller',
    ccmDeployment: '',
    ccmSelector: '',
    networkEnvVar: '',
  };

  /**
   * The StorageClass the k3s master boot script creates for vultr-csi: NVMe
   * block storage, Delete reclaim, expandable, bound where the pod lands.
   * The driver's own classes (`vultr-block-storage` and five more) carry no
   * default annotation and bind at once. The literal-guard census requires
   * every registered provider's value to be distinct and to live in this
   * file.
   * @type {string}
   */
  static K8S_STORAGE_CLASS = 'vultr-block-storage-vibecarbon';

  /**
   * Vultr's NVMe block volumes start at 10 GB (POST /v2/blocks), and
   * vultr-csi passes a claim's request through unrounded, so a smaller claim
   * never binds. See BaseProvider.K8S_MIN_VOLUME_GI.
   * @type {number}
   */
  static K8S_MIN_VOLUME_GI = 10;

  /**
   * The `vultr-csi` Secret (key `api-key`) the CSI controller reads. See
   * BaseProvider.k8sCloudSecrets.
   * @param {{token: string}} values
   * @returns {Array<{namespace: string, name: string, stringData: Record<string, string>}>}
   */
  static k8sCloudSecrets({ token }) {
    return [{ namespace: 'kube-system', name: 'vultr-csi', stringData: { 'api-key': token } }];
  }

  /**
   * What the deploy.yml of an earlier vibecarbon's GitOps layer wrote into
   * every cluster, whatever the provider (`configure cicd`): kube-system/hcloud,
   * from the repo's HETZNER_API_TOKEN Actions secret. Nothing on a Vultr
   * cluster reads it. No Vultr boot script ever wrote a cloud Secret, so
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
   * No fixed range: vultr-k8s.js derives a /24 per cluster
   * (vpcCidrForCluster) and exports it as `vpcCidr`, the value deployK3s
   * reads. @type {string}
   */
  static DEFAULT_VPC_CIDR = '';

  /**
   * The k8s node image: os_id 2760, "Ubuntu 26.04 LTS x64" (public
   * GET /v2/os), the compose image. A string for interface parity;
   * vultr-k8s.js and the autoscaler's createServer convert with Number().
   * @type {string}
   */
  static K8S_IMAGE = '2760';

  /**
   * vultr-k8s.js declares no operator rule (SSH 22, the Kubernetes API
   * 6443): those are REST's, as the k8s-ha replication rule is, so each rule
   * of the group has one writer (see BaseProvider). @type {boolean}
   */
  static K8S_OPERATOR_RULES_AFTER_UP = true;

  /**
   * No reserved IP, as on DigitalOcean: a cluster's domain points at the
   * master's own address (vultr-k8s.js says why; BaseProvider). @type {boolean}
   */
  static K8S_FLOATING_IP = false;

  /**
   * A deploy that failed partway (the VPC made, the master never ready) can
   * leave the VPC, firewall group and SSH key outside what `pulumi destroy`
   * removes, as on DigitalOcean and Linode, so destroy also removes them by
   * name (sweepK8sBackstopTargets, destroy.js). @type {boolean}
   */
  static K8S_DESTROY_BACKSTOP = true;

  /**
   * Vultr block volumes carry no tags, so a detached `pvc-*` volume in the
   * cluster's region could be any cluster's: destroy reports one no capture
   * names instead of deleting it (BaseProvider.ORPHAN_VOLUME_REGION_GUESS).
   * @type {boolean}
   */
  static ORPHAN_VOLUME_REGION_GUESS = false;

  // ── k8s boot user-data (carbon/cloud-init/k3s/vultr-*-init.sh) ──────────

  /**
   * Render the k3s master boot script. No API token: deployK3s hands the
   * CSI driver's credential to the cluster itself (applyCloudSecrets,
   * k8sCloudSecrets). No project tag either: Vultr block volumes take no
   * tags.
   * @param {{
   *   k3s_version: string,
   *   k3s_token: string,
   * }} vars - The caller's whole share of the template's var set. The
   *   rest, the CSI install's image rewrites (`csi_image_rewrites`), is
   *   added here, from src/lib/images.js.
   * @returns {Promise<string>}
   */
  static async getK8sMasterUserData(vars) {
    const { loadCloudInit, masterAddedVars, renderScript } = await import('../iac/cloud-init.js');
    return renderScript(loadCloudInit('vultr-master-init.sh'), {
      ...vars,
      ...masterAddedVars('vultr'),
    });
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
    return renderScript(loadCloudInit('vultr-worker-init.sh'), vars);
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
    return renderScript(loadCloudInit('vultr-worker-init.sh', { role: 'db' }), vars);
  }

  // ── k8s program ─────────────────────────────────────────────────────────

  /**
   * Lazily build the Pulumi Automation-API program for a single Vultr k3s
   * cluster (dynamic import, never top-level).
   * @param {import('../iac/programs/vultr-k8s.js').K8sStackConfig} config
   * @returns {Promise<() => Promise<{masterIp: string, masterId: string, masterPrivateIp: string, dbIp: string, dbPrivateIp: string, workerIps: string[], networkId: string, sshKeyId: string, k3sToken: string, clusterName: string, vpcCidr: string}>>}
   *   No `floatingIp`: K8S_FLOATING_IP is false (the domain points at masterIp).
   */
  static async getK8sProgram(config) {
    const { buildVultrK8sProgram } = await import('../iac/programs/vultr-k8s.js');
    return buildVultrK8sProgram(config);
  }

  // ── Compose-tier replacement-server identity ────────────────────────────

  /**
   * Vultr images are numeric os_ids, not slugs — `2760` = "Ubuntu 26.04
   * LTS x64" (live GET /v2/os, 2026-11-05). Stored as a STRING for
   * interface parity; both wire boundaries (createServer's REST body and
   * vultr-compose.js's `osId`) convert with Number(). MUST byte-match the
   * program's literal.
   * @type {string}
   */
  static COMPOSE_IMAGE = '2760';

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
      const { items: plans, complete } = await walkCursor(
        apiToken ? { headers: { Authorization: `Bearer ${apiToken}` } } : {},
        '/plans',
        'plans',
      );
      if (!complete) return false;
      if (plans.length === 0) return false;

      const catalog = VultrProvider.parseCatalog(plans);
      if (Object.keys(catalog.SERVER_TYPES).length === 0) return false;

      Object.assign(VultrProvider, catalog);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The catalog statics fetchServerTypes sets, from the `/v2/plans` entries
   * it walked. Pure, so the unit fixtures load through the same code as the
   * live path (tests/unit/helpers/catalog-fixtures.ts).
   * @param {object[]} plans
   * @returns {{SERVER_TYPES: object, _locationTypes: Record<string, Set<string>>, _prices: Record<string, Record<string, number|null>>}}
   */
  static parseCatalog(plans) {
    const types = {};
    const locationTypes = {};
    const prices = {};
    for (const plan of plans) {
      types[plan.id] = {
        vcpu: plan.vcpu_count,
        ram: plan.ram / 1024,
        disk: plan.disk,
      };
      prices[plan.id] = {};
      for (const region of plan.locations || []) {
        if (!locationTypes[region]) locationTypes[region] = new Set();
        locationTypes[region].add(plan.id);
        const monthly = plan.location_cost?.[region]?.monthly_cost ?? plan.monthly_cost;
        prices[plan.id][region] = typeof monthly === 'number' ? monthly : null;
      }
    }
    return { SERVER_TYPES: types, _locationTypes: locationTypes, _prices: prices };
  }

  // getServerTypesForRegion and resolveServerTypeForRegion are the base's
  // (base.js): live per-region data when fetched (plan.locations is a real
  // axis on Vultr), the fallback catalog otherwise, with
  // `architecture: 'x86'` constant because Vultr's cloud-compute lines are
  // x86.

  /**
   * The static HA standby pair — conventional pairs, then same-continent,
   * mirroring the sibling providers' contract (contract-tested for every
   * region). lax pairs with sjc, which the k8s tiers cannot use:
   * cheapestStandbyRegion gives that pair way to a partner that can.
   * @param {string} primaryRegion
   * @returns {string} the static pair, before prices
   */
  static conventionalStandbyRegion(primaryRegion) {
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
    return (
      standbyPairOrNeighbour(VultrProvider.REGION_CONTINENT, primaryRegion, PAIRS) ??
      (primaryRegion === 'ewr' ? 'ord' : 'ewr')
    );
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

  // ── Instance methods ────────────────────────────────────────────────────
  // Transport split mirrors the sibling providers: CRUD via this.apiRequest,
  // listings/teardown via a bare fetchWithRetry (listings through
  // _walkCursor, teardown through this.bareRequest),
  // getServerSummary a raw fetch with a hard 5s abort.

  /**
   * walkCursor with this account's token.
   * @param {string} path - e.g. '/instances' (may carry its own query)
   * @param {string} key - response array key (e.g. 'instances')
   * @returns {Promise<{items: object[], complete: boolean, status?: number}>}
   */
  async _walkCursor(path, key) {
    return walkCursor({ headers: { Authorization: `Bearer ${this.apiToken}` } }, path, key);
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
   * @param {string} config.image - numeric os_id as a string ('2760')
   * @param {(string|number)[]} [config.sshKeys] - key UUIDs or names
   * @param {string|number} [config.sshKeyId] - single-entry fallback
   * @param {object} [config.labels]
   * @param {string} [config.userData] - RAW cloud-init YAML; base64'd here
   * @param {(string|number)[]} [config.networks] - VPC ids; each becomes
   *   `attach_vpc` (the autoscaler passes the cluster VPC; compose passes none)
   * @param {(string|number)[]} [config.firewalls]
   * @returns {Promise<{id: string, server: object, reused?: boolean}>}
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
    // A hostname is one DNS label, at most 63 characters. A longer name (a
    // 63-character project's `-prod-db-new` scale replacement) keeps Vultr's
    // default hostname rather than failing the create; k8s boot scripts set
    // their own with hostnamectl anyway.
    if (name.length <= 63) {
      body.hostname = name;
    }
    if (userData) {
      body.user_data = Buffer.from(userData, 'utf-8').toString('base64');
    }
    if (Array.isArray(networks) && networks.length > 0) {
      body.attach_vpc = networks.map(String);
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
    // Bare DELETE in both modes: Vultr's no-wait path never went through
    // apiRequest.
    return deleteServerAt(this, `/instances/${serverId}`, serverId, {
      waitUntilGone,
      bareDelete: true,
      reason: (error) => error.error,
    });
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
      // The status goes with it: a 401, 403 or 404 is a token that can't see
      // the instance (assertTokenSeesCluster).
      throw Object.assign(new Error(`Failed to get server: ${error.error || 'Unknown error'}`), {
        status: response.status,
      });
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
    return waitUntilServerUp(
      timeout,
      async () => {
        const response = await this.apiRequest(`/instances/${serverId}`);
        const { instance } = await response.json();
        return instance;
      },
      (instance) => instance.server_status === 'ok' && VultrProvider.getPublicIP(instance),
    );
  }

  /**
   * Lightweight status summary — single raw fetch, hard 5s abort,
   * null-on-any-failure (same never-retry contract as the siblings).
   * @param {string} serverId
   * @returns {Promise<{status: string, serverType: string|null}|null>}
   */
  async getServerSummary(serverId) {
    return this._serverSummaryAt(`/instances/${serverId}`, ({ instance }) => ({
      status: instance.status,
      serverType: instance.plan || null,
    }));
  }

  /**
   * Vultr's view of an instance for the failure log (see
   * BaseProvider.describeServerForDiagnosis): GET /instances/{id} only.
   * `server_status` is the operating system's state (`installingbooting`,
   * `ok`: see waitForServer), and the power and subscription states ride
   * beside it as `detail`. Its addresses are `main_ip` (getPublicIP, which
   * reads the '0.0.0.0' placeholder as none) and `internal_ip`, its VPC
   * address, empty until it has one. Vultr's API keeps no history of what it
   * did to an instance, so there are no recent actions to read.
   * @param {string} serverId
   * @returns {Promise<import('./base.js').ServerProviderView>}
   */
  async describeServerForDiagnosis(serverId) {
    const { instance } = await this._readForDiagnosis(`/instances/${serverId}`);
    if (!instance) throw new Error(`Vultr returned no instance for ${serverId}`);
    return {
      id: instance.id,
      name: instance.label ?? null,
      status: instance.server_status ?? null,
      detail: `power ${instance.power_status ?? '?'}, subscription ${instance.status ?? '?'}`,
      created: instance.date_created ?? null,
      location: instance.region ?? null,
      publicIp: VultrProvider.getPublicIP(instance),
      privateIp: instance.internal_ip || null,
      events: [],
      eventsNote: "Vultr's API keeps no event history for an instance",
    };
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
    const targetMaterial = normalizePublicKey(publicKey);

    const { items } = await this._walkCursor('/ssh-keys', 'ssh_keys');
    const match = items.find((k) => normalizePublicKey(k.ssh_key) === targetMaterial);
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
   * Instance listing preserving the walk's completeness signal — see
   * BaseProvider.listServersDetailed.
   * @param {object} [labels]
   * @returns {Promise<{ items: object[], complete: boolean, status?: number }>}
   */
  async listServersDetailed(labels = {}) {
    const { items, complete, status } = await this._walkCursor('/instances', 'instances');

    const filtered = withAllTags(items, labels, encodeLabel);

    return status === undefined
      ? { items: filtered, complete }
      : { items: filtered, complete, status };
  }

  /**
   * Find instances by exact label (client-side; soft-fail [] on non-ok).
   * @param {string} name
   * @param {{ strict?: boolean }} [options] - reject rather than answer `[]`
   *   when the listing isn't complete (BaseProvider.findServersByName)
   * @returns {Promise<object[]>}
   */
  async findServersByName(name, { strict = false } = {}) {
    const { items, complete, status } = await this._walkCursor('/instances', 'instances');
    if (strict && !complete) throw this.serverLookupError(name, status);
    if (status !== undefined) return [];
    return items.filter((i) => i.label === name);
  }

  /**
   * Look up a firewall GROUP by its exact description (Vultr's identity
   * field for groups). The returned object is AUGMENTED with `rules` (the
   * group's inbound rule list, fetched here) so
   * buildReplicationFirewallRules/applyOperatorCidrs can operate on it:
   * Vultr keeps rules as separate sub-resources, unlike the siblings'
   * embedded rule arrays. `rulesComplete` is false when that listing broke
   * off; both rule builders then refuse (requireCompleteRules).
   * @param {string} name
   * @returns {Promise<object|null>}
   */
  async findFirewallByName(name) {
    const { items, status } = await this._walkCursor('/firewalls', 'firewall_groups');
    if (status !== undefined) return null;
    const group = items.find((g) => g.description === name);
    if (!group) return null;

    const rulesWalk = await this._walkCursor(`/firewalls/${group.id}/rules`, 'firewall_rules');
    return { ...group, rules: rulesWalk.items, rulesComplete: rulesWalk.complete };
  }

  /**
   * Make a firewall group's INBOUND rules the given set, as a minimal diff.
   * Vultr has no replace-all endpoint and its rules are immutable
   * sub-resources with their own ids, so this lists the live rules, creates
   * the ones the set adds, then deletes the ones it drops. A rule the set
   * keeps keeps its id, so the rules a k8s program owns (vultr-k8s.js: the
   * web and the VPC) are where its next refresh looks for them, and a REST
   * writer (applyOperatorCidrs, the replication rule) changes only its own.
   *
   * Creates go first because Vultr does not enforce a group with no rules:
   * an empty group lets every packet in. So the group never empties on the
   * way (between the creates and the deletes it holds both sets, the old
   * one's addresses still let in for those few calls), and an empty set is
   * refused on a group that has rules (on one with none it is already
   * true, and nothing is done). It ends where the delete-all-then-recreate
   * it took over from ended: the group holds exactly the set given.
   *
   * A rule is matched on the fields Vultr refuses to repeat (ip_type,
   * protocol, the network, port; vultrRuleKey, which compares the network
   * canonically): a set naming one twice makes it once, and a live rule
   * matching one keeps its notes.
   *
   * Every caller builds the set from an earlier read of the group, and
   * other writers change the group's rules between that read and this
   * write: the replication rule from a parallel HA step, an access push
   * from another terminal. Handed that read as `basis`, this deletes only
   * the rules the read held and the set drops, so a rule made since is
   * kept. Without one it deletes every live rule the set lacks.
   * @param {string} firewallId - group id
   * @param {object[]} rules - full INBOUND rule set, Vultr shape
   *   {ip_type, protocol, port, subnet, subnet_size, notes?}; read rows work
   * @param {{rules?: object[]}} [basis] - the group as findFirewallByName
   *   read it, the read `rules` was built from
   * @returns {Promise<void>}
   */
  async setFirewallRules(firewallId, rules, basis) {
    // Project every row to the documented create shape BEFORE the first
    // write. Both in-repo rule builders (buildReplicationFirewallRules,
    // applyOperatorCidrs) recycle rows read back from the rules listing,
    // and the READ shape carries fields the create endpoint rejects —
    // `source: "0.0.0.0/0"` draws "Invalid source group" (live v2 RCA
    // 2026-08-19: deletes succeeded, recreates 400'd, both HA firewalls
    // were left holding only the WG rule and 443 went dark). A row that
    // cannot be created must abort HERE, while the live rules are intact.
    const wanted = rules.map((r) => {
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
    // An empty set on a group with no rules is already true: a deploy killed
    // between the group's create and its first rule's leaves one, and the
    // retry's access push finds nothing to write. On a group with rules it
    // would delete them all.
    if (wanted.length === 0) {
      if (existing.items.length === 0) return;
      throw new Error(
        `Refusing to delete every rule of Vultr firewall ${firewallId}: Vultr does not ` +
          'enforce a group with none, so its servers would take traffic on every port.',
      );
    }

    const target = new Map(wanted.map((r) => [vultrRuleKey(r), r]));
    // The rules this write may drop: those the caller's read held. One made
    // since is another writer's, so it stays.
    const read = basis ? new Set((basis.rules || []).map(vultrRuleKey)) : null;
    const live = new Map();
    const dropped = [];
    for (const rule of existing.items) {
      const key = vultrRuleKey(rule);
      if (target.has(key)) {
        // A second live rule with the same fields (Vultr refuses to make
        // one, so only a race leaves it) goes: the first still lets it in.
        if (live.has(key)) dropped.push(rule);
        else live.set(key, rule);
      } else if (!read || read.has(key)) {
        dropped.push(rule);
      }
    }

    for (const [key, rule] of target) {
      if (live.has(key)) continue;
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

    for (const rule of dropped) {
      const res = await this.bareRequest(`/firewalls/${firewallId}/rules/${rule.id}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 404) {
        const body = await res.text().catch(() => '');
        throw new Error(`Vultr firewall rule delete failed (${res.status}): ${body}`);
      }
    }
  }

  /**
   * Vultr-shaped replication-rule builder — see BaseProvider's abstract
   * doc. Operates on the AUGMENTED firewall object findFirewallByName
   * returns (rules attached). The reconcile is the shared
   * replaceWireguardPeerRules: the UDP/51821 rule follows the current peer
   * (an old peer's rule is dropped), null when already correct.
   * @param {object} firewall - augmented group ({...group, rules})
   * @param {string} peerIp
   * @returns {object[]|null}
   */
  buildReplicationFirewallRules(firewall, peerIp) {
    requireCompleteRules(firewall);
    const rules = replaceWireguardPeerRules(firewall.rules || [], peerIp, {
      isWireguardRule: (r) => r.protocol === 'udp' && String(r.port) === WG_PORT,
      admitsOnlyPeer: (r, ip) => r.subnet === ip && Number(r.subnet_size) === 32,
      buildPeerRule: (ip) => ({
        ...cidrToVultrRuleFields(`${ip}/32`),
        protocol: 'udp',
        port: WG_PORT,
        notes: 'wg-replication',
      }),
    });
    return rules === null ? null : rules.map(({ id: _id, ...rest }) => rest);
  }

  /**
   * Rewrite the operator-locked ports' inbound rules to the given CIDR
   * list, deleting any tcp/5432 or tcp/6543 rule (RETIRED_DB_PORTS), and
   * leaving every other rule unchanged. Vultr keeps one subnet per
   * rule, so each locked port gets one rule PER CIDR (the same expansion
   * the compose program applies at create time). The ports rewritten are
   * the locked ones the group has rules on, plus `ports`: a k8s cluster's
   * group has neither 22 nor 6443 until the deploy writes them after its up
   * (writeOperatorRulesAfterUp, K8S_OPERATOR_RULES_AFTER_UP). The write is
   * setFirewallRules' minimal diff, so an unchanged rule keeps its id, and
   * it is handed this read, so a rule another writer made since stays. A
   * group whose rules listing broke off is refused (requireCompleteRules).
   * @param {{firewallName: string, cidrs: string[], ports?: string[]}} args
   * @returns {Promise<boolean>} true if found and updated
   */
  async applyOperatorCidrs({ firewallName, cidrs, ports = [] }) {
    for (const port of ports) {
      if (!OPERATOR_LOCKED_PORTS.has(String(port))) {
        throw new Error(
          `Port ${port} is not an operator port (${[...OPERATOR_LOCKED_PORTS].join(', ')})`,
        );
      }
    }
    const fw = await this.findFirewallByName(firewallName);
    if (!fw) return false;
    requireCompleteRules(fw);

    const kept = (fw.rules || [])
      .filter((r) => !(r.protocol === 'tcp' && OPERATOR_LOCKED_PORTS.has(String(r.port))))
      .filter((r) => !(r.protocol === 'tcp' && RETIRED_DB_PORTS.has(String(r.port))))
      .map(({ id: _id, ...rest }) => rest);
    const lockedPorts = [
      ...new Set([
        ...(fw.rules || [])
          .filter((r) => r.protocol === 'tcp' && OPERATOR_LOCKED_PORTS.has(String(r.port)))
          .map((r) => String(r.port)),
        ...ports.map(String),
      ]),
    ];
    const rebuilt = lockedPorts.flatMap((port) =>
      cidrs.map((cidr) => ({
        ...cidrToVultrRuleFields(cidr),
        protocol: 'tcp',
        port,
        notes: `operator-${port}`,
      })),
    );

    await this.setFirewallRules(fw.id, [...kept, ...rebuilt], fw);
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
      const res = await this.bareRequest(`/firewalls/${group.id}`, { method: 'DELETE' });
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

    return this.deleteGone(`/ssh-keys/${match.id}`);
  }

  /**
   * List ALL VPCs (soft-fail []). The k8s tiers make one per stack,
   * described `${clusterName}-network` (vultr-k8s.js); `name` is the
   * provider-neutral identity callers match on (autoscaler groups.js,
   * destroy.js), and Vultr calls it `description`. The compose tier makes
   * none.
   * @returns {Promise<object[]>}
   */
  async listNetworks() {
    const { items, status } = await this.listNetworksDetailed();
    return status === undefined ? items : [];
  }

  /**
   * listNetworks with the walk's completeness signal, for a caller that must
   * not read part of the list as the whole (deleteVpcByName).
   * @returns {Promise<{items: object[], complete: boolean, status?: number}>}
   */
  async listNetworksDetailed() {
    const { items, complete, status } = await this._walkCursor('/vpcs', 'vpcs');
    return { items: items.map((n) => ({ ...n, name: n.description })), complete, status };
  }

  /**
   * Delete a VPC by its exact description (listNetworks' `name`). Vultr
   * refuses while an instance is still attached to it; that comes back as
   * `apiError` (an ordering bug in the caller), never as a not-found
   * (deleteVpcByName).
   * @param {string} name
   * @returns {Promise<{deleted: boolean, everExisted: boolean, apiError: (Error|null)}>}
   * @throws when the VPC listing cannot be read whole (deleteVpcByName)
   */
  async deleteNetworkByName(name) {
    return deleteVpcByName(this, name);
  }

  /**
   * GET one resource by its path, for the pre-refresh prune
   * (lib/iac/vultr-gone-resources.js): the HTTP status and the API's own
   * `error` text, null when the body has none. fetchWithRetry retries a 429,
   * a 5xx and a network error; a network that never answers throws.
   * @param {string} endpoint - e.g. `/instances/<id>`
   * @returns {Promise<{status: number, error: string|null}>}
   */
  async readResourceStatus(endpoint) {
    const response = await this.bareRequest(endpoint);
    const text = await response.text().catch(() => '');
    if (response.ok) return { status: response.status, error: null };
    let error = null;
    try {
      const body = JSON.parse(text);
      if (typeof body?.error === 'string') error = body.error;
    } catch {
      /* not JSON: not the API's own answer */
    }
    return { status: response.status, error };
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
    return this.deleteGone(`/blocks/${volumeId}`);
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
    return this.deleteGone(`/load-balancers/${lbId}`);
  }

  // ── Destroy-sweep field accessors ───────────────────────────────────────

  /**
   * VPC ids the instance is attached to: Vultr's instance object lists them
   * as `vpcs: [{id, subnet}]` (govultr Instance.VPCs). [] for an instance in
   * no VPC (every compose instance).
   * @param {object} server
   * @returns {string[]}
   */
  serverNetworkIds(server) {
    // govultr PR #481 (Vultr's, merged 2026-10-22): Instance.VPCs `json:"vpcs"`, each {id, subnet}.
    return Array.isArray(server?.vpcs) ? server.vpcs.map((v) => v.id) : [];
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
   * Vultr names a block volume with `label`; a CSI volume's is its request
   * name, `pvc-<16 hex>` (vultr-csi).
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
