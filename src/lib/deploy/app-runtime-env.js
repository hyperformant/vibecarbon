/**
 * The app's runtime env: the one allowlist of keys the app container (compose)
 * or pod (k8s) receives, shared by both (security plan 2026-10-20, ruling R1).
 *
 * The server holds more than the app needs: the compose `.env` is also the
 * `${VAR}` substitution source for Traefik's DNS token, the db superuser
 * password, the replication and add-on role passwords, WAL-G's folder
 * (VC_ENV) and so on. The app reads none of those, so it gets only:
 *   - APP_RUNTIME_KEYS, taken from the server env when set and non-empty;
 *   - the explicit extras (APP_RUNTIME_EXTRA_KEYS): its object-storage keys,
 *     from the appStorageCredential seam, and on k8s the REDIS_URL the deploy
 *     builds (compose's redis overlay sets REDIS_URL in `environment:`).
 *
 * compose: renderBundle writes the result to `app.env`, and the prod overlay
 * points the app at it (`env_file: !override [app.env]`). k8s: it is the
 * `vibecarbon-app-secrets` Secret the app Deployment's envFrom reads.
 *
 * Census-guarded by tests/unit/deploy/app-runtime-env-census.test.ts: every
 * key the app reads is delivered, and no cloud, DNS or infra credential is.
 */
import { featureConfigKeys, featureSecretKeys } from '../config-registry.js';

/**
 * App keys that are not configure-managed: the auth secret and admin
 * bootstrap, the public origin, a few app settings, the add-on flags the
 * admin Services page reads, and the Plausible pair the CSP derives from.
 * DB_* are absent on purpose: compose's `environment:` block and the k8s
 * Deployment's `env:` set the connection explicitly. APP_DB_PASSWORD is the
 * password of the app's own role, app_service (security plan R8): on k8s the
 * app container's DB_PASSWORD reads it from the app Secret by key. The
 * owner's password (POSTGRES_PASSWORD / DB_PASSWORD) is never an app key.
 */
const CORE_APP_KEYS = [
  'BETTER_AUTH_SECRET',
  'APP_DB_PASSWORD',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
  'SITE_URL',
  'CORS_ORIGINS',
  'MAGIC_LINK_ENABLED',
  'TRUSTED_PROXY_HOPS',
  'FULLERENE_PRICE_ID',
  'PROJECT_NAME',
  'REDIS_ENABLED',
  'N8N_ENABLED',
  'METABASE_ENABLED',
  'OBSERVABILITY_ENABLED',
  'VITE_PLAUSIBLE_DOMAIN',
  'VITE_PLAUSIBLE_SCRIPT_URL',
];

/** Every key the app may receive from the server env. */
export const APP_RUNTIME_KEYS = Object.freeze([
  ...new Set([...CORE_APP_KEYS, ...featureSecretKeys(), ...featureConfigKeys()]),
]);

/** The app's object-storage keys: what appStorageCredential hands over. */
const APP_STORAGE_KEYS = [
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_REGION',
];

/** Keys the caller passes explicitly, never read from the server env. */
export const APP_RUNTIME_EXTRA_KEYS = Object.freeze([...APP_STORAGE_KEYS, 'REDIS_URL']);

/**
 * The app's runtime env: the allowlisted keys of `serverEnv` plus `extras`.
 * Empty values are dropped (the app treats "" as unset anyway). An extra that
 * is not an APP_RUNTIME_EXTRA_KEYS entry throws: the extras are the one door
 * past the allowlist, so they stay named.
 * @param {Record<string, string>} serverEnv
 * @param {Record<string, string>} [extras]
 * @returns {Record<string, string>}
 */
export function buildAppRuntimeEnv(serverEnv, extras = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of APP_RUNTIME_KEYS) {
    if (serverEnv[key]) out[key] = serverEnv[key];
  }
  for (const [key, value] of Object.entries(extras)) {
    if (!APP_RUNTIME_EXTRA_KEYS.includes(key)) {
      throw new Error(`${key} is not an app runtime extra, so it cannot reach the app`);
    }
    if (value) out[key] = value;
  }
  return out;
}

/**
 * The app's object-storage env (S3_*): the single hand-off point between the
 * storage setup and the app, on compose and k8s alike.
 *
 * Today it hands the app the same pair the infra uses (the deploy's
 * `s3Config`). Without an `s3Config` (a scale replay), it carries forward the
 * pair the app had: the old server's `app.env`, or its `.env` on a server
 * deployed before `app.env` existed.
 *
 * @param {{
 *   s3Config?: {accessKey: string, secretKey: string, bucket: string, endpoint: string, region: string} | null,
 *   previousAppEnv?: Record<string, string> | null,
 * }} [source]
 * @returns {Record<string, string>}
 */
export function appStorageCredential({ s3Config, previousAppEnv } = {}) {
  if (s3Config) {
    return {
      S3_ACCESS_KEY: s3Config.accessKey,
      S3_SECRET_KEY: s3Config.secretKey,
      S3_BUCKET: s3Config.bucket,
      S3_ENDPOINT: s3Config.endpoint,
      S3_REGION: s3Config.region,
    };
  }
  /** @type {Record<string, string>} */
  const carried = {};
  for (const key of APP_STORAGE_KEYS) {
    if (previousAppEnv?.[key]) carried[key] = previousAppEnv[key];
  }
  return carried;
}
