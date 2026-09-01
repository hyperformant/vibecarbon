/**
 * Base Provider Interface
 *
 * Abstract base class that defines the interface for cloud providers.
 * All cloud providers (Hetzner, DigitalOcean, Vultr, etc.) must implement
 * this interface to be used with Vibecarbon.
 *
 * To add a new provider, follow docs/adding-a-provider.md — the canonical
 * checklist (classes, registration, the censuses registration trips, e2e
 * wiring, CI secrets, real-infra proof). The short version: extend
 * BaseProvider, implement EVERY abstract member (the contract suite rejects
 * inherited throwing stubs), and register in index.js — the registry-driven
 * tests then walk you through the rest.
 */

export class BaseProvider {
  /**
   * Provider display name (e.g., "Hetzner Cloud")
   * @type {string}
   */
  static NAME = 'Base Provider';

  /**
   * API base URL
   * @type {string}
   */
  static API_BASE = '';

  /**
   * Available regions
   * @type {Object<string, string>}
   */
  static REGIONS = {};

  /**
   * Available server types
   * @type {Object<string, {vcpu: number, ram: number, disk: number, price: string}>}
   */
  static SERVER_TYPES = {};

  /**
   * Default server type
   * @type {string}
   */
  static DEFAULT_TYPE = '';

  /**
   * Default region for HA deployments
   * @type {string[]}
   */
  static HA_REGIONS = [];

  /**
   * Deploy tiers (see `src/lib/deploy/tier-registry.js` TIERS) this
   * provider supports. Enforced by `assertTierSupported()` (lib/providers/index.js)
   * at deploy-mode selection (prompts.js) and orchestrator entry — a
   * provider that doesn't list a tier here must never reach that tier's
   * deploy code.
   * @type {string[]}
   */
  static SUPPORTED_TIERS = [];

  // ── Engine-literal relocations, values verbatim (C7b) ───────────────
  // These were inline literals scattered across the compose-ha/compose/k3s
  // deploy code before C7b. Hoisting them onto the provider class does not
  // change behavior — every value below is relocated byte-for-byte from its
  // original call site (see each field's @type comment for its origin).

  /**
   * Default server type for a single-server compose deploy, and the
   * fallback compose-ha nodes use when the caller didn't specify one.
   * RCA (2026-07-22): compose-ha previously had its own
   * `DEFAULT_COMPOSE_HA_TYPE` static, but the orchestrator always resolved
   * `serverType` before the compose-ha effect ran, so that fallback was
   * dead code in every real deploy — deleted rather than left to drift
   * from the value actually observed (cx23, i.e. this static).
   * @type {string}
   */
  static DEFAULT_COMPOSE_TYPE = '';

  /**
   * Default node server type (master/supabase/worker) for a k3s deploy when
   * the caller didn't specify one.
   * @type {string}
   */
  static DEFAULT_K8S_NODE_TYPE = '';

  // ── Compose-tier replacement-server identity (scale/replacement path) ──
  // The scale/replacement path (scale.js's scaleServers) provisions a fresh
  // server directly via createServer(), bypassing this provider's Pulumi
  // program (getComposeProgram) entirely — these two statics let it
  // reconstruct the identical image + user-data that program would have
  // provisioned, instead of relying on an implicit provider-specific
  // default (RCA 2026-07-24: a DO compose scale sent NO `image` field at
  // all, because scale.js's createServer call omitted `image` counting on
  // HetznerProvider.createServer's own `image || 'docker-ce'` fallback — a
  // fallback DigitalOceanProvider.createServer has no equivalent of, so DO
  // rejected the droplet create with "invalid image for Droplet creation").

  /**
   * Base image slug/name for a compose-tier server (single VPS or
   * compose-ha node). MUST match this provider's `getComposeProgram`
   * literal EXACTLY — see each subclass override for the cited Pulumi
   * program line.
   * @type {string}
   */
  static COMPOSE_IMAGE = '';

  /**
   * Build this provider's compose-tier boot user-data (the cloud-init
   * payload a fresh compose VPS/droplet runs at boot). MUST return
   * byte-identical output to what `getComposeProgram` hands its server
   * resource's `userData`/`user_data` field — see each subclass override
   * for the single source of truth it delegates to.
   * @returns {Promise<string>}
   */
  static async getComposeUserData() {
    throw new Error('getComposeUserData() must be implemented by subclass');
  }

  /**
   * How long `setupServer` (lib/deploy/compose/index.js) polls a freshly
   * provisioned VPS for the boot-time cloud-init `/var/lib/vibecarbon/ready`
   * marker before giving up. This is a REAL, working default — unlike
   * DEFAULT_COMPOSE_TYPE/DEFAULT_K8S_NODE_TYPE above, BaseProvider's value
   * here is not an abstract placeholder every provider must override.
   *
   * The budget covers image-boot-to-ready-marker, and that varies by
   * provider because of what each provider's base image already has
   * installed: Hetzner's `docker-ce` image ships Docker preinstalled, so
   * cloud-init only runs ufw + unattended-upgrades — typically done in
   * 20-40s, so 180s is a generous ceiling. A provider whose base image does
   * NOT have Docker preinstalled (e.g. DigitalOcean's `ubuntu-24-04-x64`,
   * which installs docker-ce from Docker's apt repo INSIDE cloud-init — see
   * digitalocean-compose.js renderDoUserData) needs a materially larger
   * budget and must override this static.
   * @type {number}
   */
  static CLOUD_INIT_READY_TIMEOUT_MS = 180_000;

  /**
   * waitForServer's create→ready budget. 300s is calibrated for providers
   * whose servers go active in seconds-to-a-minute (Hetzner, Linode,
   * Scaleway). A provider whose routine boot approaches this ceiling MUST
   * override it rather than let ordinary variance become a hard timeout —
   * Vultr did (OS readiness ~295s observed, run 31663154544) and
   * DigitalOcean did (droplet still not active at 300s during the d2
   * compose-ha scale, 2026-09-01; the droplet went active moments later and
   * had to be swept as an orphan). Same doctrine as
   * CLOUD_INIT_READY_TIMEOUT_MS above.
   * @type {number}
   */
  static WAIT_FOR_SERVER_TIMEOUT_MS = 300_000;

