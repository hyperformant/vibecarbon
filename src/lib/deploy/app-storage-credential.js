/**
 * Each environment's app gets its own object-storage key where the provider
 * can scope one (security plan 2026-10-20, rulings R2, R4 and R9).
 *
 * The infra key (the deploy's `s3Config` pair) creates buckets, sets CORS,
 * runs the settle probes, backs the Pulumi state and is WAL-G's backup
 * credential. The app needs only Get/Put/Head/Delete/List on its own env
 * bucket. How close each provider gets to that is its S3 class's
 * `static appKeyScoping`:
 *
 *   - `mint` (Linode, DigitalOcean): the deploy mints a key limited to the
 *     env bucket over the provider API. Tier `isolated`.
 *   - `paste-fence` (Hetzner): keys are console-only. With an app key pasted
 *     by `vibecarbon configure storage <env>`, the deploy fences it out of
 *     every other vibecarbon bucket (hetzner-app-key-fence.js). Tier
 *     `fenced`; without one, `shared`.
 *   - `none` (Scaleway, Vultr): the app holds the infra key. Tier `shared`.
 *
 * Lifecycle (R9): a minted key is recorded as `envConfig.s3.appKey =
 * { id, scoping, tier, bucket }` with no secret; the secret pair lives in the
 * project's `.env.local` under per-environment names (appStorageSecretKeys),
 * written through setEnvVar, so formatDotenvLine, and never shipped. A
 * redeploy reuses the key while its secret is here and the provider still
 * lists it. Otherwise it mints one new key and records it, with the old id
 * under `retiring`: a state reconcile, not a retry. The old key is revoked
 * only once the deploy succeeds (finishAppKeyRotation), so a failed deploy
 * never leaves the running app on a dead key. Every destroy revokes them all.
 *
 * Hetzner pasted keys cannot be revoked by the CLI. One that is replaced or
 * whose env is destroyed moves to `projectConfig.retiredAppKeys` (ids only)
 * and stays denied in every fence until the operator deletes it in the
 * console and runs `vibecarbon configure storage -forget <id>`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDotenv } from '../dotenv.js';
import { APP_STORAGE_SECRET_PREFIX, setEnvVar } from '../project.js';
import { getProviderClass, resolveProviderToken } from '../providers/index.js';
import { applyHetznerFences, fenceTargets } from './hetzner-app-key-fence.js';

export { APP_STORAGE_SECRET_PREFIX };

/**
 * The `.env.local` names of one environment's app key pair. Env names are
 * `[a-z][a-z0-9-]*`, so upper-casing and `-` to `_` never maps two envs to
 * one name.
 * @param {string} environment
 * @returns {{ accessKey: string, secretKey: string }}
 */
export function appStorageSecretKeys(environment) {
  const suffix = environment.toUpperCase().replaceAll('-', '_');
  return {
    accessKey: `${APP_STORAGE_SECRET_PREFIX}ACCESS_KEY_${suffix}`,
    secretKey: `${APP_STORAGE_SECRET_PREFIX}SECRET_KEY_${suffix}`,
  };
}

/** True for a per-environment app-key secret name. */
export function isAppStorageSecretKey(key) {
  return key.startsWith(APP_STORAGE_SECRET_PREFIX);
}

/**
 * The project's `.env.local` as the per-environment app-key store. Writes go
 * through setEnvVar's localOnly path, so formatDotenvLine, and never reach
 * `.env` (the server bundle's baseline).
 * @param {string} [cwd]
 * @returns {{ get(key: string): string|undefined, set(key: string, value: string): void }}
 */
export function localAppStorageSecrets(cwd = process.cwd()) {
  return {
    get(key) {
      const path = join(cwd, '.env.local');
      if (!existsSync(path)) return undefined;
      return parseDotenv(readFileSync(path, 'utf-8'))[key] || undefined;
    },
    set(key, value) {
      setEnvVar(key, value, cwd, { localOnly: true });
    },
  };
}

