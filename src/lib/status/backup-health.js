/**
 * Backup and WAL archiving health for `vibecarbon status` (one "Backups" row).
 *
 * What it reads, and from where:
 * - the newest base backup, from the RECORDED lineage (`backup.lineage`,
 *   readEnvBaseBackups with `live: true`). A live read never resolves, so an
 *   ambiguous or unrestored lineage (a restore question) cannot stop status;
 * - `pg_stat_archiver` and the 24 h count of `WAL_ARCHIVE_FAILED` lines, from
 *   the role primary (resolvePrimary), never a retired HA side. The count
 *   matters because wal-archive.sh exits 0 after giving up on a segment, so
 *   postgres' own failed_count cannot see those drops;
 * - on k8s, the newest finished backup Job (exit 3 = base pushed, retention
 *   failed).
 *
 * Read-only. Without backup credentials the row is "unknown", naming the
 * variables (never values): status is a health read, not a gate.
 */
import { existsSync } from 'node:fs';
import { DEFAULT_BACKUP_SCHEDULE } from '../../../carbon/scripts/render-backup-settings.mjs';
import { resolvePrimary } from '../cli/resolve-primary.js';
import { getPostgresPod, getSSHKeyPath, sshKubectl, sshRun } from '../ssh.js';
import { backupCredentialVars, readEnvBaseBackups } from '../walg/restore-base.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** archive_timeout in the shipped db (compose and k8s both set 900). */
export const ARCHIVE_TIMEOUT_SECONDS = 900;
const NAMESPACE = 'vibecarbon';
const PROBE_TIMEOUT_MS = 10_000;

/** One numeric cron field as the set of values it matches, or null if unreadable. */
function cronField(field, min, max) {
  const out = new Set();
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) return null;
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      hi = b ?? (m[2] ? max : a);
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * The longest gap between two runs of a 5-field cron schedule, in ms, or null
 * when it uses names or syntax this reader does not know (the age check then
 * has no limit to apply, rather than a guessed one).
 *
 * @param {string} schedule
 * @returns {number | null}
 */