  /**
   * Kubernetes cluster-addon asset identity — pure string data (C7c). The
   * daemonset name, label selectors, and deployment name this provider's
   * CCM/CSI addons register under, plus the env var name its CCM expects
   * for network identity. No behavior of its own; consumers read these
   * strings to interrogate/wait-on the addon resources.
   *
   * Consumers (reality-driven — only fields an actual call site reads are
   * declared; see hetzner.js for the verbatim values each was hoisted
   * from):
   *   - scale.js's post-resize CSI-rollout wait (`csiNodeDaemonSet`)
   *   - diagnose.js's network-section CCM/CSI log selectors
   *     (`ccmSelector`, `csiControllerSelector`) and its CCM env-var probe
   *     (`ccmDeployment`)
   *   - shell.js's network env export + welcome banner (`networkEnvVar`)
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
   * The Kubernetes StorageClass name this provider's CSI driver creates by
   * default (e.g. Hetzner's `hcloud-volumes`, DigitalOcean's
   * `do-block-storage`). k8s manifests that provision a
   * PersistentVolumeClaim ship a `{{K8S_STORAGE_CLASS}}` placeholder — the
   * provider-specific literal must never reach a checked-in manifest.
   *
   * Resolution is PRE-APPLY, not a deploy-time kubectl PATCH: unlike a
   * Deployment's container image or a ConfigMap's data (mutable, patched
   * AFTER `kubectl apply` elsewhere in `applyK3sManifests`), a PVC's
   * `spec.storageClassName` is immutable once the object is created — the
   * API server rejects any later patch to it. So the placeholder must be
   * resolved BEFORE the manifest is ever applied.
   *
   * It is deliberately NOT resolved by `add.js` either (which copies these
   * manifests out of the packaged `services/` dir into the user's project
   * on `vibecarbon add observability`): `add` has no reliable
   * per-environment provider signal — provider is resolved and persisted
   * per-ENVIRONMENT at `deploy` time (`resolveProvider`,
   * deploy/prompts.js), and `add` can run before any environment has ever
   * deployed. The placeholder therefore survives `add` untouched and is
   * resolved by `applyK3sManifests` itself (M3 Task 4:
   * `renderK8sStorageClassPlaceholder`, deploy/k8s/k3s.js), which already
   * has the deploy's authoritative resolved `ProviderClass` in scope. It
   * renders a TEMP COPY of the manifest directory (never rewrites the
   * project's own checked-in files) and points `kubectl apply -k` at that
   * copy — so the concrete literal exists before the object is ever
   * created, and no placeholder ever reaches a live cluster.
   * @type {string}
   */
  static K8S_STORAGE_CLASS = '';

  // ── S3-egress VPC allowance (M3 Task 9c) ─────────────────────────────
  // On DigitalOcean, same-region Spaces endpoints resolve INSIDE pods to a
  // VPC-internal gateway address (e.g. nyc3.digitaloceanspaces.com ->
  // 10.10.15.254, top of the cluster VPC's 10.10.0.0/20) — the S3-purposed
  // egress rules in app-policy/registry-policy/supabase-db-s3-egress
  // (carbon/k8s/base/{app,registry}/*.yaml, carbon/k8s/base/
  // network-policies.yaml) allow 443 to 0.0.0.0/0 EXCEPT RFC1918, which cuts
  // that gateway address off. Hetzner is unaffected — its Object Storage
  // endpoints resolve to public IPs — so BOTH statics below default to
  // "no extra allowance" and only DigitalOceanProvider overrides them.

  /**
   * This provider's cluster VPC/private-network CIDR, used ONLY as
   * `deployK3s`'s (src/lib/deploy/k8s/k3s.js) resume-compat fallback when a
   * persisted `k3s-infra` step result predates the `vpcCidr` Pulumi output
   * field (mirrors the masterPrivateIp/supabasePrivateIp fallback-default
   * pattern already established there). Empty on the base class — a
   * provider whose S3 endpoints never need the extra allowance (Hetzner)
   * has no reason to carry one.
   * @type {string}
   */
  static DEFAULT_VPC_CIDR = '';

  /**
   * Extra CIDR(s) this provider's S3-purposed NetworkPolicy egress rules
   * (app/registry/supabase-db-s3-egress) must ADDITIONALLY allow TCP 443
   * to, beyond the standard `0.0.0.0/0 except RFC1918` rule — see the
   * section doc above for the DO VPC-gateway RCA. Pure, provider-neutral
   * default: no extra CIDR needed. `applyK3sManifests` calls this (via
   * optional chaining, so a hand-rolled test double that predates this
   * method still behaves as "no extra CIDRs") to decide whether to render
   * and apply `carbon/k8s/base/s3-egress-vpc/s3-egress-vpc.yaml`.
   * @param {string} [_vpcCidr] - This deploy's cluster VPC CIDR (only
   *   meaningful to a provider that overrides this method).
   * @returns {string[]}
   */
  static getS3EgressExtraCidrs(_vpcCidr) {
    return [];
  }

  /**
   * Base image slug the provider's k8s Pulumi program provisions nodes
   * with; MUST match that program's literal — carbon-autoscaler provisions
   * CA workers from it. `renderCarbonAutoscalerConfig` (deploy/k8s/k3s.js)
   * reads this off the `ProviderClass` it's given instead of hardcoding a
   * single provider's slug.
   * @type {string}
   */
  static K8S_IMAGE = '';

  /**
   * Render this provider's k3s MASTER-node boot user-data (the cloud-init
   * script baked into the master server's `userData`/`user_data` at
   * Pulumi `up`, and the body carbon-autoscaler-spawned nodes never use —
   * see getK8sWorkerUserData for the one CA actually reads). MUST
   * dynamic-import its cloud-init render helper (`lib/iac/cloud-init.js`)
   * inside the method body, never at this file's top level — mirrors the
   * IAC PROGRAM DISPATCH statics' dynamic-import discipline above (M3
   * Task 3).
   *
   * The vars CONTRACT is provider-specific — each subclass's own JSDoc
   * documents its template's exact `${...}` placeholder set (see
   * HetznerProvider's override, which wraps
   * `carbon/cloud-init/k3s/master-init.sh` verbatim with today's exact
   * vars, and DigitalOceanProvider's, which renders the new
   * `carbon/cloud-init/k3s/do-master-init.sh`). A caller must not assume
   * one provider's vars shape works for another.
   * @param {Record<string, unknown>} vars - Template vars; provider-specific.
   * @returns {Promise<string>}
   */
  static async getK8sMasterUserData(_vars) {
    throw new Error('getK8sMasterUserData() must be implemented by subclass');
  }

  /**
   * Render this provider's k3s WORKER-node boot user-data. This is the
   * one carbon-autoscaler's `nodeGroups['worker-pool'].cloudInit` config
   * (`renderCarbonAutoscalerConfig`) is ultimately built from — every
   * CA-spawned node runs whatever this returns. See
   * getK8sMasterUserData's doc for the dynamic-import + vars-contract
   * note.
   * @param {Record<string, unknown>} vars - Template vars; provider-specific.
   * @returns {Promise<string>}
   */
  static async getK8sWorkerUserData(_vars) {
    throw new Error('getK8sWorkerUserData() must be implemented by subclass');
  }

  /**
   * Render this provider's k3s SUPABASE-node boot user-data — the dedicated
   * node (`node-pool: supabase-pool`, `dedicated=supabase` label + NoSchedule
   * taint) the Supabase HelmRelease's node-affinity pins onto. Not part of
   * carbon-autoscaler's node groups (the supabase node is Pulumi-static,
   * never CA-spawned) — see getK8sMasterUserData's doc for the
   * dynamic-import + vars-contract note, which applies identically here.
   * @param {Record<string, unknown>} vars - Template vars; provider-specific.
   * @returns {Promise<string>}
   */
  static async getK8sSupabaseUserData(_vars) {
    throw new Error('getK8sSupabaseUserData() must be implemented by subclass');
  }

