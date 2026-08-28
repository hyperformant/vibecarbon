/**
 * DigitalOcean Cloud Provider
 *
 * B2 scope: identity/credentials statics, catalog statics, and the
 * IaC/guided-setup/object-storage DISPATCH statics (dynamic-import stubs —
 * their targets are created by later tasks: B4 digitalocean-spaces.js, B5
 * iac/programs/digitalocean-compose.js, B6 digitalocean-guided-setup.js).
 * Instance methods (createServer, deleteServer, ...) are intentionally left
 * unimplemented here — they inherit BaseProvider's abstract throws until B3.
 *
 * DigitalOcean is fully supported and proves the BaseProvider contract is
 * genuinely cloud-agnostic: it supports all four tiers —
 * `compose`/`compose-ha`/`k8s`/`k8s-ha` (see SUPPORTED_TIERS below).
 * `getK8sProgram` (M3 Task 5) is a real dynamic-import dispatch to
 * `iac/programs/digitalocean-k8s.js`, same shape as `getComposeProgram`;
 * `k8s-ha` (d4, 2026-08-27) reuses that same program twice — one stack per
 * region — under the provider-generic HA fan-out in effects/k8s-ha.js.
 *
 * API Documentation: https://docs.digitalocean.com/reference/api/
 */

import { fetchWithRetry } from '../fetch-retry.js';
import { pollUntil } from '../retry.js';
import { BaseProvider } from './base.js';

// C9-equivalent — the ingress ports applyOperatorCidrs's rule-rewrite
// touches, mirroring Hetzner's set: SSH, k8s API, and the Supavisor pooler
// ports (compose deploys scope 5432/6543 to operator CIDRs).
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

// The single replication port for the WireGuard tunnel (see wireguard.js —
// WG_PORT=51821; 51820 is flannel-wg's). Shared by buildReplicationFirewallRules.
const WG_PORT = '51821';

/**
 * Encode a label key/value pair into a DigitalOcean tag string. DO tags only
 * allow letters, numbers, `:`, `_`, `-` — every other character is replaced
 * with `-`. Named export (not a class member) so the Pulumi IaC program (B5)
 * can import it directly and tag its `@pulumi/digitalocean` resources with
 * the identical encoding used here, keeping REST and IaC tag shapes from
 * ever drifting apart.
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
export function encodeLabel(key, value) {
  return `${key}:${value}`.replace(/[^A-Za-z0-9:_-]/g, '-');
}

/**
 * Encode a labels object into an array of DO tag strings (encodeLabel per
 * entry) — the shape DO's `tags` droplet field and `?tag_name=` query param
 * expect.
 * @param {Object<string,string>} [labels]
 * @returns {string[]}
 */
export function encodeLabels(labels = {}) {
  return Object.entries(labels).map(([k, v]) => encodeLabel(k, v));
}

/**
 * The one key this codebase tags resources with whose canonical (pre-encode)
 * form contains a character `encodeLabel` mangles — `/` becomes `-`, so
 * `cluster-autoscaler/node` round-trips through the wire as
 * `cluster-autoscaler-node`. `encodeLabel`'s mangling is lossy IN GENERAL
 * (any `-` on the wire is ambiguous between "was always a dash" and "was
 * some other disallowed character"), but within this codebase's known,
 * fixed tag-key set (see serverLabels/volumeLabels' consumers — destroy.js's
 * cleanup* policy functions and carbon-autoscaler's node-group selector) no
 * OTHER key is spelled `cluster-autoscaler-node` before encoding, so
 * un-mangling this one prefix back to its slash form is unambiguous here. A
 * future key that introduces its own `/` (or any other mangled character)
 * needs its own entry, or decodeLabels silently returns the wire-mangled key
 * instead of the original.
 * @type {Object<string,string>}
 */
const KNOWN_MANGLED_LABEL_KEYS = { 'cluster-autoscaler-node': 'cluster-autoscaler/node' };

/**
 * Decode a DO tag array back into a flat label map — the inverse of
 * encodeLabels for this codebase's known key set (see
 * KNOWN_MANGLED_LABEL_KEYS's doc for the one collision this does NOT attempt
 * to resolve generically). Splits each tag on its FIRST `:` — safe because
 * every value this codebase encodes (cluster/environment/project names,
 * `vibecarbon`, `static`, `worker-pool`, ...) is itself colon-free. Tags
 * that don't contain `:` (e.g. a plain un-encoded tag from outside
 * vibecarbon) are skipped rather than guessed at.
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
 * Normalize an OpenSSH public key to `${type} ${base64Body}` for MATERIAL
 * comparison. DigitalOcean dedupes SSH keys by fingerprint (the type+body
 * bytes) account-wide, regardless of name or trailing comment — see
 * createSSHKey's doc for why this matters. Collapses whitespace runs and
 * drops the optional trailing comment field, so two representations of the
 * same key (different comment, different spacing) normalize identically.
 * @param {string} [publicKey]
 * @returns {string}
 */
export function normalizePublicKey(publicKey) {
  const [type, body] = (publicKey || '').trim().split(/\s+/);
  return `${type || ''} ${body || ''}`.trim();
}

export class DigitalOceanProvider extends BaseProvider {
  /**
   * Documented object-storage operational limits (docs.digitalocean.com,
   * verified 2026-08-15: products/spaces/details/limits). New Spaces buckets
   * support 800 total operations per second; no per-source-IP or connection
   * limits are published, and no consistency guarantee is documented.
   */
  static OBJECT_STORAGE_LIMITS = {
    requestsPerSecondPerBucket: 800,
    requestsPerSecondPerSourceIp: null,
    parallelConnectionsPerSourceIp: null,
    consistency: 'undocumented',
    evidenceUrl: 'https://docs.digitalocean.com/products/spaces/details/limits/',
    verifiedOn: '2026-08-15',
  };

  static NAME = 'DigitalOcean';
  static API_BASE = 'https://api.digitalocean.com/v2';
  // Ours (env-first token env var) — see resolveProviderToken (index.js).
  static TOKEN_ENV = 'DIGITALOCEAN_API_TOKEN';
  // Read by @pulumi/digitalocean and doctl — never derive/rename.
  static CLI_TOKEN_ENV = 'DIGITALOCEAN_TOKEN';
  // The pair getS3Credentials (digitalocean-guided-setup.js) reads before
  // prompting. Independent of Hetzner's HETZNER_ACCESS_KEY/HETZNER_SECRET_KEY on
  // purpose — the two providers' object stores are separate accounts.
  static OBJECT_STORAGE_ENV = ['DIGITALOCEAN_ACCESS_KEY', 'DIGITALOCEAN_SECRET_KEY'];
  // Read by the DO CCM at node bootstrap to match the k8s Node against its
  // droplet — stamped on real nodes now that SUPPORTED_TIERS includes `k8s`.
  static PROVIDER_ID_PREFIX = 'digitalocean://';
  static DEFAULT_REGION = 'nyc3';
  static PRICING_URL = 'https://www.digitalocean.com/pricing/droplets';

  // Env var override name for the Spaces (S3-compatible) client's region.
  static S3_REGION_ENV = 'DIGITALOCEAN_STORAGE_REGION';

  // Dedicated-project id for ensureProjectAssignment — persisted to
  // .env.local by the deploy/scale call sites on first find-or-create so a
  // console rename never causes a second project.
  static PROJECT_ID_ENV = 'DIGITALOCEAN_PROJECT_ID';

  // M3 Task 6 lifted k8s; d4 (2026-08-27) lifted k8s-ha — the pilot-light
  // standby is the SAME digitalocean-k8s.js program instantiated in the
  // standby region (getDefaultStandbyRegion below picks it), with failover
  // as a pure DNS flip between the two clusters' own reserved IPs.
  static SUPPORTED_TIERS = ['compose', 'compose-ha', 'k8s', 'k8s-ha'];

  // Droplet regions WITH Spaces availability only — keeps backup/S3 traffic
  // in-region (a region that can host a droplet but not a Spaces bucket
  // would force cross-region backup traffic, which we don't want as a
  // silent default).
  static REGIONS = {
    nyc3: 'New York 3',
    sfo3: 'San Francisco 3',
    ams3: 'Amsterdam 3',
    fra1: 'Frankfurt 1',
    lon1: 'London 1',
    tor1: 'Toronto 1',
    sgp1: 'Singapore 1',
    blr1: 'Bangalore 1',
    syd1: 'Sydney 1',
    atl1: 'Atlanta 1',
  };

  // Continent grouping for HA standby selection — same purpose as
  // HetznerProvider.REGION_CONTINENT (see getDefaultStandbyRegion below).
  static REGION_CONTINENT = {
    nyc3: 'na',
    sfo3: 'na',
    tor1: 'na',
    atl1: 'na',
    ams3: 'eu',
    fra1: 'eu',
    lon1: 'eu',
    sgp1: 'ap',
    blr1: 'ap',
    syd1: 'ap',
  };

