/**
 * Hetzner Cloud Provider
 *
 * Implementation of the BaseProvider interface for Hetzner Cloud.
 * Provides server, SSH key, and firewall management through the Hetzner API.
 *
 * API Documentation: https://docs.hetzner.cloud/
 */

import { fetchWithRetry } from '../fetch-retry.js';
import { pollUntil } from '../retry.js';
import { BaseProvider } from './base.js';
import { HETZNER_API_BASE, listHetznerPages } from './hetzner-pagination.js';

// C9 — operator firewall access. Verbatim value-move of operator-ip.js's old
// module-level SSH_PORT/K8S_API_PORT constants, plus the Supavisor pooler
// ports (compose deploys scope 5432/6543 to operator CIDRs, so access
// add/remove/prune must rewrite them in lockstep with SSH).
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

export class HetznerProvider extends BaseProvider {
  /**
   * Documented object-storage operational limits (docs.hetzner.com, verified
   * 2026-08-15: storage/object-storage/overview). Hetzner publishes hard
   * request ceilings and NO consistency guarantee, and warns that
   * shared-resource contention "could lead to slow response times or timeout
   * errors" — which is why the strictest-across-providers budget is Hetzner's.
   */
  static OBJECT_STORAGE_LIMITS = {
    requestsPerSecondPerBucket: 750,
    requestsPerSecondPerSourceIp: 750,
    parallelConnectionsPerSourceIp: 256,
    consistency: 'undocumented',
    evidenceUrl: 'https://docs.hetzner.com/storage/object-storage/overview',
    verifiedOn: '2026-08-15',
  };

  static NAME = 'Hetzner Cloud';
  // Shared with the page-walker (and through it with scripts/sweep-hetzner.js)
  // so the API root has exactly one definition.
  static API_BASE = HETZNER_API_BASE;
  // Externally pinned as a customer-visible CI secret name — never derive/rename.
  static TOKEN_ENV = 'HETZNER_API_TOKEN';
  static CLI_TOKEN_ENV = 'HCLOUD_TOKEN';
  // The pair getS3Credentials (hetzner-guided-setup.js) reads before prompting.
  static OBJECT_STORAGE_ENV = ['HETZNER_ACCESS_KEY', 'HETZNER_SECRET_KEY'];
  // Stamped on nodes by hcloud-cloud-controller-manager (see K8S_ASSETS).
  static PROVIDER_ID_PREFIX = 'hcloud://';
  static DEFAULT_REGION = 'nbg1';
  // Canonical link to Hetzner's live pricing. We don't hard-code prices anywhere
  // (they change), so surface this wherever a user would want current costs.
  static PRICING_URL = 'https://www.hetzner.com/cloud/';

  // Env var override name for the S3-compatible Object Storage client's
  // region (see deploy/prompts.js). Object Storage is a distinct Hetzner
  // product from Cloud, with its own region set — see hetzner-s3.js.
  static S3_REGION_ENV = 'HETZNER_STORAGE_REGION';

  /**
   * Lazily resolve the Hetzner S3-compatible object-storage provider class.
   * Dynamic import (never top-level) keeps the AWS SDK out of this module's
   * graph until object storage is actually needed, and lets
   * tests/unit/destroy/state-bucket-delete.test.ts's `vi.mock` of
   * './hetzner-s3.js' keep intercepting the resolved class.
   * @returns {Promise<typeof import('./hetzner-s3.js').HetznerS3Provider>}
   */
  static async getObjectStorageProviderClass() {
    const { HetznerS3Provider } = await import('./hetzner-s3.js');
    return HetznerS3Provider;
  }

  // ── Guided setup delegation (C7d) ────────────────────────────────────
  // hetzner-guided-setup.js stays the single implementation (visual guide,
  // 64-char token validation, module-level `_savePreference` "save keys for
  // future deploys?" session state). Dynamic import (never top-level) keeps
  // that module out of this class's static-load graph and — because ESM
  // caches a module instance per resolved specifier — every call below
  // still shares the SAME module object (and therefore the same
  // `_savePreference`) as every other call made during the process
  // lifetime, matching the pre-C7d direct-import behavior exactly. Args
  // are forwarded verbatim (no re-declared defaults here) so the module's
  // own `{ save = true }` / `{ save = true, force = false }` defaults stay
  // the single source of truth.

  /**
   * @param {string} [projectName]
   * @param {{ save?: boolean }} [options]
   * @returns {Promise<string|null>}
   */
  static async promptApiToken(projectName, options) {
    const { getApiToken } = await import('../hetzner-guided-setup.js');
    return getApiToken(projectName, options);
  }

  /**
   * @param {string} [projectName]
   * @param {{ save?: boolean, force?: boolean, skipPrompts?: boolean }} [options]
   * @returns {Promise<{accessKey: string, secretKey: string}|null>}
   */
  static async promptObjectStorageCredentials(projectName, options) {
    const { getS3Credentials } = await import('../hetzner-guided-setup.js');
    return getS3Credentials(projectName, options);
  }

  // ── IaC program dispatch (CD2) — LAZY, mandatory ────────────────────
  // hetzner-compose.js/hetzner-k8s.js stay the single implementation of the
  // Pulumi Automation-API programs; these statics are thin delegations that
  // dynamic-import the program module (never top-level — see base.js's IAC
  // PROGRAM DISPATCH block for why) and forward `config` verbatim. Before
  // CD2 the four call sites (deploy/effects/index.js, deploy/effects/
  // compose-ha.js, deploy/k8s/k3s.js, scale.js) each named-imported
  // `buildHetzner*Program` directly; Phase B (DigitalOcean) would have had
  // to edit all four. Now they resolve the provider class once (providerFor)
  // and call `Provider.getComposeProgram()`/`getK8sProgram()` — a new
  // provider only needs to implement these two statics.
  //
  // Frozen output contract (Pulumi stack outputs persisted by the
  // state-tracker; deploy/scale resume reads these back from disk — verified
  // against the real program return statements, not assumed):
  //   compose (hetzner-compose.js buildHetznerComposeProgram): serverIp,
  //     serverId, firewallId, sshKeyId.
  //   k8s (hetzner-k8s.js buildHetznerK8sProgram): masterIp, masterPrivateIp,
  //     supabaseIp, supabasePrivateIp, workerIps, floatingIp, networkId,
  //     sshKeyId, k3sToken, clusterName.
  //   supabasePrivateIp IS exported unconditionally by the program today —
  //   hardcoded '10.0.1.2' (hetzner-k8s.js return statement), same as
  //   masterPrivateIp's hardcoded '10.0.1.1'. deployK3s (k3s.js) separately
  //   destructures `supabasePrivateIp = '10.0.1.2'` off the STORED step
  //   output with a matching default — that default exists for backward
  //   compatibility with state-tracker files persisted before
  //   supabasePrivateIp was added to the program's output, not because the
  //   program can omit the key today.

  /**
   * Lazily build the Pulumi Automation-API program for a single Hetzner
   * Docker-Compose VPS. Dynamic import (never top-level) keeps
   * `@pulumi/hcloud` out of this module's static-load graph.
   * @param {import('../iac/programs/hetzner-compose.js').ComposeStackConfig} config
   * @returns {Promise<() => Promise<{serverIp: string, serverId: string, firewallId: string, sshKeyId: string}>>}
   */
  static async getComposeProgram(config) {
    const { buildHetznerComposeProgram } = await import('../iac/programs/hetzner-compose.js');
    return buildHetznerComposeProgram(config);
  }

  /**
   * Lazily build the Pulumi Automation-API program for a Hetzner k3s
   * cluster. Dynamic import (never top-level) keeps `@pulumi/hcloud` and
   * `@pulumi/pulumi` out of this module's static-load graph.
   * @param {import('../iac/programs/hetzner-k8s.js').K8sStackConfig} config
   * @returns {Promise<() => Promise<{masterIp: string, masterPrivateIp: string, supabaseIp: string, supabasePrivateIp: string, workerIps: string[], floatingIp: string, networkId: string|number, sshKeyId: string, k3sToken: string, clusterName: string}>>}
   *   No `vpcCidr` — Hetzner's S3 endpoints resolve to public IPs, so it
   *   never needs the DO-only S3-egress VPC allowance (see base.js's
   *   DEFAULT_VPC_CIDR / getS3EgressExtraCidrs, M3 Task 9c).
   */
  static async getK8sProgram(config) {
    const { buildHetznerK8sProgram } = await import('../iac/programs/hetzner-k8s.js');
    return buildHetznerK8sProgram(config);
  }

  static REGIONS = {
    fsn1: 'Falkenstein, Germany',
    nbg1: 'Nuremberg, Germany',
    hel1: 'Helsinki, Finland',
    ash: 'Ashburn, Virginia, USA',
    hil: 'Hillsboro, Oregon, USA',
  };

  // Continent grouping for HA standby selection. The goal is to keep a primary
  // and its failover standby on the same continent so cross-region replication
  // (wal-g/S3 + Postgres streaming) doesn't pay a transatlantic RTT.
  static REGION_CONTINENT = {
    fsn1: 'eu',
    nbg1: 'eu',
    hel1: 'eu',
    ash: 'na',
    hil: 'na',
  };

