/**
 * The IDENTITY of an environment: the `.vibecarbon.json` fields that say what
 * it is — placement, domain, DNS backend, backup bucket, server sizing — as
 * opposed to what currently exists (servers, the live storage bucket, deploy
 * state, HA topology).
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
  'backupS3',
  'backup',
  'region',
  'secondaryRegion',
  'serverType',
  'masterServerType',
  'supabaseServerType',
  'workerServerType',
]);

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
 *   record, so the caller can say so; `destroyedAt` is bookkeeping and is
 *   kept OUT of `envConfig` so it never lands in the persisted env block.
 */
export function resolveEnvSeed(projectConfig, envName) {
  const live = projectConfig?.environments?.[envName];
  if (live) return { envConfig: live, fromDestroyed: null };
  const recorded = projectConfig?.destroyedEnvironments?.[envName];
  if (!recorded) return { envConfig: {}, fromDestroyed: null };
  const { destroyedAt, ...identity } = recorded;
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
