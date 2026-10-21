/**
 * Backup and WAL archiving health for `vibecarbon status` (one "Backups" row).
 *
 * What it reads, and from where:
 * - the newest base backup, from the RECORDED lineage (`backup.lineage`,
 *   readEnvBaseBackups with `live: true`). A live read never resolves, so an
 *   ambiguous or unrestored lineage (a restore question) cannot stop status;
 * - `pg_stat_archiver`, the 24 h count of segments wal-archive.sh gave up on
 *   (`WAL_ARCHIVE_DROPPED`, `WAL_ARCHIVE_OVERWRITE_REFUSED`) and the gap record
 *   (`$PGDATA/vibecarbon-wal-gap`, the segments it dropped under disk
 *   pressure), from the role primary (resolvePrimary), never a retired HA
 *   side. A push that fails is held (exit 1) and retried by postgres, which
 *   pg_stat_archiver shows; only a drop is invisible to it;
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
import { hasBackupResult, pushedBackupNames } from '../walg/backup-result.js';
import { backupCredentialVars, readEnvBaseBackups } from '../walg/restore-base.js';
import { PGDATA_PATH, WAL_GAP_RECORDS } from '../walg/restore-layout.js';

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

/** Segments per log file at the 16 MB default segment size. */
const SEGMENTS_PER_LOG = 0x100;

/**
 * Timeline and absolute segment number from a WAL file name. Takes the
 * leading 24 hex of a name that may carry a .history/.backup/.partial suffix.
 *
 * @param {string} name
 * @returns {{ timeline: number, segment: number } | null}
 */
export function parseWalName(name) {
  const m = /^([0-9A-Fa-f]{8})([0-9A-Fa-f]{8})([0-9A-Fa-f]{8})/.exec(String(name ?? '').trim());
  if (!m) return null;
  return {
    timeline: Number.parseInt(m[1], 16),
    segment: Number.parseInt(m[2], 16) * SEGMENTS_PER_LOG + Number.parseInt(m[3], 16),
  };
}

/**
 * The WAL verdict from pg_stat_archiver. An idle database keeps an old
 * last_archived_time (postgres only switches on archive_timeout when WAL was
 * written), so age alone proves nothing: caught up with the current segment is
 * healthy at any age. Red is a failure newer than the last success, or
 * segments pending with nothing archived for 2 x archive_timeout. Another
 * timeline cannot be compared, so only the failure check applies.
 */
function archiveVerdict(archiver) {
  const secs = archiver.lastArchivedAgeSeconds;
  const last = parseWalName(archiver.lastArchivedWal);
  const current = parseWalName(archiver.currentWal);
  const age = secs === null || secs < 0 ? null : secs < 60 ? `${secs}s` : ageText(secs * 1000);
  if (archiver.failing) {
    return {
      bad: `archiver failing (last failure is newer than the last archived WAL${age ? `, archived ${age} ago` : ''})`,
    };
  }
  if (!last) return { warn: 'no WAL archived yet' };
  if (!current || current.timeline !== last.timeline) {
    return { good: `WAL archived ${age} ago` };
  }
  const pending = current.segment - last.segment;
  if (pending <= 1) return { good: `WAL caught up (archived ${age} ago)` };
  if (secs > 2 * ARCHIVE_TIMEOUT_SECONDS) {
    return { bad: `last WAL archived ${age} ago, ${pending - 1} segments pending` };
  }
  return { good: `WAL archived ${age} ago` };
}

/**
 * The row's verdict and text from already-gathered facts. Pure.
 *
 * @param {{ lineage: string, schedule: string, backups: Array<{ name?: string, finishTime: Date }>, archiver: { lastArchivedAgeSeconds: number|null, lastArchivedWal: string, currentWal: string, failing: boolean } | null, walFailures: { count: number, overwrite?: number, lastAt?: Date|null, since?: Date|null } | null, walGap?: { count: number, first: string, last: string } | null, job: { name: string, failed: boolean, retentionFailed?: boolean, log?: boolean, detail?: string } | null, unrestoredPrior?: string|null, unknown?: string[], now?: number }} i
 * @returns {{ level: 'ok'|'warn'|'error', text: string }}
 */
