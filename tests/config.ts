/**
 * Test Configuration
 *
 * Centralized configuration for all test settings.
 * Update these values to change test behavior across the suite.
 */

export const testConfig = {
  // ============================================================================
  // INFRASTRUCTURE TEST SETTINGS
  // ============================================================================

  infrastructure: {
    // Hetzner Cloud settings
    hetzner: {
      // Server type for test deployments
      // See: https://www.hetzner.com/cloud#pricing
      serverType: 'cx23', // 2 vCPU, 4GB RAM, 40GB SSD (replaces deprecated cx22)

      // Primary region for single-instance and HA primary
      primaryRegion: 'hel1', // Helsinki, Finland

      // Secondary region for HA standby server
      secondaryRegion: 'nbg1', // Nuremberg, Germany

      // Docker image to use for servers
      image: 'docker-ce',

      // Labels applied to all test resources
      labels: {
        'managed-by': 'vibecarbon-test',
      },

      // Timeouts (in milliseconds)
      timeouts: {
        serverCreation: 30000,
        serverReady: 300000, // 5 minutes
        sshReady: 180000, // 3 minutes
        deployment: 600000, // 10 minutes for full deployment
        serviceHealthy: 180000, // 3 minutes for services to be healthy
      },
    },

    // Cloudflare settings
    cloudflare: {
      // TTL for test DNS records (in seconds)
      dnsTTL: 60,

      // Whether to proxy test DNS records through Cloudflare
      dnsProxied: false,

      // Health check settings
      healthCheck: {
        path: '/api/health',
        port: 443,
        interval: 60,
        timeout: 5,
        retries: 2,
      },
    },

    // Resource naming
    naming: {
      // Prefix for all test resources (timestamp appended automatically)
      prefix: 'cs-test',
    },
  },

  // ============================================================================
  // SMOKE TEST SETTINGS
  // ============================================================================

  smoke: {
    // Ports required for basic Docker smoke tests (database only)
    requiredPorts: [5432],

    // Local S3 (dev-only Garage from docker-compose.override.yml)
    s3Ports: [8333],

    // Ports for Traefik reverse proxy (optional - tests skip if unavailable)
    // Note: Dashboard is now protected by admin-auth and accessed via traefik.localhost
    traefikPorts: [80],

    // Ports for optional services. Grafana no longer binds a host port (H-9 —
    // access via Traefik only), so we gate on Loki's host port (3100), which the
    // smoke test probes directly; Grafana health is checked via docker exec.
    observabilityPorts: [3100],

    // Timeouts
    timeouts: {
      dockerUp: 180000, // 3 minutes for full stack with app build
      dockerDown: 60000,
      serviceReady: 60000,
      appBuild: 120000, // 2 minutes for app container build
      optionalServices: 120000, // 2 minutes for optional services to start
    },
  },

  // ============================================================================
  // UNIT TEST SETTINGS
  // ============================================================================

  unit: {
    // Default timeout for unit tests
    timeout: 5000,
  },

  // ============================================================================
  // PERFORMANCE TEST SETTINGS
  // ============================================================================

  perf: {
    defaults: {
      /** Seconds per scenario */
      duration: 10,
      /** Concurrent connections */
      connections: 10,
      /** Label used in result filename, e.g. "cpx22-nbg1-ha" */
      label: 'local',
    },
    thresholds: {
      healthLiveness: { p95LatencyMs: 50, maxErrorRate: 0 },
      healthReady: { p95LatencyMs: 200, maxErrorRate: 0 },
      authenticated: { p95LatencyMs: 500, maxErrorRate: 0.01 },
      admin: { p95LatencyMs: 1000, maxErrorRate: 0.01 },
    },
    /** Milliseconds to wait for reachability check before skipping */
    reachabilityTimeoutMs: 5000,
  },
  // ============================================================================
  // E2E TEST SETTINGS
  // ============================================================================

  e2e: {
    // Base domain per DNS backend. Each is a zone actually delegated to that
    // provider's nameservers — a scenario's FQDN is `<envPrefix>.<domain>`,
    // and the DNS-01 solver drives the named provider's API against it, so a
    // key here that isn't really delegated fails at cert issuance, not at
    // preflight.
    //
    // `digitalocean`/`linode` are 3-label subdomain zones delegated out of
    // appcarbon.dev. `vultr` is a SEPARATE APEX and has to be: Vultr's DNS
    // API rejects subdomain zones outright ("Subdomains are not permitted",
    // HTTP 400 — docs.vultr.com/products/network/dns), so the 3-label trick
    // used for the other two is unavailable to it. threvidence.com is
    // delegated at the registrar to ns1/ns2.vultr.com.
    //
    // resolveBaseDomain (tests/e2e/utils/scenario-overrides.ts) throws naming
    // the missing key if anything ever selects a DNS provider that isn't
    // listed here.
    domains: {
      hetzner: 'carbonstack.dev',
      cloudflare: 'appcarbon.dev',
      digitalocean: 'do.appcarbon.dev',
      linode: 'linode.appcarbon.dev',
      vultr: 'threvidence.com',
      // Separate apex, same reasoning as vultr above: Scaleway's Domains API
      // requires the account to own the domain as an EXTERNAL DOMAIN before
      // it will serve any zone for it (scaleway-dns.js), so a 3-label
      // subdomain trick out of appcarbon.dev isn't an option. Onboarded +
      // validated (status: active) and delegated to ns0/ns1.dom.scw.cloud
      // 2026-08-13.
      scaleway: 'threadtrace.app',
    },
    // Baseline feature set for e2e runs. Kept minimal so timing numbers
    // reflect a typical first deploy, not a stress test. Callers can opt into
    // the optional services via runner `--features=redis` (or any subset of
    // installable add-ons); see `runner.ts` CLI parsing.
    features: ['observability'] as const,
    adminEmail: 'test@vibecarbon.dev',
    adminPassword: 'TestPassword123!',
    // The region is resolved at preflight from `capacityPreferences` (see
    // tests/e2e/utils/region-resolver.ts): the first listed region where the
    // customer's price picker (src/lib/sizing.js) can place every role of the
    // scenario on the live catalog. The server types are never pinned: the
    // deploy under test picks them exactly as a customer's first deploy does,
    // and records them in .vibecarbon.json.
    //
    // `scaleTo` is the scale ladder: the type the deploy recorded -> the type
    // the scale step moves it to. Every entry is amd64 (vibecarbon is x86-64
    // only, owner decision 2026-07-30; see src/lib/deploy/platform.js) and in
    // the provider's fallback catalog, every type the picker can default to
    // has an entry, and a compose or master default's target is sold where
    // that type is the default: tests/unit/e2e/default-sizes-unpinned-census.test.ts
    // fails otherwise. A recorded type with no entry fails the scale step.
    //
    // The scale step keys on the compose or master type only
    // (deployedScaleTarget), and `scale -type` resizes the db with every
    // other role. The db-role rows (cpx12, cpx11, s-1vcpu-2gb,
    // s-1vcpu-2gb-amd) exist only so the census's "every default has an
    // entry" rule holds; no scale step reads them.
    capacityPreferences: {
      hetzner: {
        // EU only. Hetzner's 2026-06-15 repricing raised CPX ~3x in the US
        // locations, and `ash`/`hil` carry no cx line at all; `sin` is the
        // same shape (CPX/CCX-only) with a price uplift on top. Every VM the
        // matrix spawns is billed at least one full hour, so where it lands
        // is the cost driver — see tests/unit/e2e/hetzner-capacity-cost-
        // guard.test.ts. A US perf record run is still possible by passing
        // `regions: ash,hil` at workflow dispatch (E2E_REGIONS); it is just
        // no longer the default anywhere.
        regions: ['nbg1', 'hel1', 'fsn1'] as const,
        // EU defaults stay on the current generation (cx*3, cpx*2): the
        // legacy cpx*1 line costs more than its successor since the
        // repricing. cpx21 and cpx11 are the ash/hil (US) defaults, reached
        // only by an explicit E2E_REGIONS=ash,hil run.
        scaleTo: {
          cx23: 'cx33',
          cpx22: 'cpx32',
          cpx12: 'cpx22',
          cpx21: 'cpx31',
          cpx11: 'cpx21',
        },
      },
      // DigitalOcean is fully supported — see
      // DigitalOceanProvider.SUPPORTED_TIERS (all four tiers since the d4
      // lift, 2026-08-27). Regions are
      // the subset of DigitalOceanProvider.REGIONS that also carry Spaces
      // (object storage) — keeps backup/S3 traffic in-region. The ladder
      // covers the Basic line and the `-amd` / `-intel` variants the picker
      // falls to where a region does not sell the plain size (nyc2 and sfo3
      // sold only the variants on 2026-10-22). Each variant scales to its own
      // 8 GB sibling, the size sold where the variant is; the plain
      // s-4vcpu-8gb is not sold in nyc2 or sfo3.
      digitalocean: {
        regions: ['nyc3', 'sfo3', 'ams3', 'fra1'] as const,
        scaleTo: {
          's-2vcpu-4gb': 's-4vcpu-8gb',
          's-1vcpu-2gb': 's-2vcpu-4gb',
          's-1vcpu-2gb-amd': 's-2vcpu-4gb-amd',
          's-2vcpu-4gb-amd': 's-4vcpu-8gb-amd',
          's-2vcpu-4gb-intel': 's-4vcpu-8gb-intel',
        },
      },
      // Linode runs compose + compose-ha (2026-08 expansion phase 1 +
      // tier-parity wave 1 — see LinodeProvider.SUPPORTED_TIERS). Regions are
      // the base-price subset of LinodeProvider.REGIONS (id-cgk/br-gru carry
      // region-price uplifts) with geographic spread; us-iad first, the
      // primary l1/l2 deploy to. The HA standby is not taken from this list:
      // it goes where a customer's deploy puts it (getDefaultStandbyRegion
      // on the live catalog). Linode's Standard line is a global catalog
      // with no per-region capacity flux.
      linode: {
        regions: ['us-iad', 'us-ord', 'fr-par', 'us-sea'] as const,
        scaleTo: { 'g6-standard-2': 'g6-standard-4' },
      },
      // Vultr runs compose + compose-ha (2026-08 expansion phase 1, PR 2 +
      // tier-parity wave 1 — see VultrProvider.SUPPORTED_TIERS). Regions are
      // compute region ids (IATA-style) that (a) actually carry the vc2
      // pair and (b) have a co-located Object Storage cluster (`ewr`→ewr1,
      // `ord`→chi3, `sjc`→sjc1, `lax`→lax1, `ams`→ams1 — see
      // VultrObjectStorageProvider.COMPUTE_TO_S3; cluster slugs are NOT
      // region ids).
      //
      // (a) is not a formality: unlike Linode's global catalog, a Vultr plan
      // carries its own `locations` array, and it FLUXES — vc2 was absent
      // from hnl/mxp/ord on 2026-08-08 but ord carried it again on
      // 2026-08-19, so a dated snapshot is never load-bearing here; the
      // resolver re-checks the default and its scale target live at
      // preflight.
      //
      // Backups land in whatever cluster VULTR_STORAGE_REGION names,
      // NOT in the resolved compute region's cluster — object-storage keys
      // are per-subscription. Region order is therefore "co-located with the
      // usual ewr1 subscription first"; a fallback to sjc/lax/ams still
      // works, it just crosses regions for backup traffic. ewr stays first
      // for that reason. The HA standby is not taken from this list: it goes
      // where a customer's deploy puts it (getDefaultStandbyRegion on the
      // live catalog). The resolver's live plan-locations check is the flux
      // guard: a region that loses vc2 is skipped as a primary, and a
      // default standby that cannot sell the scale target fails preflight.
      vultr: {
        regions: ['ewr', 'ord', 'sjc', 'lax', 'ams'] as const,
        scaleTo: { 'vc2-2c-4gb': 'vc2-4c-8gb' },
      },
      // Scaleway runs compose + compose-ha (2026-08 expansion PR 3 +
      // tier-parity wave 1 — see ScalewayProvider.SUPPORTED_TIERS). "Regions"
      // are ZONES (Scaleway's Instance API is zone-scoped): the audited
      // four that carry the compose candidates (BASIC3, DEV1) and whose S3
      // regions (fr-par, nl-ams) have all three storage classes.
      // NO Scaleway type exists in all ten zones (live per-zone catalog
      // 2026-08-09) and price is not zone-invariant, so the resolver
      // checks each (zone, type) against the live catalog + availability
      // endpoints — never assume a type exists in a zone. fr-par-1 first,
      // the primary s1/s2 deploy to. The HA standby is not taken from this
      // list: it goes where a customer's deploy puts it
      // (getDefaultStandbyRegion on the live catalog).
      scaleway: {
        regions: ['fr-par-1', 'nl-ams-1', 'fr-par-2', 'nl-ams-2'] as const,
        scaleTo: { 'DEV1-M': 'DEV1-L', 'BASIC3-X2C-4G': 'BASIC3-X4C-8G' },
      },
    },
    // ---------------------------------------------------------------------
    // PROVIDER REGISTRY — the single source of truth for provider × scenario.
    // The selection grammar (tests/e2e/selection.ts), preflight credential
    // gating, the perf-table reporter's per-provider blocks, and the CI
    // workflow inputs all key off this. Adding a provider = one entry here.
    // Env prefixes are INTERNAL namespacing (bucket/DNS/stack names) — they
    // are never selection vocabulary.
    // ---------------------------------------------------------------------
    providers: {
      hetzner: {
        displayName: 'Hetzner Cloud',
        requiredEnv: ['HETZNER_API_TOKEN'],
        scenarios: [
          { mode: 'compose' as const, dnsProvider: 'hetzner' as const, envPrefix: 'e1' },
          // e2 uses Hetzner DNS so the compose-ha failover flip exercises the
          // SAME provider that owns the compute — the self-contained default.
          { mode: 'compose-ha' as const, dnsProvider: 'hetzner' as const, envPrefix: 'e2' },
          { mode: 'k8s' as const, dnsProvider: 'hetzner' as const, envPrefix: 'e3' },
          { mode: 'k8s-ha' as const, dnsProvider: 'hetzner' as const, envPrefix: 'e4' },
        ],
        defaultSelection: ['compose', 'compose-ha', 'k8s', 'k8s-ha'],
      },
      digitalocean: {
        displayName: 'DigitalOcean',
        requiredEnv: [
          'DIGITALOCEAN_API_TOKEN',
          'DIGITALOCEAN_ACCESS_KEY',
          'DIGITALOCEAN_SECRET_KEY',
        ],
        // All four run on NATIVE DigitalOcean DNS (do.appcarbon.dev). That
        // costs no extra credential — the DO DNS backend authenticates with
        // the same DIGITALOCEAN_API_TOKEN as DO compute, already in
        // requiredEnv above — and it means `--provider digitalocean` exercises
        // the DO DNS-01 path end to end instead of proving Cloudflare works
        // for the fourth time.
        scenarios: [
          { mode: 'compose' as const, dnsProvider: 'digitalocean' as const, envPrefix: 'd1' },
          { mode: 'compose-ha' as const, dnsProvider: 'digitalocean' as const, envPrefix: 'd2' },
          { mode: 'k8s' as const, dnsProvider: 'digitalocean' as const, envPrefix: 'd3' },
          // d4 (2026-08-27): the k8s-ha reference scenario. Its standby, like
          // d2's, goes where a customer's nyc3 deploy puts it
          // (getDefaultStandbyRegion: tor1 on 2026-10-22); failover is a DNS flip on
          // native DO DNS, so the flip exercises the SAME provider that owns
          // the compute — the self-contained default, like Hetzner's e4.
          { mode: 'k8s-ha' as const, dnsProvider: 'digitalocean' as const, envPrefix: 'd4' },
        ],
        defaultSelection: ['compose', 'compose-ha', 'k8s', 'k8s-ha'],
      },
      // Compose + compose-ha (2026-08 expansion PR 1 + tier-parity wave 1 —
      // LinodeProvider.SUPPORTED_TIERS stops at `compose-ha`; 4-mode headroom
      // recorded in
      // the linode-provider-step0-audit plan).
      // NOTE for CI namespacing: remapEnvPrefix strips only a LEADING `e`,
      // so `l1` under E2E_NAMESPACE=ci becomes `cil1` (pinned in
      // namespace.test.ts).
      linode: {
        displayName: 'Linode',
        // STORAGE_REGION is required, not an override — the same reasoning as
        // Vultr's below, reached by a different route. Linode assigns each
        // ACCOUNT one object-storage cluster per region and it is not always
        // the documented `-1` one (this account's us-iad cluster is
        // `us-iad-10`). Unset, bucket creation goes to the wrong cluster and
        // fails as `exists but is owned by another account` — which reads as a
        // name collision and is really a wrong endpoint. Listing it here is
        // what makes preflight demand it instead of the deploy discovering it.
        requiredEnv: [
          'LINODE_API_TOKEN',
          'LINODE_ACCESS_KEY',
          'LINODE_SECRET_KEY',
          'LINODE_STORAGE_REGION',
        ],
        // Native Linode DNS (linode.appcarbon.dev), same reasoning as the DO
        // block above: LINODE_API_TOKEN already covers it, so l1 needs no
        // Cloudflare credential and the Linode DNS-01 path gets real coverage.
        scenarios: [
          { mode: 'compose' as const, dnsProvider: 'linode' as const, envPrefix: 'l1' },
          // l2 uses Linode DNS so the compose-ha failover flip exercises the
          // SAME provider that owns the compute — the self-contained default,
          // same reasoning as Hetzner's e2.
          { mode: 'compose-ha' as const, dnsProvider: 'linode' as const, envPrefix: 'l2' },
        ],
        defaultSelection: ['compose', 'compose-ha'],
      },
      // Compose + compose-ha (2026-08 expansion PR 2 + tier-parity wave 1 —
      // VultrProvider.SUPPORTED_TIERS stops at `compose-ha`; 4-mode headroom
      // recorded in
      // the vultr-provider-step0-audit plan).
      // VULTR_STORAGE_REGION is required alongside the key pair, not
      // optional like the other providers' region overrides: Vultr mints
      // object-storage keys PER SUBSCRIPTION and one subscription is one
      // cluster, so the keys carry no account-wide scope from which a
      // cluster could be inferred (see the audit's key-model section).
      // NOTE for CI namespacing: remapEnvPrefix strips only a LEADING `e`,
      // so `v1` under E2E_NAMESPACE=ci becomes `civ1` (pinned in
      // namespace.test.ts).
      vultr: {
        displayName: 'Vultr',
        requiredEnv: [
          'VULTR_API_TOKEN',
          'VULTR_ACCESS_KEY',
          'VULTR_SECRET_KEY',
          'VULTR_STORAGE_REGION',
        ],
        // Native Vultr DNS on its own apex (threvidence.com — see the
        // domains map). Vultr's API rejects subdomain zones, so unlike
        // DigitalOcean and Linode it could not reuse a 3-label delegation
        // out of appcarbon.dev and needed a separate registrable domain.
        // Verified live 2026-08-12: zone served by ns1/ns2.vultr.com, and a
        // TXT written through the API resolved authoritatively.
        scenarios: [
          { mode: 'compose' as const, dnsProvider: 'vultr' as const, envPrefix: 'v1' },
          // v2 uses Vultr DNS so the compose-ha failover flip exercises the
          // SAME provider that owns the compute — the self-contained default,
          // same reasoning as Hetzner's e2.
          { mode: 'compose-ha' as const, dnsProvider: 'vultr' as const, envPrefix: 'v2' },
        ],
        defaultSelection: ['compose', 'compose-ha'],
      },
      // Compose + compose-ha (2026-08 expansion PR 3 + tier-parity wave 1 —
      // ScalewayProvider.SUPPORTED_TIERS stops at `compose-ha`; 4-mode
      // headroom recorded in
      // the scaleway-provider-step0-audit plan).
      // The credential is a TRIPLE, not a token: the Pulumi provider
      // requires SCALEWAY_ACCESS_KEY + SCALEWAY_SECRET_KEY + SCALEWAY_DEFAULT_PROJECT_ID
      // together (ScalewayProvider.buildIacEnv fails deploy-start naming
      // the missing var), and the SAME pair signs S3 — so requiredEnv is
      // exactly the triple, with no separate object-storage keys.
      // ISOLATION: SCALEWAY_DEFAULT_PROJECT_ID must name a DEDICATED Scaleway
      // Project — SSH keys are Project-scoped and re-applied to every
      // instance at each boot (audit design flag 1).
      // Native Scaleway DNS (threadtrace.app — see the domains map), same
      // reasoning as the DO/Linode/Vultr blocks above: the same SCALEWAY_*
      // triple already in requiredEnv signs the Domains & DNS API
      // (scaleway-dns.js), so s1 needs no separate Cloudflare credential and
      // exercises the Scaleway DNS-01 path end to end.
      // NOTE for CI namespacing: remapEnvPrefix strips only a LEADING `e`,
      // so `s1` under E2E_NAMESPACE=ci becomes `cis1` (pinned in
      // namespace.test.ts).
      scaleway: {
        displayName: 'Scaleway',
        requiredEnv: ['SCALEWAY_SECRET_KEY', 'SCALEWAY_ACCESS_KEY', 'SCALEWAY_DEFAULT_PROJECT_ID'],
        scenarios: [
          { mode: 'compose' as const, dnsProvider: 'scaleway' as const, envPrefix: 's1' },
          // s2 uses Scaleway DNS so the compose-ha failover flip exercises
          // the SAME provider that owns the compute — the self-contained
          // default, same reasoning as Hetzner's e2.
          { mode: 'compose-ha' as const, dnsProvider: 'scaleway' as const, envPrefix: 's2' },
        ],
        defaultSelection: ['compose', 'compose-ha'],
      },
    },

    timeouts: {
      create: 300_000, // 5 min
      addFeatures: 60_000, // 1 min
      deploy: 900_000, // 15 min
      scale: 600_000, // 10 min
      backup: 300_000, // 5 min
      restore: 600_000, // 10 min
      failover: 300_000, // 5 min
      destroy: 300_000, // 5 min
      verify: 300_000, // 5 min
    },
  },
} as const;

// Type exports for better IDE support
export type TestConfig = typeof testConfig;
export type InfraConfig = typeof testConfig.infrastructure;
export type HetznerConfig = typeof testConfig.infrastructure.hetzner;
export type CloudflareConfig = typeof testConfig.infrastructure.cloudflare;
