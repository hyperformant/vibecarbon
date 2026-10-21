#!/usr/bin/env node
/**
 * The backup schedule and retention a k8s cluster runs with, and the two
 * objects that carry them. ONE renderer for both ways a cluster gets them:
 *
 * - the vibecarbon CLI imports this module when it applies a cluster
 *   (applyK3sManifests), from `envConfig.backup`;
 * - the GitOps deploy workflow (.github/workflows/deploy.yml) runs it as a
 *   script, from the GitHub Environment vars BACKUP_SCHEDULE and
 *   BACKUP_RETENTION_DAYS that `vibecarbon configure` seeds per environment.
 *
 * The settings are per environment, but the committed `k8s/base` is shared by
 * every environment Flux reconciles from the same branch, so they cannot live
 * there. The backup CronJob is therefore DEPLOY-owned: Flux's vibecarbon-base
 * Kustomization drops it (`$patch: delete`, k8s/flux/clusters/*), and the
 * retention days live in a per-cluster ConfigMap that is in no manifest tree.
 *
 * Script usage: `node scripts/render-backup-settings.mjs [k8s/base]` prints the
 * CronJob (its schedule filled in) and the settings ConfigMap as YAML on
 * stdout; pipe it to `kubectl apply -n vibecarbon -f -`. The two env vars are
 * required: no value is invented on a cluster that was never told one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What a deploy records when nothing is given (the documented defaults). */
export const DEFAULT_BACKUP_SCHEDULE = '0 */6 * * *';
export const DEFAULT_BACKUP_RETENTION_DAYS = 30;

/** The per-cluster ConfigMap the CronJob reads its retention days from. */
export const BACKUP_SETTINGS_CONFIGMAP = 'vibecarbon-backup-settings';

/** Five cron fields: digits, letters (names), * / , - only. */
const CRON_FIELD = /^[0-9A-Za-z*/,-]+$/;

/**
 * Validate and normalise a backup config. An absent field takes the default;
 * a present one that is not valid throws (a retention of 0 or NaN is a
 * mistake to surface, never a number to quietly replace).
 *
 * @param {{schedule?: string, retentionDays?: number|string}} [backupConfig]
 * @returns {{schedule: string, retentionDays: number}}
 */
export function resolveBackupSettings(backupConfig) {
  const rawSchedule = backupConfig?.schedule;
  const schedule = String(
    rawSchedule === undefined || rawSchedule === null || rawSchedule === ''
      ? DEFAULT_BACKUP_SCHEDULE
      : rawSchedule,
  ).trim();
  const fields = schedule.split(/\s+/);
  if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) {
    throw new Error(
      `backup schedule ${JSON.stringify(schedule)} is not a 5-field cron expression (minute hour day month weekday)`,
    );
  }
  const rawDays = backupConfig?.retentionDays;
  const days =
    rawDays === undefined || rawDays === null || rawDays === ''
      ? DEFAULT_BACKUP_RETENTION_DAYS
      : typeof rawDays === 'string' && /^[0-9]+$/.test(rawDays)
        ? Number(rawDays)
        : rawDays;
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(
      `backup retention ${JSON.stringify(rawDays)} is not a positive whole number of days`,
    );
  }
  return { schedule: fields.join(' '), retentionDays: days };
}

/** The CronJob manifest with its `{{BACKUP_SCHEDULE}}` filled in. */
export function renderBackupCronJob(template, settings) {
  if (!template.includes('{{BACKUP_SCHEDULE}}')) {
    throw new Error('the backup CronJob manifest has no {{BACKUP_SCHEDULE}} to fill in');
  }
  return template.replaceAll('{{BACKUP_SCHEDULE}}', settings.schedule);
}

/** The per-cluster settings ConfigMap, as YAML. */
export function renderBackupSettingsConfigMap(settings) {
  return [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    `  name: ${BACKUP_SETTINGS_CONFIGMAP}`,
    '  labels:',
    '    app: vibecarbon-backup',
    '    component: backup',
    '  annotations:',
    '    kustomize.toolkit.fluxcd.io/prune: disabled',
    'data:',
    `  BACKUP_RETENTION_DAYS: "${settings.retentionDays}"`,
    '',
  ].join('\n');
}

/** Both objects for a `k8s/base` directory, one YAML stream. */
export function renderBackupManifests(baseDir, settings) {
  const template = readFileSync(join(baseDir, 'backup', 'cronjob.yaml'), 'utf-8');
  return `${renderBackupCronJob(template, settings).trimEnd()}\n---\n${renderBackupSettingsConfigMap(settings)}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { BACKUP_SCHEDULE, BACKUP_RETENTION_DAYS } = process.env;
  if (!BACKUP_SCHEDULE || !BACKUP_RETENTION_DAYS) {
    console.error(
      'BACKUP_SCHEDULE and BACKUP_RETENTION_DAYS are not set for this environment. ' +
        'Run `vibecarbon configure cicd <env>` from the project to seed them, then re-run this workflow.',
    );
    process.exit(1);
  }
  try {
    const settings = resolveBackupSettings({
      schedule: BACKUP_SCHEDULE,
      retentionDays: BACKUP_RETENTION_DAYS,
    });
    process.stdout.write(renderBackupManifests(process.argv[2] || 'k8s/base', settings));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