  /**
   * Environment variable vibecarbon reads/writes for this provider's API
   * token. For Hetzner this is externally pinned as a customer-visible CI
   * secret name (see github-environments.test.ts, deploy-workflow-secret-sync.test.ts)
   * — never derive or rename it.
   * @type {string}
   */
  static TOKEN_ENV = '';

  /**
   * Environment variable the provider's own CLI/IaC tooling expects (e.g.
   * what the Pulumi provider plugin reads).
   * @type {string}
   */
  static CLI_TOKEN_ENV = '';

  /**
   * Build the env-var map an IaC/provider-CLI subprocess needs to
   * authenticate as this provider — Pulumi's Automation-API child
   * (`buildEnv`, src/lib/iac/index.js), the `hcloud` invocation in
   * console.js, and the shell/diagnose kubectl+ssh env exports all merge
   * this map instead of hand-writing `env[Provider.CLI_TOKEN_ENV] = token`
   * (the build-iac-env-census test bans that construction outside this
   * file).
   *
   * The default covers every single-credential provider:
   * `{ [CLI_TOKEN_ENV]: token }`. A provider whose IaC tooling needs MORE
   * than one variable (Scaleway reads the operator's SCALEWAY_* triple and
   * EMITS the SCW_ACCESS_KEY / SCW_SECRET_KEY / SCW_DEFAULT_PROJECT_ID that
   * the Pulumi provider requires) overrides this to return the full bag —
   * and throws an actionable error naming any missing companion env var, so
   * a misconfigured deploy fails at deploy start instead of mid-Pulumi with
   * an opaque provider error.
   *
   * @param {string} token - The provider API token/secret (the value
   *   resolveProviderToken() returned for TOKEN_ENV).
   * @returns {Record<string, string>} Env-var name → value map; never empty.
   */
  static buildIacEnv(token) {
    // Deliberately polymorphic — MUST read the CALLING subclass's
    // CLI_TOKEN_ENV (same reasoning as assertAmd64ServerType above; biome's
    // autofix to `BaseProvider.CLI_TOKEN_ENV` would silently break every
    // provider whose CLI var differs from the base's empty string).
    // biome-ignore lint/complexity/noThisInStatic: deliberately polymorphic — see comment above
    return { [this.CLI_TOKEN_ENV]: token };
  }

  /**
   * Value for the `request_checksum_calculation` query parameter on this
   * provider's Pulumi S3 state-backend URL (`resolveBackendUrl`,
   * src/lib/iac/index.js). Empty string = leave Pulumi's own default alone.
   *
   * WHY THIS EXISTS — RCA, CI run 31663154544 (2026-08-13), `E2E (scaleway)`
   * dead ~90s in at the FIRST state write, `pulumi stack select`:
   *
   *   error: write ".pulumi/meta.yaml": operation error S3: PutObject,
   *   StatusCode: 400, InvalidRequest: Value for x-amz-checksum-sha256
   *   header is invalid.
   *
   * Two upstream changes compose into that. Pulumi 3.256.0's
   * `translateLegacyS3Params` (pkg/backend/diy/backend.go) injects
   * `request_checksum_calculation=when_required` into EVERY `s3://` backend
   * URL that sets a custom `endpoint` — which is all of ours — unless the URL
   * or AWS_REQUEST_CHECKSUM_CALCULATION already pins a value. And the
   * gocloud.dev it vendors (v0.46.1-0.20260629181806-a12ddce30739) implements
   * that mode in blob/s3blob/s3blob.go:765 by sending the LITERAL SENTINEL
   * `x-amz-checksum-sha256: UNSIGNED-PAYLOAD`. Real AWS S3 special-cases that
   * string; a store that instead base64-decodes it as a 32-byte digest
   * rejects the write. Scaleway is such a store.
   *
   * DELIBERATELY OPT-IN, NOT A GLOBAL FLIP. On that same run, on that same
   * Pulumi 3.256.0, Hetzner (2h29m), DigitalOcean (1h45m) and Vultr (47m) all
   * ran full green lifecycles — thousands of state writes — with the sentinel.
   * They tolerate it. The opposite mode is not free: `when_supported` restores
   * the v2 SDK's CRC32 aws-chunked streaming upload, which is exactly what
   * Pulumi's injection was ADDED to work around for other third-party stores
   * (pulumi/pulumi#23764, IBM COS). So flipping every provider would trade a
   * proven-broken provider for three proven-green ones. Each provider declares
   * what its own store accepts; silence means "Pulumi's default is fine here".
   *
   * @type {string} '' | 'when_supported' | 'when_required'
   */
  static STATE_BACKEND_CHECKSUM_CALCULATION = '';

  /**
   * The `[accessKeyEnv, secretKeyEnv]` pair this provider's object-storage
   * credentials are read from — the env vars `promptObjectStorageCredentials`
   * (and the guided-setup `getS3Credentials` behind it) consult before falling
   * through to an interactive prompt.
   *
   * Declared as provider metadata rather than re-derived at each call site so
   * destroy can name the MISSING variable in its leak-risk warning without
   * hard-coding Hetzner's pair — the same defect class as the pre-M3-Task-9g
   * raw `process.env.HETZNER_ACCESS_KEY` read in destroy.js, which resolved
   * Hetzner's keys on every provider and 403'd against Spaces.
   * @type {[string, string]|[]}
   */
  static OBJECT_STORAGE_ENV = [];

  /**
   * The providerID scheme this provider's CCM stamps on nodes, e.g.
   * `'hcloud://'`. carbon-autoscaler's externalgrpc server uses this to
   * build/match `NodeSpec.providerID` and `ExternalGrpcNode.providerID`
   * (the join key across NodeGroupForNode/NodeGroupNodes — see
   * m2-dossier-externalgrpc.md §5) without hard-coding a provider name.
   * @type {string}
   */
  static PROVIDER_ID_PREFIX = '';

  /**
   * Link to the provider's live pricing page. Prices themselves are never
   * hard-coded here (they change) — point users at this instead.
   * @type {string}
   */
  static PRICING_URL = '';

  /**
   * Default region used when no region is specified.
   * @type {string}
   */
  static DEFAULT_REGION = '';

  /**
   * Create a new provider instance
   * @param {string} apiToken - API token for authentication
   */
  constructor(apiToken) {
    if (!apiToken) {
      throw new Error('API token is required');
    }
    this.apiToken = apiToken;
  }

  /**
   * Get the provider name
   * @returns {string}
   */
  getName() {
    return this.constructor.NAME;
  }

  /**
   * Get available regions
   * @returns {Object<string, string>}
   */
  getRegions() {
    return this.constructor.REGIONS;
  }

  /**
   * Get available server types
   * @returns {Object<string, object>}
   */
  getServerTypes() {
    return this.constructor.SERVER_TYPES;
  }

  /**
   * Get the default server type
   * @returns {string}
   */
  getDefaultType() {
    return this.constructor.DEFAULT_TYPE;
  }

  /**
   * Get default regions for HA deployment
   * @returns {string[]}
   */
  getHARegions() {
    return this.constructor.HA_REGIONS;
  }