  /**
   * Default HA standby region for a given primary: a DIFFERENT region on the
   * same continent, so failover stays intra-continent (a US primary fails over
   * to the other US region, not across the Atlantic). Used as the pre-selected
   * value in the interactive standby prompt and as the headless default.
   * @param {string} primaryRegion
   * @returns {string}
   */
  static getDefaultStandbyRegion(primaryRegion) {
    const continent = HetznerProvider.REGION_CONTINENT[primaryRegion];
    const sameContinent = Object.keys(HetznerProvider.REGION_CONTINENT).filter(
      (r) => r !== primaryRegion && HetznerProvider.REGION_CONTINENT[r] === continent,
    );
    if (sameContinent.length > 0) {
      // Keep the conventional nbg1<->fsn1 EU pairing where it applies.
      if (primaryRegion === 'nbg1') return 'fsn1';
      return sameContinent[0];
    }
    // No same-continent partner (e.g. a future single-region continent) —
    // fall back to the robust EU default, but never to the primary itself.
    return primaryRegion === 'nbg1' ? 'fsn1' : 'nbg1';
  }

  // Offline fallback catalog — used when the API is unreachable or no token is available.
  // Specs only; availability is approximate and live data from fetchServerTypes() takes
  // precedence. Prices are intentionally not hard-coded here — see PRICING_URL.
  //
  // Orderability, per the Hetzner Cloud changelog entry of 2025-10-16
  // (https://docs.hetzner.cloud/changelog), effective 2026-01-01:
  //   - Old shared-Intel `cx22/32/42/52` (IDs 104-107): unorderable everywhere.
  //   - Old shared-AMD `cpx11/21/31/41/51` (IDs 22-26): unorderable in FSN,
  //     NBG, HEL and SIN — but NOT in the US locations, where they remain the
  //     only shared-vCPU line on offer.
  // The replacement generations shipped the same day: `cx23/33/43/53`
  // (IDs 114-117, EU only) and `cpx12/22/32/42/52/62` (IDs 108-113, EU+SIN).
  //
  // Deprecated SKUs are KEPT here on purpose: this is a spec catalog, not an
  // order list. Existing servers still run these types, and they are still
  // orderable in ash/hil. Orderability is decided at runtime, not here: the
  // live path filters through isLocationOrderable, which reads BOTH the
  // `deprecation` field (global and per-location) and `available`.
  static FALLBACK_SERVER_TYPES = {
    // Current shared Intel (EU only: fsn1/nbg1/hel1)
    cx23: { vcpu: 2, ram: 4, disk: 40 },
    cx33: { vcpu: 4, ram: 8, disk: 80 },
    cx43: { vcpu: 8, ram: 16, disk: 160 },
    cx53: { vcpu: 16, ram: 32, disk: 320 },
    // Legacy shared Intel — unorderable everywhere since 2026-01-01
    cx22: { vcpu: 2, ram: 4, disk: 40 },
    cx32: { vcpu: 4, ram: 8, disk: 80 },
    cx42: { vcpu: 8, ram: 16, disk: 160 },
    cx52: { vcpu: 16, ram: 32, disk: 320 },
    // Current shared AMD (EU + SIN; absent from ash/hil as of 2026-07)
    cpx12: { vcpu: 1, ram: 2, disk: 40 },
    cpx22: { vcpu: 2, ram: 4, disk: 80 },
    cpx32: { vcpu: 4, ram: 8, disk: 160 },
    cpx42: { vcpu: 8, ram: 16, disk: 320 },
    cpx52: { vcpu: 12, ram: 24, disk: 480 },
    cpx62: { vcpu: 16, ram: 32, disk: 640 },
    // Legacy shared AMD — unorderable in EU/SIN, still orderable in ash/hil
    cpx11: { vcpu: 2, ram: 2, disk: 40 },
    cpx21: { vcpu: 3, ram: 4, disk: 80 },
    cpx31: { vcpu: 4, ram: 8, disk: 160 },
    cpx41: { vcpu: 8, ram: 16, disk: 240 },
    cpx51: { vcpu: 16, ram: 32, disk: 360 },
    // No `cax*` (ARM) entries — vibecarbon is x86-64 only (see
    // src/lib/deploy/platform.js). Hetzner's ARM line existed in just 3 of 6
    // locations (fsn1/hel1/nbg1) and 4 SKUs anyway; listing it here made ARM
    // reachable from every offline-path prompt.
    ccx13: { vcpu: 2, ram: 8, disk: 80 },
    ccx23: { vcpu: 4, ram: 16, disk: 160 },
    ccx33: { vcpu: 8, ram: 32, disk: 240 },
    ccx43: { vcpu: 16, ram: 64, disk: 360 },
    ccx53: { vcpu: 32, ram: 128, disk: 600 },
    ccx63: { vcpu: 48, ram: 192, disk: 960 },
  };

  // Live catalog populated by fetchServerTypes(). Falls back to FALLBACK_SERVER_TYPES.
  static SERVER_TYPES = { ...HetznerProvider.FALLBACK_SERVER_TYPES };

  // Per-location availability populated by fetchServerTypes().
  // Maps location name → Set of available server type names.
  static _locationTypes = null;

  // Generic default / prompt seed, and the "e.g. …" in the amd64 guard's error
  // text. Must name something the DEFAULT (EU) region can actually place.
  //
  // Was `cpx11`: deprecated in every EU location on 2026-01-01. Briefly `cx23`:
  // that whole line reads `available: false` across fsn1/nbg1/hel1, so it was
  // no better. `cpx22` is the current AMD shared generation and is live in all
  // three. Region-specific selection lives in getRegionDefaults (US split); a
  // live catalog overrides all of this via fetchServerTypes.
  static DEFAULT_TYPE = 'cpx22';
  static HA_REGIONS = ['fsn1', 'hel1'];

  static SUPPORTED_TIERS = ['compose', 'compose-ha', 'k8s', 'k8s-ha'];

  static EU_REGIONS = ['fsn1', 'nbg1', 'hel1'];
  static US_REGIONS = ['ash', 'hil'];

  // Prefix-based fallback for region filtering when live data is unavailable.
  // x86 families only: `cax` (ARM) is deliberately absent from the EU list —
  // vibecarbon is amd64-only (see src/lib/deploy/platform.js), and this list is
  // what `getServerTypesForRegion` offers the operator when the API is
  // unreachable.
  static REGION_TYPE_PREFIXES = {
    us: ['cpx', 'ccx'],
    eu: ['cx', 'cpx', 'ccx'],
  };

  // ── Engine-literal relocations (C7b) ───────────────
  // Hoisted from effects/compose-ha.js and effects/index.js and
  // deploy/k8s/k3s.js's deployK3s — see base.js for field docs.
  //
  // Moved off `cx23` on 2026-07-30: that entire line reads `available: false`
  // in fsn1/nbg1/hel1, so these seeded headless deploys with a SKU the API
  // refuses to place. `cpx22` is the same 2 vCPU / 4 GB shape and is live in
  // all three EU locations. Keep these equal to DEFAULT_TYPE unless there is a
  // reason not to — a drift guard asserts all three agree.
  static DEFAULT_COMPOSE_TYPE = 'cpx22';
  static DEFAULT_K8S_NODE_TYPE = 'cpx22';

  // ── Compose-tier replacement-server identity — see base.js's doc block ──

  /**
   * Matches hetzner-compose.js's buildHetznerComposeProgram `image:
   * 'docker-ce'` literal (lib/iac/programs/hetzner-compose.js:115) exactly.
   * @type {string}
   */
  static COMPOSE_IMAGE = 'docker-ce';

  /**
   * Returns the same raw shared cloud-init file hetzner-compose.js's Pulumi
   * program reads (both point at the identical
   * carbon/cloud-init/docker-ce-setup.yaml via their own CLOUD_INIT_PATH).
   * Delegates to deploy/compose/index.js's `loadCloudInitScript` (dynamic
   * import — keeps the deploy layer out of this class's static-load graph
   * until actually called) rather than re-declaring the path a third time.
   * @returns {Promise<string>}
   */
  static async getComposeUserData() {
    const { loadCloudInitScript } = await import('../deploy/compose/index.js');
    return loadCloudInitScript();
  }

  // ── K8s asset identity — pure string data (C7c) ──────────────────────
  // Hoisted verbatim from scale.js (csi-node rollout wait), diagnose.js
  // (CCM/CSI label selectors + the CCM-deployment env-var probe), and
  // shell.js (network env export + banner). See base.js K8S_ASSETS for
  // the field-by-consumer breakdown. `cloudSecretName` was in the original
  // plan sketch but dropped — no call site in these three consumers reads
  // a k8s Secret name (that literal lives in carbon/cloud-init/k3s/master-init.sh,
  // templated by iac/programs/hetzner-k8s.js, out of scope until Phase B).
  static K8S_ASSETS = {
    csiNodeDaemonSet: 'daemonset/hcloud-csi-node',
    csiControllerSelector:
      'app.kubernetes.io/component=controller,app.kubernetes.io/name=hcloud-csi',
    ccmDeployment: 'hcloud-cloud-controller-manager',
    ccmSelector: 'app.kubernetes.io/name=hcloud-cloud-controller-manager',
    networkEnvVar: 'HCLOUD_NETWORK',
  };

