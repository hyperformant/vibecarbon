/**
 * Shared "which providers are implemented, with which pinned values" table.
 *
 * Single source of truth consumed by both `provider-contract.test.ts` (which
 * asserts every registered provider class matches these exact values) and
 * `registry.test.ts` (which derives its provider-count assertion from
 * `Object.keys(EXPECTED)` instead of a hardcoded number). Lives outside any
 * `*.test.ts` file — biome's `noExportsInTest` rule forbids exporting from
 * test files, and a shared fixture module is this repo's existing pattern
 * for cross-test-file reuse (see `tests/_shared/arg-parser-suite.ts`,
 * `tests/_shared/temp-dir.ts`).
 *
 * Each row pins the literal values a provider's identity/credentials
 * statics must hold. This is the "customer-visible contract" surface —
 * TOKEN_ENV in particular is pinned externally as a CI secret name (see
 * github-environments.test.ts, deploy-workflow-secret-sync.test.ts) and
 * must never be silently renamed.
 *
 * Adding a provider means adding a row here (required for
 * provider-contract.test.ts's per-provider suite to pass) — both consuming
 * tests then track it with no further edits.
 */
export const EXPECTED: Record<
  string,
  {
    name: string;
    tokenEnv: string;
    cliTokenEnv: string;
    providerIdPrefix: string;
    defaultRegion: string;
    pricingUrl: string;
    s3RegionEnv: string;
    defaultComposeType: string;
    defaultK8sNodeType: string;
    k8sAssets: {
      csiNodeDaemonSet: string;
      csiControllerSelector: string;
      ccmDeployment: string;
      ccmSelector: string;
      networkEnvVar: string;
    };
    k8sStorageClass: string;
    k8sImage: string;
  }