export function backupHealthRow(i) {
  const now = i.now ?? Date.now();
  const bad = [];
  const warn = [];
  const good = [];

  const interval = cronIntervalMs(i.schedule);
  const newest = i.backups.at(-1);
  if (interval === null) warn.push('schedule unreadable, no age limit');
  if (!newest) {
    bad.push(`no base backup in lineage ${i.lineage}`);
  } else {
    const age = now - newest.finishTime.getTime();
    if (interval !== null && age > 2 * interval) bad.push(`newest base backup ${ageText(age)} old`);
    else good.push(`newest base ${ageText(age)} old`);
  }

  if (i.archiver) {
    const v = archiveVerdict(i.archiver);
    if (v.bad) bad.push(v.bad);
    if (v.warn) warn.push(v.warn);
    if (v.good) good.push(v.good);
  }

  // Segments dropped under disk pressure: the durable record, red until a
  // base pushed after them clears it.
  if (i.walGap) {
    const range =
      i.walGap.first === i.walGap.last ? i.walGap.first : `${i.walGap.first}..${i.walGap.last}`;
    bad.push(
      `WAL segments dropped under disk pressure: ${range}, a restore across them stops at the gap; take a fresh base backup`,
    );
  }

  // Segments wal-archive.sh gave up on, from the db log (pg_stat_archiver
  // cannot see a segment the wrapper exited 0 on). A drop is an open PITR gap
  // until a base backup lands after it. With the gap record shown, its own
  // drops (WAL_ARCHIVE_DROPPED) are not counted twice: only overwrite
  // refusals remain.
  const logged = i.walFailures;
  const drops =
    logged && i.walGap ? { ...logged, count: logged.overwrite ?? logged.count } : logged;
  if (drops && drops.count > 0) {
    const lastArchivedAt =
      i.archiver && i.archiver.lastArchivedAgeSeconds >= 0
        ? now - i.archiver.lastArchivedAgeSeconds * 1000
        : null;
    const at = drops.lastAt ? drops.lastAt.getTime() : null;
    const open =
      at === null ||
      lastArchivedAt === null ||
      at > lastArchivedAt ||
      !newest ||
      at > newest.finishTime.getTime();
    const window = drops.since ? `since ${drops.since.toISOString().slice(0, 16)}Z` : 'in 24h';
    if (open) bad.push(`${drops.count} WAL segments dropped ${window}`);
    else
      warn.push(
        `${drops.count} WAL segments dropped in the last 24h (a newer base backup covers them)`,
      );
  }

  if (i.job?.failed) {
    bad.push(
      i.job.log
        ? `last scheduled backup failed${i.job.retentionFailed ? ' (base pushed, retention failed)' : ''} (see backups/backup.log)${i.job.detail ? `: ${i.job.detail}` : ''}`
        : `last scheduled backup job ${i.job.name} failed${i.job.retentionFailed ? ' (base pushed, retention failed)' : ''}`,
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

const TS_RE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;

/** The wal-archive.sh lines that mean a segment was given up (exit 0, a PITR gap). */
const DROP_TAGS = ['WAL_ARCHIVE_DROPPED', 'WAL_ARCHIVE_OVERWRITE_REFUSED'];

/** The db-log grep for DROP_TAGS, as an extended regex. */
const DROP_GREP = `WAL_ARCHIVE_(DROPPED|OVERWRITE_REFUSED)`;

/**
 * The dropped-segment lines from `logs --timestamps` output (plus an optional
 * `STARTED=<iso>` line naming the container's start): WAL_ARCHIVE_DROPPED
 * (disk pressure) and WAL_ARCHIVE_OVERWRITE_REFUSED (`overwrite`). A
 * WAL_ARCHIVE_FAILED line is a held segment postgres retries, not a drop. The
 * count is labelled "since <start>" when the log cannot cover 24 h.
 *
 * @param {string} text
 * @param {{ now?: number, previousRead?: boolean }} [opts] previousRead: the prior container's log was read too, so a restart does not shorten coverage
 * @returns {{ count: number, overwrite: number, lastAt: Date|null, since: Date|null }}
 */
export function parseWalFailureLog(text, { now = Date.now(), previousRead = false } = {}) {
  let count = 0;
  let overwrite = 0;
  let lastAt = null;
  let started = null;
  for (const line of String(text ?? '').split('\n')) {
    const st = /^STARTED=(\S+)/.exec(line);
    if (st) {
      const d = new Date(st[1]);
      if (!Number.isNaN(d.getTime())) started = d;
      continue;
    }
    if (!DROP_TAGS.some((t) => line.includes(t))) continue;
    count += 1;
    if (line.includes('WAL_ARCHIVE_OVERWRITE_REFUSED')) overwrite += 1;
    const m = TS_RE.exec(line);
    if (m) {
      const d = new Date(m[1]);
      if (!lastAt || d > lastAt) lastAt = d;
    }
  }
  const since = !previousRead && started && now - started.getTime() < DAY ? started : null;
  return { count, overwrite, lastAt, since };
}

/** The read sentinel the gap probe prints after the record, so a failed read is never "no gap". */
const GAP_READ_OK = 'VC_OK';

/**
 * The shell that prints the gap record (and its aside copy while a base push
 * clears it), then the read sentinel. Runs in the db container.
 */
export const WAL_GAP_READ_SH = `cat ${WAL_GAP_RECORDS.map((n) => `${PGDATA_PATH}/${n}`).join(' ')} 2>/dev/null; echo ${GAP_READ_OK}`;

/**
 * The gap record: `<segment> <UTC time>` lines. Null when it is empty or
 * absent; throws when the sentinel is missing (the read did not complete).
 *
 * @param {string} text
 * @returns {{ count: number, first: string, last: string } | null}
 */
export function parseWalGapRecord(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.at(-1) !== GAP_READ_OK) throw new Error('the WAL gap record was unreadable');
  const segments = [
    ...new Set(
      lines
        .slice(0, -1)
        .map((l) => l.split(/\s+/)[0])
        .filter((seg) => parseWalName(seg)),
    ),
  ].sort();
  if (segments.length === 0) return null;
  return { count: segments.length, first: segments[0], last: segments.at(-1) };
}

const SECRETISH = /([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi;
const BEARER = /\b(Bearer|Basic)\s+\S+/gi;
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;

/** A log line with credential-shaped values (assignments, auth headers, URL userinfo) masked. */
function redact(line) {
  return line
    .replace(URL_CREDS, '$1<redacted>@')
    .replace(BEARER, '$1 <redacted>')
    .replace(SECRETISH, '$1=<redacted>');
}

/**
 * The newest scheduled compose backup from the tail of backups/backup.log.
 * Failed = the last "Started at" block ended without a BACKUP_RESULT marker
 * (and nothing is still running), or pushed a base and then lost retention.
 * Returns null when it succeeded, skipped, is running, or there is no block.
 *
 * @param {string} text tail of backup.log, then a `__RUNNING__=0|1` line
 * @returns {{ name: string, failed: true, retentionFailed: boolean, log: true, detail: string } | null}
 */
export function parseComposeBackupLog(text) {
  const running = /__RUNNING__=1/.test(text);
  const lines = String(text ?? '')
    .split('\n')
    .filter((l) => !l.startsWith('__RUNNING__='));
  const start = lines.findLastIndex((l) => l.startsWith('Started at'));
  if (start < 0) return null;
  const block = lines.slice(start);
  const blockText = block.join('\n');
  const marker = hasBackupResult(blockText);
  const completed = block.some((l) => l.startsWith('=== Backup completed'));
  const retentionFailed = pushedBackupNames(blockText).length > 0 && !completed;
  if (marker && !retentionFailed) return null;
  if (!marker && running) return null;
  const last = [...block].reverse().find((l) => l.trim() && !hasBackupResult(l));
  const detail = redact(last ?? '')
    .trim()
    .slice(0, 200);
  return { name: 'backup.log', failed: true, retentionFailed, log: true, detail };
}

/** The one pg_stat_archiver query: age, last archived WAL, current WAL, failing now. */
export const ARCHIVER_SQL =
  'SELECT coalesce(extract(epoch from now() - last_archived_time)::bigint, -1), ' +
  "coalesce(last_archived_wal, ''), pg_walfile_name(pg_current_wal_lsn()), " +
  'coalesce(last_failed_time > last_archived_time, last_failed_time IS NOT NULL) ' +
  'FROM pg_stat_archiver';

/** Parse ARCHIVER_SQL's `-tA` row. Null when psql gave no row. */
export function parseArchiverRow(out) {
  const line = String(out ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const [age, lastWal, currentWal, failing] = line.split('|');
  const secs = Number.parseInt(age, 10);
  if (Number.isNaN(secs)) return null;
  return {
    lastArchivedAgeSeconds: secs,
    lastArchivedWal: lastWal ?? '',
    currentWal: currentWal ?? '',
    failing: failing === 't',
  };
}

/** Read-only probes against the role primary, over this env's transport. */
function primaryProbes(envName, envConfig, projectName) {
  const isCompose = envConfig.deployMode === 'compose' || envConfig.deployMode === 'compose-ha';
  const remoteDir = `/opt/${projectName}`;
  const key = () => {
    const path = getSSHKeyPath(envName);
    if (!existsSync(path)) throw new Error('no ssh key for this environment');
    return path;
  };
  const opts = { timeout: PROBE_TIMEOUT_MS, transportRetry: false };
  const bash = (ip, script) => sshRun(ip, key(), ['bash', '-lc', script], opts);
  return {
    // The SQL goes in on stdin: no quoting layer between it and psql.
    runOnPrimary: async (ip, sql) => {
      if (isCompose) {
        return sshRun(
          ip,
          key(),
          [
            'bash',
            '-lc',
            `cd ${remoteDir} && docker compose exec -T db psql -U postgres -d postgres -tA`,
          ],
          { ...opts, input: sql },
        );
      }
      const pod = await getPostgresPod(ip, key());
      return sshKubectl(
        ip,
        key(),
        [
          'exec',
          '-i',
          '-n',
          NAMESPACE,
          pod,
          '--',
          'psql',
          '-U',
          'postgres',
          '-d',
          'postgres',
          '-tA',
        ],
        { timeout: PROBE_TIMEOUT_MS, input: sql },
      );
    },
    // The archive wrapper logs WAL_ARCHIVE_FAILED to the db's own stderr.
    countWalFailures: async (ip) => {
      if (isCompose) {
        const out = await bash(
          ip,
          `cd ${remoteDir} && cid="$(docker compose ps -q db)" && ` +
            'echo "STARTED=$(docker inspect -f \'{{.State.StartedAt}}\' "$cid")" && ' +
            `(docker compose logs --no-color -t --since 24h db 2>&1 | grep -E '${DROP_GREP}' || true)`,
        );
        return parseWalFailureLog(out);
      }
      const pod = await getPostgresPod(ip, key());
      const kube = (argv) => sshKubectl(ip, key(), argv, { timeout: PROBE_TIMEOUT_MS });
      const current = await kube(['logs', '-n', NAMESPACE, pod, '--timestamps', '--since=24h']);
      let previous = '';
      let previousRead = false;
      try {
        previous = await kube([
          'logs',
          '-n',
          NAMESPACE,
          pod,
          '--previous',
          '--timestamps',
          '--since=24h',
        ]);
        previousRead = true;
      } catch (err) {
        // A pod that never restarted has no previous container: not a finding.
        if (!/previous terminated container|not found/i.test(String(err?.message ?? err)))
          throw err;
      }
      const started = await kube([
        'get',
        'pod',
        '-n',
        NAMESPACE,
        pod,
        '-o',
        'jsonpath=STARTED={.status.containerStatuses[0].state.running.startedAt}',
      ]);
      return parseWalFailureLog(`${started}\n${previous}\n${current}`, { previousRead });
    },
    // Segments dropped under disk pressure (wal-archive.sh), in PGDATA.
    readWalGap: async (ip) => {
      if (isCompose) {
        return parseWalGapRecord(
          await bash(ip, `cd ${remoteDir} && docker compose exec -T db sh -c '${WAL_GAP_READ_SH}'`),
        );
      }
      const pod = await getPostgresPod(ip, key());
      return parseWalGapRecord(
        await sshKubectl(
          ip,
          key(),
          ['exec', '-n', NAMESPACE, pod, '--', 'sh', '-c', WAL_GAP_READ_SH],
          { timeout: PROBE_TIMEOUT_MS },
        ),
      );
    },
    // The newest finished scheduled backup: a k8s Job, or compose's cron log.
    lastJob: async (ip) => {
      if (isCompose) {
        const out = await bash(
          ip,
          // compose-backup.sh holds this lock for its whole run: held = running.
          `tail -n 40 ${remoteDir}/backups/backup.log 2>/dev/null; echo "__RUNNING__=$([ -e /tmp/vibecarbon-backup.lock ] && ! flock -n /tmp/vibecarbon-backup.lock true && echo 1 || echo 0)"`,
        );
        return parseComposeBackupLog(out);
      }
      const out = await sshKubectl(ip, key(), ['get', 'jobs', '-n', NAMESPACE, '-o', 'json'], {
        timeout: PROBE_TIMEOUT_MS,
      });
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

  const probes = deps.runOnPrimary ? deps : primaryProbes(envName, envConfig, projectName);
  const [archiver, walFailures, walGap, job] = await Promise.allSettled([
    probes.runOnPrimary(primary.ip, ARCHIVER_SQL),
    probes.countWalFailures(primary.ip),
    probes.readWalGap(primary.ip),
    probes.lastJob(primary.ip),
  ]);

  const unknown = [];
  let archiverFacts = null;
  if (archiver.status === 'fulfilled') {
    archiverFacts = parseArchiverRow(archiver.value);
    if (!archiverFacts) unknown.push('WAL archiving unknown (pg_stat_archiver gave no answer)');
  } else unknown.push(`WAL archiving unknown (${archiver.reason?.message ?? archiver.reason})`);
  if (walFailures.status === 'rejected') {
    unknown.push(
      `dropped WAL count unknown (${walFailures.reason?.message ?? walFailures.reason})`,
    );
  }
  if (walGap.status === 'rejected') {
    unknown.push(`WAL gap record unknown (${walGap.reason?.message ?? walGap.reason})`);
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
    walGap: walGap.status === 'fulfilled' ? walGap.value : null,
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
    archiverFailing: archiverFacts?.failing ?? null,
    walSegmentsDropped24h: facts.walFailures?.count ?? null,
    walGap: facts.walGap,
    lastJob: facts.job,
    unrestoredPrior: facts.unrestoredPrior,
  };
}