  /**
   * StorageClass name Hetzner's hcloud-csi driver (v2.18.1, installed by
   * master-init.sh) creates by default. Value verified live — this is what
   * `services/observability/k8s/{loki,grafana,prometheus}-pvc.yaml` and
   * `services/n8n/k8s/pvc.yaml`'s `storageClassName: {{K8S_STORAGE_CLASS}}`
   * placeholder resolves to for a Hetzner deploy (M3 Task 4; see base.js
   * K8S_STORAGE_CLASS for why resolution happens PRE-APPLY inside
   * `applyK3sManifests`, not a deploy-time kubectl patch and not at `add`
   * time). See DigitalOceanProvider.K8S_STORAGE_CLASS for the DO
   * counterpart.
   * @type {string}
   */
  static K8S_STORAGE_CLASS = 'hcloud-volumes';

  /**
   * Matches hetzner-k8s.js's `image: 'ubuntu-24.04'` literal (the master,
   * supabase, and worker `hcloud.Server` resources all use the same slug —
   * lib/iac/programs/hetzner-k8s.js:243,283,318) exactly.
   * `renderCarbonAutoscalerConfig` reads this for the CA-spawned worker
   * node group's `image` field instead of hardcoding it.
   * @type {string}
   */
  static K8S_IMAGE = 'ubuntu-24.04';

  /**
   * Render this provider's k3s master-node boot user-data — wraps
   * `carbon/cloud-init/k3s/master-init.sh` via loadCloudInit/renderScript
   * (M3 Task 3), the SAME template hetzner-k8s.js's Pulumi program renders
   * directly today (lib/iac/programs/hetzner-k8s.js:117,223) — this static
   * is an ADDITIVE wrap, not a replacement of that call site (left
   * untouched this task to avoid touching the frozen Hetzner render path
   * mid-refactor; a later task may route it through here instead).
   * @param {{
   *   k3s_version: string,
   *   k3s_token: string,
   *   hcloud_token: string,
   *   network_id: string|number,
   *   floating_ip: string,
   *   project_name: string,
   *   cluster_name?: string,
   *   disable_traefik?: string,
   * }} vars - Passed straight through to renderScript; must match
   *   hetzner-k8s.js's own masterUserData renderScript call vars EXACTLY
   *   for byte-identical output. Only k3s_version, k3s_token,
   *   hcloud_token, network_id, floating_ip, and project_name are actually
   *   substituted into master-init.sh's `${...}` placeholders —
   *   cluster_name/disable_traefik are accepted for call-site parity with
   *   hetzner-k8s.js but are unused by the template (same as today).
   * @returns {Promise<string>}
   */
  static async getK8sMasterUserData(vars) {
    const { loadCloudInit, renderScript } = await import('../iac/cloud-init.js');
    return renderScript(loadCloudInit('master-init.sh'), vars);
  }

  /**
   * Render this provider's k3s worker-node boot user-data — wraps
   * `carbon/cloud-init/k3s/worker-init.sh` via loadCloudInit/renderScript
   * (M3 Task 3), the SAME template both hetzner-k8s.js's Pulumi program
   * (static workers) and deploy/k8s/k3s.js's renderCarbonAutoscalerConfig
   * (CA-spawned workers) render directly today. See
   * getK8sMasterUserData's doc for why those call sites are left
   * untouched this task.
   * @param {{
   *   k3s_version: string,
   *   k3s_token: string,
   *   master_ip: string,
   *   cluster_name?: string,
   * }} vars - Only k3s_version, k3s_token, and master_ip are substituted
   *   into worker-init.sh's `${...}` placeholders; cluster_name is
   *   accepted for call-site parity (renderCarbonAutoscalerConfig passes
   *   it) but unused by the template (same as today).
   * @returns {Promise<string>}
   */
  static async getK8sWorkerUserData(vars) {
    const { loadCloudInit, renderScript } = await import('../iac/cloud-init.js');
    return renderScript(loadCloudInit('worker-init.sh'), vars);
  }

  /**
   * Render this provider's k3s supabase-node boot user-data — wraps
   * `carbon/cloud-init/k3s/supabase-init.sh` via loadCloudInit/renderScript
   * (M3 Task 5), the SAME template hetzner-k8s.js's Pulumi program renders
   * directly today (lib/iac/programs/hetzner-k8s.js:118,268). See
   * getK8sMasterUserData's doc for why that call site is left untouched.
   * @param {{
   *   k3s_version: string,
   *   k3s_token: string,
   *   master_ip: string,
   * }} vars - Passed straight through to renderScript; must match
   *   hetzner-k8s.js's own supabaseUserData renderScript call vars EXACTLY
   *   for byte-identical output.
   * @returns {Promise<string>}
   */
  static async getK8sSupabaseUserData(vars) {
    const { loadCloudInit, renderScript } = await import('../iac/cloud-init.js');
    return renderScript(loadCloudInit('supabase-init.sh'), vars);
  }

