/**
 * The backup schedule and retention a k8s cluster runs with, from
 * `envConfig.backup`, written into the manifest tree as concrete values.
 *
 * ONE mechanism for every way the manifests reach a cluster. The CLI's deploy
 * applies a rendered temp copy of `k8s/base` (renderK8sBase), `vibecarbon
 * configure` GitOps commits the project's own tree, and Flux reconciles
 * `./k8s/base` (and the overlay built on it) every 10 minutes with prune. A
 * value patched onto the live objects would be written straight back by the
 * next Flux reconcile, so the values live in the files themselves: the CronJob
 * `spec.schedule` and the vibecarbon-config `BACKUP_RETENTION_DAYS` key.
 * Concrete values, never `{{}}` placeholders (Flux applies base raw).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the manifests carry when the deploy has no backup config. */
const DEFAULT_BACKUP_SCHEDULE = '0 2 * * *';
const DEFAULT_BACKUP_RETENTION_DAYS = 7;

/** Five cron fields: digits, letters (names), * / , - only. */
const CRON_FIELD = /^[0-9A-Za-z*/,-]+$/;

/**
 * @param {{schedule?: string, retentionDays?: number}} [backupConfig]
 * @returns {{schedule: string, retentionDays: number}}
 */
export function resolveBackupSettings(backupConfig) {
  const schedule = String(backupConfig?.schedule || DEFAULT_BACKUP_SCHEDULE).trim();
  const fields = schedule.split(/\s+/);
  if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) {
    throw new Error(
      `backup schedule ${JSON.stringify(schedule)} is not a 5-field cron expression (minute hour day month weekday)`,
    );
  }
  const days = backupConfig?.retentionDays;
  return {
    schedule: fields.join(' '),
    retentionDays: Number.isInteger(days) && days > 0 ? days : DEFAULT_BACKUP_RETENTION_DAYS,
  };
}

/** Replace the one line matching `re` in `file`; anything but exactly one match throws. */
function replaceOne(file, re, line) {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf-8');
  const hits = text.match(new RegExp(re.source, 'gm'));
  if (hits?.length !== 1) {
    throw new Error(
      `${file}: expected exactly one line matching ${re} to carry the backup setting, found ${hits?.length ?? 0}`,
    );
  }
  writeFileSync(file, text.replace(re, line));
  return true;
}

/**
 * Write the schedule and retention into a manifest tree, in place.
 *
 * @param {string} k8sDir - a `k8s/base` directory (the project's, or a rendered temp copy)
 * @param {{schedule?: string, retentionDays?: number}} [backupConfig]
 * @returns {{schedule: string, retentionDays: number}} the values written
 */
export function writeBackupConfigIntoTree(k8sDir, backupConfig) {
  const settings = resolveBackupSettings(backupConfig);
  replaceOne(
    join(k8sDir, 'backup', 'cronjob.yaml'),
    /^ {2}schedule: .*$/m,
    `  schedule: "${settings.schedule}"`,
  );
  replaceOne(
    join(k8sDir, 'config', 'configmap.yaml'),
    /^ {2}BACKUP_RETENTION_DAYS: .*$/m,
    `  BACKUP_RETENTION_DAYS: "${settings.retentionDays}"`,
  );
  return settings;
}