  static HA_REGIONS = ['nyc3', 'sfo3'];

  // Offline fallback catalog — used when the API is unreachable or no token
  // is available. Specs only; prices are intentionally not hard-coded here
  // (see PRICING_URL). DigitalOcean's Basic (`s-*`) droplet line is uniform
  // across all regions (unlike Hetzner's architecture-split cx/cpx/cax), so
  // there's no per-region fallback variant to maintain here.
  // Entries live-verified 2026-07-24 via DO API.
  static FALLBACK_SERVER_TYPES = {
    's-1vcpu-2gb': { vcpu: 1, ram: 2, disk: 50 },
    's-2vcpu-2gb': { vcpu: 2, ram: 2, disk: 60 },
    's-2vcpu-4gb': { vcpu: 2, ram: 4, disk: 80 },
    's-4vcpu-8gb': { vcpu: 4, ram: 8, disk: 160 },
  };

  // Live catalog populated by fetchServerTypes(). Falls back to
  // FALLBACK_SERVER_TYPES. NOTE: kept as an object map (name -> spec),
  // matching HetznerProvider's SERVER_TYPES shape and the
  // `Provider.SERVER_TYPES).toHaveProperty(Provider.DEFAULT_TYPE)` contract
  // invariant (provider-contract.test.ts) — NOT `Object.keys(...)`, which
  // would produce an array with no `DEFAULT_TYPE` property.
  static SERVER_TYPES = { ...DigitalOceanProvider.FALLBACK_SERVER_TYPES };

  // Per-region availability populated by fetchServerTypes(). Maps region
  // slug -> Set of available server-type slugs. Convention shared with
  // HetznerProvider._locationTypes (see base.js's catalog-statics doc).
  static _locationTypes = null;

  static DEFAULT_TYPE = 's-2vcpu-4gb';

  // ── Engine-literal statics (mirrors HetznerProvider's C7b/C7c fields) ──
  static DEFAULT_COMPOSE_TYPE = 's-2vcpu-4gb';
  // M3 Task 1 — real k8s node-type default (DO's Basic droplet line has no
  // separate k8s-sized tier, so this matches DEFAULT_COMPOSE_TYPE).
  static DEFAULT_K8S_NODE_TYPE = 's-2vcpu-4gb';

  // Overrides BaseProvider's 180s default: `ubuntu-24-04-x64` has no
  // preinstalled Docker, so cloud-init installs docker-ce from Docker's apt
  // repo INSIDE the boot script (see digitalocean-compose.js
  // renderDoUserData) — realistically 3-5 minutes on small droplets, vs
  // Hetzner's docker-ce image where cloud-init only runs ufw +
  // unattended-upgrades. RCA'd from a real d1 e2e failure: cloud-init never
  // reached the ready marker within the 180s Hetzner-calibrated budget.
  static CLOUD_INIT_READY_TIMEOUT_MS = 600_000;

  /**
   * Kubernetes cluster-addon asset identity for DO's CCM/CSI (M3 Task 1) —
   * see base.js's K8S_ASSETS doc for the field-by-consumer breakdown.
   * `ccmSelector`/`csiControllerSelector` use bare `app=` — DO's v0.1.68 CCM
   * and v4.17.0 CSI manifests label with a plain `app` key, NOT Hetzner's
   * `app.kubernetes.io/name=` convention (dossier-verified). `csi-do-controller`
   * is a StatefulSet in DO (a Deployment on Hetzner) — irrelevant to
   * csiControllerSelector's use as a log-selector, but any future
   * `kubectl rollout status` call against it must say `statefulset/...`, not
   * `deployment/...`. `networkEnvVar` stays `''`: DO's CCM has no
   * HCLOUD_NETWORK analogue — VPC membership is discovered from droplet
   * metadata, not an injected env var.
   * @type {{
   *   csiNodeDaemonSet: string,
   *   csiControllerSelector: string,
   *   ccmDeployment: string,
   *   ccmSelector: string,
   *   networkEnvVar: string,
   * }}
   */
  static K8S_ASSETS = {
    csiNodeDaemonSet: 'daemonset/csi-do-node',
    csiControllerSelector: 'app=csi-do-controller',
    ccmDeployment: 'digitalocean-cloud-controller-manager',
    ccmSelector: 'app=digitalocean-cloud-controller-manager',
    networkEnvVar: '',
  };

  /**
   * StorageClass name DO's csi-digitalocean driver (v4.17.0) creates by
   * default (M3 dossier §2). See HetznerProvider.K8S_STORAGE_CLASS for the
   * Hetzner counterpart (`hcloud-volumes`).
   * @type {string}
   */
  static K8S_STORAGE_CLASS = 'do-block-storage';

  /**
   * The FIXED-ERA VPC range — the literal every DO k8s stack provisioned
   * before the d4 lift (2026-08-28) actually holds. Used ONLY as
   * `deployK3s`'s (deploy/k8s/k3s.js) resume-compat fallback for a
   * `k3s-infra` step result persisted before M3 Task 9c added the `vpcCidr`
   * Pulumi output field — and every such stack IS a fixed-era stack, so this
   * value is correct for exactly the population the fallback serves. Fresh
   * deploys never read it: the program now derives a per-cluster range
   * (`vpcCidrForCluster` in `iac/programs/digitalocean-k8s.js` — DO enforces
   * VPC CIDR uniqueness account-wide, so a fixed default capped an account
   * at one cluster) and exports the real value as the `vpcCidr` output.
   * @type {string}
   */
  static DEFAULT_VPC_CIDR = '10.10.0.0/20';

  /**
   * DO-only override (M3 Task 9c): same-region Spaces endpoints resolve
   * INSIDE pods to a VPC-internal gateway address (observed on the d3 kept
   * rig: nyc3.digitaloceanspaces.com -> 10.10.15.254, top of the cluster
   * VPC's 10.10.0.0/20) that the standard `0.0.0.0/0 except RFC1918`
   * S3-egress rule cuts off. Allowing the cluster's own VPC CIDR on 443 is
   * additive-only (default-deny-all still holds on every other port); we
   * allow the whole VPC rather than the literal gateway IP because DO does
   * not document that address as stable — the top-of-range IP we observed
   * is an implementation detail, not a contract, and the marginal exposure
   * (HTTPS to our own droplets) is the same either way.
   * @param {string} [vpcCidr] - This deploy's cluster VPC CIDR (see
   *   applyK3sManifests's `vpcCidr` arg). Falsy → no extra allowance rather
   *   than a broken NetworkPolicy rule (defense-in-depth; in practice
   *   deployK3s always supplies DEFAULT_VPC_CIDR at minimum).
   * @returns {string[]}
   */
  static getS3EgressExtraCidrs(vpcCidr) {
    return vpcCidr ? [vpcCidr] : [];
  }

  /**
   * Base droplet image slug DO's k8s Pulumi program (`digitalocean-k8s.js`,
   * M3 Task 5) provisions master/supabase/worker nodes with — matches
   * `COMPOSE_IMAGE` below (same `ubuntu-24-04-x64` base image, no separate
   * k8s-tier image on DO). `renderCarbonAutoscalerConfig` reads this for
   * the CA-spawned worker node group's `image` field.
   * @type {string}
   */
  static K8S_IMAGE = 'ubuntu-24-04-x64';

  /**
   * Render this provider's k3s master-node boot user-data — wraps the new
   * `carbon/cloud-init/k3s/do-master-init.sh` template (M3 Task 3) via
   * loadCloudInit/renderScript. Unlike HetznerProvider's master template,
   * do-master-init.sh derives its own public/private IPs and droplet id
   * from DigitalOcean's metadata service AT BOOT (see the template's own
   * comments), so its template-var surface is deliberately smaller: no
   * reserved-IP var (not knowable pre-create — the Reserved IP is
   * assigned to the master after it already exists), no network-id var
   * (the DO CCM discovers VPC membership from metadata, not an injected
   * id), no project-name var (DO's CSI has no label-injection env to
   * stamp it onto — see the template's own note).
   * @param {{
   *   k3s_version: string,
   *   k3s_token: string,
   *   do_token: string,
   * }} vars - Substituted into do-master-init.sh's `${...}` placeholders —
   *   this is the template's COMPLETE var set (unlike
   *   HetznerProvider.getK8sMasterUserData, every key here is actually
   *   consumed; there is no unused-var carry-over).
   * @returns {Promise<string>}
   */
  static async getK8sMasterUserData(vars) {
    const { loadCloudInit, renderScript } = await import('../iac/cloud-init.js');
    return renderScript(loadCloudInit('do-master-init.sh'), vars);
  }