/**
 * Why a `none` provider's app shares the infra key (R2).
 * @type {Record<string, string>}
 */
const SHARED_CAUSE = {
  scaleway: 'a one-bucket key needs org-wide IAM write on the deploy key',
  vultr: 'one key pair per subscription, no per-bucket keys',
};

/**
 * The provider's S3 class and its declared scoping. A class without a
 * declaration is a bug the census catches; here it fails loudly.
 * @param {string} provider
 */
async function scopingOf(provider) {
  const S3Class = await getProviderClass(provider).getObjectStorageProviderClass();
  const scoping = Object.hasOwn(S3Class, 'appKeyScoping') ? S3Class.appKeyScoping : undefined;
  if (!['mint', 'paste-fence', 'none'].includes(scoping)) {
    throw new Error(`${S3Class.name} declares no appKeyScoping, so its app key tier is unknown`);
  }
  return { S3Class, scoping };
}

/**
 * The tier and reason for an environment, from what is recorded. No network,
 * so `status` can show it.
 * @param {{ provider: string, scoping: 'mint'|'paste-fence'|'none', envConfig?: object }} args
 * @returns {{ tier: 'isolated'|'fenced'|'shared', reason: string }}
 */
export function describeAppStorageAccess({ provider, scoping, envConfig }) {
  const record = envConfig?.s3?.appKey;
  const bucket = record?.bucket ?? envConfig?.s3?.bucket;
  if (scoping === 'mint') {
    return record?.scoping === 'mint'
      ? { tier: 'isolated', reason: `${provider}: key limited to bucket ${bucket}` }
      : { tier: 'shared', reason: `${provider}: no app key yet, the next deploy mints one` };
  }
  if (scoping === 'paste-fence') {
    return record?.scoping === 'paste-fence'
      ? {
          tier: 'fenced',
          reason: `${provider}: pasted key denied on every other vibecarbon bucket`,
        }
      : { tier: 'shared', reason: `${provider}: no app key pasted` };
  }
  return {
    tier: 'shared',
    reason: `${provider}: ${SHARED_CAUSE[provider] ?? 'the provider cannot scope a key to one bucket'}`,
  };
}

/**
 * The `status` row: `storage access: <tier> (<reason>)`.
 * @param {{ provider?: string, s3?: object }} envConfig
 * @param {string} provider
 * @returns {Promise<string|null>} null for an env with no bucket
 */
export async function storageAccessLine(envConfig, provider) {
  if (!envConfig?.s3?.bucket) return null;
  const { scoping } = await scopingOf(provider);
  const { tier, reason } = describeAppStorageAccess({ provider, scoping, envConfig });
  return `storage access: ${tier} (${reason})`;
}

/**
 * Resolve, or mint, the environment's app storage credential (R9).
 *
 * @param {object} args
 * @param {string} args.provider - provider id
 * @param {string} args.environment
 * @param {object} args.envConfig - the env's persisted config (its `s3.appKey` record)
 * @param {object} [args.projectConfig]
 * @param {string} args.bucket - the env app bucket, from resolveEnvStorage
 * @param {{ accessKey: string, secretKey: string, endpoint: string }} args.infraCredential
 * @param {{ get(key: string): string|undefined, set(key: string, value: string): void }} args.secrets
 * @param {string|null} [args.apiToken] - the provider API token (mint only)
 * @returns {Promise<{ accessKey: string, secretKey: string, tier: 'isolated'|'fenced'|'shared', reason: string, record: { id: string, scoping: string, tier: string, bucket?: string, retiring?: string[] } | null, scoping: 'mint'|'paste-fence'|'none', retire: string|null }>}
 *   `record.bucket` (mint only) is the bucket the key is limited to; `retiring`
 *   lists replaced minted keys still to revoke after the deploy succeeds;
 *   `retire` is a replaced pasted key id to keep denied (retiredAppKeys).
 */
