/**
 * Single source of truth for the env keys that `vibecarbon configure` manages,
 * plus the operator-facing keys that other commands (deploy/access/CI) read
 * directly outside `configure`.
 *
 * `configure` writes feature config/secrets to `.env.local`/`.env`. Several
 * deploy paths each need to know *which* keys to propagate and *how* to treat
 * each one (build-time vs runtime, secret vs non-secret). Historically each
 * path carried its own hand-maintained list, so a key added to one feature
 * silently failed to reach the cloud on another path. This registry is the one
 * list they all derive from; coverage tests assert registry ⊆ each path.
 *
 * Scope: feature keys (billing, OAuth, SMTP, analytics) plus operator/provider
 * credentials (Hetzner/DigitalOcean/Cloudflare/S3 tokens, Docker Hub, the
 * Pulumi state backend, the ACME CA override) plus the one operator-local
 * runtime key deploy reads directly (ALLOWED_SSH_IPS). Infra secrets
 * (DB_PASSWORD/JWT_SECRET/ANON_KEY/…) are *generated*, not configured, and
 * carry k8s-specific Supabase-chart translation logic — they stay local to the
 * k8s deploy modules.
 *
 * Classification:
 *   - 'client-build'    → baked into the client bundle at image build time
 *                         (VITE_*). A change must force an image rebuild.
 *   - 'runtime-config'  → non-secret server/auth runtime env.
 *   - 'runtime-secret'  → secret server/auth runtime env.
 *   - 'operator-secret' → cloud/DNS provider credentials, Docker Hub registry
 *                         credentials, the Pulumi state-backend URL, and the
 *                         ACME CA override — CLI-local values the CLI (or its
 *                         spawned children: ssh/pulumi/docker) uses locally.
 *                         Never a pod/container env var — `featureRuntimeKeys()`
 *                         and `clientBuildKeys()` exclude this class by
 *                         construction (they only ever list the other three),
 *                         so nothing here can leak into deploy propagation.
 *
 * Per-entry shape metadata (`kind`/`shape`/`sample`/`where`/`optional`/`scope`)
 * lets `configure` validate input and lets docs generation (the
 * `.env.local.example` operator doc) describe each key without a second,
 * hand-maintained copy of this same knowledge. A tight `shape.regex` is added
 * ONLY where the vendor documents the exact format — a loose shape (`minLen`)
 * or no shape at all otherwise, so this file never asserts a format it can't
 * back up.
 *
 * Keep this aligned with what `configure` writes (src/configure.js) and what
 * the app/auth services read (carbon/src/server/lib/env.ts + the GoTrue
 * `auth` service wiring in carbon/docker-compose.yml). Dependency-free on
 * purpose so deploy code can import it without pulling in @clack/prompts.
 */

/**
 * @typedef {'client-build' | 'runtime-config' | 'runtime-secret' | 'operator-secret'} ConfigClass
 * @typedef {'token'|'secret'|'id'|'slug'|'hostname'|'port'|'email'|'url'|'cidr-list'|'pem'|'enum'|'flag'} ConfigKind
 * @typedef {{ regex?: RegExp, minLen?: number, maxLen?: number, values?: string[], describe: string }} ConfigShape
 * @typedef {'.env.local' | '.env' | 'operator shell' | 'tests/.env.e2e'} ConfigWhere
 * @typedef {{
 *   key: string,
 *   class: ConfigClass,
 *   feature: string,
 *   kind: ConfigKind,
 *   shape?: ConfigShape,
 *   sample?: string,
 *   where: ConfigWhere,
 *   optional?: boolean,
 *   scope: string,
 * }} ConfigKey
 */

// Shared shapes, so the tight formats aren't retyped at each call site.
// https-only — RFC 8555 mandates https for ACME directory URLs, so this
// shape is scoped to ACME_CA_SERVER alone (PULUMI_BACKEND_URL documents a
// wider set of schemes and gets its own shape below).
const HTTPS_URL_SHAPE = { regex: /^https:\/\/.+/, describe: 'an https:// ACME directory URL' };
const TRUE_FALSE_SHAPE = { values: ['true', 'false'], describe: 'one of true, false' };
// Exported so operator-env.js's shape-less 'email' kind fallback validates
// against the exact same pattern as any registry entry that pins this shape,
// instead of carrying its own duplicate.
export const EMAIL_REGEX = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
// One octet, 0-255 — reused for the CIDR-list regex below.
const IPV4_OCTET = '(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4_CIDR = `${IPV4_OCTET}(\\.${IPV4_OCTET}){3}/(3[0-2]|[12]?[0-9])`;

