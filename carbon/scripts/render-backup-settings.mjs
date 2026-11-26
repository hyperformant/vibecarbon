/**
 * The backup schedule and retention a k8s cluster runs with, and the two
 * objects that carry them. The vibecarbon CLI imports this module when it
 * applies a cluster (applyK3sManifests), from `envConfig.backup`; on a GitOps
 * cluster too, where `vibecarbon deploy <env>` applies them.
 *
 * The settings are per environment, but the committed `k8s/base` is shared by
 * every environment Flux reconciles from the same branch, so they cannot live
 * there. The backup CronJob is therefore DEPLOY-owned: Flux's vibecarbon-base
 * Kustomization drops it (`$patch: delete`, k8s/flux/clusters/*), and the
 * retention days live in a per-cluster ConfigMap that is in no manifest tree.
 */

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

/** Our mirrored kubectl, by digest: the only shape `{{KUBECTL_IMAGE}}` may take. */
const KUBECTL_IMAGE = /^ghcr\.io\/hyperformant\/k8s:[0-9.]+@sha256:[a-f0-9]{64}$/;

/**
 * The CronJob manifest with its `{{BACKUP_SCHEDULE}}` filled in, and its
 * `{{KUBECTL_IMAGE}}` when `settings.kubectlImage` carries one (the CLI deploy
 * has already rendered it).
 */
export function renderBackupCronJob(template, settings) {
  if (!template.includes('{{BACKUP_SCHEDULE}}')) {
    throw new Error('the backup CronJob manifest has no {{BACKUP_SCHEDULE}} to fill in');
  }
  const { kubectlImage } = settings;
  if (kubectlImage && !KUBECTL_IMAGE.test(kubectlImage)) {
    throw new Error('KUBECTL_IMAGE is not our mirrored kubectl, pinned by digest');
  }
  const rendered = template.replaceAll('{{BACKUP_SCHEDULE}}', settings.schedule);
  return kubectlImage ? rendered.replaceAll('{{KUBECTL_IMAGE}}', kubectlImage) : rendered;
}

/** A plain `s3://<bucket>/<path>` folder: safe as a YAML scalar and as kubectl exec argv. */
const TLS_SNAPSHOT_PREFIX = /^s3:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+$/;

/**
 * The per-cluster settings ConfigMap, as YAML. `settings.tlsSnapshotPrefix`
 * (tlsSnapshotS3Prefix in src/lib/deploy/tls-snapshot.js) is where the backup
 * CronJob saves the vibecarbon-tls Secret; without it no snapshot is taken.
 */
export function renderBackupSettingsConfigMap(settings) {
  const prefix = settings.tlsSnapshotPrefix;
  if (prefix && !TLS_SNAPSHOT_PREFIX.test(prefix)) {
    throw new Error(
      `TLS snapshot prefix ${JSON.stringify(prefix)} is not an s3://<bucket>/<path> folder`,
    );
  }
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
    ...(prefix ? [`  TLS_SNAPSHOT_S3_PREFIX: "${prefix}"`] : []),
    '',
  ].join('\n');
}