export async function resolveAppStorageCredential({
  provider,
  environment,
  envConfig,
  bucket,
  infraCredential,
  secrets,
  apiToken,
}) {
  const { S3Class, scoping } = await scopingOf(provider);
  const names = appStorageSecretKeys(environment);
  const shared = () => ({
    accessKey: infraCredential.accessKey,
    secretKey: infraCredential.secretKey,
    ...describeAppStorageAccess({ provider, scoping, envConfig: {} }),
    record: null,
    scoping,
    retire: null,
  });

  if (scoping === 'none') return shared();

  if (scoping === 'paste-fence') {
    const accessKey = secrets.get(names.accessKey);
    const secretKey = secrets.get(names.secretKey);
    const prior = envConfig?.s3?.appKey?.scoping === 'paste-fence' ? envConfig.s3.appKey : null;
    if (!accessKey || !secretKey) {
      // Never a silent downgrade: an env that was fenced stays fenced, or the
      // deploy stops, rather than hand its app the account-wide key.
      if (prior) {
        throw new Error(
          `${environment} is fenced with pasted app storage key ${prior.id}, but that key is not stored on this machine. Paste it (or a replacement) with \`vibecarbon configure storage ${environment}\` and deploy again.`,
        );
      }
      return shared();
    }
    if (accessKey === infraCredential.accessKey) {
      throw new Error(
        `the app storage key pasted for ${environment} is the deploy's own key, so fencing it would lock the deploy out. Make a second key in the console and paste it with \`vibecarbon configure storage ${environment}\`.`,
      );
    }
    const record = { id: accessKey, scoping, tier: 'fenced' };
    return {
      accessKey,
      secretKey,
      ...describeAppStorageAccess({ provider, scoping, envConfig: { s3: { appKey: record } } }),
      record,
      scoping,
      // A replaced pasted key stays denied in every fence until the operator
      // forgets it (retiredAppKeys, `configure storage -forget <id>`).
      retire: prior && prior.id !== accessKey ? prior.id : null,
    };
  }

  // mint
  const token = apiToken ?? resolveProviderToken(provider);
  if (!token) {
    throw new Error(
      `no ${provider} API token, so the app storage key for ${environment} cannot be minted. The app never falls back to the account-wide key.`,
    );
  }
  const prior = envConfig?.s3?.appKey?.scoping === 'mint' ? envConfig.s3.appKey : null;
  const storedAccess = secrets.get(names.accessKey);
  const storedSecret = secrets.get(names.secretKey);
  const reusable =
    prior &&
    prior.bucket === bucket &&
    storedAccess &&
    storedSecret &&
    (await S3Class.appKeyExists(prior.id, { apiToken: token }));
  let accessKey = storedAccess;
  let secretKey = storedSecret;
  let record = prior;
  if (!reusable) {
    const minted = await S3Class.mintAppKey(bucket, {
      endpoint: infraCredential.endpoint,
      apiToken: token,
    });
    secrets.set(names.accessKey, minted.accessKey);
    secrets.set(names.secretKey, minted.secretKey);
    accessKey = minted.accessKey;
    secretKey = minted.secretKey;
    // The old key is NOT revoked here: the running app still uses it until
    // the new one is rolled out. It is recorded as `retiring` and revoked
    // only once the deploy succeeds (finishAppKeyRotation); a failed deploy
    // leaves it working, and destroy revokes it with the rest.
    const retiring = [
      ...(prior?.retiring ?? []),
      ...(prior && prior.id !== minted.id ? [prior.id] : []),
    ];
    record = {
      id: minted.id,
      scoping,
      tier: 'isolated',
      bucket,
      ...(retiring.length > 0 && { retiring }),
    };
  }
  return {
    accessKey,
    secretKey,
    ...describeAppStorageAccess({ provider, scoping, envConfig: { s3: { appKey: record } } }),
    record,
    scoping,
    retire: null,
  };
}

/**
 * Revoke the keys a re-mint replaced (`record.retiring`), once the deploy
 * that rolled out the new key has succeeded. A key that cannot be revoked
 * stays in `retiring` (so the next deploy or destroy tries again) and is
 * reported as one warn line.
 *
 * @param {{ provider: string, record: object|null, apiToken?: string|null, log?: { warn: (m: string) => void } }} args
 * @returns {Promise<object|null>} the record with what is still retiring
 */