  // ============================================================================
  // ABSTRACT METHODS - Must be implemented by subclasses
  // ============================================================================

  /**
   * Create a new server
   * @param {object} config - Server configuration
   * @param {string} config.name - Server name
   * @param {string} config.serverType - Server type/size
   * @param {string} config.region - Region/location
   * @param {(string|number)[]} [config.sshKeys] - SSH key ID(s), preferred —
   *   this is the shape scale.js's buildReplacementServerArgs actually sends
   * @param {string|number} [config.sshKeyId] - single SSH key ID, fallback
   * @param {string} config.environment - Environment name
   * @param {(string|number)[]} [config.networks] - Provider network id(s) to
   *   attach the server to at create time (e.g. carbon-autoscaler's worker
   *   creates, which must land on the cluster's private network to join
   *   k3s — see groups.js's `_lookupNetworkId`). Omitted/empty means no
   *   network attachment, the pre-M2 default for compose/scale creates.
   * @returns {Promise<{id: string|number, server?: object}>}
   */
  async createServer(_config) {
    throw new Error('createServer() must be implemented by subclass');
  }

  /**
   * Delete a server. Two modes, keyed on `options.waitUntilGone` (see
   * hetzner.js's `deleteServer` for the canonical merged implementation —
   * this doc mirrors its contract, not its wire-level implementation):
   *
   *   - `waitUntilGone` false/omitted (default — scale semantics): fire the
   *     delete and return once the provider accepts it, without confirming
   *     the resource is actually gone yet.
   *   - `waitUntilGone` true (destroy semantics): delete and then poll
   *     until the provider confirms the resource is gone, so a caller that
   *     immediately recreates a same-named resource doesn't race the
   *     provider's own asynchronous teardown (a recreate-before-drained
   *     race can otherwise collide on a "name already in use" error).
   *
   * @param {string|number} serverId - Server ID
   * @param {{waitUntilGone?: boolean}} [options]
   * @returns {Promise<void|boolean>} void in default mode; in
   *   waitUntilGone mode, true if the server was present at delete time
   *   (poll attempted), false if it was already gone.
   */
  async deleteServer(_serverId, _options) {
    throw new Error('deleteServer() must be implemented by subclass');
  }

  /**
   * Rename a server. Used by scale's final step: once the replacement
   * server has taken over the role, it's renamed from its temporary
   * `-new`-suffixed name to the permanent Pulumi-naming-convention name
   * (`${projectName}-${environment}[-${role}]`) so a later `destroy` or
   * `scale` invocation can find it by name again.
   * @param {string|number} serverId - Server ID
   * @param {string} name - New server name
   * @returns {Promise<void>}
   */
  async renameServer(_serverId, _name) {
    throw new Error('renameServer() must be implemented by subclass');
  }

  /**
   * Get server details
   * @param {string|number} serverId - Server ID
   * @returns {Promise<object>}
   */
  async getServer(_serverId) {
    throw new Error('getServer() must be implemented by subclass');
  }

  /**
   * Wait for a server to become ready/running
   * @param {string|number} serverId - Server ID
   * @param {number} [timeout] - Timeout in milliseconds; subclasses default it
   *   to `this.constructor.WAIT_FOR_SERVER_TIMEOUT_MS` so the budget is
   *   provider-owned.
   * @returns {Promise<object>} Server details when ready
   */
  async waitForServer(_serverId, _timeout = 300000) {
    throw new Error('waitForServer() must be implemented by subclass');
  }

  /**
   * Get a lightweight status summary for a server (status + type name),
   * suitable for a hot read-only probe (C8 — verbatim move of status.js's
   * original getServerInfo; see HetznerProvider.getServerSummary for the
   * canonical shape). MUST be a single raw fetch with a short hard timeout
   * and null-on-any-failure semantics — deliberately NOT routed through
   * this.apiRequest()/fetchWithRetry, since `status` runs this probe on
   * every invocation and a retry policy would multiply its worst-case
   * latency for no benefit.
   * @param {string|number} serverId - Server ID
   * @returns {Promise<{status: string, serverType: string|null}|null>}
   */
  async getServerSummary(_serverId) {
    throw new Error('getServerSummary() must be implemented by subclass');
  }

  /**
   * Fetch a single server type's specs by exact name — the source of the
   * `specs` argument carbon-autoscaler's `buildTemplateNode`
   * (src/autoscaler/node-template.js) needs to synthesize a
   * NodeGroupTemplateNodeInfo response for a node group's `serverType`.
   * @param {string} _name - Exact server type name (e.g. "cx23")
   * @returns {Promise<{cores: number, memoryGb: number, architecture: string, disk: number}>}
   */
  async getServerType(_name) {
    throw new Error('getServerType() must be implemented by subclass');
  }

  /**
   * Create or get an SSH key
   * @param {string} name - SSH key name
   * @param {string} publicKey - Public key content
   * @returns {Promise<string|number>} SSH key ID
   */
  async createSSHKey(_name, _publicKey) {
    throw new Error('createSSHKey() must be implemented by subclass');
  }

  /**
   * List servers matching labels/tags. Contract: returns ALL matching
   * servers — implementations must walk the provider's pagination, not
   * return a single page (B0-4).
   * @param {object} labels - Labels to filter by
   * @returns {Promise<object[]>}
   */
  async listServers(_labels = {}) {
    throw new Error('listServers() must be implemented by subclass');
  }

  /**
   * Find servers by exact name via the provider's server-side name filter
   * (B0-3). Soft-fail contract: resolves `[]` on a non-2xx response —
   * callers use this for best-effort discovery/recovery paths; only
   * network-level errors reject. Exact name match means at most one result
   * on providers with unique server names.
   * @param {string} name - Exact server name
   * @returns {Promise<object[]>}
   */
  async findServersByName(_name) {
    throw new Error('findServersByName() must be implemented by subclass');
  }

  // ── Operator firewall access (C9) ────────────────────────────────────
  // The operator-CIDR allowlist refresh (src/lib/operator-ip.js) used to
  // hand-roll two raw Hetzner Cloud API calls plus a Hetzner-specific
  // rule-JSON encoding. Those moved onto the provider class here;
  // operator-ip.js keeps only the provider-neutral pieces (IP detection,
  // CIDR persistence/math, the empty-CIDR lockout refusal, and its own
  // `${projectName}-${env}-firewall` naming convention) and calls
  // applyOperatorCidrs() per environment.

  /**
   * Look up a firewall by its exact name.
   * @param {string} name - Firewall name
   * @returns {Promise<object|null>} The firewall, or null if not found
   *   (also null on a non-2xx response — callers rely on this as a soft
   *   "does this env's firewall exist yet?" check for a not-yet-deployed
   *   environment, so it must swallow errors rather than throw).
   */
  async findFirewallByName(_name) {
    throw new Error('findFirewallByName() must be implemented by subclass');
  }

  /**
   * Replace a firewall's rule set wholesale.
   * @param {string|number} firewallId - Firewall ID
   * @param {object[]} rules - Full replacement rule list
   * @returns {Promise<void>}
   */
  async setFirewallRules(_firewallId, _rules) {
    throw new Error('setFirewallRules() must be implemented by subclass');
  }

