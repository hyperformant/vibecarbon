/**
 * Single source of truth for the env keys that `vibecarbon configure` manages.
 *
 * `configure` writes feature config/secrets to `.env.local`/`.env`. Several
 * deploy paths each need to know *which* keys to propagate and *how* to treat
 * each one (build-time vs runtime, secret vs non-secret). Historically each
 * path carried its own hand-maintained list, so a key added to one feature
 * silently failed to reach the cloud on another path. This registry is the one
 * list they all derive from; coverage tests assert registry ⊆ each path.
 *
 * Scope: feature keys (billing, OAuth, SMTP, analytics) plus operator/provider
 * credentials (Hetzner/DigitalOcean/Cloudflare/S3 tokens). Infra secrets
 * (DB_PASSWORD/JWT_SECRET/ANON_KEY/…) are *generated*, not configured, and
 * carry k8s-specific Supabase-chart translation logic — they stay local to the
 * k8s deploy modules.
 *
 * Classification:
 *   - 'client-build'    → baked into the client bundle at image build time
 *                         (VITE_*). A change must force an image rebuild.
 *   - 'runtime-config'  → non-secret server/auth runtime env.
 *   - 'runtime-secret'  → secret server/auth runtime env.
 *   - 'operator-secret' → cloud/DNS provider credentials the CLI uses locally
 *                         (Pulumi, S3 state backend, DNS API calls). Never a
 *                         pod/container env var — `featureRuntimeKeys()` and
 *                         `clientBuildKeys()` exclude this class by
 *                         construction (they only ever list the other three),
 *                         so nothing here can leak into deploy propagation.
 *
 * Keep this aligned with what `configure` writes (src/configure.js) and what
 * the app/auth services read (carbon/src/server/lib/env.ts + the GoTrue
 * `auth` service wiring in carbon/docker-compose.yml). Dependency-free on
 * purpose so deploy code can import it without pulling in @clack/prompts.
 */

/**
 * @typedef {'client-build' | 'runtime-config' | 'runtime-secret' | 'operator-secret'} ConfigClass
 * @typedef {{ key: string, class: ConfigClass, feature: string }} ConfigKey
 */