> = {
  hetzner: {
    name: 'Hetzner Cloud',
    tokenEnv: 'HETZNER_API_TOKEN',
    cliTokenEnv: 'HCLOUD_TOKEN',
    // CA's providerID join key — must match what the hcloud CCM stamps on
    // nodes (dossier: Instance.id === node .spec.providerID).
    providerIdPrefix: 'hcloud://',
    defaultRegion: 'nbg1',
    pricingUrl: 'https://www.hetzner.com/cloud/',
    s3RegionEnv: 'HETZNER_STORAGE_REGION',
    // cpx22, not cx23: the whole cx*3 line reads available:false across
    // fsn1/nbg1/hel1, and nbg1 is defaultRegion above — these seeded headless
    // deploys with a SKU the API refuses to place.
    defaultComposeType: 'cpx22',
    defaultK8sNodeType: 'cpx22',
    // C7c — hoisted verbatim from scale.js's csi-node rollout wait,
    // diagnose.js's CCM/CSI label selectors + CCM-deployment env-var probe,
    // and shell.js's network env export + banner.
    k8sAssets: {
      csiNodeDaemonSet: 'daemonset/hcloud-csi-node',
      csiControllerSelector:
        'app.kubernetes.io/component=controller,app.kubernetes.io/name=hcloud-csi',
      ccmDeployment: 'hcloud-cloud-controller-manager',
      ccmSelector: 'app.kubernetes.io/name=hcloud-cloud-controller-manager',
      networkEnvVar: 'HCLOUD_NETWORK',
    },
    k8sStorageClass: 'hcloud-volumes',
    // M3 Task 2 — matches hetzner-k8s.js's `image: 'ubuntu-24.04'` literal.
    k8sImage: 'ubuntu-24.04',
  },
  linode: {
    name: 'Linode',
    tokenEnv: 'LINODE_API_TOKEN',
    cliTokenEnv: 'LINODE_TOKEN',
    providerIdPrefix: 'linode://',
    defaultRegion: 'us-iad',
    pricingUrl: 'https://www.linode.com/pricing/',
    // Endpoint-slug form (us-iad-1, not us-iad) — see
    // linode-objectstorage.js's REGIONS doc for the compute→cluster split.
    s3RegionEnv: 'LINODE_STORAGE_REGION',
    defaultComposeType: 'g6-standard-2',
    defaultK8sNodeType: 'g6-standard-2',
    // Compose-only provider (2026-08 expansion phase 1): no CCM/CSI is
    // deployed, so the asset identity is deliberately empty — except the
    // storage-class literal, which the literal-guard census requires to be
    // real and distinct even before the k8s tier exists.
    k8sAssets: {
      csiNodeDaemonSet: '',
      csiControllerSelector: '',
      ccmDeployment: '',
      ccmSelector: '',
      networkEnvVar: '',
    },
    k8sStorageClass: 'linode-block-storage',
    k8sImage: '',
  },
  vultr: {
    name: 'Vultr',
    tokenEnv: 'VULTR_API_TOKEN',
    // What @ediri/vultr reads — distinct from tokenEnv by the uniqueness
    // contract, and genuinely a different var on this provider.
    cliTokenEnv: 'VULTR_API_KEY',
    providerIdPrefix: 'vultr://',
    defaultRegion: 'ewr',
    pricingUrl: 'https://www.vultr.com/pricing/',
    // Cluster slug of the operator's per-subscription keys (e.g. ewr1) —
    // effectively REQUIRED config on Vultr; see vultr-objectstorage.js.
    s3RegionEnv: 'VULTR_STORAGE_REGION',
    defaultComposeType: 'vc2-2c-4gb',
    defaultK8sNodeType: 'vc2-2c-4gb',
    // Compose-only (2026-08 expansion PR 2): empty asset identity except
    // the storage-class literal (vultr-csi's real default class), which the
    // literal-guard census requires distinct + resident in vultr.js.
    k8sAssets: {
      csiNodeDaemonSet: '',
      csiControllerSelector: '',
      ccmDeployment: '',
      ccmSelector: '',
      networkEnvVar: '',
    },
    k8sStorageClass: 'vultr-block-storage',
    k8sImage: '',
  },
  scaleway: {
    name: 'Scaleway',
    // Operator-facing SPELLED-OUT name vs the plugin's native one — same
    // split as every sibling (HETZNER_API_TOKEN→HCLOUD_TOKEN,
    // VULTR_API_TOKEN→VULTR_API_KEY). TOKEN_ENV is what the operator sets
    // (and the REST X-Auth-Token value); CLI_TOKEN_ENV is what the Pulumi
    // Scaleway provider reads (SCW_SECRET_KEY). The provider additionally
    // needs SCW_ACCESS_KEY + SCW_DEFAULT_PROJECT_ID, EMITTED (translated
    // from the operator's SCALEWAY_* triple) by buildIacEnv — the
    // multi-credential seam — not via a second token static.
    tokenEnv: 'SCALEWAY_SECRET_KEY',
    cliTokenEnv: 'SCW_SECRET_KEY',
    // Scaleway's CCM builds `scaleway://instance/<zone>/<uuid>` — two path
    // segments between prefix and UUID, unlike hcloud://<id> (k8s-tier
    // caveat recorded in the audit; inert while compose-only).
    providerIdPrefix: 'scaleway://',
    // A ZONE (3-part), not a region — Scaleway's Instance API is
    // zone-scoped and ScalewayProvider.REGIONS is keyed on zones.
    defaultRegion: 'fr-par-1',
    pricingUrl: 'https://www.scaleway.com/en/pricing/',
    // Object-storage REGION (fr-par / nl-ams) — normally DERIVED by
    // stripping the zone's trailing `-N` (zoneToS3Region); optional
    // override for parity with the sibling providers.
    s3RegionEnv: 'SCALEWAY_STORAGE_REGION',
    defaultComposeType: 'BASIC3-X2C-4G',
    defaultK8sNodeType: 'BASIC3-X2C-4G',
    // Compose-only (2026-08 expansion PR 3): empty asset identity except
    // the storage-class literal (scaleway-csi's default class,
    // `sbs-default`), which the literal-guard census requires distinct +
    // resident in scaleway.js.
    k8sAssets: {
      csiNodeDaemonSet: '',
      csiControllerSelector: '',
      ccmDeployment: '',
      ccmSelector: '',
      networkEnvVar: '',
    },
    k8sStorageClass: 'sbs-default',
    k8sImage: '',
  },
  digitalocean: {
    name: 'DigitalOcean',
    tokenEnv: 'DIGITALOCEAN_API_TOKEN',
    cliTokenEnv: 'DIGITALOCEAN_TOKEN',
    providerIdPrefix: 'digitalocean://',
    defaultRegion: 'nyc3',
    pricingUrl: 'https://www.digitalocean.com/pricing/droplets',
    s3RegionEnv: 'DIGITALOCEAN_STORAGE_REGION',
    defaultComposeType: 's-2vcpu-4gb',
    // M3 Task 1 — real k8s-facing statics; SUPPORTED_TIERS gained `k8s`
    // in Task 6 (k8s-ha remains Hetzner-only).
    defaultK8sNodeType: 's-2vcpu-4gb',
    k8sAssets: {
      csiNodeDaemonSet: 'daemonset/csi-do-node',
      csiControllerSelector: 'app=csi-do-controller',
      ccmDeployment: 'digitalocean-cloud-controller-manager',
      ccmSelector: 'app=digitalocean-cloud-controller-manager',
      networkEnvVar: '',
    },
    k8sStorageClass: 'do-block-storage',
    // M3 Task 2 — matches COMPOSE_IMAGE (no separate k8s-tier image on DO).
    k8sImage: 'ubuntu-24-04-x64',
  },
};
