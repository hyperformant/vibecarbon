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

import { escapeSql } from '../shell.js';

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
 * The persistent slot's wal_status and the WAL it holds, as `status|bytes`,
 * for the standby's slot by name (any other slot, a reseed's or an operator's,
 * says nothing about it). A lost slot has no restart_lsn, which reads as 0
 * bytes. It carries a string literal, so it travels by a quoting-safe
 * transport only: base64 on stdin (compose), a kubectl argv (k8s).
 */
export const REPLICATION_SLOT_HEALTH_SQL =
  'SELECT wal_status, coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0) ' +
  `FROM pg_replication_slots WHERE slot_name = '${REPLICATION_SLOT}'`;

/**
 * Idempotent slot ensure: drop the slot if it is lost, then create it if it is
 * missing. The one builder every slot creation goes through (the census in
 * tests/unit/deploy/slot-lost-reseed.test.ts); primaryReplicationSql embeds
 * its output verbatim.
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
 * The replication role, created if missing and given the per-deploy password.
 *
 * Postgres logs a failing statement's text (log_min_error_statement = error)
 * and any statement over 1 s (log_min_duration_statement = 1000), and the db
 * log reaches Loki. So the password literal never rides in a statement that
 * can be logged:
 *
 *   - the SETs come first, so this session logs neither, and keeps the
 *     statement out of pg_stat_statements (which the monitoring view reads);
 *   - the DO block carries NO password: an error inside PL/pgSQL quotes the
 *     inner statement in a CONTEXT line, which no SET suppresses;
 *   - the password is set by one TOP-LEVEL ALTER ROLE, after the SETs.
 *
 * Deliver it on psql's stdin (never argv, never a file on the node). The
 * census in tests/unit/security/role-password-session.test.ts pins the shape.
 *
 * @param {string} password
 * @returns {string}
 */
export function replicationRoleSql(password) {
  return `SET log_min_error_statement = panic;
SET log_min_duration_statement = -1;
SET pg_stat_statements.track_utility = off;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replicator') THEN
    CREATE ROLE replicator WITH REPLICATION LOGIN;
  END IF;
END $$;
ALTER ROLE replicator WITH PASSWORD ${escapeSql(password)};`;
}

/**
 * The primary's whole replication setup, one psql session on stdin: the role
 * (replicationRoleSql), then the physical slot (ensureReplicationSlotSql). The
 * one builder both HA tiers run.
 *
 * @param {string} password
 * @returns {string}
 */
export function primaryReplicationSql(password) {
  return `${replicationRoleSql(password)}

-- The physical replication slot: dropped when lost (WAL past the
-- max_slot_wal_keep_size cap, it can never stream again), created if missing.
${ensureReplicationSlotSql()}
`;
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
  return `Could not drop the old primary's inactive replication slot (${ip}): ${cause}. It ${SLOT_RETAINS_WAL}`;
}

/** What an undropped slot does, in slotDropWarning's words (both messages share it). */
const SLOT_RETAINS_WAL =
  `holds WAL on that node up to max_slot_wal_keep_size ` +
  `(${SLOT_WAL_SETTINGS.max_slot_wal_keep_size}) until \`vibecarbon deploy\` rebuilds it as the standby.`;

/**
 * The note a demotion adds when its role write failed and so it skipped the
 * slot drop (DEMOTION_ORDER): the slots remain, in slotDropWarning's words.
 *
 * @param {string} ip
 * @returns {string}
 */
export function slotDropSkippedNote(ip) {
  return `The old primary's inactive replication slot (${ip}) was not dropped either: it ${SLOT_RETAINS_WAL}`;
}