/** @type {ConfigKey[]} */
export const CONFIG_KEYS = [
  // ---- Billing: provider selection ----
  { key: 'BILLING_PROVIDER', class: 'runtime-config', feature: 'billing' },

  // ---- Billing: Stripe ----
  { key: 'STRIPE_SECRET_KEY', class: 'runtime-secret', feature: 'billing' },
  { key: 'STRIPE_WEBHOOK_SECRET', class: 'runtime-secret', feature: 'billing' },
  { key: 'STRIPE_PRICE_STARTER', class: 'runtime-config', feature: 'billing' },
  { key: 'STRIPE_PRICE_PRO', class: 'runtime-config', feature: 'billing' },

  // ---- Billing: Paddle ----
  { key: 'PADDLE_API_KEY', class: 'runtime-secret', feature: 'billing' },
  { key: 'PADDLE_WEBHOOK_SECRET', class: 'runtime-secret', feature: 'billing' },
  { key: 'PADDLE_ENVIRONMENT', class: 'runtime-config', feature: 'billing' },
  { key: 'PADDLE_PRICE_STARTER', class: 'runtime-config', feature: 'billing' },
  { key: 'PADDLE_PRICE_PRO', class: 'runtime-config', feature: 'billing' },

  // ---- Billing: Polar ----
  { key: 'POLAR_ACCESS_TOKEN', class: 'runtime-secret', feature: 'billing' },
  { key: 'POLAR_WEBHOOK_SECRET', class: 'runtime-secret', feature: 'billing' },
  { key: 'POLAR_ORGANIZATION_ID', class: 'runtime-config', feature: 'billing' },
  { key: 'POLAR_PRICE_STARTER', class: 'runtime-config', feature: 'billing' },
  { key: 'POLAR_PRICE_PRO', class: 'runtime-config', feature: 'billing' },

  // ---- OAuth: Google (consumed by the GoTrue auth service) ----
  { key: 'GOOGLE_ENABLED', class: 'runtime-config', feature: 'oauth' },
  { key: 'GOOGLE_CLIENT_ID', class: 'runtime-config', feature: 'oauth' },
  { key: 'GOOGLE_CLIENT_SECRET', class: 'runtime-secret', feature: 'oauth' },

  // ---- OAuth: Microsoft ----
  { key: 'MICROSOFT_ENABLED', class: 'runtime-config', feature: 'oauth' },
  { key: 'MICROSOFT_CLIENT_ID', class: 'runtime-config', feature: 'oauth' },
  { key: 'MICROSOFT_CLIENT_SECRET', class: 'runtime-secret', feature: 'oauth' },
  { key: 'MICROSOFT_TENANT_ID', class: 'runtime-config', feature: 'oauth' },

  // ---- SMTP / Email (shared by the app and the auth service) ----
  // Canonical name is SMTP_PASS everywhere (app env.ts, compose, manifests).
  { key: 'SMTP_HOST', class: 'runtime-config', feature: 'smtp' },
  { key: 'SMTP_PORT', class: 'runtime-config', feature: 'smtp' },
  { key: 'SMTP_USER', class: 'runtime-config', feature: 'smtp' },
  { key: 'SMTP_PASS', class: 'runtime-secret', feature: 'smtp' },
  { key: 'SMTP_ADMIN_EMAIL', class: 'runtime-config', feature: 'smtp' },
  { key: 'SMTP_SENDER_NAME', class: 'runtime-config', feature: 'smtp' },
  // Carries GoTrue's value directly (true = SKIP the confirmation email —
  // compose env interpolation cannot negate, so no friendlier inverted
  // name). The configure SMTP wizard writes it; deploy templates default
  // to true because a false without working SMTP 500s every signup.
  { key: 'GOTRUE_MAILER_AUTOCONFIRM', class: 'runtime-config', feature: 'smtp' },

  // ---- Analytics (client-side, baked at build time) ----
  { key: 'VITE_PLAUSIBLE_DOMAIN', class: 'client-build', feature: 'analytics' },
  { key: 'VITE_PLAUSIBLE_SCRIPT_URL', class: 'client-build', feature: 'analytics' },

  // ---- Landing (client-side, baked at build time) ----
  // Opt-in gate for the GitHub stars button. Empty (the generated-app
  // default) = the button renders nothing and NOTHING is fetched — a
  // customer's site must not phone home to GitHub (nav-no-phone-home
  // contract). vibecarbon.com sets its public repo URL.
  { key: 'VITE_GITHUB_REPO_URL', class: 'client-build', feature: 'landing' },

  // ---- Providers: cloud/DNS operator credentials ----
  // Never deployed to a server (see the 'operator-secret' class note above).
  // NOT included: DOCKER_HUB_* — operator-shell-level env var, outside the
  // per-project store entirely (owner decision).
  //
  // Object-storage credentials follow ONE convention: <PROVIDER>_ACCESS_KEY /
  // <PROVIDER>_SECRET_KEY / <PROVIDER>_STORAGE_REGION, keyed off the same
  // <PROVIDER> prefix as <PROVIDER>_API_TOKEN. This is the OPERATOR-facing name
  // the CLI reads (Provider.OBJECT_STORAGE_ENV) — distinct from the deployed
  // stack's provider-agnostic server-side S3_* namespace (renderBundle /
  // vibecarbon-secrets → AWS_* for wal-g), which is NOT a configure-managed key
  // and stays S3_*. Scaleway keeps OPERATOR-facing SCALEWAY_* names like every
  // other provider; the tool-imposed SCW_* spelling the Pulumi plugin demands
  // exists only inside ScalewayProvider.buildIacEnv. (An earlier note here
  // predicted the opposite — that Scaleway would carry no SCALEWAY_-prefixed
  // registry entries. The buildIacEnv credential seam made that unnecessary:
  // the operator never types SCW_.)
  { key: 'HETZNER_API_TOKEN', class: 'operator-secret', feature: 'providers' },
  { key: 'HETZNER_ACCESS_KEY', class: 'operator-secret', feature: 'providers' },
  { key: 'HETZNER_SECRET_KEY', class: 'operator-secret', feature: 'providers' },
  { key: 'DIGITALOCEAN_API_TOKEN', class: 'operator-secret', feature: 'providers' },
  { key: 'DIGITALOCEAN_ACCESS_KEY', class: 'operator-secret', feature: 'providers' },
  { key: 'DIGITALOCEAN_SECRET_KEY', class: 'operator-secret', feature: 'providers' },
  // Dedicated-project id for ensureProjectAssignment (persisted by
  // runProjectAssignment on first find-or-create). Registered like
  // SCALEWAY_DEFAULT_PROJECT_ID: an id, not a credential, but it rides the
  // operator .env.local store and the same registry-driven handling.
  { key: 'DIGITALOCEAN_PROJECT_ID', class: 'operator-secret', feature: 'providers' },
  { key: 'CLOUDFLARE_API_TOKEN', class: 'operator-secret', feature: 'providers' },
  // Linode (Akamai) — 2026-08 provider expansion (Compose tier, scenario l1).
  // Registry parity with .env.e2e.example is pinned by
  // credential-key-convention.test.ts.
  { key: 'LINODE_API_TOKEN', class: 'operator-secret', feature: 'providers' },
  { key: 'LINODE_ACCESS_KEY', class: 'operator-secret', feature: 'providers' },
  { key: 'LINODE_SECRET_KEY', class: 'operator-secret', feature: 'providers' },
  { key: 'LINODE_STORAGE_REGION', class: 'operator-secret', feature: 'providers' },
  // Vultr — 2026-08 provider expansion (Compose tier, scenario v1). Its
  // STORAGE_REGION is the one object-storage region kept as an explicit
  // registry key, and deliberately so: Vultr mints storage keys per
  // subscription and a subscription lives in exactly one cluster, so the
  // cluster slug is required config that travels with the pair rather than
  // something resolveS3Region can infer from the compute region. Classified
  // operator-secret so it inherits the class's two guarantees — written
  // .env.local only, and stripped from any bundle baseline — keeping the
  // credential triple intact instead of splitting it across two files.
  { key: 'VULTR_API_TOKEN', class: 'operator-secret', feature: 'providers' },
  { key: 'VULTR_ACCESS_KEY', class: 'operator-secret', feature: 'providers' },
  { key: 'VULTR_SECRET_KEY', class: 'operator-secret', feature: 'providers' },
  { key: 'VULTR_STORAGE_REGION', class: 'operator-secret', feature: 'providers' },
  // Scaleway — 2026-08 provider expansion (Compose tier, scenario s1). A
  // credential TRIPLE, not a token: the Pulumi provider requires all three of
  // secret key / access key / project id (ScalewayProvider.buildIacEnv), and
  // the SAME key pair signs S3 — there are no separate object-storage keys,
  // which is why Scaleway has no *_STORAGE_REGION row. The project id is a
  // UUID and NOT a secret, but is classified operator-secret anyway for the
  // class's two guarantees (written .env.local only, stripped from any bundle
  // baseline), keeping the triple in one file — same reasoning as
  // VULTR_STORAGE_REGION above.
  { key: 'SCALEWAY_SECRET_KEY', class: 'operator-secret', feature: 'providers' },
  { key: 'SCALEWAY_ACCESS_KEY', class: 'operator-secret', feature: 'providers' },
  { key: 'SCALEWAY_DEFAULT_PROJECT_ID', class: 'operator-secret', feature: 'providers' },
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
 * tokens) — CLI-local only, never propagated to a deployed server. Deliberately
 * NOT included in `featureRuntimeKeys()`/`clientBuildKeys()`.
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