  /**
   * Render this provider's k3s worker-node boot user-data — wraps the new
   * `carbon/cloud-init/k3s/do-worker-init.sh` template (M3 Task 3) via
   * loadCloudInit/renderScript. See getK8sMasterUserData's doc for the
   * metadata-derived-IPs contrast with the master template.
   * @param {{
   *   k3s_version: string,
   *   k3s_token: string,
   *   master_ip: string,
   * }} vars - The template's complete var set. master_ip is the cluster
   *   master's PRIVATE (VPC) IP — digitalocean-k8s.js (M3 Task 5) threads
   *   this in from the REAL `pulumi.all([master.ipv4AddressPrivate]).apply(...)`
   *   output, since the master doesn't know its own private IP at Pulumi
   *   program-build time, only at apply time.
   * @returns {Promise<string>}
   */
  static async getK8sWorkerUserData(vars) {
    const { loadCloudInit, renderScript } = await import('../iac/cloud-init.js');
    return renderScript(loadCloudInit('do-worker-init.sh'), vars);
  }

  /**
   * Render this provider's k3s supabase-node boot user-data — wraps the new
   * `carbon/cloud-init/k3s/do-supabase-init.sh` template (M3 Task 5) via
   * loadCloudInit/renderScript. do-supabase-init.sh is do-worker-init.sh
   * plus boot-time `--node-label`/`--node-taint` k3s agent flags (dedicated
   * Supabase node-pool isolation, applied at join time rather than a
   * post-join `kubectl label`/`kubectl taint` step) and an async
   * containerd image-prewarm block — see the template's own comments. Same
   * var set as getK8sWorkerUserData (master_ip is a template var here too,
   * since this node is always created after the master, unlike the master
   * template).
   * @param {{
   *   k3s_version: string,
   *   k3s_token: string,
   *   master_ip: string,
   * }} vars - The template's complete var set. master_ip is the cluster
   *   master's PRIVATE (VPC) IP — digitalocean-k8s.js (M3 Task 5) threads
   *   this in from the REAL `pulumi.all([master.ipv4AddressPrivate]).apply(...)`
   *   output, same as getK8sWorkerUserData's vars.
   * @returns {Promise<string>}
   */
  static async getK8sSupabaseUserData(vars) {
    const { loadCloudInit, renderScript } = await import('../iac/cloud-init.js');
    return renderScript(loadCloudInit('do-supabase-init.sh'), vars);
  }

  // ── Compose-tier replacement-server identity — see base.js's doc block ──

  /**
   * Matches digitalocean-compose.js's buildDigitalOceanComposeProgram
   * `image: 'ubuntu-24-04-x64'` literal
   * (lib/iac/programs/digitalocean-compose.js:204) exactly.
   * @type {string}
   */
  static COMPOSE_IMAGE = 'ubuntu-24-04-x64';

  /**
   * Returns the SAME rendered user-data digitalocean-compose.js's Pulumi
   * program uses — delegates to that module's `loadDoComposeUserData`
   * (dynamic import), which is itself the single source of truth for the
   * file read + renderDoUserData() splice/transliteration (never
   * duplicated here).
   * @returns {Promise<string>}
   */
  static async getComposeUserData() {
    const { loadDoComposeUserData } = await import('../iac/programs/digitalocean-compose.js');
    return loadDoComposeUserData();
  }