  /**
   * Fetch server types and per-location pricing from the Hetzner API.
   * Populates SERVER_TYPES with live data and caches per-location availability.
   * Safe to call multiple times — returns cached data after the first successful fetch.
   * @param {string} apiToken - Hetzner API token
   * @returns {Promise<boolean>} true if live data was loaded, false on failure (fallback used)
   */
  static async fetchServerTypes(apiToken) {
    if (HetznerProvider._locationTypes) return true; // already fetched

    try {
      // Walk pagination via the shared walker. /server_types fits in one
      // 50-entry page today, but "fits today" is exactly how truncated-listing
      // bugs ship (see hetzner-pagination.js's module doc — the API defaults
      // to 25/page and hides the rest behind meta.pagination.next_page). An
      // incomplete walk returns false so a truncated catalog can never pose
      // as live truth — the offline FALLBACK catalog is at least honest about
      // being a fallback.
      const { items, complete } = await listHetznerPages({
        path: '/server_types',
        key: 'server_types',
        token: apiToken,
        apiBase: HetznerProvider.API_BASE,
        fetchImpl: fetchWithRetry,
      });
      if (!complete) return false;
      // Empty-catalog guard: a 200 whose body lacks the `server_types` key
      // walks "complete" with zero items (the walker's missing-key tolerance
      // is correct for the destroy sweeps, where an empty listing is a real
      // answer). HERE zero items would wipe SERVER_TYPES, set the truthy
      // `_locationTypes = {}` short-circuit, and return true — permanently
      // trading the populated fallback catalog for nothing. The Hetzner
      // catalog is never legitimately empty, so treat empty as failure and
      // keep the fallback. (Pre-pagination, the `for..of data.server_types`
      // threw on that body and fell back — this preserves that outcome.)
      if (items.length === 0) return false;

      const types = {};
      const locationTypes = {};

      for (const t of items) {
        if (t.deprecation) continue;

        // amd64-only (see src/lib/deploy/platform.js). Drop ARM at the source
        // so it can never reach a prompt, a region default, or a persisted
        // config: SERVER_TYPES and _locationTypes feed getServerTypesForRegion,
        // getRegionDefaults and every option builder downstream, and removing
        // `cax*` from the offline FALLBACK catalog alone would NOT have covered
        // them (live data replaces that catalog wholesale). The API tags each
        // SKU's `architecture` ('x86' | 'arm'); the name check is a belt-and-
        // braces fallback should the field ever be absent.
        if (t.architecture === 'arm' || HetznerProvider.isArmServerType(t.name)) continue;

        // Build per-location availability from the `locations` field (actual availability),
        // not `prices` (which includes regions where the type is priced but not placeable).
        for (const loc of t.locations || []) {
          const locName = loc.name || loc;
          if (!HetznerProvider.isLocationOrderable(loc)) continue;
          if (!locationTypes[locName]) locationTypes[locName] = new Set();
          locationTypes[locName].add(t.name);
        }

        types[t.name] = {
          vcpu: t.cores,
          ram: t.memory,
          disk: t.disk,
          cpuType: t.cpu_type,
          architecture: t.architecture,
        };
      }

      // Post-FILTER empty guard (PR #214 re-review): the raw-items guard
      // above has the same hole one layer down — a catalog whose entries
      // are all filtered out (all-ARM, or all SKU-level deprecated) would
      // still wipe SERVER_TYPES and arm the short-circuit. Unreachable
      // today (the global catalog always carries x86 SKUs), but
      // "unreachable today" is exactly how the raw-items hole shipped.
      //
      // DELIBERATELY counts `types` (the SKU/spec axis), NOT `locationTypes`
      // (the per-location offer axis that isLocationOrderable prunes, PR
      // #215). The two compose, they don't stack: a SKU orderable in ZERO
      // locations still lands in `types` as a spec entry, so an
      // availability blackout can never trip this guard — correctly, since
      // live "nothing orderable" knowledge beats the fallback's optimism,
      // SERVER_TYPES must stay a usable spec table (provider-contract pins
      // DEFAULT_TYPE ∈ SERVER_TYPES), and getRegionDefaults degrades
      // per-region to its offline branch when a location has no orderable
      // entry. Pinned in fetch-server-types-pagination.test.ts
      // ("availability blackout is NOT an empty catalog").
      if (Object.keys(types).length === 0) return false;

      HetznerProvider.SERVER_TYPES = types;
      HetznerProvider._locationTypes = locationTypes;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * THE orderability predicate for one entry of a server type's `locations[]`.
   *
   * Two independent flags can each make a SKU unorderable in a location, and
   * for a long time this only checked the first:
   *   - `deprecation` — an announced retirement (e.g. the whole `cpx*1` line in
   *     FSN/NBG/HEL from 2026-01-01). Permanent, and pre-announced.
   *   - `available`   — live capacity/offering state. Flips WITHOUT notice and
   *     in both directions. The entire `cx*3` line read `available: false`
   *     across all three EU locations while this filter ignored the field, so
   *     the CLI kept offering SKUs the API would refuse to place. That is the
   *     root cause of "our table has the wrong SKUs in it": picking better
   *     constants is a patch, reading the flag is the fix.
   *
   * Treats a MISSING `available` as orderable — older/other shapes of this
   * payload omit it, and absence must not empty the catalog. Only an explicit
   * `false` excludes.
   *
   * Single chokepoint on purpose: every offered SKU must pass exactly the same
   * test the provisioner will apply. tests/unit/providers/hetzner-availability
   * .test.ts asserts the offer paths never emit a SKU outside this filter's
   * output.
   *
   * @param {{deprecation?: unknown, available?: boolean}|string} loc
   * @returns {boolean}
   */
  static isLocationOrderable(loc) {
    if (typeof loc === 'string') return true;
    if (loc?.deprecation) return false;
    return loc?.available !== false;
  }

  /**
   * Returns region-appropriate default server types.
   *
   * Hetzner's SKU availability is split by geography AND by generation:
   *   - EU (fsn1/nbg1/hel1): `cpx*2` (AMD shared, current) + `ccx*` (dedicated).
   *     The `cpx*1` line was DEPRECATED here on 2026-01-01, and the entire
   *     `cx*3` line currently reads `available: false` in all three — so `cpx*2`
   *     is the only shared-vCPU line actually placeable in the EU.
   *   - US (ash/hil):        `cpx*1` (AMD shared) + `ccx*`. No `cx` line has
   *     ever existed here, and the current `cpx*2` generation has not landed
   *     here either — so the legacy names remain correct for these two.
   * There is consequently no shared-vCPU x86 SKU valid in all five regions.
   *
   * These constants are a BEST-EFFORT offline fallback only. `available` flips
   * without notice in both directions, so no hardcoded list can stay correct;
   * the real guarantee is that the live path filters through
   * isLocationOrderable and never offers a SKU outside that set.
   *
   * (Hetzner also sells a `cax*` ARM line in the three EU locations. It is
   * excluded everywhere — vibecarbon is amd64-only; see
   * src/lib/deploy/platform.js.)
   *
   * Shared-vCPU x86 for cluster nodes. Prefer tiers in this order for
   * each role, falling back to the first available:
   *   - master/worker: 2 vCPU, 2–4 GB RAM
   *   - supabase:      2–4 vCPU, 4+ GB RAM
   */
  static getRegionDefaults(region) {
    const available = HetznerProvider._locationTypes?.[region];

    // Preference lists — order matters. First available in the region wins.
    // Both current generations lead, then the legacy names, which are still
    // orderable in ash/hil. `cx*3` stays in the list deliberately: it is
    // `available: false` in the EU today, but that flag can flip back, and the
    // live filter (isLocationOrderable) is what decides — the list only
    // expresses preference, never availability.
    const smallShared = ['cpx11', 'cpx22', 'cx23', 'cx22']; // ~2 vCPU, 2–4 GB
    const mediumShared = ['cpx32', 'cx33', 'cpx21', 'cx23', 'cx32']; // 2–4 vCPU, 4–8 GB

    // Offline defaults, by region. There is no single shared-vCPU x86 SKU that
    // is orderable in every supported location: the EU locations lost the whole
    // `cpx*1` generation on 2026-01-01 AND currently show the whole `cx*3` line
    // as unavailable, while the `cpx*2` generation has not reached ash/hil,
    // which have no `cx` line at all. So the offline path has to branch rather
    // than "assume US" as it did until 2026-07 — that older comment claimed CPX
    // was the stable family and EU `cx` the one that rotates, which is
    // backwards: `cpx11`/`cpx21` are exactly the SKUs that went unorderable
    // across all four EU+APAC locations.
    const offline = HetznerProvider.US_REGIONS.includes(region)
      ? { masterType: 'cpx11', supabaseType: 'cpx21', workerType: 'cpx11' }
      : { masterType: 'cpx22', supabaseType: 'cpx32', workerType: 'cpx22' };

    const pickAvailable = (prefs, fallback) => {
      if (available) {
        for (const t of prefs) if (available.has(t)) return t;
      }
      return fallback;
    };

    if (available) {
      return {
        masterType: pickAvailable(smallShared, offline.masterType),
        supabaseType: pickAvailable(mediumShared, offline.supabaseType),
        workerType: pickAvailable(smallShared, offline.workerType),
      };
    }

    return offline;
  }

  /**
   * Hetzner's ARM (aarch64) line is the `cax*` family — cax11/21/31/41, and
   * only in fsn1/hel1/nbg1. See BaseProvider.isArmServerType for the contract.
   * @param {string} serverType
   * @returns {boolean}
   */
  static isArmServerType(serverType) {
    return typeof serverType === 'string' && serverType.startsWith('cax');
  }

  /**
   * Size-preserving ARM (`cax*`) → x86 map. THE single source of truth for the
   * ARM rescue — see BaseProvider.armToAmd64Equivalent for the contract. If you
   * are about to add a second ARM→x86 mapping somewhere else, don't: a parallel
   * one existed briefly and the two disagreed. One map, one owner.
   *
   * The mapping is by SPEC, not by numeric suffix. Hetzner's ARM line runs one
   * family digit "richer" than the AMD shared line at the same suffix, so
   * `cax<N>1 → cpx<N>1` would silently halve a node's RAM — and for cax11 it
   * would land on 2 GB, BELOW `COMPOSE_MIN_RAM_GB`.
   *
   * Targets the CURRENT `cpx*2` generation, not the legacy `cpx*1` one. This is
   * an orderability requirement, not a preference: `cax*` only ever existed in
   * fsn1/hel1/nbg1, and those are exactly the locations where Hetzner made the
   * whole `cpx*1` line unorderable on 2026-01-01. Rescuing onto a SKU Hetzner
   * will refuse to create defeats the point of the rescue. (The `cx*3` line is
   * not a candidate either — it reads `available: false` in all three EU
   * locations. Availability is the binding constraint here; see
   * fetchServerTypes, which now filters on it.)
   *
   * The current generation is also a strictly better spec match than `cpx*1`:
   * vCPU and RAM are EXACT on all four, with equal-or-larger disk. Nothing here
   * ever shrinks a node. (ARM specs are Hetzner's, recorded here because the
   * `cax*` entries were deliberately removed from FALLBACK_SERVER_TYPES.)
   *
   *   cax11  2 vCPU /  4 GB /  40 GB  →  cpx22   2 vCPU /  4 GB /  80 GB
   *   cax21  4 vCPU /  8 GB /  80 GB  →  cpx32   4 vCPU /  8 GB / 160 GB
   *   cax31  8 vCPU / 16 GB / 160 GB  →  cpx42   8 vCPU / 16 GB / 320 GB
   *   cax41 16 vCPU / 32 GB / 320 GB  →  cpx62  16 vCPU / 32 GB / 640 GB
   *
   * Hetzner's ARM line is exactly these four SKUs and is closed as far as
   * vibecarbon is concerned (nothing in the product *chooses* ARM any more — a
   * `cax` type can only arrive from an environment provisioned before the
   * x86-64 standardization, or from a hand-edited `.vibecarbon.json`). An
   * unmapped `cax*` therefore means a SKU we have never seen; it falls back to
   * DEFAULT_COMPOSE_TYPE (4 GB) so the floor is never below COMPOSE_MIN_RAM_GB.
   */
  static ARM_TO_AMD64 = {
    cax11: 'cpx22',
    cax21: 'cpx32',
    cax31: 'cpx42',
    cax41: 'cpx62',
  };

  /**
   * @param {string} serverType
   * @returns {string}
   */
  static armToAmd64Equivalent(serverType) {
    if (!HetznerProvider.isArmServerType(serverType)) return serverType;
    return HetznerProvider.ARM_TO_AMD64[serverType] ?? HetznerProvider.DEFAULT_COMPOSE_TYPE;
  }

  /**
   * Returns the equivalent server type available in a target region.
   *
   * Called by BOTH HA standby fan-outs (deploy/effects/k8s-ha.js and, since
   * 2026-08-20, deploy/effects/compose-ha.js) to translate the primary's types
   * into SKUs the standby region actually offers. Result is always x86 —
   * vibecarbon is amd64-only (src/lib/deploy/platform.js).
   */
  static resolveServerTypeForRegion(serverType, targetRegion) {
    // ARM→x86 rescue, applied up front and REGARDLESS of availability.
    //
    // "Regardless of availability" is load-bearing: cax IS available in
    // fsn1/hel1/nbg1, so the old availability-first walk (`if
    // (available.has(serverType)) return serverType`) would have happily kept
    // an ARM type for an EU standby.
    //
    // This is belt-and-braces, NOT how an ARM type is normally handled. The
    // live callers are the deploy-time standby fan-outs
    // (deploy/effects/k8s-ha.js, deploy/effects/compose-ha.js), whose inputs
    // already passed
    // assertAmd64ServerType in the deploy prompt — so in practice nothing ARM
    // reaches here. Every path where an unvalidated type could reach real
    // hardware (scale -type, failover -server-type, the persisted
    // ha.standbyWorkerSpec.serverType, .vibecarbon.json) REJECTS instead. The
    // substitution is size-preserving (armToAmd64Equivalent), so if it ever
    // does fire it cannot quietly downsize a node.
    const requested = HetznerProvider.armToAmd64Equivalent(serverType);
    const available = HetznerProvider._locationTypes?.[targetRegion];

    // If live data available, check directly
    if (available) {
      if (available.has(requested)) return requested;

      // Fall back to region defaults at the same role tier. There is NO
      // x86→ARM (cpx→cax) leg here any more. It used to convert an x86
      // primary's cpx11 into ARM cax11 on an EU standby — an arch flip the
      // amd64 app image cannot survive, chasing scarcer ARM capacity besides
      // (RCA 2026-06-23: nbg1 standby failed resource_unavailable on cax). The
      // offline branch below was hardened at the time; this live-data branch
      // was missed and kept flipping until the x86-64 standardization.
      // getRegionDefaults only ever returns x86 SKUs, so the tier fallback is
      // arch-safe by construction.
      const suffix = requested.replace(/^[a-z]+/, '');
      const defaults = HetznerProvider.getRegionDefaults(targetRegion);
      if (suffix.startsWith('1')) return defaults.masterType;
      if (suffix.startsWith('2')) return defaults.supabaseType;
      return defaults.workerType;
    }

    // Offline fallback — no live catalog to consult. x86 shared-vCPU (cx/cpx)
    // is available in every Hetzner location, so the requested type is assumed
    // placeable as-is; `requested` is already x86 thanks to the rescue above.
    return requested;
  }

  /**
   * Returns server types available in the given region.
   * Uses live per-location data when available, otherwise falls back to prefix filtering.
   *
   * Every entry carries an `architecture` field so the shared prompt builders
   * (lib/server-types.js `filterAmd64Types`) can drop non-amd64 SKUs without
   * knowing Hetzner's `cax*` naming. Live entries already carry it from the
   * API; offline entries are stamped from the SKU family here. Result is
   * amd64-only in practice — ARM is dropped at both catalog sources — but the
   * field is what makes that guarantee legible (and enforceable) downstream.
   */
  static getServerTypesForRegion(region) {
    const withArchitecture = (name, info) => ({
      name,
      ...info,
      architecture: info.architecture ?? (HetznerProvider.isArmServerType(name) ? 'arm' : 'x86'),
    });

    const available = HetznerProvider._locationTypes?.[region];

    if (available) {
      return [...available]
        .filter((name) => name in HetznerProvider.SERVER_TYPES)
        .map((name) => withArchitecture(name, HetznerProvider.SERVER_TYPES[name]))
        .sort((a, b) => a.vcpu - b.vcpu || a.ram - b.ram);
    }

    // Offline fallback — filter by prefix
    const prefixes = HetznerProvider.US_REGIONS.includes(region)
      ? HetznerProvider.REGION_TYPE_PREFIXES.us
      : HetznerProvider.REGION_TYPE_PREFIXES.eu;
    return Object.entries(HetznerProvider.SERVER_TYPES)
      .filter(([name]) => prefixes.some((prefix) => name.startsWith(prefix)))
      .map(([name, info]) => withArchitecture(name, info));
  }

  /**
   * Create a new Hetzner server
   * @param {object} config - Server configuration
   * @param {(string|number)[]} [config.networks] - Network id(s) to attach
   *   at create time (see BaseProvider.createServer's doc for the contract).
   *   Coerced to Number — Hetzner's POST /servers `networks` field is a flat
   *   array of integer network ids (unlike `firewalls`, which wraps each id
   *   in a `{firewall: id}` object); the coercion is defensive against a
   *   caller holding the id as a string, matching how `group.running`'s map
   *   keys elsewhere in this codebase stringify provider ids.
   * @returns {Promise<{id: number, server: object}>}
   */
  async createServer(config) {
    const {
      name,
      serverType,
      region,
      sshKeyId,
      sshKeys,
      environment,
      image,
      firewalls,
      labels,
      userData,
      networks,
    } = config;

    const body = {
      name,
      server_type: serverType,
      location: region,
      image: image || 'docker-ce',
      ssh_keys: sshKeys || (sshKeyId ? [sshKeyId] : []),
      public_net: {
        enable_ipv4: true,
        enable_ipv6: true,
      },
      labels: labels || {
        'managed-by': 'vibecarbon',
        environment: environment || 'default',
      },
    };
    if (firewalls?.length) {
      body.firewalls = firewalls.map((id) => ({ firewall: id }));
    }
    if (networks?.length) {
      body.networks = networks.map((id) => Number(id));
    }
    // user_data runs at boot time via cloud-init. Hetzner accepts either a
    // raw shell script or a #cloud-config YAML document up to 32KB. We pass
    // whatever string the caller supplies; compose deploy uses a cloud-config
    // YAML that front-loads ufw + unattended-upgrades installs so setupServer
    // can shrink to a marker-file probe.
    if (userData) {
      body.user_data = userData;
    }

    // Retry on transient resource_limit_exceeded — observed when several
    // scenarios concurrently provision in a quota-tight project (e.g.
    // matrix-mode e2e + W1.5a parallel compose-ha scale doubled
    // the in-flight Primary IP allocations and tripped Hetzner's project
    // quota at iter-reliab 2026-05-01T14:13Z). Old servers being torn
    // down free their Primary IPs within 30-90s, so backing off and
    // retrying tends to succeed without operator intervention. If the
    // quota is genuinely too low for the workload, we still surface the
    // error after exhausting attempts.
    const RESOURCE_LIMIT_DELAYS_MS = [15_000, 45_000, 90_000];
    let response;
    let attemptError = null;
    for (let attempt = 0; attempt <= RESOURCE_LIMIT_DELAYS_MS.length; attempt++) {
      response = await this.apiRequest('/servers', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (response.ok) break;
      // Body is read at most once per attempt; reuse `attemptError` rather
      // than `response.clone()` so the WHATWG fetch shim and the test mock
      // (which doesn't implement clone()) both work.
      attemptError = await response.json();
      const peekCode = attemptError.error?.code || '';
      const peekMessage = attemptError.error?.message || '';
      const isResourceLimit =
        peekCode === 'resource_limit_exceeded' || /resource_limit_exceeded/i.test(peekMessage);
      if (!isResourceLimit || attempt === RESOURCE_LIMIT_DELAYS_MS.length) {
        break;
      }
      // Log to stderr so operator (or post-run analysis) can see we're
      // queueing rather than dying on first quota bump.
      console.warn(
        `[hetzner] createServer(${name}): quota busy (${peekMessage}); ` +
          `retrying in ${RESOURCE_LIMIT_DELAYS_MS[attempt] / 1000}s ` +
          `(attempt ${attempt + 1}/${RESOURCE_LIMIT_DELAYS_MS.length + 1})`,
      );
      await new Promise((r) => setTimeout(r, RESOURCE_LIMIT_DELAYS_MS[attempt]));
    }

    if (!response.ok) {
      const error = attemptError ?? { error: { message: 'Unknown error', code: 'unknown' } };
      const message = error.error?.message || 'Unknown error';
      const code = error.error?.code || 'unknown';

      let hint = '';
      if (code === 'invalid_input' && message.includes('unsupported location')) {
        hint = `\nHint: Server type "${serverType}" is not available in region "${region}". Try a different server type or region.`;
      } else if (code === 'uniqueness_error') {
        // Recover: look up the existing server by name and return it
        const [existing] = await this.findServersByName(name);
        if (existing) {
          return { id: existing.id, server: existing, reused: true };
        }
        hint = `\nHint: A server with this name already exists. Use --destroy first or choose a different environment name.`;
      } else if (code === 'unauthorized') {
        hint = '\nHint: Check that your API token is valid and has Read & Write permissions.';
      } else if (code === 'resource_limit_exceeded') {
        hint =
          '\nHint: Project quota exhausted even after retries. Either wait for in-flight tear-downs to free resources, or raise the project quota in the Hetzner Console (Resources → Limits).';
      }

      throw new Error(`Hetzner API error: ${message} (${code})${hint}`);
    }

    const data = await response.json();
    return { id: data.server.id, server: data.server };
  }

  /**
   * Get a lightweight status summary for a server: current status + type
   * name. Verbatim move from status.js's original getServerInfo (C8) — a
   * single raw `fetch` (NOT fetchWithRetry / this.apiRequest) with a hard
   * 5000ms abort and null-on-any-failure semantics. `status` is a hot
   * read-only command that runs this on every invocation; it must stay a
   * single attempt, no retry. The token-presence check the original
   * function did up front (`if (!apiToken) return null`) is now the
   * caller's job (env-only token gate in status.js) — a constructed
   * instance always has a truthy apiToken (BaseProvider's constructor
   * throws otherwise), so it's dropped here rather than duplicated.
   * @param {number|string} serverId - Server ID
   * @returns {Promise<{status: string, serverType: string|null}|null>}
   */
  async getServerSummary(serverId) {
    try {
      const response = await fetch(`${HetznerProvider.API_BASE}/servers/${serverId}`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return null;

      const { server } = await response.json();
      return {
        status: server.status,
        serverType: server.server_type?.name || null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch a single server type's specs by exact name — the source of the
   * `specs` argument carbon-autoscaler's `buildTemplateNode`
   * (src/autoscaler/node-template.js) needs for a node group's
   * `serverType`. Same `fetchWithRetry` + Bearer-auth pattern as
   * listServers (retries transient failures; NOT the single-shot
   * fetch/no-retry pattern getServerSummary above uses — this isn't a hot
   * per-invocation probe).
   * @param {string} name - Exact server type name (e.g. "cx23")
   * @returns {Promise<{cores: number, memoryGb: number, architecture: string, disk: number}>}
   */
  async getServerType(name) {
    const response = await fetchWithRetry(
      `${HetznerProvider.API_BASE}/server_types?name=${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${this.apiToken}` } },
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch server type "${name}": ${response.status}`);
    }
    const { server_types } = await response.json();
    const type = server_types?.[0];
    if (!type) {
      throw new Error(`Server type "${name}" not found`);
    }
    return {
      cores: type.cores,
      memoryGb: type.memory,
      architecture: type.architecture,
      disk: type.disk,
    };
  }

  /**
   * Delete a server. Two modes, keyed on `waitUntilGone` (merged in C10a;
   * error message converged in B0-5 — both modes throw
   * `Failed to delete server: <error.error.message>`):
   *
   *   - waitUntilGone=false (DEFAULT — scale semantics): fire the async DELETE
   *     and return once Hetzner accepts it (202/204/404). Transport is
   *     `this.apiRequest` (adds the JSON Content-Type header). Verbatim from
   *     the pre-C10a class method that scale.js calls (src/scale.js —
   *     old-server teardown + failed-scale cleanup), which never needed the
   *     VM fully gone before moving on.
   *
   *   - waitUntilGone=true (destroy semantics): DELETE then poll GET
   *     /servers/{id} until 404 (90s budget, fixed 2s interval), returning
   *     whether the server was present at DELETE time. Transport is a direct
   *     `fetchWithRetry` DELETE + a deliberately-un-retried raw `fetch` poll
   *     probe (NOT apiRequest — that would add Content-Type and change the
   *     probe's retry semantics). From destroy.js's old `hetznerDeleteServer`:
   *     Hetzner's DELETE is async (returns 202, VM drains for seconds), and a
   *     destroy→re-deploy cycle that recreates the same-named server before
   *     the old one is gone 409s with 'server name is already used
   *     (uniqueness_error)'.
   *
   * @param {number|string} serverId - Server ID
   * @param {{waitUntilGone?: boolean}} [options]
   * @returns {Promise<void|boolean>} void in default mode; in waitUntilGone
   *   mode, `true` if the server was present at DELETE time (poll attempted),
   *   `false` if it was already gone.
   */
  async deleteServer(serverId, { waitUntilGone = false } = {}) {
    if (!waitUntilGone) {
      const response = await this.apiRequest(`/servers/${serverId}`, {
        method: 'DELETE',
      });

      if (!response.ok && response.status !== 404) {
        const error = await response.json();
        throw new Error(`Failed to delete server: ${error.error?.message || 'Unknown error'}`);
      }
      return;
    }

    const response = await fetchWithRetry(`${HetznerProvider.API_BASE}/servers/${serverId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.json();
      throw new Error(`Failed to delete server: ${error.error?.message || 'Unknown error'}`);
    }

    // Hetzner's DELETE is async — it returns 202 and the actual VM teardown
    // continues for several seconds. Poll GET /servers/{id} until it returns
    // 404, with a 90s deadline (empirical delete time on cx23 is well under
    // that). Observed during compose restore. The same delete-then-poll fix is
    // applied in destroyComposeHA.
    if (response.status !== 404) {
      // A throwing probe (transient) is treated as falsy and retried; on budget
      // exhaustion we simply stop waiting — the return value below is unaffected.
      await pollUntil(
        async () => {
          const probe = await fetch(`${HetznerProvider.API_BASE}/servers/${serverId}`, {
            headers: { Authorization: `Bearer ${this.apiToken}` },
          });
          return probe.status === 404;
        },
        {
          budgetMs: 90_000,
          initialDelayMs: 2_000,
          backoffFactor: 1,
          description: `server ${serverId} deletion`,
        },
      ).catch(() => {});
    }

    return response.status !== 404;
  }

  /**
   * Rename a server. Verbatim move of scale.js's old inline
   * `PUT /servers/{id}` call (C10a-style primitive move onto the provider) —
   * doesn't check response.ok: the caller (scale's rename-to-permanent-name
   * step) wraps this in its own non-critical try/catch, since the new
   * server works fine under its temporary name if the rename fails.
   * @param {number|string} serverId - Server ID
   * @param {string} name - New server name
   * @returns {Promise<void>}
   */
  async renameServer(serverId, name) {
    await this.apiRequest(`/servers/${serverId}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    });
  }

  /**
   * Get server details
   * @param {number} serverId - Server ID
   * @returns {Promise<object>}
   */
  async getServer(serverId) {
    const response = await this.apiRequest(`/servers/${serverId}`);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Failed to get server: ${error.error?.message || 'Unknown error'}`);
    }

    const data = await response.json();
    return data.server;
  }

  /**
   * Wait for a server to become ready
   * @param {number} serverId - Server ID
   * @param {number} [timeout=300000] - Timeout in ms (default 5 minutes)
   * @returns {Promise<object>}
   */
  async waitForServer(serverId, timeout = this.constructor.WAIT_FOR_SERVER_TIMEOUT_MS) {
    const startTime = Date.now();
    const pollInterval = 5000;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await this.apiRequest(`/servers/${serverId}`);
        const { server } = await response.json();

        if (server.status === 'running') {
          return server;
        }
      } catch (error) {
        // Network errors - continue retrying
        if (Date.now() - startTime >= timeout - pollInterval) {
          throw new Error(`Failed to check server status: ${error.message}`);
        }
      }

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error('Server creation timed out');
  }

  /**
   * Create or update an SSH key
   * @param {string} name - SSH key name
   * @param {string} publicKey - Public key content
   * @returns {Promise<number>} SSH key ID
   */
  async createSSHKey(name, publicKey) {
    // Hetzner paginates /ssh_keys at 25 entries/page by default. Long-lived
    // Hetzner projects accumulate dozens of keys; with the default pagination
    // the dedup scan below would silently miss keys on pages 2+, and we'd hit
    // the very 409/"not unique" error the dedup is meant to prevent. Ask for
    // the max allowed page size (50) and still walk pagination defensively.
    const ssh_keys = [];
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      const resp = await this.apiRequest(`/ssh_keys?per_page=50&page=${page}`);
      const body = await resp.json();
      if (Array.isArray(body.ssh_keys)) ssh_keys.push(...body.ssh_keys);
      const next = body.meta?.pagination?.next_page;
      if (!next) break;
      page = next;
    }

    const newKeyPart = publicKey.split(' ').slice(0, 2).join(' ');

    // 1. If a key with the same name already exists, prefer it (by-name lookup).
    const existingByName = ssh_keys.find((k) => k.name === name);
    if (existingByName) {
      const existingKeyPart = existingByName.public_key.split(' ').slice(0, 2).join(' ');
      if (existingKeyPart === newKeyPart) {
        return existingByName.id;
      }
      // Same name but different key — delete so we can recreate.
      await this.apiRequest(`/ssh_keys/${existingByName.id}`, { method: 'DELETE' });
    }

    // 2. Hetzner also rejects `POST /ssh_keys` with 409/"not unique" if the
    // public-key bytes are already registered under a DIFFERENT name (common
    // in e2e test reruns that share a single dev key pair). Scan the
    // list a second time by key content and reuse if found.
    const existingByKey = ssh_keys.find((k) => {
      const kPart = k.public_key.split(' ').slice(0, 2).join(' ');
      return kPart === newKeyPart;
    });
    if (existingByKey) {
      return existingByKey.id;
    }

    // 3. Truly new — create it. Always tag with `managed-by=vibecarbon` so
    // post-run sweeps that filter by label_selector reap it on cleanup.
    // Without the label, leaked keys only show up in the name-prefix
    // preflight scan and silently block the next e2e run.
    const createResponse = await this.apiRequest('/ssh_keys', {
      method: 'POST',
      body: JSON.stringify({
        name,
        public_key: publicKey,
        labels: { 'managed-by': 'vibecarbon' },
      }),
    });

    if (!createResponse.ok) {
      const error = await createResponse.json();
      throw new Error(`Failed to create SSH key: ${error.error?.message || 'Unknown error'}`);
    }

    const { ssh_key } = await createResponse.json();
    return ssh_key.id;
  }

  /**
   * List ALL servers, optionally filtered by labels, walking pagination
   * (B0-4). Long-lived projects exceed one 50-entry page, and the destroy
   * sweeps that filter this list client-side would silently miss servers on
   * pages 2+. Keeps the C10a destroy semantics otherwise: direct
   * `fetchWithRetry` (NOT apiRequest — no Content-Type on a GET) and `[]` on
   * a non-ok first page; a non-ok mid-walk returns the pages already
   * collected.
   * @param {object} [labels] - Labels to filter by
   * @returns {Promise<object[]>}
   */
  async listServers(labels = {}) {
    return (await this.listServersDetailed(labels)).items;
  }

  /**
   * Server listing that preserves the page-walker's `complete` flag — see
   * BaseProvider.listServersDetailed for why a soft-failed `[]` must not be
   * allowed to read as "the project is quiet".
   * @param {object} [labels]
   * @returns {Promise<{ items: object[], complete: boolean, status?: number }>}
   */
  async listServersDetailed(labels = {}) {
    // Build label selector query
    let query = '';
    if (Object.keys(labels).length > 0) {
      const selector = Object.entries(labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      query = `label_selector=${encodeURIComponent(selector)}`;
    }
    return listHetznerPages({
      path: '/servers',
      key: 'servers',
      query,
      token: this.apiToken,
      apiBase: HetznerProvider.API_BASE,
      fetchImpl: fetchWithRetry,
    });
  }

  /**
   * Find servers by exact name via the server-side `?name=` filter (B0-3).
   * Soft-fail contract: `[]` on a non-ok response (callers use this for
   * best-effort discovery/recovery); network throws propagate. No pagination
   * walk — server names are unique per project, so an exact filter returns
   * at most one match. The client-side re-filter is defensive: it preserves
   * the exact-match semantics every pre-B0-3 call site enforced with
   * `.find((s) => s.name === name)`.
   * @param {string} name - Exact server name
   * @returns {Promise<object[]>}
   */
  async findServersByName(name) {
    const response = await fetchWithRetry(
      `${HetznerProvider.API_BASE}/servers?name=${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${this.apiToken}` } },
    );
    if (!response.ok) return [];
    const data = await response.json();
    return (data.servers || []).filter((s) => s.name === name);
  }

  /**
   * Look up a firewall by its exact name (C9 — verbatim move of
   * operator-ip.js's old module-private findFirewallByName; mechanical
   * substitutions only: `apiToken` param -> `this.apiToken`, the
   * `https://api.hetzner.cloud/v1` URL literal -> the
   * `${HetznerProvider.API_BASE}` template, producing the identical string.
   * fetchWithRetry usage/retry semantics unchanged).
   * @param {string} name - Firewall name
   * @returns {Promise<object|null>} The firewall, or null if not found
   *   (also null on a non-2xx response, deliberately swallowed here — see
   *   applyOperatorCidrs's "skip silently for a not-yet-deployed env" case).
   */
  async findFirewallByName(name) {
    const res = await fetchWithRetry(
      `${HetznerProvider.API_BASE}/firewalls?name=${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${this.apiToken}` } },
    );
    if (!res.ok) return null;
    const { firewalls } = await res.json();
    return firewalls?.[0] ?? null;
  }

