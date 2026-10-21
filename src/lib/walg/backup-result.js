/**
 * What a backup run did, read from the marker the backup scripts print.
 *
 * carbon/backup/compose-backup.sh and the backup CronJob
 * (carbon/k8s/base/backup/cronjob.yaml) print exactly one line on every run
 * that exits 0, plus the lock skip (exit 75):
 *
 *   BACKUP_RESULT=pushed:<base backup name>   wal-g backup-push landed a base
 *   BACKUP_RESULT=skipped:<reason>            nothing was pushed, and why
 *
 * The pushed line is printed right after backup-push succeeds and BEFORE
 * retention, so a retention failure (exit 3) still carries the name of the
 * base that is in the bucket. Refusals (retired node, backup-prefix fence)
 * and failed pushes exit 1 with no marker. On k8s the lock skip exits the
 * backup Job 0 (the marker is the skip), and exit 3 fails the Job at once
 * (podFailurePolicy), with no second pod and no second push.
 *
 * This is the one parser of that marker (census:
 * tests/unit/backup/backup-result-consumed-census.test.ts).
 */

const MARKER_RE = /^BACKUP_RESULT=(.*)$/;
const VALUE_RE = /^(pushed|skipped):([A-Za-z0-9_.-]+)$/;

/**
 * @typedef {{ result: 'pushed', name: string } | { result: 'skipped', reason: string }} BackupResult
 */

/**
 * @param {unknown} stdout a backup run's stdout (a Job's logs for k8s)
 * @returns {BackupResult}
 * @throws {Error} on zero markers, two or more, or a malformed one
 */
export function parseBackupResult(stdout) {
  const lines = String(stdout ?? '')
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim());
  const markers = lines.map((l) => MARKER_RE.exec(l)?.[1]).filter((v) => v !== undefined);
  if (markers.length === 0) {
    throw new Error('the backup printed no BACKUP_RESULT marker, so nothing proves what it did');
  }
  if (markers.length > 1) {
    throw new Error(
      `the backup printed ${markers.length} BACKUP_RESULT markers (expected one): ${markers.join(', ')}`,
    );
  }
  const m = VALUE_RE.exec(markers[0]);
  if (!m) throw new Error(`unreadable BACKUP_RESULT marker: ${markers[0]}`);
  return m[1] === 'pushed' ? { result: 'pushed', name: m[2] } : { result: 'skipped', reason: m[2] };
}

/**
 * Did this output get as far as printing a marker? (A run that exits non-zero
 * WITH one is the lock skip or a retention failure after a push.)
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function hasBackupResult(text) {
  return /^BACKUP_RESULT=/m.test(String(text ?? ''));
}

/**
 * Every pushed name in a log that may hold several runs (the logs of every
 * pod of one backup Job: a pod that failed before its push beside the one
 * that pushed; restartPolicy Never, so a container never restarts in place).
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function pushedBackupNames(text) {
  return [...String(text ?? '').matchAll(/^BACKUP_RESULT=pushed:([A-Za-z0-9_.-]+)\r?$/gm)].map(
    (m) => m[1],
  );
}