  /**
   * Rewrite a named firewall's SSH/Kubernetes-API ingress rules to use the
   * given CIDR list as their `source_ips`, leaving every other rule
   * untouched. Composes findFirewallByName + the provider's own
   * `{direction, port, source_ips}` rule-JSON rewrite + setFirewallRules —
   * that rule-JSON schema is provider wire knowledge and must never leave
   * the class. No `ports` option: the SSH/Kubernetes-API ports are the
   * provider's own constants (single consumer today).
   * @param {{firewallName: string, cidrs: string[]}} args
   * @returns {Promise<boolean>} true if a firewall by that name was found
   *   and updated; false if it doesn't exist yet — skipped silently, since
   *   that just means the environment hasn't been deployed.
   */
  async applyOperatorCidrs(_args) {
    throw new Error('applyOperatorCidrs() must be implemented by subclass');
  }

  /**
   * Compute the updated firewall rule set admitting a peer's replication
   * (WireGuard, udp/51821) endpoint, or null when no update is needed
   * (idempotent no-op — the peer's rule is already present). Pure — no I/O,
   * no `this` reference; each provider encodes its own firewall-rule wire
   * shape (e.g. Hetzner's flat `{direction, protocol, port, source_ips}`
   * vs DigitalOcean's `{protocol, ports, sources:{addresses}}`), so this
   * moved onto the provider class rather than staying a free function in
   * deploy/replication.js — the compose-ha and k8s-ha WireGuard-port openers
   * call `provider.buildReplicationFirewallRules(...)` and never encode a
   * rule shape themselves.
   *
   * Takes the provider's own FIREWALL OBJECT (the same shape returned by
   * this provider's `findFirewallByName`), not a pre-extracted rules array —
   * openers must hold zero field knowledge about where a provider's inbound
   * rules live (Hetzner's flat `firewall.rules` vs DigitalOcean's
   * `firewall.inbound_rules`). Each implementation extracts its own rules
   * field as its first line. Returns the FULL replacement rules array in
   * that same provider-native shape, ready to hand to that provider's
   * `setFirewallRules`.
   * @param {object} firewall - The firewall object as returned by this
   *   provider's findFirewallByName.
   * @param {string} peerIp - The peer node's public IPv4.
   * @returns {object[]|null} Updated rules, or null if already correct.
   */
  buildReplicationFirewallRules(_firewall, _peerIp) {
    throw new Error('buildReplicationFirewallRules() must be implemented by subclass');
  }

  // ── Teardown primitives (C10a) ───────────────────────────────────────
  // These seven exist today only on HetznerProvider (verbatim moves of
  // destroy.js's old raw-API `hetzner*` teardown helpers — see hetzner.js's
  // own "Teardown primitives (C10a)" section for the implementation). Declared
  // here as abstract stubs so a future provider's contract is explicit; the
  // load-bearing teardown semantics (delete-until-gone polling, exact-name
  // filters, null-vs-throw/false error shapes) are provider wire knowledge and
  // converge across providers in Phase B, not here. Consumers stay in
  // destroy.js's policy functions (cleanupLoadBalancers /
  // cleanupAutoscalerWorkers / cleanupOrphanedVolumes) and the
  // compose-ha/k8s-ha teardown paths.

  /**
   * Delete a firewall by its exact name, detaching it from any attached
   * resources first if the provider requires that before deletion.
   * @param {string} name - Firewall name
   * @returns {Promise<{deleted: boolean, everExisted: boolean, apiError: (Error|null)}>}
   */
  async deleteFirewallByName(_name) {
    throw new Error('deleteFirewallByName() must be implemented by subclass');
  }

  /**
   * Delete an SSH key by its exact name.
   * @param {string} name - SSH key name
   * @returns {Promise<boolean>} true if a key was found and deleted (or
   *   was already gone); false if no key matches
   */
  async deleteSSHKeyByName(_name) {
    throw new Error('deleteSSHKeyByName() must be implemented by subclass');
  }

  /**
   * List all private networks.
   * @returns {Promise<object[]>}
   */
  async listNetworks() {
    throw new Error('listNetworks() must be implemented by subclass');
  }

  /**
   * List all volumes.
   * @returns {Promise<object[]>}
   */
  async listVolumes() {
    throw new Error('listVolumes() must be implemented by subclass');
  }

  /**
   * List all servers WITH the pagination-honesty signal — same contract and
   * same reason as listVolumesDetailed. The destroy sweep's "is any foreign
   * server still running in this region?" gate cannot use `listServers()`: a
   * soft-failed `[]` there reads as "the project is quiet", which is precisely
   * the condition that unlocks deleting volumes on a name pattern.
   *
   * @param {object} [_labels]
   * @returns {Promise<{ items: object[], complete: boolean, status?: number }>}
   */
  async listServersDetailed(_labels = {}) {
    throw new Error('listServersDetailed() must be implemented by subclass');
  }

  /**
   * List all volumes WITH the pagination-honesty signal.
   *
   * `listVolumes()` soft-fails to `[]` on a non-ok response, which makes a
   * transient API failure indistinguishable from "this account holds no
   * volumes" — and the destroy sweep then prints `No orphaned volumes found`
   * over a real leak (2026-07-31: three `pvc-*` volumes survived a destroy
   * whose provider calls were 403ing). Callers that turn an empty listing into
   * a VERDICT must use this instead and treat `complete: false` as "no
   * information", never as "nothing there".
   *
   * @returns {Promise<{ items: object[], complete: boolean, status?: number }>}
   */
  async listVolumesDetailed() {
    throw new Error('listVolumesDetailed() must be implemented by subclass');
  }

  /**
   * Delete a volume by ID.
   * @param {number|string} volumeId - Volume ID
   * @returns {Promise<boolean>} true on success or if already gone
   */
  async deleteVolume(_volumeId) {
    throw new Error('deleteVolume() must be implemented by subclass');
  }

  /**
   * List all load balancers.
   * @returns {Promise<object[]>}
   */
  async listLoadBalancers() {
    throw new Error('listLoadBalancers() must be implemented by subclass');
  }

  /**
   * Delete a load balancer by ID.
   * @param {number|string} lbId - Load balancer ID
   * @returns {Promise<boolean>} true on success or if already gone
   */
  async deleteLoadBalancer(_lbId) {
    throw new Error('deleteLoadBalancer() must be implemented by subclass');
  }

  // ── Destroy-sweep field accessors (Task 7, +serverRegion Task 7 fix round 1) ──
  // destroy.js's three cleanup* policy functions (cleanupLoadBalancers /
  // cleanupAutoscalerWorkers / cleanupOrphanedVolumes) — plus destroyK8sTier's
  // own pre-Pulumi volume pre-scan and post-Pulumi orphaned-server sweep — need
  // to read "is this server in cluster network X", "what are this server's
  // labels", "what volumes/region does this server/volume reference" without
  // knowing whether the underlying list call returned Hetzner server/volume
  // objects or DigitalOcean droplet/volume objects. These eight accessors are
  // that seam: each subclass reads its own wire shape and returns a
  // provider-neutral value (an array of ids, a flat string-keyed label map, a
  // region string, or an ISO timestamp), so every policy function stays
  // byte-for-byte the same regardless of provider.

