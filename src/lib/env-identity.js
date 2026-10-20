/**
 * The IDENTITY of an environment: the `.vibecarbon.json` fields that say what
 * it is — placement, domain, DNS backend, its app and backup buckets, server
 * sizing — as opposed to what currently exists (servers, the state bucket,
 * deploy state, HA topology).
 *
 * `destroy` records this block under `destroyedEnvironments.<env>` after it
 * removes the live entry, and `deploy` reads it back when asked to deploy an
 * environment of that name that no longer exists, so a destroy → deploy of
 * the same environment (a region or server-type move, a rebuild) starts from
 * the settings it had instead of a hand-typed block (region-move runbook,
 * 2026-09-15). deploy clears the record once the environment is live again.
 *
 * Why a sibling key and not a `status: "destroyed"` stub inside
 * `environments`: access, console, status, configure and the operator-IP
 * refresh all treat presence in `environments` as "a deployed environment"
 * (console picks the first key; operator-ip's `envDeployed` is a bare
 * presence check). A stub there would need every one of them taught to skip
 * it; a sibling key is invisible to all of them by construction.
 */

/** Fields that survive a destroy. Everything else is runtime state. */
export const ENV_IDENTITY_FIELDS = Object.freeze([
  'provider',
  'envName',
  'deployMode',
  'domain',
  'dnsProvider',
  'dns',
  // Plain destroy keeps the env's app bucket and its uploads, so the seed
  // names it (and any pin): a redeploy lands on the same bucket. Only the
  // ENV_IDENTITY_S3_FIELDS subset is kept; see envIdentityOf.
  's3',
  'backupS3',
  'backup',
  'region',
  'secondaryRegion',
  'serverType',
  'masterServerType',
  'dbServerType',
  'workerServerType',
]);

/**
 * The part of `s3` that is identity: the app bucket, its pin, and the region
 * it lives in. The state bucket can rotate on -purge, and the endpoint and
 * creation time describe the bucket as it last existed, so they stay behind.
 */
const ENV_IDENTITY_S3_FIELDS = Object.freeze(['bucket', 'bucketPin', 'region']);

/**
 * @param {Record<string, unknown>} envConfig - a live `environments.<env>` block
 * @returns {Record<string, unknown>} the identity subset (only fields present)
 */
export function envIdentityOf(envConfig) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of ENV_IDENTITY_FIELDS) {
    if (envConfig?.[key] !== undefined) out[key] = envConfig[key];
  }
  if (out.s3) {
    const s3 = /** @type {Record<string, unknown>} */ (out.s3);
    /** @type {Record<string, unknown>} */
    const kept = {};
    for (const key of ENV_IDENTITY_S3_FIELDS) {
      if (s3[key] !== undefined) kept[key] = s3[key];
    }
    if (Object.keys(kept).length > 0) out.s3 = kept;
    else delete out.s3;
  }
  return out;
}

/**
 * deploy-side lookup: the live `environments.<env>` block if there is one,
 * else the identity `destroy` recorded for that name, else `{}`.
 *
 * @param {{ environments?: Record<string, any>, destroyedEnvironments?: Record<string, any> }} projectConfig
 * @param {string} envName
 * @returns {{ envConfig: Record<string, unknown>, fromDestroyed: { destroyedAt?: string } | null }}
 *   `fromDestroyed` is non-null exactly when the seed came from a destroyed
 *   record, so the caller can say so; `destroyedAt` and `backupsPurged` are
 *   bookkeeping and are kept OUT of `envConfig` so they never land in the
 *   persisted env block.
 */
export function resolveEnvSeed(projectConfig, envName) {
  const live = projectConfig?.environments?.[envName];
  if (live) return { envConfig: live, fromDestroyed: null };
  const recorded = projectConfig?.destroyedEnvironments?.[envName];
  if (!recorded) return { envConfig: {}, fromDestroyed: null };
  // backupsPurged is destroy's bookkeeping too (preservedBackupHolders).
  const { destroyedAt, backupsPurged: _purged, ...identity } = recorded;
  return { envConfig: identity, fromDestroyed: { destroyedAt } };
}

/**
 * Pure: the project config without `destroyedEnvironments.<env>` — called by
 * deploy once the environment is live again, so a record never outlives the
 * rebuild it was kept for. Drops the map entirely when it empties.
 *
 * @template {{ destroyedEnvironments?: Record<string, any> }} T
 * @param {T} projectConfig
 * @param {string} envName
 * @returns {T}
 */
export function clearDestroyedRecord(projectConfig, envName) {
  const records = projectConfig?.destroyedEnvironments;
  if (!records || !(envName in records)) return projectConfig;
  const { [envName]: _dropped, ...rest } = records;
  const { destroyedEnvironments: _all, ...withoutMap } = projectConfig;
  return /** @type {T} */ (
    Object.keys(rest).length > 0 ? { ...withoutMap, destroyedEnvironments: rest } : withoutMap
  );
}