export async function finishAppKeyRotation({ provider, record, apiToken, log = { warn() {} } }) {
  if (!record?.retiring?.length) return record;
  const { S3Class } = await scopingOf(provider);
  const token = apiToken ?? resolveProviderToken(provider);
  const left = [];
  for (const id of record.retiring) {
    try {
      if (!token) throw new Error(`no ${provider} API token`);
      await S3Class.revokeAppKey(id, { apiToken: token });
    } catch (err) {
      left.push(id);
      log.warn(
        `the replaced app storage key ${id} was not revoked (${err.message}); the next deploy or destroy tries again, or delete it in the ${provider} console`,
      );
    }
  }
  const { retiring: _done, ...rest } = record;
  return left.length > 0 ? { ...rest, retiring: left } : rest;
}

/**
 * Revoke the environment's minted app key on destroy (R9). Plain destroy and
 * `-purge` both call this: no server uses the key once the servers are gone,
 * and a redeploy mints a fresh one.
 *
 * @param {{ provider: string, envConfig: object, apiToken?: string|null }} args
 * @returns {Promise<{ revoked: boolean, leak?: string }>} `revoked` is false
 *   when there was no minted key; `leak` names one that could not be revoked
 */
export async function revokeAppStorageCredential({ provider, envConfig, apiToken }) {
  const record = envConfig?.s3?.appKey;
  if (record?.scoping !== 'mint' || !record.id) return { revoked: false };
  const { S3Class } = await scopingOf(provider);
  const token = apiToken ?? resolveProviderToken(provider);
  const ids = [record.id, ...(record.retiring ?? [])];
  if (!token) {
    return { revoked: false, leak: `app storage key ${ids.join(', ')}: no ${provider} API token` };
  }
  const failed = [];
  for (const id of ids) {
    try {
      await S3Class.revokeAppKey(id, { apiToken: token });
    } catch (err) {
      failed.push(`app storage key ${id}: ${err.message}`);
    }
  }
  return failed.length === 0 ? { revoked: true } : { revoked: false, leak: failed.join('; ') };
}

/**
 * The pair the app holds today, from what is recorded and stored here, with
 * no network and no mint. GitOps seeds this into the env's GitHub
 * Environment, so the app pod gets the same key the CLI deploy rendered.
 *
 * @param {{ provider: string, environment: string, envConfig: object, infraCredential: { accessKey: string, secretKey: string }, secrets: { get(key: string): string|undefined } }} args
 * @returns {Promise<{ accessKey: string, secretKey: string }>}
 */
export async function storedAppStoragePair({
  provider,
  environment,
  envConfig,
  infraCredential,
  secrets,
}) {
  const { scoping } = await scopingOf(provider);
  const record = envConfig?.s3?.appKey;
  const names = appStorageSecretKeys(environment);
  if (scoping !== 'none' && record) {
    const accessKey = secrets.get(names.accessKey);
    const secretKey = secrets.get(names.secretKey);
    if (!accessKey || !secretKey) {
      throw new Error(
        `the app storage key for ${environment} is not stored on this machine, so GitOps would hand the app the account-wide key. Run \`vibecarbon deploy ${environment}\` here first; it mints or picks up the key.`,
      );
    }
    return { accessKey, secretKey };
  }
  if (scoping === 'mint') {
    throw new Error(
      `${environment} has no app storage key yet. Run \`vibecarbon deploy ${environment}\` first; it mints one limited to the env bucket.`,
    );
  }
  return { accessKey: infraCredential.accessKey, secretKey: infraCredential.secretKey };
}

/**
 * Record, on every env that references one, the buckets the last fence sync
 * had to skip (absent, and no env finished a deploy into them), and clear
 * the record everywhere else. Mutates and returns `projectConfig`.
 * @param {object} projectConfig
 * @param {string[]} skipped
 */