export function cronIntervalMs(schedule) {
  const f = String(schedule).trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minute = cronField(f[0], 0, 59);
  const hour = cronField(f[1], 0, 23);
  const dom = cronField(f[2], 1, 31);
  const month = cronField(f[3], 1, 12);
  const dow = cronField(f[4].replace(/7/g, '0'), 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return null;
  // Walk two years of days from a Monday-aligned start; the longest gap wins.
  const start = Date.UTC(2026, 0, 5);
  let last = null;
  let longest = 0;
  for (let d = 0; d < 800; d++) {
    const day = new Date(start + d * DAY);
    const domStar = f[2] === '*';
    const dowStar = f[4] === '*';
    const domOk = dom.has(day.getUTCDate());
    const dowOk = dow.has(day.getUTCDay());
    const dayOk = domStar || dowStar ? domOk && dowOk : domOk || dowOk;
    if (!dayOk || !month.has(day.getUTCMonth() + 1)) continue;
    for (const h of [...hour].sort((a, b) => a - b)) {
      for (const m of [...minute].sort((a, b) => a - b)) {
        const at = day.getTime() + h * HOUR + m * MINUTE;
        if (last !== null) longest = Math.max(longest, at - last);
        last = at;
      }
    }
  }
  return longest > 0 ? longest : null;
}

/** "5m", "2h", or "3 days": coarse and readable. */
function ageText(ms) {
  const m = Math.max(0, Math.round(ms / MINUTE));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)} days`;
}

/**
 * The row's verdict and text from already-gathered facts. Pure.
 *
 * @param {{ lineage: string, schedule: string, backups: Array<{ name?: string, finishTime: Date }>, archiver: { lastArchivedAgeSeconds: number|null, failedCount: number } | null, walFailures: number | null, job: { name: string, failed: boolean, retentionFailed?: boolean } | null, unrestoredPrior?: string|null, unknown?: string[], now?: number }} i
 * @returns {{ level: 'ok'|'warn'|'error', text: string }}
 */
export function backupHealthRow(i) {
  const now = i.now ?? Date.now();
  const bad = [];
  const warn = [];
  const good = [];

  const interval = cronIntervalMs(i.schedule);
  const newest = i.backups.at(-1);
  if (!newest) {
    bad.push(`no base backup in lineage ${i.lineage}`);
  } else {
    const age = now - newest.finishTime.getTime();
    if (interval !== null && age > 2 * interval) bad.push(`newest base backup ${ageText(age)} old`);
    else good.push(`newest base ${ageText(age)} old`);
  }

  if (i.archiver) {
    const secs = i.archiver.lastArchivedAgeSeconds;
    if (secs === null || secs < 0) warn.push('no WAL archived yet');
    else if (secs > 2 * ARCHIVE_TIMEOUT_SECONDS) {
      bad.push(`last WAL archived ${ageText(secs * 1000)} ago`);
    } else good.push(`WAL archived ${secs < 60 ? `${secs}s` : ageText(secs * 1000)} ago`);
    if (i.archiver.failedCount > 0)
      warn.push(`${i.archiver.failedCount} archiver failures (lifetime)`);
  }
  if (i.walFailures > 0) bad.push(`${i.walFailures} WAL_ARCHIVE_FAILED in 24h`);

  if (i.job?.failed) {
    bad.push(
      `last scheduled backup job ${i.job.name} failed${i.job.retentionFailed ? ' (base pushed, retention failed)' : ''}`,
    );
  }
  for (const u of i.unknown ?? []) warn.push(u);
  if (i.unrestoredPrior) {
    warn.push(
      `an older lineage ${i.unrestoredPrior} holds bases a deploy replaced; a bare restore will refuse, pass -lineage`,
    );
  }

  const level = bad.length ? 'error' : warn.length ? 'warn' : 'ok';
  return { level, text: `backups: ${[...bad, ...warn, ...good].join(', ')}` };
}

/** Read-only probes against the role primary, over this env's transport. */
function primaryProbes(envName, envConfig, projectName, primary) {
  const isCompose = envConfig.deployMode === 'compose' || envConfig.deployMode === 'compose-ha';
  const key = () => {
    const path = getSSHKeyPath(envName);
    if (!existsSync(path)) throw new Error('no ssh key for this environment');
    return path;
  };
  const kubectl = (argv) => sshKubectl(primary.ip, key(), argv, { timeout: PROBE_TIMEOUT_MS });
  return {
    runOnPrimary: async (ip, sql) => {
      if (isCompose) {
        return sshRun(
          ip,
          key(),
          [
            'bash',
            '-lc',
            `cd /opt/${projectName} && docker compose exec -T db psql -U postgres -d postgres -tAc "${sql}"`,
          ],
          { timeout: PROBE_TIMEOUT_MS, transportRetry: false },
        );
      }
      const pod = await getPostgresPod(ip, key());
      return sshKubectl(
        ip,
        key(),
        [
          'exec',
          '-n',
          NAMESPACE,
          pod,
          '--',
          'psql',
          '-U',
          'postgres',
          '-d',
          'postgres',
          '-tAc',
          sql,
        ],
        { timeout: PROBE_TIMEOUT_MS },
      );
    },
    // The archive wrapper logs WAL_ARCHIVE_FAILED to the db's own stderr.
    countWalFailures: async (ip) => {
      if (isCompose) {
        const out = await sshRun(
          ip,
          key(),
          [
            'bash',
            '-lc',
            `cd /opt/${projectName} && (docker compose logs --no-color --since 24h db 2>&1 | grep -c WAL_ARCHIVE_FAILED || true)`,
          ],
          { timeout: PROBE_TIMEOUT_MS, transportRetry: false },
        );
        return Number.parseInt(out.trim().split('\n').pop(), 10) || 0;
      }
      const pod = await getPostgresPod(ip, key());
      const logs = await sshKubectl(ip, key(), ['logs', '-n', NAMESPACE, pod, '--since=24h'], {
        timeout: PROBE_TIMEOUT_MS,
      });
      return String(logs)
        .split('\n')
        .filter((l) => l.includes('WAL_ARCHIVE_FAILED')).length;
    },
    // The newest finished scheduled backup Job (k8s only; compose runs cron).
    lastJob: async () => {
      if (isCompose) return null;
      const out = await kubectl(['get', 'jobs', '-n', NAMESPACE, '-o', 'json']);
      const jobs = (JSON.parse(out || '{"items":[]}').items ?? [])
        .filter((j) => String(j.metadata?.name).startsWith('backup'))
        .map((j) => {
          const done = (j.status?.conditions ?? []).find(
            (c) => (c.type === 'Failed' || c.type === 'Complete') && c.status === 'True',
          );
          return { j, done };
        })
        .filter((x) => x.done)
        .sort((a, b) =>
          String(b.j.metadata.creationTimestamp).localeCompare(
            String(a.j.metadata.creationTimestamp),
          ),
        );
      const newest = jobs[0];
      if (!newest) return null;
      return {
        name: newest.j.metadata.name,
        failed: newest.done.type === 'Failed',
        // podFailurePolicy fails the Job at once on exit 3 (base pushed, retention failed).
        retentionFailed: newest.done.reason === 'PodFailurePolicy',
      };
    },
  };
}

/**
 * The Backups row for one environment: `{ level, text, ...facts }` or null
 * when nothing is deployed. Never throws on a failed probe; the row says so.
 *
 * @param {string} envName
 * @param {object} envConfig
 * @param {string} projectName
 * @param {object} [deps] test seams
 */
export async function checkBackupHealth(envName, envConfig, projectName, deps = {}) {
  const primary = resolvePrimary(envConfig, { env: envName });
  if (!primary?.ip) return null;

  const readBases = deps.readBases ?? readEnvBaseBackups;
  const credentialVars = deps.credentialVars ?? backupCredentialVars;
  let listing;
  try {
    listing = await readBases({
      envName,
      envConfig,
      projectName,
      skipPrompts: true,
      live: true,
    });
  } catch (err) {
    return { level: 'warn', text: `backups: unknown (${err.message})` };
  }
  if (!listing.s3Config) {
    return {
      level: 'warn',
      text: `backups: unknown (backup credentials not set: ${credentialVars(envConfig)})`,
    };
  }

  const probes = deps.runOnPrimary ? deps : primaryProbes(envName, envConfig, projectName, primary);
  const sql =
    'SELECT coalesce(extract(epoch from now() - last_archived_time)::bigint, -1), failed_count FROM pg_stat_archiver';
  const [archiver, walFailures, job] = await Promise.allSettled([
    probes.runOnPrimary(primary.ip, sql),
    probes.countWalFailures(primary.ip),
    probes.lastJob(),
  ]);

  const unknown = [];
  let archiverFacts = null;
  if (archiver.status === 'fulfilled') {
    const [age, failed] = String(archiver.value).trim().split('\n')[0].split('|');
    archiverFacts = {
      lastArchivedAgeSeconds: Number.parseInt(age, 10),
      failedCount: Number.parseInt(failed, 10) || 0,
    };
    if (Number.isNaN(archiverFacts.lastArchivedAgeSeconds)) {
      archiverFacts = null;
      unknown.push('WAL archiving unknown (pg_stat_archiver gave no answer)');
    }
  } else unknown.push(`WAL archiving unknown (${archiver.reason?.message ?? archiver.reason})`);
  if (walFailures.status === 'rejected') {
    unknown.push(
      `WAL_ARCHIVE_FAILED count unknown (${walFailures.reason?.message ?? walFailures.reason})`,
    );
  }
  if (job.status === 'rejected') {
    unknown.push(`backup job status unknown (${job.reason?.message ?? job.reason})`);
  }

  const facts = {
    lineage: listing.lineage,
    schedule: envConfig.backup?.schedule || DEFAULT_BACKUP_SCHEDULE,
    backups: listing.backups,
    archiver: archiverFacts,
    walFailures: walFailures.status === 'fulfilled' ? walFailures.value : null,
    job: job.status === 'fulfilled' ? job.value : null,
    unrestoredPrior: envConfig.backup?.unrestoredPrior ?? null,
    unknown,
    now: deps.now,
  };
  const row = backupHealthRow(facts);
  const newest = listing.backups.at(-1);
  return {
    ...row,
    lineage: facts.lineage,
    newestBaseAt: newest ? newest.finishTime.toISOString() : null,
    baseCount: listing.backups.length,
    lastArchivedAgeSeconds: archiverFacts?.lastArchivedAgeSeconds ?? null,
    archiverFailedCount: archiverFacts?.failedCount ?? null,
    walArchiveFailures24h: facts.walFailures,
    lastJob: facts.job,
    unrestoredPrior: facts.unrestoredPrior,
  };
}