  /**
   * Replace a firewall's rule set wholesale (C9 — verbatim move of
   * operator-ip.js's old module-private setFirewallRules; same mechanical
   * substitutions as findFirewallByName above). Throws on a non-2xx
   * response — unlike findFirewallByName, a failed rule-set write is never
   * silently swallowed.
   * @param {string|number} firewallId - Firewall ID
   * @param {object[]} rules - Full replacement rule list
   * @returns {Promise<void>}
   */
  async setFirewallRules(firewallId, rules) {
    const res = await fetchWithRetry(
      `${HetznerProvider.API_BASE}/firewalls/${firewallId}/actions/set_rules`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rules }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Hetzner firewall set_rules failed (${res.status}): ${body}`);
    }
  }

  /**
   * Rewrite the SSH (port 22) and Kubernetes API (port 6443) ingress rules
   * on a named firewall to use the given CIDR list as their `source_ips`,
   * leaving every other rule (HTTP/HTTPS, internal cluster traffic)
   * unchanged (C9 — composes findFirewallByName + the
   * `{direction, port, source_ips}` rule-rewrite, moved verbatim from
   * operator-ip.js's old applyToFirewall body, + setFirewallRules). This
   * rule-JSON shape never leaves the class. No `ports` option —
   * SSH_PORT/K8S_API_PORT above are the sole consumer today.
   * @param {{firewallName: string, cidrs: string[]}} args
   * @returns {Promise<boolean>} true if the named firewall was found and
   *   updated; false if it doesn't exist yet (env not deployed) — skipped
   *   silently, matching the pre-C9 applyToFirewall behavior.
   */
  async applyOperatorCidrs({ firewallName, cidrs }) {
    const fw = await this.findFirewallByName(firewallName);
    if (!fw) return false;
    const newRules = fw.rules.map((rule) => {
      if (rule.direction === 'in' && OPERATOR_LOCKED_PORTS.has(rule.port)) {
        return { ...rule, source_ips: cidrs };
      }
      return rule;
    });
    await this.setFirewallRules(fw.id, newRules);
    return true;
  }

  /**
   * Compute the updated Hetzner firewall rule set admitting the peer supabase
   * node's WireGuard tunnel endpoint (udp/51821), or null when no update is
   * needed. Pure: deployK8sHA fetches the firewall, calls this, and PUTs the
   * result — for BOTH clusters with the peer swapped (the post-failover
   * reverse re-seed dials the promoted standby, so its firewall must admit the
   * old primary too; neither failover.js nor restore.js touches firewalls).
   *
   * Replication moved from a public-IP TCP connection to a point-to-point
   * WireGuard tunnel (wireguard.js — WG_PORT=51821; 51820 is flannel-wg's), so
   * this also drops the stale TCP rules from that earlier architecture: the
   * retired NodePort 30432 rule (SNAT masked the source IP, breaking the /32
   * pg_hba scope) and the superseded 5433 rule — plus any udp/51821 rule
   * pointing at a previous peer IP (server replacement). tcp/5432 is NOT
   * scrubbed: compose deploys now carry a legitimate operator-scoped
   * Supavisor pooler rule on 5432 (+6543), and this reconcile runs on
   * compose-ha too (compose/ha.js) — the replication-era direct-5432 rule
   * the scrub once targeted never worked and predates every live rig.
   *
   * (Moved verbatim from deploy/replication.js onto the provider class — see
   * BaseProvider.buildReplicationFirewallRules for why: the rule-JSON shape is
   * provider wire knowledge and must never leave the class.)
   *
   * Takes the firewall OBJECT (as returned by findFirewallByName), not a
   * pre-extracted rules array — see BaseProvider's abstract doc.
   * @param {object} firewall - The firewall object as returned by
   *   findFirewallByName. Hetzner's flat `rules` field is extracted here.
   * @param {string} peerIp - The peer supabase node's public IPv4.
   * @returns {Array<object>|null} Updated rules, or null if already correct.
   */
  buildReplicationFirewallRules(firewall, peerIp) {
    const existingRules = firewall.rules || [];
    const wgPort = '51821';
    const staleTcpPorts = new Set(['5433', '30432']);
    const isStaleTcp = (r) => r.protocol === 'tcp' && staleTcpPorts.has(r.port);
    const isWgRule = (r) => r.protocol === 'udp' && r.port === wgPort;

    const hasExactRule = existingRules.some(
      (r) => isWgRule(r) && r.source_ips?.includes(`${peerIp}/32`),
    );
    const hasStale = existingRules.some((r) => isStaleTcp(r) || (isWgRule(r) && !hasExactRule));
    if (hasExactRule && !hasStale) return null;
    const cleaned = existingRules.filter((r) => !isStaleTcp(r) && !isWgRule(r));
    return [
      ...cleaned,
      {
        direction: 'in',
        protocol: 'udp',
        port: wgPort,
        source_ips: [`${peerIp}/32`],
        destination_ips: [],
      },
    ];
  }

  // ── Teardown primitives (C10a) ───────────────────────────────────────
  // Verbatim moves of destroy.js's old raw-API `hetzner*` teardown helpers,
  // with MECHANICAL substitutions only: the `apiToken` param became
  // `this.apiToken`, and each `https://api.hetzner.cloud/v1` URL literal became
  // the `${HetznerProvider.API_BASE}` template (byte-identical string). Every
  // one keeps its direct `fetchWithRetry` (NOT this.apiRequest — apiRequest
  // adds a JSON Content-Type header and re-prefixes API_BASE, changing the wire
  // bytes) and, where present, its deliberately-un-retried raw-`fetch` poll
  // probe. The load-bearing teardown semantics (202-then-poll, `?name=`
  // exact-match filters, null-vs-throw error shapes) are preserved as-is —
  // they converge in Phase B. The three destroy.js *policy* functions
  // (cleanupLoadBalancers / cleanupAutoscalerWorkers /
  // cleanupOrphanedVolumes) stay in destroy.js and call these.

  /**
   * Delete a firewall by its exact name (verbatim move of destroy.js's old
   * `hetznerDeleteFirewall`). Uses Hetzner's `?name=<exact>` filter — NOT a
   * global list-then-find, whose default `per_page=25` silently hides the
   * project's firewalls once 25+ leaked firewalls accumulate, so the destroy
   * no-ops and the next deploy collides on "name is already used". Detaches
   * attached servers, then DELETEs, under a delete-until-gone poll.
   * @param {string} name - Firewall name
   * @returns {Promise<{deleted: boolean, everExisted: boolean, apiError: (Error|null)}>}
   */
  async deleteFirewallByName(name) {
    const headers = { Authorization: `Bearer ${this.apiToken}` };
    const lookupUrl = `${HetznerProvider.API_BASE}/firewalls?name=${encodeURIComponent(name)}`;
    let everExisted = false;
    let apiError = null;
    // Delete-until-gone under a 30s budget with a fixed 3s interval. Each probe
    // re-looks-up the firewall (to refresh applied_to), detaches servers, then
    // DELETEs; a 409 (still attached) returns a falsy result so pollUntil backs
    // off and retries. A truthy wrapper object signals "done" — needed because
    // the "firewall gone" outcome can carry `everExisted === false`, which a bare
    // falsy return would misread as "keep polling". A genuine not-found therefore
    // returns the truthy { value: false } wrapper PROMPTLY (pollUntil never
    // throws for it). pollUntil only throws on budget exhaustion, which means the
    // delete never completed — either the lookup/DELETE kept failing (err.cause
    // is the last API error) or the firewall stayed attached (persistent 409).
    // Either way it's a probable LEAK, not a not-found, so we remember the
    // underlying error and let the caller surface it instead of "not found".
    const outcome = await pollUntil(
      async () => {
        const listResp = await fetchWithRetry(lookupUrl, { headers });
        const { firewalls } = await listResp.json();
        const fw = firewalls?.[0];
        if (!fw) return { value: everExisted };
        everExisted = true;
        if (fw.applied_to?.length > 0) {
          const serverResources = fw.applied_to
            .filter((a) => a.type === 'server' && a.server?.id)
            .map((a) => ({ type: 'server', server: { id: a.server.id } }));
          if (serverResources.length > 0) {
            try {
              await fetchWithRetry(
                `${HetznerProvider.API_BASE}/firewalls/${fw.id}/actions/remove_from_resources`,
                {
                  method: 'POST',
                  headers: { ...headers, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ remove_from: serverResources }),
                },
              );
            } catch {
              // Servers may already be gone — proceed to DELETE anyway
            }
          }
        }
        const delResp = await fetchWithRetry(`${HetznerProvider.API_BASE}/firewalls/${fw.id}`, {
          method: 'DELETE',
          headers,
        });
        if (delResp.ok || delResp.status === 404) return { value: true };
        // 409 = still attached; back off and re-look-up to refresh applied_to.
        return null;
      },
      {
        budgetMs: 30_000,
        initialDelayMs: 3_000,
        backoffFactor: 1,
        description: `firewall ${name} deletion`,
      },
    ).catch((err) => {
      apiError = err?.cause ?? err;
      return { value: false };
    });
    return { deleted: outcome.value === true, everExisted, apiError };
  }

