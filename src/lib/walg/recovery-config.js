/**
 * The archive-recovery settings a restore writes into the fetched cluster's
 * postgresql.auto.conf, for both tiers.
 *
 * A fetched base backup is only consistent after replaying the WAL from its
 * redo point to its stop point, and that WAL lives in the bucket, so the
 * restore sets restore_command (wal-g wal-fetch), recovery_target_action
 * 'promote' and recovery_target_timeline 'current', plus recovery_target_time
 * for a point-in-time target. 'current' pins recovery to the base backup's own
 * timeline: the default 'latest' chases the newest .history file in the shared
 * prefix, which in HA can belong to a timeline that forked before this base
 * (RCA 2026-06-01, "requested timeline N is not a child of this server's
 * history").
 *
 * Before appending, the restore strips every setting it is about to write and
 * every other recovery_target_*: a base taken from a cluster restored earlier
 * carries what that restore appended. It also strips
 * default_transaction_read_only, so a base taken while a failover's write
 * fence was stranded on the primary comes back writable by construction
 * (assertRestoredPrimaryWritable stays as the proof).
 *
 * One builder, one rendering: compose embeds renderRecoveryConf's text in its
 * restore script and k8s receives the same text through RESTORE_RECOVERY_CONF
 * on vibecarbon-infra-secrets. The two copies had drifted before (M2).
 */

/**
 * ISO-8601 instant for point-in-time recovery: YYYY-MM-DDTHH:MM:SS then Z or
 * ±HH:MM. The one format restore, the recovery config and the scripts accept.
 */
export const RESTORE_PITR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;

/** Settings removed from postgresql.auto.conf before the recovery lines go in. */
export const RECOVERY_STRIP_SETTINGS = Object.freeze([
  'restore_command',
  'recovery_target',
  'recovery_target_action',
  'recovery_target_inclusive',
  'recovery_target_lsn',
  'recovery_target_name',
  'recovery_target_time',
  'recovery_target_timeline',
  'recovery_target_xid',
  'default_transaction_read_only',
]);

/**
 * @param {{ target: 'latest' | string }} args  'latest', or an ISO-8601 instant
 * @returns {{ strip: string[], lines: string[] }}
 */
export function buildRecoveryConfig({ target }) {
  if (target !== 'latest' && !RESTORE_PITR_RE.test(String(target))) {
    throw new Error(
      `Invalid target ${JSON.stringify(target)}: must be "latest" or an ISO-8601 datetime (e.g. 2026-05-31T12:00:00Z)`,
    );
  }
  const lines = [
    `restore_command = 'wal-g wal-fetch "%f" "%p"'`,
    "recovery_target_action = 'promote'",
    "recovery_target_timeline = 'current'",
  ];
  if (target !== 'latest') lines.push(`recovery_target_time = '${target}'`);
  return { strip: [...RECOVERY_STRIP_SETTINGS], lines };
}

/**
 * Render the config as the text both restore scripts apply: one `-<setting>`
 * row per stripped setting, then the appended lines. The scripts read it row
 * by row, deleting `<setting> = ...` for a `-` row and appending any other.
 *
 * @param {{ strip: string[], lines: string[] }} config
 * @returns {string}
 */
export function renderRecoveryConf({ strip, lines }) {
  for (const name of strip) {
    if (!/^[a-z_]+$/.test(name)) throw new Error(`renderRecoveryConf: bad setting ${name}`);
  }
  for (const line of lines) {
    if (line.startsWith('-') || line.includes('\n')) {
      throw new Error(`renderRecoveryConf: bad line ${JSON.stringify(line)}`);
    }
  }
  return [...strip.map((name) => `-${name}`), ...lines].join('\n');
}
