/**
 * The standby's lineage, and the one verdict a cold reseed reads before it
 * wipes the standby's data directory (both tiers).
 *
 * A cold deploy reseeds a standby that is not streaming. That is right for a
 * fresh initdb (another system identifier), for a retired old primary (the
 * same identifier on a timeline no higher than the primary's), and for a
 * standby still in recovery. It is wrong for a standby promoted outside the
 * CLI: the same identifier on a HIGHER timeline, holding writes the primary
 * never saw. That one is refused.
 *
 * With one exception: `vibecarbon failover <env> -abort` keeps the OLD
 * primary, and a failover it calls off may already have promoted the
 * standby. The abort reads the standby's lineage before it stops it and
 * records it as discardable (`ha.discardableStandby`, an env safety field):
 * the operator chose the old primary, so that copy's writes are given up.
 * The verdict lets a standby through only when it is still exactly that
 * copy (the same address, system identifier and timeline). Any other
 * promotion still refuses, and a record for another lineage unlocks
 * nothing. A successful reseed clears the record.
 */

import { updateProjectConfig } from '../config.js';

/** The env field (relative to the env entry) the abort records. */
export const DISCARDABLE_STANDBY_FIELD = 'ha.discardableStandby';

/**
 * One db's lineage in one read: `<in recovery t|f>|<system identifier>|<timeline, 8 hex>`.
 * The timeline is the current WAL file's, read only outside recovery (a
 * server in recovery has no current WAL LSN; it prints an empty third
 * column). No quotes, so it sits inside a single-quoted shell word.
 */
export const DB_LINEAGE_SQL =
  'SELECT pg_is_in_recovery(), system_identifier, CASE WHEN pg_is_in_recovery() THEN NULL ' +
  'ELSE substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8) END FROM pg_control_system()';

/**
 * Pure. DB_LINEAGE_SQL's row as `{ inRecovery, systemIdentifier, timeline }`;
 * a part that does not parse is null. The last line wins (psql may print a
 * notice first).
 *
 * @param {unknown} text
 * @returns {{ inRecovery: boolean|null, systemIdentifier: string|null, timeline: number|null }}
 */
export function parseDbLineage(text) {
  const row =
    String(text ?? '')
      .trim()
      .split('\n')
      .pop() ?? '';
  const [recovery = '', sysid = '', tli = ''] = row.split('|').map((x) => x.trim());
  return {
    inRecovery: recovery === 't' ? true : recovery === 'f' ? false : null,
    systemIdentifier: /^\d+$/.test(sysid) ? sysid : null,
    timeline: /^[0-9A-Fa-f]{8}$/.test(tli) ? Number.parseInt(tli, 16) : null,
  };
}

/**
 * Pure. The record an abort keeps for its standby: only a standby read OUT
 * of recovery with a whole lineage (it may have promoted). A standby in
 * recovery never promoted and needs none; an unread one gets none (the next
 * deploy then refuses an unexplained promotion, as before).
 *
 * @param {{ ip: string, reading: ReturnType<typeof parseDbLineage>|null, at?: string }} o
 * @returns {{ ip: string, systemIdentifier: string, timeline: number, at: string }|null}
 */
export function discardableStandbyRecord({ ip, reading, at = new Date().toISOString() }) {
  if (!ip || reading?.inRecovery !== false) return null;
  if (!reading.systemIdentifier || !Number.isInteger(reading.timeline)) return null;
  return { ip, systemIdentifier: reading.systemIdentifier, timeline: reading.timeline, at };
}

/**
 * Pure. Does this standby's reading match the abort's record exactly?
 *
 * @param {object|null|undefined} record
 * @param {{ ip: string, systemIdentifier?: string|null, timeline?: number|null }} target
 * @returns {boolean}
 */
export function matchesDiscardableStandby(record, target) {
  return (
    !!record &&
    typeof record === 'object' &&
    record.ip === target?.ip &&
    typeof record.systemIdentifier === 'string' &&
    record.systemIdentifier === target?.systemIdentifier &&
    Number.isInteger(record.timeline) &&
    record.timeline === target?.timeline
  );
}

/**
 * Pure. The cold reseed's verdict on its target.
 *   - `standby`: in recovery, whatever its timeline;
 *   - `fresh`: another system identifier (its own initdb);
 *   - `retired`: the same database on a timeline no higher than the primary's;
 *   - `discardable`: promoted past the primary, but exactly the copy an abort
 *     recorded as discardable;
 *   - `promoted`: promoted past the primary, unexplained (refuse);
 *   - `target-unread` / `source-unread`: a side's lineage could not be read
 *     (refuse: never reseed blind).
 *
 * @param {object} o
 * @param {{ inRecovery?: boolean|string|null, systemIdentifier?: string|null, timeline?: number|null }} o.target
 * @param {{ systemIdentifier?: string|null, timeline?: number|null }} o.source
 * @param {string} o.standbyIp
 * @param {object|null} [o.discardable] the env's ha.discardableStandby
 * @returns {'standby'|'fresh'|'retired'|'discardable'|'promoted'|'target-unread'|'source-unread'}
 */
export function standbyLineageVerdict({ target, source, standbyIp, discardable = null }) {
  if (target?.inRecovery === true || target?.inRecovery === 't') return 'standby';
  if (!target?.systemIdentifier || !Number.isInteger(target?.timeline)) return 'target-unread';
  if (!source?.systemIdentifier || !Number.isInteger(source?.timeline)) return 'source-unread';
  if (target.systemIdentifier !== source.systemIdentifier) return 'fresh';
  if (target.timeline <= source.timeline) return 'retired';
  if (
    matchesDiscardableStandby(discardable, {
      ip: standbyIp,
      systemIdentifier: target.systemIdentifier,
      timeline: target.timeline,
    })
  ) {
    return 'discardable';
  }
  return 'promoted';
}

/**
 * The line a reseed over an abort's discardable standby logs.
 *
 * @param {{ standbyIp: string, target: { systemIdentifier: string, timeline: number }, envName?: string }} o
 * @returns {string}
 */
export function discardableReseedLine({ standbyIp, target, envName }) {
  return (
    `the standby ${standbyIp} runs timeline ${target.timeline} of the database ` +
    `(system identifier ${target.systemIdentifier}) that \`vibecarbon failover ${envName || '<env>'} ` +
    '-abort` recorded as discardable when it kept the old primary: reseeding it from the primary'
  );
}

/**
 * The abort's record for this env, as it is on disk now (null when none).
 *
 * @param {string} environment
 * @param {() => object|null} load - loadProjectConfig, injectable
 * @returns {object|null}
 */
export function readDiscardableStandby(environment, load) {
  try {
    const record = load()?.environments?.[environment]?.ha?.discardableStandby;
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

/**
 * Drop the abort's record once a reseed replaced that copy. One save; a no-op
 * when the env carries none.
 *
 * @param {string} environment
 * @param {typeof updateProjectConfig} [update]
 */
export function clearDiscardableStandby(environment, update = updateProjectConfig) {
  update((config) => {
    const ha = config.environments?.[environment]?.ha;
    if (!ha || !Object.hasOwn(ha, 'discardableStandby')) return;
    delete ha.discardableStandby;
  });
}
