/**
 * The HA replication slot's lifecycle (HA-correctness Task 7, H5).
 *
 * The primary holds WAL for its standby through one physical slot. Unbounded,
 * a standby that stays down for about a week fills the primary's 10Gi volume,
 * so the db argv caps it (SLOT_WAL_SETTINGS, both tiers, census-pinned). Past
 * the cap Postgres removes that WAL and marks the slot `lost`; a lost slot can
 * never stream again. So:
 *
 *   - every slot ensure drops a lost slot before it creates a missing one
 *     (ensureReplicationSlotSql), which is what the deploy's reseed of a
 *     non-streaming standby runs on the primary;
 *   - every demotion drops the old primary's inactive slots
 *     (DROP_INACTIVE_SLOTS_SQL), since nobody streams from it after a failover;
 *   - `vibecarbon status` reads the slot's wal_status and retained WAL
 *     (REPLICATION_SLOT_HEALTH_SQL).
 *
 * Both drops work on a write-fenced server (default_transaction_read_only=on):
 * verified on postgres:17.11-walg3.0.9-r2.
 */

// The physical replication slot name is a project-wide constant: the primary
// creates it and the standby streams through it (primary_slot_name).
export const REPLICATION_SLOT = 'vibecarbon_standby_slot';

/**
 * The db argv's replication settings, equal on compose and k8s
 * (tests/unit/deploy/slot-wal-cap-census.test.ts). 4GB fits on the 10Gi
 * volume beside the data; 512MB is the floor a briefly disconnected standby
 * can catch up from; 10 senders leaves room for the streaming standby plus a
 * reseed's basebackup.
 */
export const SLOT_WAL_SETTINGS = Object.freeze({
  max_slot_wal_keep_size: '4GB',
  wal_keep_size: '512MB',
  max_wal_senders: '10',
});

/** Drop every slot nobody streams from (run on a node being demoted). */
export const DROP_INACTIVE_SLOTS_SQL =
  'SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE NOT active';

/**
 * The persistent slot's wal_status and the WAL it holds, as `status|bytes`.
 * No string literals, so it survives both status transports' quoting. A lost
 * slot has no restart_lsn, which reads as 0 bytes.
 */
export const REPLICATION_SLOT_HEALTH_SQL =
  'SELECT wal_status, coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0) ' +
  'FROM pg_replication_slots WHERE NOT temporary ORDER BY slot_name LIMIT 1';

/**
 * Idempotent slot ensure: drop the slot if it is lost, then create it if it is
 * missing. The one builder every slot creation goes through (the census in
 * tests/unit/deploy/slot-lost-reseed.test.ts); carbon/ha/primary-init.sql
 * carries its output verbatim.
 *
 * @param {string} [slotName]
 * @returns {string}
 */
export function ensureReplicationSlotSql(slotName = REPLICATION_SLOT) {
  return `DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_replication_slots
    WHERE slot_name = '${slotName}' AND wal_status = 'lost'
  ) THEN
    PERFORM pg_drop_replication_slot('${slotName}');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_replication_slots WHERE slot_name = '${slotName}'
  ) THEN
    PERFORM pg_create_physical_replication_slot('${slotName}');
  END IF;
END $$;`;
}

/**
 * Run DROP_INACTIVE_SLOTS_SQL through a psql runner. Never throws: a demotion
 * is best-effort and the caller decides how to report a failed drop.
 *
 * @param {(sql: string) => Promise<unknown>} exec
 * @returns {Promise<{ok: true} | {ok: false, error: Error}>}
 */
export async function dropInactiveReplicationSlots(exec) {
  try {
    const out = await exec(DROP_INACTIVE_SLOTS_SQL);
    if (out === false) throw new Error('the psql call failed');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * The warning for an inactive slot a demotion could not drop.
 *
 * @param {string} ip
 * @param {Error} error
 * @returns {string}
 */
export function slotDropWarning(ip, error) {
  const cause = String(error?.message ?? error).split('\n')[0];
  return (
    `Could not drop the old primary's inactive replication slot (${ip}): ${cause}. ` +
    `It holds WAL on that node up to max_slot_wal_keep_size ` +
    `(${SLOT_WAL_SETTINGS.max_slot_wal_keep_size}) until \`vibecarbon deploy\` rebuilds it as the standby.`
  );
}
