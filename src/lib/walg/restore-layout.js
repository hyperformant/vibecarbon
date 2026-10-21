/**
 * Where a restore keeps its staging dir, the previous cluster and its
 * in-progress marker, all inside PGDATA (see restore-marker.js for why), and
 * the shape of a wal-g backup name, and the free-space check before a staged
 * fetch. No imports: the compose restore (compose/index.js) and the restore
 * commands both read it.
 */

/** PGDATA inside the db container, both tiers. */
export const PGDATA_PATH = '/var/lib/postgresql/data';

/**
 * walg-env.sh inside the db container, both tiers (carbon/volumes/db/walg-env.sh,
 * and its copy in the vibecarbon-wal-archive ConfigMap). It exports
 * WALG_S3_PREFIX, the archive folder of one database lineage, from
 * WALG_S3_PREFIX_BASE and RESTORE_LINEAGE or the system identifier in PGDATA.
 * Every script the CLI runs in the db container that calls wal-g starts with
 * WALG_ENV_SOURCE (tests/unit/deploy/walg-lineage-prefix-census.test.ts).
 */
export const WALG_ENV_PATH = '/etc/postgresql/walg-env.sh';
export const WALG_ENV_SOURCE = `. ${WALG_ENV_PATH}`;

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
  // The attempt a completed swap came from: `<backup> <attempt id>`. The k8s
  // init restores on every boot while the marker is set; when the marker's
  // RESTORE_ATTEMPT is the one recorded here it boots normally instead of
  // rewinding the live cluster again. Keyed on the attempt, not the base, so
  // a new restore of the same base (another target, or after a stale record
  // survived) always restores. Removed first by REMOVE_DISCARD_SH, after the
  // CLI cleared the marker.
  restoredFrom: '.vc-restored-from',
});

/**
 * The record wal-archive.sh keeps in PGDATA of WAL segments it dropped under
 * disk pressure (`<segment> <UTC time>` per line), and the name a pushed base
 * moves it aside to while it clears the entries older than itself
 * (backup/compose-backup.sh, the k8s backup CronJob). vibecarbon status reads
 * both; a restore drops both from the staged tree, since a restored database
 * does not share its source's gap.
 */
export const WAL_GAP_RECORD = 'vibecarbon-wal-gap';
export const WAL_GAP_RECORDS = Object.freeze([WAL_GAP_RECORD, `${WAL_GAP_RECORD}.clearing`]);

/** The previous cluster, removed once the restored one is proven. */
export const PREVIOUS_PGDATA_PATH = `${PGDATA_PATH}/${RESTORE_LAYOUT.previous}`;

/** Where the CLI renames the previous cluster before removing it. */
export const DISCARD_PGDATA_PATH = `${PGDATA_PATH}/${RESTORE_LAYOUT.discard}`;

/**
 * The shell that retires a proven restore's previous cluster: one atomic
 * rename out of the `.vc-prev` name, into a per-call name under the discard,
 * with nothing removed in front of it (a crash at any point leaves either the
 * whole `.vc-prev` or garbage under `.vc-discard`). REMOVE_DISCARD_SH then
 * removes the attempt record (first, it is one small file) and then the
 * discard. Two steps so k8s can clear its marker in between: the record must
 * outlive the marker, or a pod start in that gap would restore again. `$$`
 * is the remote shell's pid: run it through `sh -c` with the text quoted so
 * only that shell expands it.
 */
export const RETIRE_PREVIOUS_SH = `mkdir -p ${DISCARD_PGDATA_PATH} && if [ -e ${PREVIOUS_PGDATA_PATH} ]; then mv ${PREVIOUS_PGDATA_PATH} ${DISCARD_PGDATA_PATH}/prev.$$; fi`;
export const REMOVE_DISCARD_SH = `rm -f ${PGDATA_PATH}/${RESTORE_LAYOUT.restoredFrom} && rm -rf ${DISCARD_PGDATA_PATH}`;

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

/**
 * The Secret keys the k8s restore marker is made of. RESTORE_ATTEMPT is a
 * random id per restore attempt (not a secret): the walg-restore init records
 * it after a swap, so a pod start during the same attempt does not restore
 * again. RESTORE_ORIGIN says which command set it ('deploy' for deploy
 * -restore onto a new cluster, 'restore' for vibecarbon restore), so a
 * refusal can name the command that finishes it. RESTORE_LINEAGE is the
 * system identifier of the database the backup came from: the init sources
 * walg-env.sh with it, so the fetch reads that lineage's archive folder
 * before PGDATA holds the database that names it.
 */
export const RESTORE_MARKER_KEYS = Object.freeze([
  'RESTORE_TARGET',
  'RESTORE_BACKUP',
  'RESTORE_RECOVERY_CONF',
  'RESTORE_ATTEMPT',
  'RESTORE_ORIGIN',
  'RESTORE_LINEAGE',
]);

/** A database lineage: its system identifier, the name of its archive folder. */
export const LINEAGE_RE = /^[0-9]{1,20}$/;

/** Who set a restore marker. */
export const RESTORE_ORIGINS = Object.freeze(['deploy', 'restore']);

/** A restore attempt id: one shell word, safe in the init's record. */
export const RESTORE_ATTEMPT_RE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * The marker's Secret stringData. A complete set, or every key empty (clear).
 *
 * @param {{ backup: string, target: string, recoveryConf: string, attempt: string, origin: 'deploy'|'restore', lineage: string } | null} marker
 * @returns {Record<string, string>}
 */
export function restoreMarkerStringData(marker) {
  if (!marker) return Object.fromEntries(RESTORE_MARKER_KEYS.map((k) => [k, '']));
  const { backup, target, recoveryConf, attempt, origin, lineage } = marker;
  if (!BACKUP_NAME_RE.test(String(backup))) {
    throw new Error(`restore marker: ${JSON.stringify(backup)} is not a wal-g backup name`);
  }
  if (!target || !recoveryConf) {
    throw new Error('restore marker: target and recoveryConf are required with a backup');
  }
  if (!RESTORE_ATTEMPT_RE.test(String(attempt ?? ''))) {
    throw new Error(`restore marker: ${JSON.stringify(attempt)} is not a restore attempt id`);
  }
  if (!RESTORE_ORIGINS.includes(origin)) {
    throw new Error(`restore marker: origin ${JSON.stringify(origin)} is not deploy or restore`);
  }
  if (!LINEAGE_RE.test(String(lineage ?? ''))) {
    throw new Error(
      `restore marker: lineage ${JSON.stringify(lineage)} is not a database system identifier`,
    );
  }
  return {
    RESTORE_TARGET: target,
    RESTORE_BACKUP: backup,
    RESTORE_RECOVERY_CONF: recoveryConf,
    RESTORE_ATTEMPT: attempt,
    RESTORE_ORIGIN: origin,
    RESTORE_LINEAGE: lineage,
  };
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
        'so it needs room for both. Grow the volume, then run the command again.',
    );
  }
}

function formatGiB(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