  /**
   * Fetch droplet sizes from the DigitalOcean API. Populates SERVER_TYPES
   * with live data and caches per-region availability. Safe to call
   * multiple times — returns cached data after the first successful fetch.
   * Mirrors HetznerProvider.fetchServerTypes's fallback contract: never
   * throws, returns false (leaving SERVER_TYPES/FALLBACK_SERVER_TYPES as
   * the caller's default) on any failure.
   * @param {string} apiToken - DigitalOcean API token
   * @returns {Promise<boolean>} true if live data was loaded, false on failure
   */
  static async fetchServerTypes(apiToken) {
    if (DigitalOceanProvider._locationTypes) return true; // already fetched

    try {
      // Walk pagination (same per_page=200 + guarded links.pages.next walk as
      // getServerType below — DO's catalog is ~100+ sizes and growing, and a
      // truncated listing would silently shrink the picker catalog and
      // per-region availability, the truncated-listing failure class of
      // 2026-07-30). Any non-ok page → false, so a partial catalog can never
      // pose as live truth; the caller keeps the offline fallback instead.
      const sizes = [];
      let page = 1;
      let complete = false;
      for (let guard = 0; guard < 20; guard++) {
        const response = await fetchWithRetry(
          `${DigitalOceanProvider.API_BASE}/sizes?per_page=200&page=${page}`,
          { headers: { Authorization: `Bearer ${apiToken}` } },
        );
        if (!response.ok) return false;
        const data = await response.json();
        sizes.push(...(data.sizes || []));
        if (!data.links?.pages?.next) {
          complete = true;
          break;
        }
        page++;
      }
      if (!complete) return false;
      // Empty-catalog guard (mirrors HetznerProvider.fetchServerTypes): a
      // 200 whose body lacks the `sizes` key would otherwise count as a
      // complete-but-empty walk, wipe SERVER_TYPES, set the truthy
      // `_locationTypes = {}` short-circuit, and return true — permanently
      // trading the populated fallback catalog for nothing. DO's size
      // catalog is never legitimately empty, so empty means failure.
      if (sizes.length === 0) return false;

      const types = {};
      const locationTypes = {};

      for (const s of sizes) {
        if (s.available === false) continue;

        types[s.slug] = {
          vcpu: s.vcpus,
          ram: s.memory / 1024,
          disk: s.disk,
          regions: s.regions,
        };

        for (const region of s.regions || []) {
          if (!locationTypes[region]) locationTypes[region] = new Set();
          locationTypes[region].add(s.slug);
        }
      }

      // Post-FILTER empty guard (PR #214 re-review): a catalog whose every
      // entry is `available: false` would pass the raw-items guard above
      // and still wipe SERVER_TYPES — same hole, one layer down.
      //
      // Deliberate ASYMMETRY with HetznerProvider (post-#215): DO's
      // `available` is a SIZE-level attribute on /v2/sizes (there is no
      // per-region availability in this payload), so here the guard IS
      // downstream of the availability filter and an all-unavailable
      // catalog falls back. That is the right outcome on this shape:
      // live all-unavailable data offers nothing placeable that the
      // fallback doesn't, and SERVER_TYPES must stay a usable spec table
      // (provider-contract pins DEFAULT_TYPE ∈ SERVER_TYPES). Hetzner's
      // availability lives on the LOCATION axis instead, so its guard
      // deliberately ignores availability — see the twin comment there.
      if (Object.keys(types).length === 0) return false;

      DigitalOceanProvider.SERVER_TYPES = types;
      DigitalOceanProvider._locationTypes = locationTypes;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns server types available in the given region. Uses live
   * per-region data when available (populated by fetchServerTypes),
   * otherwise falls back to the full FALLBACK_SERVER_TYPES catalog — DO's
   * Basic droplet line is available uniformly across all regions, so there
   * is no prefix-filtering equivalent to Hetzner's US/EU split.
   *
   * Entries carry `architecture: 'x86'` for parity with
   * HetznerProvider.getServerTypesForRegion — the field the shared prompt
   * builders filter on (lib/server-types.js `filterAmd64Types`). It is a
   * constant here because DigitalOcean sells NO ARM instances at all: 31 size
   * slugs across the s/c/g/gd/m/gpu families, none of them ARM, and DO's own
   * CCM (v0.1.68) and CSI (v4.17.0) publish amd64-only images regardless.
   * @param {string} region - Region slug
   * @returns {Array<{name: string, vcpu: number, ram: number, disk: number, architecture: string}>}
   */
  static getServerTypesForRegion(region) {
    const available = DigitalOceanProvider._locationTypes?.[region];

    if (available) {
      return [...available]
        .filter((name) => name in DigitalOceanProvider.SERVER_TYPES)
        .map((name) => ({
          name,
          ...DigitalOceanProvider.SERVER_TYPES[name],
          architecture: 'x86',
        }))
        .sort((a, b) => a.vcpu - b.vcpu || a.ram - b.ram);
    }

    return Object.entries(DigitalOceanProvider.FALLBACK_SERVER_TYPES).map(([name, info]) => ({
      name,
      ...info,
      architecture: 'x86',
    }));
  }

  /**
   * Returns region-appropriate default server types. Fixed roles (not
   * region-branched) — see FALLBACK_SERVER_TYPES's doc comment for why DO
   * doesn't need Hetzner's per-region preference-list walk.
   * @param {string} _region - Region slug (accepted for interface parity
   *   with HetznerProvider.getRegionDefaults; unused — see above)
   * @returns {{masterType: string, supabaseType: string, workerType: string}}
   */
  static getRegionDefaults(_region) {
    return {
      masterType: 's-2vcpu-2gb',
      supabaseType: DigitalOceanProvider.DEFAULT_TYPE,
      workerType: 's-2vcpu-2gb',
    };
  }

  /**
   * Default HA standby region for a given primary: a DIFFERENT region on
   * the same continent, so failover stays intra-continent. Mirrors
   * HetznerProvider.getDefaultStandbyRegion's contract.
   * @param {string} primaryRegion
   * @returns {string}
   */
  static getDefaultStandbyRegion(primaryRegion) {
    // Conventional pairings, kept where they apply (bidirectional).
    const PAIRS = {
      nyc3: 'sfo3',
      sfo3: 'nyc3',
      fra1: 'ams3',
      ams3: 'fra1',
      sgp1: 'syd1',
      syd1: 'sgp1',
    };
    if (PAIRS[primaryRegion]) return PAIRS[primaryRegion];

    const continent = DigitalOceanProvider.REGION_CONTINENT[primaryRegion];
    const sameContinent = Object.keys(DigitalOceanProvider.REGION_CONTINENT).filter(
      (r) => r !== primaryRegion && DigitalOceanProvider.REGION_CONTINENT[r] === continent,
    );
    if (sameContinent.length > 0) return sameContinent[0];

    // No same-continent partner (e.g. a future single-region continent).
    return 'sfo3';
  }

  /**
   * Returns the equivalent server type available in a target region.
   * Mirrors HetznerProvider.resolveServerTypeForRegion's walk: if live data
   * shows the requested type isn't available in the target region, fall
   * back to the region-default type at the same role tier; offline, DO's
   * uniform Basic droplet line means the requested type is always assumed
   * available (no architecture-split fallback to reconcile, unlike
   * Hetzner's cax/cpx case).
   * @param {string} serverType - Original server type slug
   * @param {string} targetRegion - Region to resolve for
   * @returns {string}
   */
  static resolveServerTypeForRegion(serverType, targetRegion) {
    const available = DigitalOceanProvider._locationTypes?.[targetRegion];

    if (available) {
      if (available.has(serverType)) return serverType;

      const defaults = DigitalOceanProvider.getRegionDefaults(targetRegion);
      if (serverType === defaults.supabaseType) return defaults.supabaseType;
      return defaults.masterType;
    }

    // Offline fallback — no architecture split to reconcile.
    return serverType;
  }

  /**
   * Get public IPv4 address of a droplet.
   * @param {object} server - Droplet object (DO API `droplet` shape)
   * @returns {string|null}
   */
  static getPublicIP(server) {
    return server?.networks?.v4?.find((n) => n.type === 'public')?.ip_address ?? null;
  }

  /**
   * Get public IPv6 address of a droplet.
   * @param {object} server - Droplet object (DO API `droplet` shape)
   * @returns {string|null}
   */
  static getPublicIPv6(server) {
    return server?.networks?.v6?.find((n) => n.type === 'public')?.ip_address ?? null;
  }

  // ── Instance methods (B3) ────────────────────────────────────────────
  // Transport choice mirrors HetznerProvider method-for-method: the original
  // CRUD surface (createServer/deleteServer(no-wait)/getServer/waitForServer/
  // createSSHKey) goes through `this.apiRequest`; list/firewall/teardown
  // methods (introduced alongside C9/C10a on Hetzner) use a direct
  // `fetchWithRetry` with a bare Authorization header, matching hetzner.js's
  // own split — getServerType (M3 Task 1) joins this group. getServerSummary
  // stays a single raw `fetch` with a hard 5s abort (never
  // fetchWithRetry/apiRequest) — see BaseProvider's doc.

  /**
   * Resolve one `createServer` `sshKeys`/`sshKeyId` entry to a numeric DO
   * ssh-key ID (M3 Task 5b Critical). DO's droplet-create `ssh_keys` field
   * accepts only numeric IDs or fingerprints — NEVER names (unlike
   * Hetzner's, which accepts either) — so a caller-supplied NAME (e.g.
   * carbon-autoscaler's groups.js, which passes
   * `sshKeys: [this.config.sshKeyName]` generically across every provider)
   * must be resolved before it ever reaches the request body, or DO 422s on
   * every CA-initiated create.
   *
   * Numeric IDs (number, or a string of only digits) pass through
   * UNCHANGED — zero extra API calls — so every existing numeric-ID caller
   * (scale.js's replacement-server path, the compose Pulumi programs) stays
   * byte-identical to before this method existed. Note the type is
   * preserved, not coerced: a numeric-string entry stays a string.
   *
   * Paginates `/account/keys` (same per_page=50 + guarded links.pages.next
   * walk as listServers) since an account can hold more keys than one page.
   * Throws loudly on no match — a silent skip would create a droplet nobody
   * can SSH into, which is worse than refusing the create outright.
   * @param {string|number} entry
   * @returns {Promise<string|number>}
   */
  async _resolveSshKeyId(entry) {
    if (typeof entry === 'number' || /^\d+$/.test(String(entry))) return entry;

    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const res = await fetchWithRetry(
        `${DigitalOceanProvider.API_BASE}/account/keys?per_page=50&page=${page}`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!res.ok) {
        throw new Error(
          `DigitalOcean ssh key lookup failed (${res.status}) while resolving "${entry}" to an ID`,
        );
      }
      const data = await res.json();
      const match = (data.ssh_keys || []).find((k) => k.name === entry);
      if (match) return match.id;
      if (!data.links?.pages?.next) break;
      page++;
    }
    throw new Error(
      `DigitalOcean ssh key "${entry}" not found — cannot resolve to an ID for droplet create`,
    );
  }

  /**
   * Create a new DigitalOcean droplet. DO droplet names are NOT unique
   * (unlike Hetzner's uniqueness_error) — POSTing a duplicate name silently
   * creates a second droplet instead of erroring, which would leak resources
   * on any create-then-resume path. So, unlike Hetzner's recover-after-error
   * pattern, this checks findServersByName FIRST and short-circuits with the
   * existing droplet (reused:true) before ever POSTing — prevents the
   * duplicate rather than recovering from it.
   * @param {object} config
   * @param {string} config.name
   * @param {string} config.region
   * @param {string} config.serverType - droplet size slug
   * @param {string} config.image
   * @param {(string|number)[]} [config.sshKeys] - SSH key ID(s) OR name(s) —
   *   this is what scale.js's buildReplacementServerArgs and (M3 Task 5b)
   *   carbon-autoscaler's groups.js actually send (see base.js:268's
   *   abstract createServer doc). A non-numeric entry is resolved to an ID
   *   via `_resolveSshKeyId` before it reaches the request body — DO's API
   *   accepts only numeric IDs/fingerprints, never names.
   * @param {string|number} [config.sshKeyId] - single SSH key ID/name, fallback
   * @param {object} [config.labels]
   * @param {string} [config.userData]
   * @param {(string|number)[]} [config.networks] - VPC id(s). When a
   *   non-empty array is given, `networks[0]` becomes the droplet's
   *   `vpc_uuid` (M3 Task 1 — CA-spawned k8s workers must join the cluster
   *   VPC; `groups.js` passes `networks:[networkId]`). Omitted entirely when
   *   absent/empty, so compose-tier callers (which never pass `networks`)
   *   POST the exact same body as before this field existed.
   * @param {(string|number)[]} [config.firewalls] - Firewall id(s) to attach
   *   the new droplet to. DO has no create-time firewall field, so this is a
   *   second, additive API call after the droplet exists; if it fails the
   *   droplet is deleted rather than left unfirewalled.
   *
   *   This used to be ACCEPTED BUT IGNORED, on the reasoning that DO firewalls
   *   attach by TAG. That is true of the K8S program
   *   (digitalocean-k8s.js's `Firewall({tags:[clusterTag]})`, which is why
   *   CA-spawned workers are covered automatically) but NOT of the COMPOSE
   *   one, which scopes by `dropletIds` (digitalocean-compose.js:228). So the
   *   scale path's blue-green replacement droplet — created outside Pulumi —
   *   was covered by nothing at all. Honoring the field converges both
   *   providers on one provider-neutral call site
   *   (scale.js's buildReplacementServerArgs, groups.js's createConfig).
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
      networks,
      firewalls,
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

    const body = {
      name,
      region,
      size: serverType,
      image,
      ssh_keys: resolvedSshKeys,
      tags: encodeLabels(labels),
    };
    if (Array.isArray(networks) && networks.length > 0) {
      body.vpc_uuid = String(networks[0]);
    }
    // Runs at boot via cloud-init, same contract as Hetzner's user_data —
    // only sent when the caller supplies one.
    if (userData) {
      body.user_data = userData;
    }

    const response = await this.apiRequest('/droplets', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`DigitalOcean API error: ${error.message || 'Unknown error'}`);
    }

    const { droplet } = await response.json();

    // DO has no create-time firewall field, so attachment is a second call.
    // The compose Firewall scopes by `dropletIds` (digitalocean-compose.js:228),
    // NOT by tag like the k8s one — so a droplet created outside Pulumi (the
    // scale replacement) is covered by nothing until it is added explicitly.
    //
    // Atomic on failure: a droplet that exists but is unfirewalled is the exact
    // hole this closes, and it would otherwise be invisible (scale's own
    // cleanup only wraps the steps AFTER createServer returns). So we delete
    // what we just made and surface the reason.
    if (Array.isArray(firewalls) && firewalls.length > 0) {
      try {
        await this._attachServerToFirewalls(droplet.id, firewalls);
      } catch (err) {
        await this.deleteServer(droplet.id).catch(() => {});
        throw new Error(
          `Droplet ${name} was created but could not be attached to firewall(s) ` +
            `${firewalls.join(', ')}: ${err.message}. The droplet has been deleted rather ` +
            'than left running without a firewall.',
        );
      }
    }
    return { id: droplet.id, server: droplet };
  }

  /**
   * Add a droplet to each of the given firewalls' droplet lists.
   * DO's endpoint is additive and idempotent — re-POSTing a droplet already in
   * the list is a no-op 204 — so this is safe on a resumed/retried create.
   * @param {number|string} dropletId
   * @param {(string|number)[]} firewallIds
   * @returns {Promise<void>}
   */
  async _attachServerToFirewalls(dropletId, firewallIds) {
    for (const firewallId of firewallIds) {
      const response = await this.apiRequest(`/firewalls/${firewallId}/droplets`, {
        method: 'POST',
        body: JSON.stringify({ droplet_ids: [Number(dropletId)] }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(
          `firewall ${firewallId} attach failed (HTTP ${response.status}): ${
            error.message || 'unknown error'
          }`,
        );
      }
    }
  }

  /**
   * Delete a droplet. Two modes, keyed on `waitUntilGone` — same contract as
   * HetznerProvider.deleteServer (see its doc + BaseProvider's abstract
   * doc): default fires the DELETE and returns once DO accepts it; true
   * DELETEs then polls GET until 404 (30 attempts, fixed 2s interval) so a
   * destroy→re-deploy cycle never races DO's own async teardown.
   * @param {number|string} serverId
   * @param {{waitUntilGone?: boolean}} [options]
   * @returns {Promise<void|boolean>}
   */
  async deleteServer(serverId, { waitUntilGone = false } = {}) {
    if (!waitUntilGone) {
      const response = await this.apiRequest(`/droplets/${serverId}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        const error = await response.json();
        throw new Error(`Failed to delete server: ${error.message || 'Unknown error'}`);
      }
      return;
    }

    const response = await fetchWithRetry(`${DigitalOceanProvider.API_BASE}/droplets/${serverId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.json();
      throw new Error(`Failed to delete server: ${error.message || 'Unknown error'}`);
    }

    if (response.status !== 404) {
      await pollUntil(
        async () => {
          const probe = await fetch(`${DigitalOceanProvider.API_BASE}/droplets/${serverId}`, {
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
   * Rename a droplet via the DO Actions API — DO has no direct PUT/PATCH for
   * droplet identity; renames go through an action object. Non-2xx throws
   * the DO `{message}` error shape (matching every other DO instance
   * method here); the caller (scale's rename-to-permanent-name step) wraps
   * this in its own non-critical try/catch, since the new server works fine
   * under its temporary name if the rename fails.
   * @param {number|string} serverId
   * @param {string} name
   * @returns {Promise<void>}
   */
  async renameServer(serverId, name) {
    const response = await this.apiRequest(`/droplets/${serverId}/actions`, {
      method: 'POST',
      body: JSON.stringify({ type: 'rename', name }),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Failed to rename server: ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * Get droplet details.
   * @param {number|string} serverId
   * @returns {Promise<object>}
   */
  async getServer(serverId) {
    const response = await this.apiRequest(`/droplets/${serverId}`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Failed to get server: ${error.message || 'Unknown error'}`);
    }
    const { droplet } = await response.json();
    return droplet;
  }

  /**
   * Wait for a droplet to become ready: status 'active' AND a public v4 IP
   * assigned (a droplet can report 'active' briefly before network info is
   * populated).
   * @param {number|string} serverId
   * @param {number} [timeout=300000]
   * @returns {Promise<object>}
   */
  async waitForServer(serverId, timeout = 300000) {
    const startTime = Date.now();
    const pollInterval = 5000;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await this.apiRequest(`/droplets/${serverId}`);
        const { droplet } = await response.json();

        if (droplet.status === 'active' && DigitalOceanProvider.getPublicIP(droplet)) {
          return droplet;
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
   * Get a lightweight status summary for a droplet: {status, serverType}
   * (mirrors HetznerProvider.getServerSummary's shape/contract exactly — see
   * BaseProvider's doc). Single raw `fetch` with a hard 5000ms abort and
   * null-on-any-failure, NOT fetchWithRetry/apiRequest — `status` runs this
   * on every invocation, so a retry policy would multiply its worst-case
   * latency for no benefit.
   * @param {number|string} serverId
   * @returns {Promise<{status: string, serverType: string|null}|null>}
   */
  async getServerSummary(serverId) {
    try {
      const response = await fetch(`${DigitalOceanProvider.API_BASE}/droplets/${serverId}`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return null;

      const { droplet } = await response.json();
      return {
        status: droplet.status,
        serverType: droplet.size_slug || null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch a single droplet size's specs by exact slug — the source of the
   * `specs` argument carbon-autoscaler's `buildTemplateNode`
   * (src/autoscaler/node-template.js) needs for a node group's
   * `serverType` (M3 Task 1). `GET /v2/sizes` has no name-filter query
   * param (unlike Hetzner's `?name=`), so this walks the paginated list
   * (same `fetchWithRetry` + Bearer-auth + `links.pages.next` pattern as
   * listServers/findServersByName below) and matches by `slug` client-side.
   * A slug present but flagged `available: false` is treated as absent —
   * matches fetchServerTypes' skip-unavailable filter, so carbon-autoscaler
   * never spawns a worker sized off a retired/out-of-stock slug.
   * @param {string} name - Exact droplet size slug (e.g. "s-2vcpu-4gb")
   * @returns {Promise<{cores: number, memoryGb: number, architecture: string, disk: number}>}
   */
  async getServerType(name) {
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const response = await fetchWithRetry(
        `${DigitalOceanProvider.API_BASE}/sizes?per_page=200&page=${page}`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch server type "${name}": ${response.status}`);
      }
      const data = await response.json();
      const match = (data.sizes || []).find((s) => s.slug === name && s.available !== false);
      if (match) {
        return {
          cores: match.vcpus,
          memoryGb: match.memory / 1024,
          architecture: 'x86',
          disk: match.disk,
        };
      }
      if (!data.links?.pages?.next) break;
      page++;
    }
    throw new Error(`Server type "${name}" not found`);
  }

  /**
   * Create or reuse an SSH key. DigitalOcean rejects a POST whose public-key
   * BYTES are already registered under ANY name (422 "already in use") — DO
   * dedupes SSH keys by fingerprint account-wide, not by name (unlike
   * Hetzner's name-scoped uniqueness_error). So recovery after a 422 walks
   * the paginated /account/keys list and matches by normalized key MATERIAL
   * (type + base64 body, via normalizePublicKey — ignores the trailing
   * comment and whitespace variance), not by name: a caller can register the
   * same key bytes under a different name than a prior registration (e.g.
   * `scale`'s key name vs `deploy`'s), and a name-only match would miss it
   * — this was the exact d1 scale regression. An exact-name hit whose
   * material does NOT match is a genuine conflict (a different key squatting
   * on the name) and throws a distinct, loud error rather than silently
   * reusing the wrong key.
   * @param {string} name
   * @param {string} publicKey
   * @returns {Promise<number>} SSH key ID
   */
  async createSSHKey(name, publicKey) {
    const createResponse = await this.apiRequest('/account/keys', {
      method: 'POST',
      body: JSON.stringify({ name, public_key: publicKey }),
    });

    if (createResponse.ok) {
      const { ssh_key } = await createResponse.json();
      return ssh_key.id;
    }

    const error = await createResponse.json();
    const message = error.message || 'Unknown error';

    if (createResponse.status === 422 && /already in use/i.test(message)) {
      const targetMaterial = normalizePublicKey(publicKey);
      let nameMatchDifferentMaterial = null;
      let page = 1;
      for (let guard = 0; guard < 20; guard++) {
        const resp = await this.apiRequest(`/account/keys?per_page=100&page=${page}`);
        const body = await resp.json();
        const keys = body.ssh_keys || [];

        const materialMatch = keys.find((k) => normalizePublicKey(k.public_key) === targetMaterial);
        if (materialMatch) return materialMatch.id;

        if (!nameMatchDifferentMaterial) {
          nameMatchDifferentMaterial = keys.find((k) => k.name === name) || null;
        }

        const next = body.links?.pages?.next;
        if (!next) break;
        page++;
      }

      if (nameMatchDifferentMaterial) {
        throw new Error(
          `Failed to create SSH key: a key named "${name}" already exists on this account with different key material (DigitalOcean dedupes by fingerprint, not name) — refusing to reuse it`,
        );
      }
      throw new Error(
        `Failed to create SSH key: key already in use, but no matching key (by material or name "${name}") was found`,
      );
    }

    throw new Error(`Failed to create SSH key: ${message}`);
  }

  /**
   * List ALL droplets, optionally filtered by labels, walking pagination
   * (B0-4 semantics: non-ok first page → [], mid-walk → collected so far).
   * DO's droplet list only supports filtering by a SINGLE `tag_name` per
   * request (no AND-combination query param, and `tag_name` can't be
   * combined with other filters) — this is a genuine behavior change from
   * Hetzner's server-side `label_selector=k=v,k2=v2` AND, not a rename (M3
   * dossier §7). The FIRST entry of `labels` (caller-ordered — put the most
   * selective predicate first, e.g. groups.js's
   * `{'cluster-autoscaler/node': groupId, cluster: clusterName}` already
   * does) drives the single server-side `tag_name` query; any remaining
   * entries are matched client-side against each returned droplet's
   * `tags[]` array using the SAME `encodeLabel` encoding, so the wire tag
   * string here is byte-identical to what createServer/the k8s Pulumi
   * programs tag droplets with — this is the destroy-sweep + carbon-
   * autoscaler correctness contract (M3 Task 1).
   * @param {object} [labels]
   * @returns {Promise<object[]>}
   */
  async listServers(labels = {}) {
    return (await this.listServersDetailed(labels)).items;
  }

  /**
   * Droplet listing that preserves the page-walk's completeness signal — see
   * BaseProvider.listServersDetailed for why a soft-failed `[]` must not be
   * allowed to read as "the project is quiet".
   * @param {object} [labels]
   * @returns {Promise<{ items: object[], complete: boolean, status?: number }>}
   */
  async listServersDetailed(labels = {}) {
    const [primary, ...rest] = Object.entries(labels);

    let baseUrl = `${DigitalOceanProvider.API_BASE}/droplets?per_page=50`;
    if (primary) {
      const [k, v] = primary;
      baseUrl += `&tag_name=${encodeURIComponent(encodeLabel(k, v))}`;
    }

    const droplets = [];
    let page = 1;
    let complete = false;
    let status;
    for (let guard = 0; guard < 20; guard++) {
      const response = await fetchWithRetry(`${baseUrl}&page=${page}`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });
      if (!response.ok) {
        status = response.status;
        break;
      }
      const data = await response.json();
      if (Array.isArray(data.droplets)) droplets.push(...data.droplets);
      if (!data.links?.pages?.next) {
        complete = true;
        break;
      }
      page++;
    }

    const items =
      rest.length === 0
        ? droplets
        : (() => {
            const remainingTags = rest.map(([k, v]) => encodeLabel(k, v));
            return droplets.filter((d) =>
              remainingTags.every((tag) => (d.tags || []).includes(tag)),
            );
          })();

    return status === undefined ? { items, complete } : { items, complete, status };
  }

  /**
   * Find droplets by exact name. DO has no name-filter query param (unlike
   * Hetzner's `?name=`), so this walks the full paginated droplet list and
   * filters client-side. Soft-fail contract: [] on a non-ok response at any
   * page (B0-3) — best-effort discovery/recovery; network throws propagate.
   * @param {string} name
   * @returns {Promise<object[]>}
   */
  async findServersByName(name) {
    const droplets = [];
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const response = await fetchWithRetry(
        `${DigitalOceanProvider.API_BASE}/droplets?per_page=50&page=${page}`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!response.ok) return [];
      const data = await response.json();
      if (Array.isArray(data.droplets)) droplets.push(...data.droplets);
      if (!data.links?.pages?.next) break;
      page++;
    }
    return droplets.filter((d) => d.name === name);
  }

  /**
   * Find a DO project by EXACT name (paginated walk — /v2/projects has no
   * name filter), creating it when absent. Exact match only: a rename in
   * the console makes this create a second project rather than silently
   * adopting a near-miss, which is why call sites persist the returned id
   * to DIGITALOCEAN_PROJECT_ID and ensureProjectAssignment prefers that.
   * Non-ok listing throws (never falls through to a create off a failed
   * walk — that would duplicate the project on every API blip).
   * @param {string} name
   * @returns {Promise<{ id: string, created: boolean }>}
   */
  async findOrCreateProject(name) {
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const response = await fetchWithRetry(
        `${DigitalOceanProvider.API_BASE}/projects?per_page=200&page=${page}`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(
          `Failed to list DigitalOcean projects (${response.status}): ${error.message || 'Unknown error'}`,
        );
      }
      const data = await response.json();
      const match = (data.projects || []).find((proj) => proj.name === name);
      if (match) return { id: match.id, created: false };
      if (!data.links?.pages?.next) break;
      page++;
    }

    const response = await fetchWithRetry(`${DigitalOceanProvider.API_BASE}/projects`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      // `purpose` is required by the API; "Web Application" is DO's own
      // suggested value and purely descriptive.
      body: JSON.stringify({ name, purpose: 'Web Application' }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        `Failed to create DigitalOcean project "${name}": ${error.message || 'Unknown error'}`,
      );
    }
    const { project } = await response.json();
    return { id: project.id, created: true };
  }

  /**
   * Assign a batch of resource URNs (`do:droplet:<id>`, …) to a project.
   * DO's endpoint is additive and idempotent — re-POSTing an already-assigned
   * resource just moves it again, so callers never need a diff first.
   * @param {string} projectId
   * @param {string[]} urns
   */
  async assignResourcesToProject(projectId, urns) {
    const response = await fetchWithRetry(
      `${DigitalOceanProvider.API_BASE}/projects/${projectId}/resources`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ resources: urns }),
      },
    );
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        `Failed to assign resources to DigitalOcean project ${projectId}: ${error.message || 'Unknown error'}`,
      );
    }
  }

  /**
   * DO override of BaseProvider.ensureProjectAssignment: file this
   * environment's droplets into the dedicated project. Project resolution is
   * env-first (DIGITALOCEAN_PROJECT_ID, persisted by the call site on first
   * use) → find-or-create by the vibecarbon project name. The droplet sweep
   * matches the `${projectName}-${environment}[-role]` naming convention
   * exactly (`base` or `base-…`, never a bare prefix — `newapp-production`
   * must not match environment `prod`). An incomplete droplet listing
   * throws rather than assigning off a partial sweep.
   * @param {{ projectName: string, environment: string }} opts
   * @returns {Promise<{ projectId: string, created: boolean, assigned: number }>}
   */
  async ensureProjectAssignment({ projectName, environment }) {
    const envId = process.env[DigitalOceanProvider.PROJECT_ID_ENV];
    const { id: projectId, created } = envId
      ? { id: envId, created: false }
      : await this.findOrCreateProject(projectName);

    const { items, complete, status } = await this.listServersDetailed();
    if (!complete) {
      throw new Error(
        `DigitalOcean droplet listing incomplete (status ${status ?? 'unknown'}) — refusing project assignment off a partial sweep`,
      );
    }

    const base = `${projectName}-${environment}`;
    const urns = items
      .filter((d) => d.name === base || d.name.startsWith(`${base}-`))
      .map((d) => `do:droplet:${d.id}`);
    if (urns.length > 0) {
      await this.assignResourcesToProject(projectId, urns);
    }
    return { projectId, created, assigned: urns.length };
  }

  /**
   * Look up a firewall by its exact name. DO has no name-filter query param,
   * so this walks /firewalls (guarded ≤20 pages). Null on a non-ok response
   * or no match (soft "does this env's firewall exist yet?" check).
   * @param {string} name
   * @returns {Promise<object|null>}
   */
  async findFirewallByName(name) {
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const res = await fetchWithRetry(
        `${DigitalOceanProvider.API_BASE}/firewalls?per_page=50&page=${page}`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!res.ok) return null;
      const data = await res.json();
      const match = (data.firewalls || []).find((f) => f.name === name);
      if (match) return match;
      if (!data.links?.pages?.next) break;
      page++;
    }
    return null;
  }

  /**
   * Replace a firewall's inbound rule set. DigitalOcean's firewall PUT is a
   * TOTAL REPLACE of the whole firewall object (unlike Hetzner's dedicated
   * set_rules action) — fetch the current firewall first and PUT back the
   * full object with only inbound_rules swapped, so
   * name/outbound_rules/droplet_ids/tags survive untouched. Throws on a
   * non-2xx response (lookup or write).
   * @param {string|number} firewallId
   * @param {object[]} rules - full replacement INBOUND rule list
   * @returns {Promise<void>}
   */
  async setFirewallRules(firewallId, rules) {
    const headers = { Authorization: `Bearer ${this.apiToken}` };

    const getRes = await fetchWithRetry(
      `${DigitalOceanProvider.API_BASE}/firewalls/${firewallId}`,
      { headers },
    );
    if (!getRes.ok) {
      const body = await getRes.text().catch(() => '');
      throw new Error(`DigitalOcean firewall lookup failed (${getRes.status}): ${body}`);
    }
    const { firewall } = await getRes.json();

    const putRes = await fetchWithRetry(
      `${DigitalOceanProvider.API_BASE}/firewalls/${firewallId}`,
      {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: firewall.name,
          inbound_rules: rules,
          outbound_rules: firewall.outbound_rules,
          droplet_ids: firewall.droplet_ids,
          tags: firewall.tags,
        }),
      },
    );
    if (!putRes.ok) {
      const body = await putRes.text().catch(() => '');
      throw new Error(`DigitalOcean firewall update failed (${putRes.status}): ${body}`);
    }
  }

  /**
   * DO-shaped replication-firewall rule builder — see BaseProvider's
   * abstract doc for the cross-provider contract. Takes the firewall OBJECT
   * (as returned by findFirewallByName), not a pre-extracted rules array —
   * DO's inbound rules live under `firewall.inbound_rules` (not Hetzner's
   * flat `firewall.rules`), and use the shape
   * `{protocol, ports, sources:{addresses:[...]}}` (not Hetzner's flat
   * `{direction, protocol, port, source_ips}`). Idempotent: returns null
   * when the peer's udp/51821 rule is already present; otherwise appends it.
   * @param {object} firewall - The firewall object as returned by
   *   findFirewallByName. DO's `inbound_rules` field is extracted here.
   * @param {string} peerIp - the peer node's public IPv4.
   * @returns {object[]|null}
   */
  buildReplicationFirewallRules(firewall, peerIp) {
    const existingRules = firewall.inbound_rules || [];
    const hasExactRule = existingRules.some(
      (r) =>
        r.protocol === 'udp' &&
        r.ports === WG_PORT &&
        r.sources?.addresses?.includes(`${peerIp}/32`),
    );
    if (hasExactRule) return null;
    return [
      ...existingRules,
      { protocol: 'udp', ports: WG_PORT, sources: { addresses: [`${peerIp}/32`] } },
    ];
  }

  /**
   * Rewrite the SSH (port 22) and Kubernetes API (port 6443) inbound rules
   * on a named firewall to use the given CIDR list as their
   * `sources.addresses`, leaving every other rule (HTTP/HTTPS, internal
   * cluster traffic) unchanged. Composes findFirewallByName + a
   * `{protocol, ports, sources}` rule-rewrite + setFirewallRules — mirrors
   * HetznerProvider.applyOperatorCidrs's SSH_PORT/K8S_API_PORT pair (Task 7
   * controller-added requirement: post-Task-6 tier lift, an operator-IP
   * change left the 6443 rule pointing at stale sources, locking kubectl
   * out of DO k8s clusters).
   * @param {{firewallName: string, cidrs: string[]}} args
   * @returns {Promise<boolean>} true if the named firewall was found and
   *   updated; false if it doesn't exist yet (env not deployed).
   */
  async applyOperatorCidrs({ firewallName, cidrs }) {
    const fw = await this.findFirewallByName(firewallName);
    if (!fw) return false;
    const newRules = (fw.inbound_rules || []).map((rule) => {
      if (rule.protocol === 'tcp' && OPERATOR_LOCKED_PORTS.has(rule.ports)) {
        return { ...rule, sources: { ...rule.sources, addresses: cidrs } };
      }
      return rule;
    });
    await this.setFirewallRules(fw.id, newRules);
    return true;
  }

  /**
   * Delete a firewall by its exact name.
   * @param {string} name
   * @returns {Promise<{deleted: boolean, everExisted: boolean, apiError: (Error|null)}>}
   */
  async deleteFirewallByName(name) {
    let everExisted = false;
    try {
      const fw = await this.findFirewallByName(name);
      if (!fw) return { deleted: false, everExisted: false, apiError: null };
      everExisted = true;
      const res = await fetchWithRetry(`${DigitalOceanProvider.API_BASE}/firewalls/${fw.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });
      return { deleted: res.ok || res.status === 404, everExisted, apiError: null };
    } catch (err) {
      return { deleted: false, everExisted, apiError: err };
    }
  }

  /**
   * Delete an SSH key by its exact name. DO has no name-filter query param,
   * so this walks /account/keys (guarded ≤20 pages). Never throws; returns
   * false when no key matches.
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  async deleteSSHKeyByName(name) {
    let match = null;
    let page = 1;
    for (let guard = 0; guard < 20 && !match; guard++) {
      const res = await fetchWithRetry(
        `${DigitalOceanProvider.API_BASE}/account/keys?per_page=100&page=${page}`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!res.ok) return false;
      const data = await res.json();
      match = (data.ssh_keys || []).find((k) => k.name === name);
      if (match) break;
      if (!data.links?.pages?.next) break;
      page++;
    }

    if (!match) return false;

    const response = await fetchWithRetry(
      `${DigitalOceanProvider.API_BASE}/account/keys/${match.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${this.apiToken}` } },
    );
    return response.ok || response.status === 404;
  }

  /**
   * List ALL VPCs (DO's private-network equivalent), walking pagination
   * (M3 Task 5b — same per_page=50 + guarded links.pages.next walk as
   * listServers). A DO account starts with ~10 default VPCs; a single-page
   * fetch could silently truncate before the cluster's own VPC, causing
   * carbon-autoscaler's `_lookupNetworkId` (groups.js) to refuse worker
   * creation. Soft-fail contract: [] on a non-ok first-page response
   * (mid-walk failure keeps whatever was already collected), matching
   * listServers.
   * @returns {Promise<object[]>}
   */
  async listNetworks() {
    const vpcs = [];
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const response = await fetchWithRetry(
        `${DigitalOceanProvider.API_BASE}/vpcs?per_page=50&page=${page}`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!response.ok) break;
      const data = await response.json();
      if (Array.isArray(data.vpcs)) vpcs.push(...data.vpcs);
      if (!data.links?.pages?.next) break;
      page++;
    }
    return vpcs;
  }

  /**
   * Delete a VPC by its exact name — the k8s destroy sweep's backstop for
   * `digitalocean-k8s.js`'s `network` resource (M3 Task 9f; DO-only, mirrors
   * `deleteFirewallByName`'s shape). DO refuses to delete a VPC that still
   * has member resources (droplets, load balancers, ...) — the response is
   * a non-2xx (403 or 409 depending on account/API version; DO's own docs
   * are inconsistent on which). That refusal is a genuine ordering bug (the
   * caller didn't clear every member first), never a not-found, so it comes
   * back as `apiError` for the caller to surface loudly — never swallowed
   * as if the delete simply didn't apply.
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
      const res = await fetchWithRetry(`${DigitalOceanProvider.API_BASE}/vpcs/${vpc.id}`, {
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
   * List ALL volumes, walking pagination (M3 Task 5b — same per_page=50 +
   * guarded links.pages.next walk as listServers). A single-page fetch
   * could silently miss volumes past the first page, causing the destroy
   * sweep to leak them. Soft-fail contract: [] on a non-ok first-page
   * response, matching listServers.
   * @returns {Promise<object[]>}
   */
  async listVolumes() {
    return (await this.listVolumesDetailed()).items;
  }

  /**
   * Volume listing that preserves the page-walk's completeness signal — see
   * BaseProvider.listVolumesDetailed for why an empty listing must not be
   * allowed to masquerade as a clean account.
   * @returns {Promise<{ items: object[], complete: boolean, status?: number }>}
   */
  async listVolumesDetailed() {
    const volumes = [];
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const response = await fetchWithRetry(
        `${DigitalOceanProvider.API_BASE}/volumes?per_page=50&page=${page}`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!response.ok) return { items: volumes, complete: false, status: response.status };
      const data = await response.json();
      if (Array.isArray(data.volumes)) volumes.push(...data.volumes);
      if (!data.links?.pages?.next) return { items: volumes, complete: true };
      page++;
    }
    return { items: volumes, complete: false };
  }

  /**
   * Delete a volume by ID.
   * @param {number|string} volumeId
   * @returns {Promise<boolean>} true on success or if already gone (404)
   */
  async deleteVolume(volumeId) {
    const response = await fetchWithRetry(`${DigitalOceanProvider.API_BASE}/volumes/${volumeId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    return response.ok || response.status === 404;
  }

  /**
   * Delete a Reserved IP by its address — the k8s destroy sweep's backstop
   * for `digitalocean-k8s.js`'s `reservedIp` resource (M3 Task 9f;
   * DO-only). Unlike every other resource this provider tears down by
   * name, DO's Reserved IP has no `name` field at all (verified against
   * `digitalocean-k8s.js`'s program — `new digitalocean.ReservedIp('ingress',
   * {region})` takes no name input, and the wire API's own path param is the
   * address itself: `DELETE /v2/reserved_ips/{reserved_ip}`). The only
   * durable attribution is the address, persisted into `envConfig.floatingIp`
   * at deploy time (orchestrator.js) — callers pass that value straight
   * through. Idempotent — 404 counts as already-gone/success.
   * @param {string} address
   * @returns {Promise<boolean>} true on success or if already gone (404)
   */
  async deleteReservedIpByAddress(address) {
    const response = await fetchWithRetry(
      `${DigitalOceanProvider.API_BASE}/reserved_ips/${address}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${this.apiToken}` } },
    );
    return response.ok || response.status === 404;
  }

  /**
   * List ALL load balancers, walking pagination (M3 Task 5b — same
   * per_page=50 + guarded links.pages.next walk as listServers). A
   * single-page fetch could silently miss load balancers past the first
   * page, causing the destroy sweep to leak them. Soft-fail contract: []
   * on a non-ok first-page response, matching listServers.
   * @returns {Promise<object[]>}
   */
  async listLoadBalancers() {
    const loadBalancers = [];
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const response = await fetchWithRetry(
        `${DigitalOceanProvider.API_BASE}/load_balancers?per_page=50&page=${page}`,
        { headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
      if (!response.ok) break;
      const data = await response.json();
      if (Array.isArray(data.load_balancers)) loadBalancers.push(...data.load_balancers);
      if (!data.links?.pages?.next) break;
      page++;
    }
    return loadBalancers;
  }

  /**
   * Delete a load balancer by ID.
   * @param {number|string} lbId
   * @returns {Promise<boolean>} true on success or if already gone (404)
   */
  async deleteLoadBalancer(lbId) {
    const response = await fetchWithRetry(
      `${DigitalOceanProvider.API_BASE}/load_balancers/${lbId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${this.apiToken}` } },
    );
    return response.ok || response.status === 404;
  }

  // ── Destroy-sweep field accessors (Task 7) ───────────────────────────
  // See BaseProvider's doc for the cross-provider contract.

  /**
   * A droplet belongs to at most one VPC.
   * @param {object} server
   * @returns {string[]}
   */
  serverNetworkIds(server) {
    return server.vpc_uuid ? [server.vpc_uuid] : [];
  }

  /**
   * @param {object} server
   * @returns {Object<string,string>}
   */
  serverLabels(server) {
    return decodeLabels(server.tags);
  }

  /**
   * @param {object} server
   * @returns {string[]}
   */
  serverVolumeIds(server) {
    return server.volume_ids || [];
  }

  /**
   * A droplet's `region` field is the same `{slug, name, ...}` shape
   * volumes use (godo's `Region` type) — matches volumeRegion's contract.
   * @param {object} server
   * @returns {string|null}
   */
  serverRegion(server) {
    return server.region?.slug ?? null;
  }

  /**
   * @param {object} volume
   * @returns {number[]}
   */
  volumeAttachedServerIds(volume) {
    return volume.droplet_ids || [];
  }

  /**
   * @param {object} volume
   * @returns {string|null}
   */
  volumeRegion(volume) {
    return volume.region?.slug ?? null;
  }

  /**
   * Task 7 brief's verify-at-impl note: csi-digitalocean v4.17.0's
   * driver.yaml (the exact manifest do-master-init.sh applies) runs its
   * csi-provisioner sidecar WITHOUT `--extra-create-metadata` and its
   * csi-do-plugin container WITHOUT a `--do-tag` flag (confirmed against
   * upstream source — controller.go only appends `d.doTag` to a created
   * volume's Tags when the flag is non-empty, and it's never passed here) —
   * so a CSI-created DO volume carries NO tags at all; this returns `{}` for
   * every such volume. The `pvc-<uuid>` NAME convention still holds
   * (external-provisioner's default naming, unaffected by the missing
   * flags — same convention Hetzner CSI uses), so cleanupOrphanedVolumes's
   * name+region fallback, not label/tag matching, is what actually catches a
   * detached DO CSI volume — which requires `serverRegion` (Task 7 fix round
   * 1, below) to actually populate the caller's `clusterLocations` for DO;
   * without it this fallback silently never fires and a detached volume
   * leaks.
   * @param {object} volume
   * @returns {Object<string,string>}
   */
  volumeLabels(volume) {
    return decodeLabels(volume.tags);
  }

  /**
   * DigitalOcean reports volume creation as an ISO-8601 `created_at` field.
   * @param {object} volume
   * @returns {string|null}
   */
  volumeCreatedAt(volume) {
    return volume.created_at ?? null;
  }

  // ── Object storage dispatch ──────────────────────────────────────────
  // digitalocean-spaces.js created in a later task (B4).

  /**
   * Lazily resolve the DigitalOcean Spaces (S3-compatible) object-storage
   * provider class. Dynamic import (never top-level) — see
   * HetznerProvider.getObjectStorageProviderClass for why.
   * @returns {Promise<typeof import('./digitalocean-spaces.js').DigitalOceanSpacesProvider>}
   */
  static async getObjectStorageProviderClass() {
    const { DigitalOceanSpacesProvider } = await import('./digitalocean-spaces.js');
    return DigitalOceanSpacesProvider;
  }

  // ── Guided setup delegation ──────────────────────────────────────────
  // digitalocean-guided-setup.js created in a later task (B6).

  /**
   * @param {string} [projectName]
   * @param {{ save?: boolean }} [options]
   * @returns {Promise<string|null>}
   */
  static async promptApiToken(projectName, options) {
    const { getApiToken } = await import('../digitalocean-guided-setup.js');
    return getApiToken(projectName, options);
  }

  /**
   * @param {string} [projectName]
   * @param {{ save?: boolean, force?: boolean, skipPrompts?: boolean }} [options]
   * @returns {Promise<{accessKey: string, secretKey: string}|null>}
   */
  static async promptObjectStorageCredentials(projectName, options) {
    const { getS3Credentials } = await import('../digitalocean-guided-setup.js');
    return getS3Credentials(projectName, options);
  }

  // ── IaC program dispatch ─────────────────────────────────────────────
  // digitalocean-compose.js created in a later task (B5).

  /**
   * Lazily build the Pulumi Automation-API program for a single
   * DigitalOcean Docker-Compose droplet. Dynamic import (never top-level)
   * — see the IAC PROGRAM DISPATCH block in base.js for why.
   * @param {object} config - DigitalOcean compose stack config
   * @returns {Promise<() => Promise<{serverIp: string, serverId: string, firewallId: string, sshKeyId: string}>>}
   */
  static async getComposeProgram(config) {
    const { buildDigitalOceanComposeProgram } = await import(
      '../iac/programs/digitalocean-compose.js'
    );
    return buildDigitalOceanComposeProgram(config);
  }

  /**
   * Lazily build the Pulumi Automation-API program for a DigitalOcean k3s
   * cluster (M3 Task 5). Dynamic import (never top-level) keeps
   * `@pulumi/digitalocean` and `@pulumi/pulumi` out of this module's
   * static-load graph — mirrors getComposeProgram's shape exactly, and
   * HetznerProvider.getK8sProgram's dispatch pattern.
   * @param {import('../iac/programs/digitalocean-k8s.js').K8sStackConfig} config
   * @returns {Promise<() => Promise<{masterIp: string, masterPrivateIp: string, supabaseIp: string, supabasePrivateIp: string, workerIps: string[], floatingIp: string, networkId: string, sshKeyId: string, k3sToken: string, clusterName: string, vpcCidr: string}>>}
   *   `vpcCidr` (M3 Task 9c) is the Vpc's actual `ipRange` — see
   *   getS3EgressExtraCidrs above.
   */
  static async getK8sProgram(config) {
    const { buildDigitalOceanK8sProgram } = await import('../iac/programs/digitalocean-k8s.js');
    return buildDigitalOceanK8sProgram(config);
  }
}