  /**
   * Delete an SSH key by its exact name (verbatim move of destroy.js's old
   * `hetznerDeleteSSHKey`). Uses the `?name=<exact>` filter instead of listing
   * everything and filtering client-side — without it, once the project (or
   * test matrix) accumulates 50+ keys the target falls off page 1 of the
   * unpaginated list and destroy silently no-ops. Never throws; returns false
   * when no key matches.
   * @param {string} name - SSH key name
   * @returns {Promise<boolean>} true if a key was found and deleted (or 404)
   */
  async deleteSSHKeyByName(name) {
    const listResponse = await fetchWithRetry(
      `${HetznerProvider.API_BASE}/ssh_keys?name=${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${this.apiToken}` } },
    );

    const { ssh_keys } = await listResponse.json();
    const sshKey = ssh_keys?.[0];

    if (!sshKey) return false;

    const response = await fetchWithRetry(`${HetznerProvider.API_BASE}/ssh_keys/${sshKey.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });

    return response.ok || response.status === 404;
  }

  /**
   * Walk a paginated Hetzner list endpoint and return every entry, via the
   * shared walker in ./hetzner-pagination.js (the same one
   * scripts/sweep-hetzner.js uses — see that module for why an un-paginated
   * GET is a correctness bug, not a performance one).
   *
   * Soft-fail contract, unchanged from the hand-rolled walk this replaces:
   * `[]` on a non-ok first page, and a non-ok mid-walk yields the pages
   * collected so far.
   *
   * @param {string} path - Collection path, e.g. `/volumes`.
   * @param {string} key - Response body key holding the array, e.g. `volumes`.
   * @param {string} [query] - Extra query params (already encoded).
   * @returns {Promise<object[]>}
   */
  async #listAllPages(path, key, query = '') {
    const { items } = await listHetznerPages({
      path,
      key,
      query,
      token: this.apiToken,
      apiBase: HetznerProvider.API_BASE,
      fetchImpl: fetchWithRetry,
    });
    return items;
  }

  /**
   * List ALL private networks, walking pagination — destroy's cluster-network
   * lookup (which also seeds `clusterLocations`) filters this client-side.
   * @returns {Promise<object[]>}
   */
  async listNetworks() {
    return this.#listAllPages('/networks', 'networks');
  }

  /**
   * List ALL volumes, walking pagination. The orphaned-CSI-volume sweep
   * matches these client-side, so a truncated first page leaks every volume
   * beyond it (see #listAllPages).
   * @returns {Promise<object[]>}
   */
  async listVolumes() {
    return (await this.listVolumesDetailed()).items;
  }

  /**
   * Volume listing that preserves the page-walker's `complete` flag — see
   * BaseProvider.listVolumesDetailed for why an empty listing must not be
   * allowed to masquerade as a clean account.
   * @returns {Promise<{ items: object[], complete: boolean, status?: number }>}
   */
  async listVolumesDetailed() {
    return listHetznerPages({
      path: '/volumes',
      key: 'volumes',
      query: '',
      token: this.apiToken,
      apiBase: HetznerProvider.API_BASE,
      fetchImpl: fetchWithRetry,
    });
  }

  /**
   * Delete a volume by ID (verbatim move of `hetznerDeleteVolume`).
   * @param {number|string} volumeId - Volume ID
   * @returns {Promise<boolean>} true on success or 404
   */
  async deleteVolume(volumeId) {
    const response = await fetchWithRetry(`${HetznerProvider.API_BASE}/volumes/${volumeId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });

    return response.ok || response.status === 404;
  }

  /**
   * List ALL load balancers, walking pagination — the CCM-load-balancer
   * cleanup filters these client-side by network membership.
   * @returns {Promise<object[]>}
   */
  async listLoadBalancers() {
    return this.#listAllPages('/load_balancers', 'load_balancers');
  }

  /**
   * Delete a load balancer by ID (verbatim move of `hetznerDeleteLoadBalancer`).
   * @param {number|string} lbId - Load balancer ID
   * @returns {Promise<boolean>} true on success or 404
   */
  async deleteLoadBalancer(lbId) {
    const response = await fetchWithRetry(`${HetznerProvider.API_BASE}/load_balancers/${lbId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });

    return response.ok || response.status === 404;
  }

  // ── Destroy-sweep field accessors (Task 7) ───────────────────────────
  // See BaseProvider's doc for the cross-provider contract. Every accessor
  // here is a verbatim relocation of the field read the destroy-sweep policy
  // functions used to do inline against a Hetzner server/volume object —
  // zero behavior change, just named and moved onto the provider.

  /**
   * @param {object} server
   * @returns {number[]}
   */
  serverNetworkIds(server) {
    return (server.private_net || []).map((n) => n.network_id);
  }

  /**
   * @param {object} server
   * @returns {Object<string,string>}
   */
  serverLabels(server) {
    return server.labels || {};
  }

  /**
   * @param {object} server
   * @returns {number[]}
   */
  serverVolumeIds(server) {
    return server.volumes || [];
  }

  /**
   * @param {object} server
   * @returns {string|null}
   */
  serverRegion(server) {
    return server.datacenter?.location?.name ?? null;
  }

  /**
   * Hetzner volumes attach to at most one server, in the single `server`
   * field (id, or null when unattached).
   * @param {object} volume
   * @returns {number[]}
   */
  volumeAttachedServerIds(volume) {
    return volume.server != null ? [volume.server] : [];
  }

  /**
   * @param {object} volume
   * @returns {string|null}
   */
  volumeRegion(volume) {
    return volume.location?.name ?? null;
  }

  /**
   * @param {object} volume
   * @returns {Object<string,string>}
   */
  volumeLabels(volume) {
    return volume.labels || {};
  }

  /**
   * Hetzner reports volume creation as an ISO-8601 `created` field.
   * @param {object} volume
   * @returns {string|null}
   */
  volumeCreatedAt(volume) {
    return volume.created ?? null;
  }

  /**
   * Get public IPv4 address of a server
   * @param {object} server - Server object
   * @returns {string|null}
   */
  static getPublicIP(server) {
    return server?.public_net?.ipv4?.ip || null;
  }

  /**
   * Get public IPv6 address of a server
   * @param {object} server - Server object
   * @returns {string|null}
   */
  static getPublicIPv6(server) {
    return server?.public_net?.ipv6?.ip || null;
  }
}