/** @type {ConfigKey[]} */
export const CONFIG_KEYS = [
  // ---- Billing: provider selection ----
  {
    key: 'BILLING_PROVIDER',
    class: 'runtime-config',
    feature: 'billing',
    kind: 'enum',
    shape: { values: ['stripe', 'paddle', 'polar'], describe: 'one of stripe, paddle, polar' },
    sample: 'stripe',
    where: '.env',
    scope: 'billing',
  },

  // ---- Billing: Stripe ----
  {
    key: 'STRIPE_SECRET_KEY',
    class: 'runtime-secret',
    feature: 'billing',
    kind: 'secret',
    shape: { regex: /^sk_(test|live)_[A-Za-z0-9]+$/, describe: 'sk_live_… or sk_test_…' },
    sample: 'sk_test_abc123',
    where: '.env',
    scope: 'billing',
  },
  {
    key: 'STRIPE_WEBHOOK_SECRET',
    class: 'runtime-secret',
    feature: 'billing',
    kind: 'secret',
    shape: { regex: /^whsec_[A-Za-z0-9]+$/, describe: 'whsec_… webhook signing secret' },
    sample: 'whsec_abc123',
    where: '.env',
    scope: 'billing',
  },
  {
    key: 'STRIPE_PRICE_STARTER',
    class: 'runtime-config',
    feature: 'billing',
    kind: 'id',
    where: '.env',
    scope: 'billing',
  },
  {
    key: 'STRIPE_PRICE_PRO',
    class: 'runtime-config',
    feature: 'billing',
    kind: 'id',
    where: '.env',
    scope: 'billing',
  },

  // ---- Billing: Paddle ----
  {
    key: 'PADDLE_API_KEY',
    class: 'runtime-secret',
    feature: 'billing',
    kind: 'secret',
    shape: { minLen: 8, describe: 'at least 8 characters' },
    sample: 'paddle-api-key-sample',
    where: '.env',
    scope: 'billing',
  },
  {
    key: 'PADDLE_WEBHOOK_SECRET',
    class: 'runtime-secret',
    feature: 'billing',
    kind: 'secret',
    shape: { minLen: 8, describe: 'at least 8 characters' },
    sample: 'paddle-webhook-secret',
    where: '.env',
    scope: 'billing',
  },
  {
    key: 'PADDLE_ENVIRONMENT',
    class: 'runtime-config',
    feature: 'billing',
    kind: 'enum',
    shape: { values: ['sandbox', 'production'], describe: 'one of sandbox, production' },
    sample: 'sandbox',
    where: '.env',
    scope: 'billing',
  },
  {
    key: 'PADDLE_PRICE_STARTER',
    class: 'runtime-config',
    feature: 'billing',
    kind: 'id',
    where: '.env',
    scope: 'billing',
  },
  {
    key: 'PADDLE_PRICE_PRO',
    class: 'runtime-config',
    feature: 'billing',
    kind: 'id',
    where: '.env',
    scope: 'billing',
  },

  // ---- Billing: Polar ----
  // No documented token prefix to pin (review 2026-09-19: the `polar_oat_`
  // prefix used in an earlier draft was unverified against Polar's docs) —
  // loose shape only, same treatment as the other undocumented secrets below.
  {
    key: 'POLAR_ACCESS_TOKEN',
    class: 'runtime-secret',
    feature: 'billing',
    kind: 'secret',
    shape: { minLen: 16, describe: 'at least 16 characters' },
    sample: 'polar-access-token-sample',
    where: '.env',
    scope: 'billing',
  },
  {
    key: 'POLAR_WEBHOOK_SECRET',
    class: 'runtime-secret',
    feature: 'billing',
    kind: 'secret',
    shape: { minLen: 8, describe: 'at least 8 characters' },
    sample: 'polar-webhook-secret',
    where: '.env',
    scope: 'billing',
  },
  {
    key: 'POLAR_ORGANIZATION_ID',
    class: 'runtime-config',
    feature: 'billing',
    kind: 'id',
    where: '.env',
    scope: 'billing',
  },
  {
    key: 'POLAR_PRICE_STARTER',
    class: 'runtime-config',
    feature: 'billing',
    kind: 'id',
    where: '.env',
    scope: 'billing',
  },
  {
    key: 'POLAR_PRICE_PRO',
    class: 'runtime-config',
    feature: 'billing',
    kind: 'id',
    where: '.env',
    scope: 'billing',
  },

  // ---- OAuth: Google (consumed by the GoTrue auth service) ----
  {
    key: 'GOOGLE_ENABLED',
    class: 'runtime-config',
    feature: 'oauth',
    kind: 'flag',
    shape: TRUE_FALSE_SHAPE,
    sample: 'true',
    where: '.env',
    scope: 'oauth',
  },
  {
    key: 'GOOGLE_CLIENT_ID',
    class: 'runtime-config',
    feature: 'oauth',
    kind: 'id',
    shape: {
      regex: /^[0-9]+-[0-9A-Za-z_]+\.apps\.googleusercontent\.com$/,
      describe: 'ending in .apps.googleusercontent.com',
    },
    sample: '123456789012-abc123def456ghi789jkl012.apps.googleusercontent.com',
    where: '.env',
    scope: 'oauth',
  },
  {
    key: 'GOOGLE_CLIENT_SECRET',
    class: 'runtime-secret',
    feature: 'oauth',
    kind: 'secret',
    shape: { regex: /^GOCSPX-[A-Za-z0-9_-]+$/, describe: 'GOCSPX-… (Google OAuth client secret)' },
    sample: 'GOCSPX-AbCdEf1234567890ghijk',
    where: '.env',
    scope: 'oauth',
  },

  // ---- OAuth: Microsoft ----
  {
    key: 'MICROSOFT_ENABLED',
    class: 'runtime-config',
    feature: 'oauth',
    kind: 'flag',
    shape: TRUE_FALSE_SHAPE,
    sample: 'true',
    where: '.env',
    scope: 'oauth',
  },
  {
    key: 'MICROSOFT_CLIENT_ID',
    class: 'runtime-config',
    feature: 'oauth',
    kind: 'id',
    where: '.env',
    scope: 'oauth',
  },
  {
    key: 'MICROSOFT_CLIENT_SECRET',
    class: 'runtime-secret',
    feature: 'oauth',
    kind: 'secret',
    shape: { minLen: 8, describe: 'at least 8 characters' },
    sample: 'microsoft-client-secret',
    where: '.env',
    scope: 'oauth',
  },
  {
    key: 'MICROSOFT_TENANT_ID',
    class: 'runtime-config',
    feature: 'oauth',
    kind: 'id',
    shape: {
      regex:
        /^(common|organizations|consumers|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
      describe: 'a tenant UUID, or common/organizations/consumers',
    },
    sample: 'common',
    where: '.env',
    scope: 'oauth',
  },

  // ---- SMTP / Email (shared by the app and the auth service) ----
  // Canonical name is SMTP_PASS everywhere (app env.ts, compose, manifests).
  {
    key: 'SMTP_HOST',
    class: 'runtime-config',
    feature: 'smtp',
    kind: 'hostname',
    where: '.env',
    scope: 'smtp',
  },
  {
    key: 'SMTP_PORT',
    class: 'runtime-config',
    feature: 'smtp',
    kind: 'port',
    shape: {
      regex: /^([1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/,
      describe: '1-65535',
    },
    sample: '587',
    where: '.env',
    scope: 'smtp',
  },
  {
    key: 'SMTP_USER',
    class: 'runtime-config',
    feature: 'smtp',
    kind: 'id',
    where: '.env',
    scope: 'smtp',
  },
  {
    key: 'SMTP_PASS',
    class: 'runtime-secret',
    feature: 'smtp',
    kind: 'secret',
    shape: { minLen: 8, describe: 'at least 8 characters' },
    sample: 'smtp-password',
    where: '.env',
    scope: 'smtp',
  },
  {
    key: 'SMTP_ADMIN_EMAIL',
    class: 'runtime-config',
    feature: 'smtp',
    kind: 'email',
    shape: { regex: EMAIL_REGEX, describe: 'a valid email address, e.g. admin@example.com' },
    sample: 'admin@example.com',
    where: '.env',
    scope: 'smtp',
  },
  {
    key: 'SMTP_SENDER_NAME',
    class: 'runtime-config',
    feature: 'smtp',
    kind: 'id',
    where: '.env',
    scope: 'smtp',
  },
  // Carries GoTrue's value directly (true = SKIP the confirmation email —
  // compose env interpolation cannot negate, so no friendlier inverted
  // name). The configure SMTP wizard writes it; deploy templates default
  // to true because a false without working SMTP 500s every signup.
  {
    key: 'GOTRUE_MAILER_AUTOCONFIRM',
    class: 'runtime-config',
    feature: 'smtp',
    kind: 'flag',
    shape: TRUE_FALSE_SHAPE,
    sample: 'true',
    where: '.env',
    scope: 'smtp',
  },

  // ---- Analytics (client-side, baked at build time) ----
  {
    key: 'VITE_PLAUSIBLE_DOMAIN',
    class: 'client-build',
    feature: 'analytics',
    kind: 'hostname',
    optional: true,
    where: '.env',
    scope: 'analytics',
  },
  {
    key: 'VITE_PLAUSIBLE_SCRIPT_URL',
    class: 'client-build',
    feature: 'analytics',
    kind: 'url',
    optional: true,
    where: '.env',
    scope: 'analytics',
  },

  // ---- Landing (client-side, baked at build time) ----
  // Opt-in gate for the GitHub stars button. Empty (the generated-app
  // default) = the button renders nothing and NOTHING is fetched — a
  // customer's site must not phone home to GitHub (nav-no-phone-home
  // contract). vibecarbon.com sets its public repo URL.
  {
    key: 'VITE_GITHUB_REPO_URL',
    class: 'client-build',
    feature: 'landing',
    kind: 'url',
    optional: true,
    where: '.env',
    scope: 'landing',
  },

  // ---- Providers: cloud/DNS operator credentials ----
  // Never deployed to a server (see the 'operator-secret' class note above).
  // Written .env.local only.
  //
  // Object-storage credentials follow ONE convention: <PROVIDER>_ACCESS_KEY /
  // <PROVIDER>_SECRET_KEY / <PROVIDER>_STORAGE_REGION, keyed off the same
  // <PROVIDER> prefix as <PROVIDER>_API_TOKEN. This is the OPERATOR-facing name
  // the CLI reads (Provider.OBJECT_STORAGE_ENV) — distinct from the deployed
  // stack's provider-agnostic server-side S3_* namespace (renderBundle /
  // vibecarbon-secrets → AWS_* for wal-g), which is NOT a configure-managed key
  // and stays S3_*. Scaleway keeps OPERATOR-facing SCALEWAY_* names like every
  // other provider; the tool-imposed SCW_* spelling the Pulumi plugin demands
  // exists only inside ScalewayProvider.buildIacEnv.
  {
    key: 'HETZNER_API_TOKEN',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'token',
    shape: { regex: /^[A-Za-z0-9]{64}$/, describe: '64 alphanumeric characters' },
    sample: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4',
    where: '.env.local',
    scope: 'provider:hetzner',
  },
  {
    key: 'HETZNER_ACCESS_KEY',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'id',
    where: '.env.local',
    scope: 'provider:hetzner',
  },
  {
    key: 'HETZNER_SECRET_KEY',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'token',
    shape: { minLen: 8, describe: 'at least 8 characters' },
    sample: 'hetzner-secret-key-sample',
    where: '.env.local',
    scope: 'provider:hetzner',
  },
  // Object-storage REGION override — usually inferred from the compute
  // region; an explicit override for parity with the sibling providers.
  {
    key: 'HETZNER_STORAGE_REGION',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'slug',
    optional: true,
    where: '.env.local',
    scope: 'provider:hetzner',
  },
  {
    key: 'DIGITALOCEAN_API_TOKEN',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'token',
    shape: { minLen: 8, describe: 'at least 8 characters' },
    sample: 'digitalocean-api-token-sample',
    where: '.env.local',
    scope: 'provider:digitalocean',
  },
  {
    key: 'DIGITALOCEAN_ACCESS_KEY',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'id',
    where: '.env.local',
    scope: 'provider:digitalocean',
  },
  {
    key: 'DIGITALOCEAN_SECRET_KEY',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'token',
    shape: { minLen: 8, describe: 'at least 8 characters' },
    sample: 'digitalocean-secret-key-sample',
    where: '.env.local',
    scope: 'provider:digitalocean',
  },
  // Dedicated-project id for ensureProjectAssignment (persisted by
  // runProjectAssignment on first find-or-create). Registered like
  // SCALEWAY_DEFAULT_PROJECT_ID: an id, not a credential, but it rides the
  // operator .env.local store and the same registry-driven handling.
  {
    key: 'DIGITALOCEAN_PROJECT_ID',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'id',
    optional: true,
    shape: {
      regex: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
      describe: 'a UUID',
    },
    sample: '12345678-1234-4123-8123-123456789012',
    where: '.env.local',
    scope: 'provider:digitalocean',
  },
  // Object-storage REGION override for DigitalOcean Spaces — same rationale
  // as HETZNER_STORAGE_REGION (usually inferred, optional override).
  {
    key: 'DIGITALOCEAN_STORAGE_REGION',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'slug',
    optional: true,
    where: '.env.local',
    scope: 'provider:digitalocean',
  },
  {
    key: 'CLOUDFLARE_API_TOKEN',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'token',
    shape: { minLen: 8, describe: 'at least 8 characters' },
    sample: 'cloudflare-api-token-sample',
    where: '.env.local',
    scope: 'dns:cloudflare',
  },
  // Linode (Akamai) — 2026-08 provider expansion (Compose tier, scenario l1).
  // Registry parity with .env.e2e.example is pinned by
  // credential-key-convention.test.ts.
  {
    key: 'LINODE_API_TOKEN',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'token',
    shape: { minLen: 16, describe: 'at least 16 characters' },
    sample: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4',
    where: '.env.local',
    scope: 'provider:linode',
  },
  {
    key: 'LINODE_ACCESS_KEY',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'id',
    where: '.env.local',
    scope: 'provider:linode',
  },
  {
    key: 'LINODE_SECRET_KEY',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'token',
    shape: { minLen: 8, describe: 'at least 8 characters' },
    sample: 'linode-secret-key-sample',
    where: '.env.local',
    scope: 'provider:linode',
  },
  // Linode assigns one storage cluster per account/region, not always the
  // default one — optional pin when it differs (see .env.e2e.example).
  {
    key: 'LINODE_STORAGE_REGION',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'slug',
    optional: true,
    where: '.env.local',
    scope: 'provider:linode',
  },
  // Vultr — 2026-08 provider expansion (Compose tier, scenario v1). Its
  // STORAGE_REGION is the one object-storage region kept as an explicit
  // registry key, and deliberately so: Vultr mints storage keys per
  // subscription and a subscription lives in exactly one cluster, so the
  // cluster slug is required config that travels with the pair rather than
  // something resolveS3Region can infer from the compute region. Classified
  // operator-secret so it inherits the class's two guarantees — written
  // .env.local only, and stripped from any bundle baseline — keeping the
  // credential triple intact instead of splitting it across two files.
  {
    key: 'VULTR_API_TOKEN',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'token',
    shape: { minLen: 8, describe: 'at least 8 characters' },
    sample: 'vultr-api-token-sample',
    where: '.env.local',
    scope: 'provider:vultr',
  },
  {
    key: 'VULTR_ACCESS_KEY',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'id',
    where: '.env.local',
    scope: 'provider:vultr',
  },
  {
    key: 'VULTR_SECRET_KEY',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'token',
    shape: { minLen: 8, describe: 'at least 8 characters' },
    sample: 'vultr-secret-key-sample',
    where: '.env.local',
    scope: 'provider:vultr',
  },
  {
    key: 'VULTR_STORAGE_REGION',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'slug',
    where: '.env.local',
    scope: 'provider:vultr',
  },
  // Scaleway — 2026-08 provider expansion (Compose tier, scenario s1). A
  // credential TRIPLE, not a token: the Pulumi provider requires all three of
  // secret key / access key / project id (ScalewayProvider.buildIacEnv), and
  // the SAME key pair signs S3. SCALEWAY_STORAGE_REGION is a REGION override
  // (fr-par/nl-ams, not a zone) — usually derived by stripping the trailing
  // zone digit (scaleway-objectstorage.js zoneToS3Region); optional override
  // for parity with the sibling providers. The project id is a UUID and NOT a
  // secret, but is classified operator-secret anyway for the class's two
  // guarantees (written .env.local only, stripped from any bundle baseline),
  // keeping the triple in one file — same reasoning as VULTR_STORAGE_REGION.
  {
    key: 'SCALEWAY_SECRET_KEY',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'token',
    shape: { minLen: 8, describe: 'at least 8 characters' },
    sample: 'scaleway-secret-key-sample',
    where: '.env.local',
    scope: 'provider:scaleway',
  },
  {
    key: 'SCALEWAY_ACCESS_KEY',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'id',
    where: '.env.local',
    scope: 'provider:scaleway',
  },
  {
    key: 'SCALEWAY_DEFAULT_PROJECT_ID',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'id',
    where: '.env.local',
    scope: 'provider:scaleway',
  },
  {
    key: 'SCALEWAY_STORAGE_REGION',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'slug',
    optional: true,
    where: '.env.local',
    scope: 'provider:scaleway',
  },

  // ---- Registry: Docker Hub ----
  // Operator-shell-level only (OWNER-PINNED decision) — never written by
  // `configure` (its menu row is informational, run() returns {}), never
  // stored in .env/.env.local. Registered so deploy's credential-resolution
  // path (src/lib/deploy/docker-hub.js) and the operator-facing docs generator
  // both derive from this registry instead of a second hand-maintained note.
  // Optional pair: a run without them falls back to anonymous Docker Hub pulls.
  {
    key: 'DOCKER_HUB_USERNAME',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'id',
    optional: true,
    where: 'operator shell',
    scope: 'registry',
  },
  {
    key: 'DOCKER_HUB_TOKEN',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'token',
    optional: true,
    shape: {
      regex: /^dckr_pat_[A-Za-z0-9_-]+$/,
      describe: 'dckr_pat_… (Docker Hub personal access token)',
    },
    sample: 'dckr_pat_AbCdEf1234567890-xyz',
    where: 'operator shell',
    scope: 'registry',
  },

  // ---- State: Pulumi backend override ----
  // Opt-in backend override (src/lib/iac/index.js resolveBackendUrl) —
  // absent, the CLI computes its own S3 or local file:// backend. The regex
  // covers what Pulumi itself documents as valid backend URL schemes
  // (https://, s3://, azblob://, gs://, file://), not just Pulumi Cloud —
  // narrower than that would assert a format Pulumi doesn't actually require.
  {
    key: 'PULUMI_BACKEND_URL',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'url',
    optional: true,
    shape: {
      regex: /^[a-z][a-z0-9+.-]*:\/\/\S+$/,
      describe: 'a Pulumi backend URL (https://…, s3://…, file://…)',
    },
    sample: 's3://vibecarbon-state/pulumi',
    where: '.env.local',
    scope: 'state',
  },

  // ---- TLS: ACME CA override ----
  // Points at Let's Encrypt staging (or another ACME directory) instead of
  // production — e2e/dev envs avoiding LE's production rate limits (see
  // src/lib/deploy/staging-ca.js, src/lib/deploy/tls-ready.js). Absent, the
  // deploy templates default to the production LE directory.
  {
    key: 'ACME_CA_SERVER',
    class: 'operator-secret',
    feature: 'providers',
    kind: 'url',
    optional: true,
    shape: HTTPS_URL_SHAPE,
    sample: 'https://acme-v02.api.letsencrypt.org/directory',
    where: '.env.local',
    scope: 'tls',
  },

  // ---- Access: operator-CIDR firewall allowlist ----
  // `vibecarbon access` persists the allowlist to .vibecarbon.json, not to
  // an env file — this var is a CI/non-interactive bootstrap fallback
  // (src/lib/operator-ip.js ensureOperatorIpAccess) and the required-input
  // the Pulumi IaC programs accept when no persisted list exists yet
  // (src/lib/iac/programs/*). Not operator-secret: it never carries a
  // credential and `access` never writes it with setEnvVar's `localOnly`
  // option, so it ships in .env like any other runtime-config key.
  {
    key: 'ALLOWED_SSH_IPS',
    class: 'runtime-config',
    feature: 'access',
    kind: 'cidr-list',
    optional: true,
    shape: {
      regex: new RegExp(`^${IPV4_CIDR}(,\\s*${IPV4_CIDR})*$`),
      describe: 'comma-separated IPv4 CIDRs like 203.0.113.0/24',
    },
    sample: '203.0.113.0/24,198.51.100.5/32',
    where: '.env',
    scope: 'access',
  },
];

/** Keys of a given classification. @param {ConfigClass} cls */
function keysOfClass(cls) {
  return CONFIG_KEYS.filter((k) => k.class === cls).map((k) => k.key);
}

/** Secret runtime keys (Stripe/Paddle/Polar secrets, OAuth secrets, SMTP_PASS). */
export function featureSecretKeys() {
  return keysOfClass('runtime-secret');
}

/** Non-secret runtime keys (BILLING_PROVIDER, SMTP_HOST, GOOGLE_CLIENT_ID, …). */
export function featureConfigKeys() {
  return keysOfClass('runtime-config');
}

/** All runtime keys (secret + non-secret) — everything that must reach a pod/container at runtime. */
export function featureRuntimeKeys() {
  return [...featureConfigKeys(), ...featureSecretKeys()];
}

/** Client build-time keys (VITE_*) — a change must force an image rebuild. */
export function clientBuildKeys() {
  return keysOfClass('client-build');
}

/**
 * Operator/provider credential keys (Hetzner/DigitalOcean/Cloudflare/S3
 * tokens, Docker Hub, the Pulumi backend URL, the ACME CA override) — CLI-local
 * only, never propagated to a deployed server. Deliberately NOT included in
 * `featureRuntimeKeys()`/`clientBuildKeys()`.
 */
export function operatorSecretKeys() {
  return keysOfClass('operator-secret');
}

/**
 * Whether `key` is an operator/provider credential (see operatorSecretKeys()
 * above). Drives `configure`'s write loop: operator keys go to `.env.local`
 * only (`setEnvVar`'s `localOnly` option), never `.env`.
 * @param {string} key
 */
export function isOperatorKey(key) {
  return operatorSecretKeys().includes(key);
}

/** Whether `key` is a configure-managed secret. @param {string} key */
export function isSecretKey(key) {
  return CONFIG_KEYS.some(
    (k) => k.key === key && (k.class === 'runtime-secret' || k.class === 'operator-secret'),
  );
}

/**
 * Strip operator-secret `KEY=value` lines from raw dotenv file content.
 *
 * Defense-in-depth for the one place a project's raw `.env` file gets
 * forwarded toward a deployed server as a baseline — `renderBundle`
 * (deploy/bundle.js) reads the project's `.env` and echoes any line it
 * doesn't have an explicit override for verbatim into the staged bundle.
 * `setEnvVar`'s `localOnly` option keeps *new* operator-secret writes out of
 * `.env` going forward, but this catches whatever is already on disk (a
 * stale write from before that option existed, a hand edit) so it can never
 * ride that echo into a bundle.
 *
 * Deliberately does NOT touch programmatic `envOverrides` — renderBundle's
 * own explicit propagation of individual operator-secret-classified keys
 * (S3 storage/backup credentials via `options.s3`, the DNS-01 provider
 * token via `options.dnsToken`, an old server's
 * full env replayed via `options.envOverrides` during `scale`) is a
 * separate, deliberate, tested mechanism — those values arrive as explicit
 * function arguments, never by echoing this file, and callers rely on them
 * reaching the bundle (see tests/unit/deploy/bundle-env-overrides.test.ts).
 *
 * @param {string} content - raw dotenv file content
 * @returns {string}
 */
export function stripOperatorSecretLines(content) {
  const keys = new Set(operatorSecretKeys());
  return content
    .split('\n')
    .filter((line) => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
      return !(m && keys.has(m[1]));
    })
    .join('\n');
}

/** All keys belonging to a feature, in registry order. @param {string} feature */
export function featureKeys(feature) {
  return CONFIG_KEYS.filter((k) => k.feature === feature).map((k) => k.key);
}

/** The full registry entry for `key`, or undefined if it isn't registered. @param {string} key */
export function registryEntry(key) {
  return CONFIG_KEYS.find((k) => k.key === key);
}

/**
 * Entries whose `scope` is one of `scopes` (a Set or array), in registry order.
 * @param {Iterable<string>} scopes
 */
export function entriesForScopes(scopes) {
  const set = scopes instanceof Set ? scopes : new Set(scopes);
  return CONFIG_KEYS.filter((k) => set.has(k.scope));
}
