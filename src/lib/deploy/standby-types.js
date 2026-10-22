/**
 * The k8s-ha standby's server types: what is on record for the standby side,
 * else what the standby location stocks for each role. A redeploy never
 * resizes or refuses an existing env, so a recorded type always wins unless
 * the operator asked for new sizes (`deploy -server-type`).
 *
 * The deploy wizard (refusal and the skeleton save) and the k8s-ha fan-out
 * both resolve through `k8sStandbyTypes`, so the two always agree.
 */

/**
 * The per-side record a k8s-ha deploy follows, from the env as it stood
 * before this deploy: each side's stack identity and region (only when both
 * sides carry a stack, the role mapping failover persists), and its recorded
 * master and db types (whether or not a stack exists yet: a first deploy that
 * failed after the skeleton save has types but no stack). The standby's
 * worker type comes from `ha.standbyWorkerSpec`. A failover swaps
 * `ha.primary` and `ha.standby` wholesale, so the record follows the role.
 *
 * @param {object|undefined} envConfig
 * @returns {{primary: object, standby: object}|null} null when the env has no ha record
 */
export function haStacksFrom(envConfig) {
  const ha = envConfig?.ha;
  if (!ha?.primary && !ha?.standby) return null;
  const stacked = Boolean(ha.primary?.stack && ha.standby?.stack);
  const side = (record, workerServerType) => ({
    ...(stacked ? { stack: record.stack, region: record.region } : {}),
    ...(record?.masterServerType ? { masterServerType: record.masterServerType } : {}),
    ...(record?.dbServerType ? { dbServerType: record.dbServerType } : {}),
    ...(workerServerType ? { workerServerType } : {}),
  });
  return {
    primary: side(ha.primary),
    standby: side(ha.standby, ha.standbyWorkerSpec?.serverType),
  };
}

/**
 * The standby's master, db and worker types at `standbyRegion`.
 *
 * Each role: the recorded type (unless `requested`), else
 * `Provider.resolveServerTypeForRegion(primaryType, standbyRegion, role)`:
 * the primary's type where stocked, else the role's cheapest stocked pick of
 * at least its RAM, else null. Master and db null means the standby cannot be
 * placed (the caller refuses). A null worker (the pilot-light standby only
 * records it, for failover to bring up) is reported as `workerUnstocked` and
 * left out, for the caller to fall back and say so. A role with no primary
 * type at all stays undefined (the caller's last-resort default covers it).
 *
 * @param {object} args
 * @param {object} args.Provider - a provider class
 * @param {string} args.standbyRegion
 * @param {{master?: string, db?: string, worker?: string}} args.primary - the primary's types
 * @param {{masterServerType?: string, dbServerType?: string, workerServerType?: string}} [args.recorded]
 * @param {boolean} [args.requested] - `deploy -server-type` given: ignore the record
 * @returns {{masterServerType: string|null|undefined, dbServerType: string|null|undefined,
 *   workerServerType: string|undefined, workerUnstocked: boolean}}
 */
export function k8sStandbyTypes({ Provider, standbyRegion, primary, recorded = {}, requested }) {
  const record = requested ? {} : (recorded ?? {});
  const pick = (role, primaryType, recordedType) =>
    recordedType || Provider.resolveServerTypeForRegion(primaryType, standbyRegion, role);
  const worker = pick('worker', primary.worker, record.workerServerType);
  return {
    masterServerType: pick('master', primary.master, record.masterServerType),
    dbServerType: pick('db', primary.db, record.dbServerType),
    workerServerType: worker ?? undefined,
    workerUnstocked: worker === null,
  };
}
