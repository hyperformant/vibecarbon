/**
 * The safety records an environment entry carries, and the one way a writer
 * that rebuilds a whole env entry keeps them.
 *
 * These are written mid-run, straight to .vibecarbon.json, by the step that
 * owns each one (the failover journal, the write-fence marker and a scale's
 * cutover journal, a standby's proof or its loss, a pending Pulumi state
 * sync, an unrestored backup lineage). A deploy or scale that builds its env
 * entry from the copy it loaded earlier would roll them back: a stranded
 * write fence vanishes before the primary-writable check reads it, a cutover
 * journal is lost, a standby marked unproven reads as streaming again.
 *
 * So every whole-env write inside an updateProjectConfig mutator goes through
 * preserveSafetyFields (census: tests/unit/config/no-stale-save-census.test.ts):
 * each field takes its value from the env as it is on disk now, unless the
 * writer names it in `owns`, meaning this run decided it (set or cleared).
 * A field the run clears on its own (clearWriteFenceMarker,
 * clearPendingServerState, liftStrandedWriteFence) is already gone from disk,
 * so preserving it keeps it cleared.
 */

/** Dotted paths, relative to the env entry. */
export const ENV_SAFETY_FIELDS = Object.freeze([
  'ha.writeFence',
  'ha.failoverInFlight',
  'ha.systemIdentifier',
  'ha.backupFence',
  'pendingServerState',
  'replication',
  'degraded',
  'degradedCause',
  'backup.unrestoredPrior',
]);

/**
 * Named causes for `degraded` beyond the replication verdict (`replication`
 * carries that one), persisted as the env's `degradedCause`.
 * STANDBY_IMAGE_MISSING: a k8s-ha deploy under -allow-degraded could not copy
 * the app image into the standby's registry, so the standby cannot start the
 * app and failover refuses it.
 */
export const DEGRADED_CAUSE = Object.freeze({
  STANDBY_IMAGE_MISSING: 'standby-image-missing',
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `nextEnv` with every safety field not in `owns` taken from `freshEnv` (the
 * env read under the config lock): copied when it is there, removed when it
 * is not. Returns a new object; neither input is changed.
 *
 * @param {object|undefined} freshEnv - the env entry as it is on disk now
 * @param {object} nextEnv - the entry this writer built
 * @param {{ owns?: string[] }} [opts] - safety fields this run decided
 * @returns {object}
 */
export function preserveSafetyFields(freshEnv, nextEnv, { owns = [] } = {}) {
  for (const field of owns) {
    if (!ENV_SAFETY_FIELDS.includes(field)) {
      throw new Error(`preserveSafetyFields: ${field} is not a safety field`);
    }
  }
  const out = { ...nextEnv };
  for (const field of ENV_SAFETY_FIELDS) {
    if (owns.includes(field)) continue;
    const [head, key] = field.split('.');
    if (!key) {
      if (freshEnv && Object.hasOwn(freshEnv, head)) out[head] = freshEnv[head];
      else delete out[head];
      continue;
    }
    const freshParent = freshEnv?.[head];
    const has = isObject(freshParent) && Object.hasOwn(freshParent, key);
    if (has) {
      out[head] = { ...(isObject(out[head]) ? out[head] : {}), [key]: freshParent[key] };
    } else if (isObject(out[head]) && Object.hasOwn(out[head], key)) {
      const { [key]: _dropped, ...rest } = out[head];
      // No empty `ha` left behind: status reads its presence as HA.
      if (Object.keys(rest).length > 0) out[head] = rest;
      else delete out[head];
    }
  }
  return out;
}