  /**
   * Network/VPC ids this server is attached to.
   * @param {object} _server - A server/droplet object as returned by listServers.
   * @returns {(string|number)[]}
   */
  serverNetworkIds(_server) {
    throw new Error('serverNetworkIds() must be implemented by subclass');
  }

  /**
   * This server's labels/tags, decoded to a flat string-keyed map — the
   * provider-neutral shape every destroy-sweep label predicate
   * (`labels['cluster-autoscaler/node']`, `labels.role`, `labels['managed-by']`,
   * ...) reads.
   * @param {object} _server - A server/droplet object as returned by listServers.
   * @returns {Object<string,string>}
   */
  serverLabels(_server) {
    throw new Error('serverLabels() must be implemented by subclass');
  }

  /**
   * Volume ids attached to this server.
   * @param {object} _server - A server/droplet object as returned by listServers.
   * @returns {(string|number)[]}
   */
  serverVolumeIds(_server) {
    throw new Error('serverVolumeIds() must be implemented by subclass');
  }

  /**
   * This server's region/location identifier (same slug/name convention as
   * volumeRegion), or null when the provider doesn't report one. Task 7 fix
   * round 1: without this, destroyK8sTier's pre-scan populated
   * `clusterLocations` from a Hetzner-only field read
   * (`server.datacenter?.location?.name`), which is always absent on a DO
   * droplet — silently disabling cleanupOrphanedVolumes's
   * isPvcInClusterLocation fallback (the only thing that catches a CSI volume
   * DETACHED before destroy runs) for DO, leaking it.
   * @param {object} _server - A server/droplet object as returned by listServers.
   * @returns {string|null}
   */
  serverRegion(_server) {
    throw new Error('serverRegion() must be implemented by subclass');
  }

  /**
   * Server ids this volume is currently attached to (empty when unattached).
   * @param {object} _volume - A volume object as returned by listVolumes.
   * @returns {(string|number)[]}
   */
  volumeAttachedServerIds(_volume) {
    throw new Error('volumeAttachedServerIds() must be implemented by subclass');
  }

  /**
   * This volume's region/location identifier (the same slug/name the
   * provider's own REGIONS map and server datacenter/location use), or null
   * when the provider doesn't report one for this volume.
   * @param {object} _volume - A volume object as returned by listVolumes.
   * @returns {string|null}
   */
  volumeRegion(_volume) {
    throw new Error('volumeRegion() must be implemented by subclass');
  }

  /**
   * This volume's labels/tags, decoded to a flat string-keyed map — same
   * contract as serverLabels.
   * @param {object} _volume - A volume object as returned by listVolumes.
   * @returns {Object<string,string>}
   */
  volumeLabels(_volume) {
    throw new Error('volumeLabels() must be implemented by subclass');
  }

  /**
   * When this volume was created, as an ISO-8601 string, or null when the
   * provider doesn't report it. Reporting-only: the destroy sweep prints it
   * alongside every volume it deletes or defers so an operator reading the
   * teardown report can judge whether a heuristic match is plausibly this
   * environment's. Deliberately NOT used as a delete predicate — the obvious
   * "only reap volumes newer than the environment" rule is wrong here, because
   * `envConfig.deployedAt` is the LAST deploy's timestamp and the volumes that
   * matter (supabase-db's PVC) are created by the FIRST one.
   * @param {object} _volume - A volume object as returned by listVolumes.
   * @returns {string|null}
   */
  volumeCreatedAt(_volume) {
    throw new Error('volumeCreatedAt() must be implemented by subclass');
  }

  // ============================================================================
  // ABSTRACT STATIC METHODS - CATALOG
  // Must be implemented by subclasses. Polymorphic call sites resolve these
  // through the registered provider class (see lib/providers/index.js), so a
  // new provider only needs to override the statics below — no call-site
  // changes required.
  //
  // Cache convention: a provider that caches fetched catalog data (e.g.
  // per-region server-type availability) on a class field should name that
  // field `_locationTypes` (see HetznerProvider) so the convention stays
  // consistent across providers. There is no cross-provider cache-reset
  // hook yet — add one only when a concrete consumer needs it.
  // ============================================================================

  /**
   * Fetch server types (and any per-region availability) from the
   * provider's API, populating SERVER_TYPES with live data.
   * @param {string} apiToken - Provider API token
   * @returns {Promise<boolean>} true if live data was loaded, false on failure
   */
  static async fetchServerTypes(_apiToken) {
    throw new Error('fetchServerTypes() must be implemented by subclass');
  }

  /**
   * Returns server types available in the given region.
   *
   * Each entry SHOULD carry an `architecture` field — 'x86' (or the equivalent
   * 'amd64') for everything vibecarbon supports. The shared prompt builders in
   * lib/server-types.js drop any entry whose architecture is neither, which is
   * how "the CLI never offers a non-amd64 server type" is enforced without
   * SKU-naming knowledge leaking out of the provider. An entry with no
   * `architecture` is treated as x86, so a provider whose catalog is all-x86
   * may omit it.
   *
   * @param {string} region - Region ID
   * @returns {Array<{name: string, vcpu: number, ram: number, disk: number, architecture?: string}>}
   */
  static getServerTypesForRegion(_region) {
    throw new Error('getServerTypesForRegion() must be implemented by subclass');
  }

  /**
   * Returns region-appropriate default server types.
   * @param {string} region - Region ID
   * @returns {{masterType: string, supabaseType: string, workerType: string}}
   */
  static getRegionDefaults(_region) {
    throw new Error('getRegionDefaults() must be implemented by subclass');
  }

  /**
   * Default HA standby region for a given primary region.
   * @param {string} primaryRegion
   * @returns {string}
   */
  static getDefaultStandbyRegion(_primaryRegion) {
    throw new Error('getDefaultStandbyRegion() must be implemented by subclass');
  }

  /**
   * Returns the equivalent server type available in a target region.
   * @param {string} serverType - Original server type
   * @param {string} targetRegion - Region to resolve for
   * @returns {string}
   */
  static resolveServerTypeForRegion(_serverType, _targetRegion) {
    throw new Error('resolveServerTypeForRegion() must be implemented by subclass');
  }

  /**
   * Is `serverType` a non-amd64 (ARM / aarch64) SKU for this provider?
   *
   * vibecarbon standardizes on x86-64 — see src/lib/deploy/platform.js for the
   * decision and the provider data behind it. The *knowledge of which SKUs are
   * ARM* is provider-specific (Hetzner's `cax*` line), so it lives here as an
   * overridable predicate rather than as a literal in shared code.
   *
   * Default `false`: a provider that sells no ARM at all inherits it unchanged.
   * DigitalOcean is exactly that case — zero ARM instance types across all 31
   * size slugs (families s/c/g/gd/m/gpu), so DigitalOceanProvider deliberately
   * does not override this.
   *
   * @param {string} _serverType - Provider server type / size slug
   * @returns {boolean}
   */
  static isArmServerType(_serverType) {
    return false;
  }

