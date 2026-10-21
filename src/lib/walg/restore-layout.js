/**
 * Where a restore keeps its staging dir, the previous cluster and its
 * in-progress marker, all inside PGDATA (see restore-marker.js for why), and
 * the shape of a wal-g backup name, and the free-space check before a staged
 * fetch. No imports: the compose restore (compose/index.js) and the restore
 * commands both read it.
 */

/** PGDATA inside the db container, both tiers. */
export const PGDATA_PATH = '/var/lib/postgresql/data';

/** Entries a restore keeps inside PGDATA (names relative to it). */
export const RESTORE_LAYOUT = Object.freeze({
  staging: '.vc-restore',
  previous: '.vc-prev',
  // Garbage only: an unproven copy a restore set aside, or a proven restore's
  // old cluster on its way out (the CLI renames .vc-prev here first, so a
  // .vc-prev that survives always means its restore never proved itself).
  discard: '.vc-discard',
  inProgress: '.vc-restore-in-progress',
  lock: '.vc-restore.lock',
});

/** The previous cluster, removed once the restored one is proven. */
export const PREVIOUS_PGDATA_PATH = `${PGDATA_PATH}/${RESTORE_LAYOUT.previous}`;

/** Where the CLI renames the previous cluster before removing it. */
export const DISCARD_PGDATA_PATH = `${PGDATA_PATH}/${RESTORE_LAYOUT.discard}`;

/**
 * The shell that retires a proven restore's previous cluster: one atomic
 * rename out of the `.vc-prev` name, into a per-call name under the discard,
 * with nothing removed in front of it (a crash at any point leaves either the
 * whole `.vc-prev` or garbage under `.vc-discard`). REMOVE_DISCARD_SH then
 * removes the discard. Two steps so k8s can clear its marker in between. `$$`
 * is the remote shell's pid: run it through `sh -c` with the text quoted so
 * only that shell expands it.
 */
export const RETIRE_PREVIOUS_SH = `mkdir -p ${DISCARD_PGDATA_PATH} && if [ -e ${PREVIOUS_PGDATA_PATH} ]; then mv ${PREVIOUS_PGDATA_PATH} ${DISCARD_PGDATA_PATH}/prev.$$; fi`;
export const REMOVE_DISCARD_SH = `rm -rf ${DISCARD_PGDATA_PATH}`;

/** The restore states a writable proof accepts (assertRolePrimaryWritable). */
export const PROVEN_WRITABLE_STATES = Object.freeze(['writable', 'lifted']);

/**
 * The staged fetch's wait, sized from the backup like the k8s rollout wait:
 * the floor, or the fetch at 20 MiB/s plus five minutes for the swap.
 */
export function restoreFetchTimeoutS(requiredBytes, floorS = 900) {
  const bytes = Number(requiredBytes) || 0;
  return Math.max(floorS, Math.ceil(bytes / (20 * 1024 ** 2)) + 300);
}

/** wal-g backup names: base_<24 hex>, or a delta base_<24 hex>_D_<24 hex>. */
export const BACKUP_NAME_RE = /^base_[0-9A-F]{24}(_D_[0-9A-F]{24})?$/;

/** The Secret keys the k8s restore marker is made of. */
export const RESTORE_MARKER_KEYS = Object.freeze([
  'RESTORE_TARGET',
  'RESTORE_BACKUP',
  'RESTORE_RECOVERY_CONF',
]);

/**
 * The marker's Secret stringData. A complete set, or all three empty (clear).
 *
 * @param {{ backup: string, target: string, recoveryConf: string } | null} marker
 * @returns {Record<string, string>}
 */
export function restoreMarkerStringData(marker) {
  if (!marker) return Object.fromEntries(RESTORE_MARKER_KEYS.map((k) => [k, '']));
  const { backup, target, recoveryConf } = marker;
  if (!BACKUP_NAME_RE.test(String(backup))) {
    throw new Error(`restore marker: ${JSON.stringify(backup)} is not a wal-g backup name`);
  }
  if (!target || !recoveryConf) {
    throw new Error('restore marker: target and recoveryConf are required with a backup');
  }
  return { RESTORE_TARGET: target, RESTORE_BACKUP: backup, RESTORE_RECOVERY_CONF: recoveryConf };
}

/**
 * Refuse a restore whose staged fetch cannot fit next to the live cluster:
 * staging needs the backup's full uncompressed size on the same volume, plus
 * a tenth for the WAL replay. Unreadable free space only warns: a fetch that
 * runs out of room fails without touching the live cluster.
 *
 * @param {{ requiredBytes: number, freeBytes: number | null, where: string, warn: (msg: string) => void }} args
 */
export function assertRestoreFits({ requiredBytes, freeBytes, where, warn }) {
  const need = Math.ceil(requiredBytes * 1.1);
  if (freeBytes === null) {
    warn(
      `could not read the free space on ${where}; the restore stages ${formatGiB(need)} next to the live database`,
    );
    return;
  }
  if (freeBytes < need) {
    throw new Error(
      `restore refused before stopping anything: staging this backup needs ${formatGiB(need)} free on ${where}, ` +
        `and it has ${formatGiB(freeBytes)}. The restore keeps the live database until the backup is proven, ` +
        'so it needs room for both. Grow the volume, then rerun vibecarbon restore.',
    );
  }
}

function formatGiB(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
