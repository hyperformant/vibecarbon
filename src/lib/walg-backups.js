/**
 * List wal-g base backups by running `wal-g backup-list --json` inside the
 * Postgres container (compose) or pod (k8s). wal-g is the source of truth for
 * what is actually restorable — the legacy `backups/*_full.tar.gz` S3 objects
 * are NOT wal-g backups and must not be offered as restore targets.
 *
 * Restore itself always fetches the LATEST base backup and replays WAL (to the
 * present or a point-in-time target), so this listing is informational — it
 * tells the operator the available recovery window for PITR.
 */

import * as p from '@clack/prompts';
import { formatInstant } from './backup-format.js';
import { spinner as makeSpinner } from './cli/progress.js';
import { c } from './colors.js';
import { getPostgresPod, sshKubectl, sshRun } from './ssh.js';

/**
 * Parse `wal-g backup-list --json` output into normalized entries, newest-first.
 * Pure (no I/O) so it's unit-testable. Tolerant of wal-g version field-name
 * drift (backup_name/BackupName, time/start_time/finish_time/…).
 *
 * @param {string} jsonStr
 * @returns {Array<{ name: string, time: Date }>}
 */
export function parseWalgBackupList(jsonStr) {
  let arr;
  try {
    arr = JSON.parse(jsonStr);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((b) => {
      const name = b.backup_name ?? b.BackupName ?? b.name ?? null;
      const rawTime =
        b.time ?? b.start_time ?? b.StartTime ?? b.finish_time ?? b.FinishTime ?? b.creation_time;
      const time = rawTime ? new Date(rawTime) : null;
      return { name, time };
    })
    .filter((b) => b.name && b.time && !Number.isNaN(b.time.getTime()))
    .sort((a, b) => b.time.getTime() - a.time.getTime());
}

/**
 * List wal-g base backups for an environment. Best-effort: returns [] on any
 * failure (db down, wal-g missing, no --json support, parse error) so callers
 * can degrade gracefully without breaking the restore/backup flow.
 *
 * @param {object} opts
 * @param {string} opts.serverIp - master/single node IP
 * @param {string} opts.sshKeyPath
 * @param {string} opts.projectName
 * @param {boolean} opts.isCompose - true for compose, false for k8s
 * @returns {Promise<Array<{ name: string, time: Date }>>}
 */
export async function listWalgBackups({ serverIp, sshKeyPath, projectName, isCompose }) {
  try {
    let out;
    if (isCompose) {
      out = await sshRun(serverIp, sshKeyPath, [
        'bash',
        '-lc',
        `cd /opt/${projectName} && docker compose exec -T db wal-g backup-list --json`,
      ]);
    } else {
      const pod = await getPostgresPod(serverIp, sshKeyPath);
      if (!pod) return [];
      out = await sshKubectl(serverIp, sshKeyPath, [
        'exec',
        '-n',
        'vibecarbon',
        pod,
        '--',
        'wal-g',
        'backup-list',
        '--json',
      ]);
    }
    return typeof out === 'string' ? parseWalgBackupList(out) : [];
  } catch {
    return [];
  }
}

/**
 * Fetch and print the wal-g base-backup list for an env — the shared body of
 * `backup <env> -l` and `restore <env> -l` (previously copy-pasted in both).
 *
 * @param {object} opts - listWalgBackups opts plus:
 * @param {string} opts.envName - for the empty-state hint + heading
 * @param {object} [opts.spinner] - reuse the caller's clack spinner; one is
 *   created when omitted
 */
export async function printWalgBackupList({
  spinner,
  serverIp,
  sshKeyPath,
  projectName,
  isCompose,
  envName,
}) {
  const s = spinner ?? makeSpinner();
  s.start('Reading wal-g backups');
  const backups = await listWalgBackups({ serverIp, sshKeyPath, projectName, isCompose });
  s.stop('Backups read');

  if (backups.length === 0) {
    p.log.info('No wal-g base backups found.');
    p.log.info(`Create one with: ${c.info(`vibecarbon backup ${envName}`)}`);
    return;
  }
  p.log.info(
    `${c.bold(`Backups for ${envName}`)} (${backups.length} base backup(s), newest first):`,
  );
  for (const b of backups) {
    p.log.message(`  ${formatInstant(b.time).padEnd(22)} ${c.dim(b.name)}`);
  }
}