  /**
   * The amd64 SKU an operator should use in place of an ARM `serverType`.
   *
   * Quoted in `assertAmd64ServerType`'s rejection message and used by the
   * standby-region resolver's ARM→x86 rescue, so the suggestion an operator
   * reads and the substitution the resolver performs can never drift apart.
   *
   * Providers with an ARM line MUST override this with a **size-preserving**
   * map. A same-numeric-suffix guess is not good enough: Hetzner's `cax<N>`
   * carries roughly twice the RAM of `cpx<N>` (cax11 is 4 GB, cpx11 is 2 GB —
   * below `COMPOSE_MIN_RAM_GB`), so the obvious mapping silently downsizes a
   * node, potentially below the supported minimum.
   *
   * Default returns `DEFAULT_TYPE`: a provider that sells no ARM at all never
   * reaches this, and a generic "use the default" beats guessing.
   *
   * @param {string} _serverType - An ARM SKU for this provider.
   * @returns {string} An amd64 SKU of at least equivalent size.
   */
  static armToAmd64Equivalent(_serverType) {
    // biome-ignore lint/complexity/noThisInStatic: polymorphic — see assertAmd64ServerType
    return this.DEFAULT_TYPE;
  }

  /**
   * Throw unless `serverType` is an amd64 SKU. The guard for every point where
   * a server type that did NOT come from a filtered option list enters the
   * system — `scale -type`, `failover -server-type`, the deploy prompt's
   * `.vibecarbon.json`-seeded types, and the pilot-light failover's persisted
   * `ha.standbyWorkerSpec.serverType` — so an ARM type fails loudly with a
   * reason instead of being taken verbatim and provisioning hardware the amd64
   * app image cannot run on.
   *
   * Throws rather than logging so it is callable from pure/library code; the
   * interactive commands catch it and render `err.message` through clack.
   *
   * This hard rejection is the rule, including on the DR path: a failover that
   * provisioned ARM workers would quiesce the primary and promote the standby
   * before discovering the app image cannot exec there — trading a recoverable
   * abort for an unrecoverable one. `HetznerProvider.resolveServerTypeForRegion`
   * still performs an ARM→x86 *rescue*, but only on the deploy-time standby
   * fan-out, whose inputs have already passed this guard in the deploy prompt;
   * it is a belt-and-braces substitution, not the way an ARM type is handled.
   *
   * @param {string|null|undefined} serverType - The type to validate. Falsy
   *   values pass (callers use `null` to mean "not specified").
   * @param {string} [source] - Where the value came from, quoted in the error
   *   (e.g. `-type`, `.vibecarbon.json masterServerType`).
   * @returns {string|null|undefined} `serverType`, unchanged, when valid.
   */
  static assertAmd64ServerType(serverType, source = 'server type') {
    // Deliberately polymorphic — MUST read the CALLING subclass's ARM
    // predicate, NAME and equivalence map, so
    // `HetznerProvider.assertAmd64ServerType('cax21')` rejects with Hetzner's
    // wording and Hetzner's suggested alternative, while a provider with no ARM
    // line inherits the base no-op. Rewriting `this` to `BaseProvider` (which
    // is what biome's noThisInStatic autofix does) silently turns this guard
    // into a permanent no-op — same pattern, same reason, as
    // s3-base.js's getRegions().
    // biome-ignore lint/complexity/noThisInStatic: deliberately polymorphic — see comment above
    if (!serverType || !this.isArmServerType(serverType)) return serverType;
    // biome-ignore lint/complexity/noThisInStatic: deliberately polymorphic — see comment above
    const { NAME } = this;
    // biome-ignore lint/complexity/noThisInStatic: deliberately polymorphic — see comment above
    const suggestion = this.armToAmd64Equivalent(serverType);
    throw new Error(
      `${source}: '${serverType}' is an ARM (aarch64) ${NAME} server type. ` +
        `vibecarbon is x86-64 (amd64) only; the app image and every dependency ` +
        `it runs alongside (the Supabase stack, Traefik, Kong, cert-manager, the ` +
        `cloud-controller/CSI drivers, cluster-autoscaler) are published for ` +
        `linux/amd64. Choose an x86 server type instead (e.g. ${suggestion}).`,
    );
  }

  /**
   * Get public IPv4 address of a server.
   * @param {object} server - Server object
   * @returns {string|null}
   */
  static getPublicIP(_server) {
    throw new Error('getPublicIP() must be implemented by subclass');
  }

  /**
   * Get public IPv6 address of a server.
   * @param {object} server - Server object
   * @returns {string|null}
   */
  static getPublicIPv6(_server) {
    throw new Error('getPublicIPv6() must be implemented by subclass');
  }

  // ============================================================================
  // ABSTRACT STATIC METHODS - OBJECT STORAGE (S3-compatible)
  // A provider's S3-compatible client lives in its own module and must be
  // reached lazily via getObjectStorageProviderClass() (see
  // lib/providers/index.js getObjectStorageProvider()/resolveS3RegionFor())
  // so the S3 SDK stays out of the compute provider's module graph until
  // object storage is actually used. Region resolution stays on the S3
  // class itself (e.g. HetznerS3Provider.resolveS3Region) — there is
  // deliberately no region-map/S3_REGIONS data mirrored on the compute
  // provider class.
  // ============================================================================

  /**
   * Environment variable vibecarbon reads for an override of the
   * object-storage region (distinct from the compute provider's region).
   * @type {string}
   */
  static S3_REGION_ENV = '';

  /**
   * Lazily resolve this provider's S3-compatible object-storage client
   * class. Implementations MUST dynamic-import their storage module (never
   * a top-level import) so the S3 SDK isn't loaded until object storage is
   * actually needed.
   * @returns {Promise<Function>} constructor(accessKeyId, secretAccessKey, region)
   */
  static async getObjectStorageProviderClass() {
    throw new Error('getObjectStorageProviderClass() must be implemented by subclass');
  }