export function markUnfencedBuckets(projectConfig, skipped) {
  const missing = new Set(skipped);
  for (const e of Object.values(projectConfig.environments ?? {})) {
    if (!e?.s3) continue;
    const hits = [e.s3.bucket, e.s3.stateBucket, e.backupS3?.bucket].filter(
      (b, i, all) => b && missing.has(b) && all.indexOf(b) === i,
    );
    if (hits.length > 0) e.s3.unfencedBuckets = hits;
    else delete e.s3.unfencedBuckets;
  }
  return projectConfig;
}

/**
 * The `status` row for an env with buckets its app-key fence could not
 * cover, or null.
 * @param {{ s3?: { unfencedBuckets?: string[] } }} envConfig
 * @returns {string|null}
 */
export function unfencedBucketsLine(envConfig) {
  const list = envConfig?.s3?.unfencedBuckets;
  if (!Array.isArray(list) || list.length === 0) return null;
  return `storage fence: not set on ${list.join(', ')} (the bucket did not exist at the last fence sync; deploy again to fence it)`;
}

/** How long a new app key gets to start answering HeadBucket (R9: 5 to 10 s seen). */
export const APP_KEY_READY_BUDGET_MS = 60_000;
export const APP_KEY_READY_INTERVAL_MS = 2_000;

/**
 * Wait until the app key can HeadBucket its bucket, inside a fixed budget. A
 * readiness gate for a key the provider has just made, run inside the
 * concurrent storage-finalize task, never as a serial step before IaC.
 *
 * @param {{ createAppProvider: () => Promise<{ canHeadBucket(b: string): Promise<boolean> }>, bucket: string, sleep?: (ms: number) => Promise<void>, now?: () => number }} args
 * @returns {Promise<void>}
 */
export async function waitForAppKeyReady({
  createAppProvider,
  bucket,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}) {
  const app = await createAppProvider();
  const deadline = now() + APP_KEY_READY_BUDGET_MS;
  while (!(await app.canHeadBucket(bucket))) {
    if (now() + APP_KEY_READY_INTERVAL_MS > deadline) {
      throw new Error(
        `the app storage key cannot reach bucket ${bucket} after ${APP_KEY_READY_BUDGET_MS / 1000} s, so the app could not use its storage. Check the key in the provider console and deploy again.`,
      );
    }
    await sleep(APP_KEY_READY_INTERVAL_MS);
  }
}

/**
 * Bring every Hetzner fence in the project up to date for `environment`
 * (deploy) or for its removal (`leaving: true`, destroy), and verify each
 * written fence with every pasted key stored on this machine.
 *
 * @param {object} args
 * @param {object} args.projectConfig - with the env's current `s3.appKey` record
 * @param {string} args.environment
 * @param {boolean} [args.leaving]
 * @param {object} args.s3 - the infra key's HetznerS3Provider
 * @param {{ get(key: string): string|undefined }} args.secrets
 * @param {(accessKey: string, secretKey: string) => Promise<{ isDeniedOn(b: string): Promise<boolean> }>} args.createProbe
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @param {() => number} [args.now]
 */
export async function syncHetznerFences({
  projectConfig,
  environment,
  leaving = false,
  s3,
  secrets,
  createProbe,
  sleep,
  now,
}) {
  const targets = fenceTargets({ projectConfig, environment, leaving });
  const probes = {};
  for (const [name, e] of Object.entries(projectConfig.environments ?? {})) {
    if (leaving && name === environment) continue;
    if (e?.s3?.appKey?.scoping !== 'paste-fence') continue;
    const names = appStorageSecretKeys(name);
    const accessKey = secrets.get(names.accessKey);
    const secretKey = secrets.get(names.secretKey);
    if (accessKey === e.s3.appKey.id && secretKey) {
      probes[accessKey] = await createProbe(accessKey, secretKey);
    }
  }
  const ownerId = await s3.ownerId();
  return applyHetznerFences({ s3, ownerId, targets, probes, sleep, now });
}