  // ============================================================================
  // ABSTRACT STATIC METHODS - IAC PROGRAM DISPATCH (CD2)
  // Pulumi Automation-API programs — the resource-declaring closures that
  // `upStack`/`getStackOutputs`/`destroyStack` (lib/iac/index.js) run — live
  // in provider-specific modules under lib/iac/programs/ (e.g.
  // hetzner-compose.js, hetzner-k8s.js for HetznerProvider). Those modules
  // import `@pulumi/*` packages at THEIR OWN top level, which is fine — they
  // only load when a statics below actually resolves them. Implementations
  // of the statics below MUST dynamic-import their program module INSIDE the
  // method body (never a top-level import in the provider class file) so
  // `@pulumi/*` never enters THIS class's static-load graph: status.js and
  // deploy.js import the provider class at CLI startup on every command, and
  // a top-level `@pulumi/*` import here would regress startup latency for
  // every command, not just deploy/scale.
  //
  // Frozen output contract (Pulumi stack outputs persisted by the
  // state-tracker; deploy/scale resume reads these keys back from disk, so
  // renaming/dropping one breaks resume for any in-flight deploy — see
  // HetznerProvider.getComposeProgram/getK8sProgram for the verified-against-
  // reality field list and the one documented default-on-absence case):
  //   compose: { serverIp, serverId, firewallId, sshKeyId }
  //   k8s:     { masterIp, masterPrivateIp, supabaseIp, supabasePrivateIp,
  //              workerIps, floatingIp, networkId, sshKeyId, k3sToken,
  //              clusterName }
  //   k8s (DO-only additive, M3 Task 9c): vpcCidr — the Vpc's actual
  //     ipRange, threaded to `applyK3sManifests` so DO deploys can extend
  //     the S3-purposed NetworkPolicy egress rules (see DEFAULT_VPC_CIDR /
  //     getS3EgressExtraCidrs above). Hetzner's program does not return
  //     this key at all — its S3 endpoints never need the allowance.
  // ============================================================================

  /**
   * Lazily build the Pulumi Automation-API program (a `() => Promise<outputs>`
   * closure, ready to hand to `upStack`/`getStackOutputs`) for a single
   * Docker-Compose VPS. MUST dynamic-import the provider's program module
   * inside the method body — see the IAC PROGRAM DISPATCH block above.
   * @param {object} config - Provider-specific compose stack config
   * @returns {Promise<() => Promise<{serverIp: string, serverId: string, firewallId: string, sshKeyId: string}>>}
   */
  static async getComposeProgram(_config) {
    throw new Error('getComposeProgram() must be implemented by subclass');
  }

  /**
   * Lazily build the Pulumi Automation-API program (a `() => Promise<outputs>`
   * closure, ready to hand to `upStack`/`getStackOutputs`) for a k3s cluster.
   * MUST dynamic-import the provider's program module inside the method
   * body — see the IAC PROGRAM DISPATCH block above.
   * @param {object} config - Provider-specific k8s stack config
   * @returns {Promise<() => Promise<{masterIp: string, masterPrivateIp: string, supabaseIp: string, supabasePrivateIp: string, workerIps: string[], floatingIp: string, networkId: string|number, sshKeyId: string, k3sToken: string, clusterName: string, vpcCidr?: string}>>}
   */
  static async getK8sProgram(_config) {
    throw new Error('getK8sProgram() must be implemented by subclass');
  }

  // ============================================================================
  // ABSTRACT STATIC METHODS - GUIDED SETUP DELEGATION (C7d)
  // Interactive first-run credential prompts (visual guide + validation +
  // "save keys?" flow) live in a provider-specific guided-setup module
  // (e.g. hetzner-guided-setup.js) that predates the provider-class seam.
  // These statics are thin delegations to that module — implementations
  // MUST dynamic-import it (never a top-level import) so its module-level
  // session state (e.g. Hetzner's `_savePreference`) stays a single cached
  // instance shared by every call site that resolves through the static,
  // and forward args verbatim rather than re-declaring the module
  // function's own option defaults here. Consumers: src/lib/deploy/prompts.js,
  // src/scale.js, src/destroy.js, src/backup.js.
  // ============================================================================

  /**
   * Interactively resolve this provider's API token (env var → credentials
   * file → interactive prompt), offering to save it for future deploys.
   * @param {string} [projectName] - Project name for display in the setup guide
   * @param {{ save?: boolean }} [options]
   * @returns {Promise<string|null>}
   */
  static async promptApiToken(_projectName, _options) {
    throw new Error('promptApiToken() must be implemented by subclass');
  }

  /**
   * Interactively resolve this provider's object-storage (S3-compatible)
   * credentials (env vars → credentials file → interactive prompt).
   * @param {string} [projectName] - Project name for display in the setup guide
   * @param {{ save?: boolean, force?: boolean }} [options]
   * @returns {Promise<{accessKey: string, secretKey: string}|null>}
   */
  static async promptObjectStorageCredentials(_projectName, _options) {
    throw new Error('promptObjectStorageCredentials() must be implemented by subclass');
  }

  /**
   * Satisfy this cloud's "dedicated project" container for the deployed
   * resources, where the cloud models one that needs post-hoc assignment.
   *
   * Default: no-op returning null — the CORRECT implementation wherever the
   * project concept is already satisfied by the credential (Hetzner: API
   * tokens are project-scoped, the token IS the project selector) or by a
   * request parameter (Scaleway: SCALEWAY_DEFAULT_PROJECT_ID scopes every
   * call), and for clouds with no project concept at all (Linode, Vultr).
   *
   * DigitalOcean overrides this: its tokens are account-scoped and
   * API-created resources land in the account's DEFAULT project unless
   * explicitly assigned, so it find-or-creates a project named after the
   * vibecarbon project and files this environment's resources into it.
   *
   * Call sites (deploy orchestrator, scale) treat this as best-effort:
   * organizational filing must never fail a deploy that already succeeded,
   * so they wrap it in try/warn — implementations should throw loudly on
   * failure rather than soft-fail.
   * @param {object} _opts
   * @param {string} _opts.projectName - vibecarbon project name
   * @param {string} _opts.environment - environment seed (prod, staging, …)
   * @returns {Promise<{projectId: string, created: boolean, assigned: number}|null>}
   */
  async ensureProjectAssignment(_opts) {
    return null;
  }

  // ============================================================================
  // HELPER METHODS - Can be overridden if needed
  // ============================================================================

  /**
   * Make an authenticated API request
   * @param {string} endpoint - API endpoint (relative to API_BASE)
   * @param {object} [options={}] - Fetch options
   * @returns {Promise<Response>}
   */
  async apiRequest(endpoint, options = {}) {
    const url = `${this.constructor.API_BASE}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    // Delegate to the shared fetch-retry helper so "fetch failed" /
    // ECONNRESET / EAI_AGAIN from Hetzner gets 5 tries with exponential
    // backoff instead of the previous 3. Transient 5xx / 429 also retry.
    const { fetchWithRetry } = await import('../fetch-retry.js');
    return await fetchWithRetry(url, { ...options, headers });
  }

  /**
   * Validate that a region is supported
   * @param {string} region - Region ID
   * @returns {boolean}
   */
  isValidRegion(region) {
    return region in this.constructor.REGIONS;
  }

  /**
   * Validate that a server type is supported
   * @param {string} serverType - Server type ID
   * @returns {boolean}
   */
  isValidServerType(serverType) {
    return serverType in this.constructor.SERVER_TYPES;
  }

  /**
   * Format a region ID to display name
   * @param {string} region - Region ID
   * @returns {string}
   */
  formatRegion(region) {
    return this.constructor.REGIONS[region] || region;
  }

  /**
   * Format a server type to display string
   * @param {string} serverType - Server type ID
   * @returns {string}
   */
  formatServerType(serverType) {
    const type = this.constructor.SERVER_TYPES[serverType];
    if (!type) return serverType;
    return `${serverType} (${type.vcpu} vCPU, ${type.ram}GB RAM, ${type.disk}GB SSD)`;
  }
}
