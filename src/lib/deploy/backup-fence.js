/**
 * The backup-prefix fence (HA-correctness final review I1).
 *
 * The retirement fence (retired-fence.js) only works on a node the CLI can
 * reach: it places markers the node's own scripts check. An old primary that
 * stays unreachable through the failover and then reboots on its own still
 * reads WALG_ROLE=primary, out of recovery, and its archive_command and backup
 * cron push WAL, base backups and a `delete retain` into the shared prefix,
 * where LATEST can become its stale timeline.
 *
 * So failover also writes a fence object into the env's backup prefix, which
 * stays reachable when the old primary is dead: `vibecarbon-fence.json` at the
 * root of WALG_S3_PREFIX, the database lineage's own folder that walg-env.sh
 * exports (a promoted standby and its old primary are one lineage), read and
 * written with `wal-g st` from inside the db container after sourcing that
 * file (its prefix and AWS_* are the ones every push uses):
 *
 *   { "primaryNode", "systemIdentifier", "timeline", "switchSegment", "at" }
 *
 * It names the primary's database (system identifier), its timeline at the
 * moment it became primary, and the segment that timeline branched in. A
 * promotion always moves to a new timeline and the old primary never does, so
 * every push path refuses when the fence names its database on a newer
 * timeline than its own: wal-archive.sh (both tiers, by the pushed segment's
 * own timeline), backup/compose-backup.sh and the k8s backup CronJob (by the
 * current WAL insert timeline). The archive wrapper still lets through what
 * the parent timeline shares with the new one: parent-timeline segments
 * before the switch segment (an old primary's archive backlog at the moment of
 * a planned failover, which a refusal would turn into a gap every
 * pre-failover backup needs), and the .history and .partial files a promotion
 * itself archives. The switch point comes from the new timeline's history
 * file; when it cannot be read the fence records none and exempts nothing. No fence object means an env
 * that never failed over: allowed. Another system identifier is another
 * database (a destroyed and recreated env): allowed. `wal-g delete garbage` and
 * `delete retain` only touch basebackups_005/ and wal_005/, never the root
 * (verified on postgres:17.11-walg3.0.9-r2 against MinIO).
 *
 * Written BEFORE the DNS flip and the role-swap save of every failover, by
 * `failover -abort` for the primary it keeps, and by every HA deploy that
 * finishes, from the role primary (so a reconverge or a recreated database
 * moves it along). A failed write warns: the fence is a second line behind the
 * retirement fence, never a reason to strand a promoted primary behind DNS.
 */

import * as p from '@clack/prompts';
import { loadProjectConfig, saveProjectConfig } from '../config.js';
import { sshKubectl } from '../ssh.js';
import { WALG_ENV_SOURCE } from '../walg/restore-layout.js';
import { sshRun } from './compose/index.js';
import { DB_CONTAINER, DB_POD } from './db-workload.js';
import { k8sPsqlRunner } from './replication.js';

/** The fence object, at the root of WALG_S3_PREFIX (the lineage folder). */
export const BACKUP_FENCE_OBJECT = 'vibecarbon-fence.json';

/** The line every push path prints when the fence refuses it. */
export const BACKUP_FENCE_REFUSAL = 'backup prefix fenced to another primary';

/**
 * The fenced primary's identity: `sysid|timeline-hex`. pg_walfile_name of the
 * insert position carries the current timeline in its first 8 hex digits, even
 * right after a promotion (pg_control_checkpoint lags until a checkpoint). No
 * string literals, so it survives every psql transport's quoting. Errors on a
 * server in recovery, which is never a primary to fence to.
 */
export const BACKUP_FENCE_STATE_SQL =
  'SELECT (SELECT system_identifier FROM pg_control_system()), ' +
  'substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8)';

/**
 * The switch point of the current timeline, from its own history file
 * (pg_wal/<tli>.history, whose last line is `<parent tli>\t<switch LSN>\t...`),
 * as `parent|segment` with the segment number (16 hex) that holds the switch
 * LSN. The history file is the durable record: pg_last_wal_replay_lsn() reads
 * NULL once the promoted server restarts. Errors on a timeline with no history
 * (a primary that never promoted), which leaves the fence with no switch point.
 * Dollar-quoted, no single quote, so it nests in `'...'` and kubectl argv.
 * Verified on postgres:17.11-walg3.0.9-r2: a standby promoted at 0/4000060
 * reads `1|0000000000000004`, before and after a restart.
 */
export const BACKUP_FENCE_SWITCH_SQL =
  'WITH h AS (SELECT string_to_array(rtrim(pg_read_file($$pg_wal/$$ || ' +
  'substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8) || $$.history$$), chr(10)), chr(10)) AS a) ' +
  'SELECT split_part(a[array_length(a, 1)], chr(9), 1) || chr(124) || ' +
  'substr(pg_walfile_name(split_part(a[array_length(a, 1)], chr(9), 2)::pg_lsn), 9, 16) FROM h';

/**
 * Parse BACKUP_FENCE_STATE_SQL's row.
 *
 * @param {unknown} out
 * @returns {{ systemIdentifier: string, timeline: number } | null}
 */
export function parseBackupFenceState(out) {
  const row = String(out ?? '')
    .trim()
    .split('\n')
    .pop();
  const [sysid, tl] = (row ?? '').split('|').map((s) => s.trim());
  if (!/^\d+$/.test(sysid ?? '') || !/^[0-9A-Fa-f]{8}$/.test(tl ?? '')) return null;
  const timeline = Number.parseInt(tl, 16);
  return timeline > 0 ? { systemIdentifier: sysid, timeline } : null;
}

/**
 * Parse BACKUP_FENCE_SWITCH_SQL's row into the switch segment, or null unless
 * it names exactly the parent of `timeline` (anything else fails closed: the
 * fence then exempts nothing).
 *
 * @param {unknown} out
 * @param {number} timeline
 * @returns {string|null}
 */
export function parseBackupFenceSwitch(out, timeline) {
  const row = String(out ?? '')
    .trim()
    .split('\n')
    .pop();
  const m = /^(\d+)\|([0-9A-Fa-f]{16})$/.exec((row ?? '').trim());
  if (!m || Number(m[1]) !== timeline - 1) return null;
  return m[2].toUpperCase();
}

/**
 * The `sh` script that writes the fence from inside the db container. The JSON
 * travels base64-encoded (no quote of any kind in the script, so it nests in
 * the ssh and kubectl transports). walg-env.sh first, so the fence lands in
 * this database lineage's folder, where its own push paths read it. A db with
 * no backup target (empty or bucketless prefix, as wal-archive.sh reads it)
 * has nothing to fence.
 *
 * @param {object} fence
 * @returns {string}
 */
export function backupFenceWriteScript(fence) {
  const b64 = Buffer.from(`${JSON.stringify(fence)}\n`).toString('base64');
  const tmp = `/tmp/${BACKUP_FENCE_OBJECT}`;
  return [
    WALG_ENV_SOURCE,
    'case "$WALG_S3_PREFIX" in ""|s3:///*) echo FENCE_SKIPPED; exit 0;; esac',
    `echo ${b64} | base64 -d > ${tmp}`,
    `wal-g st put --no-compress --no-encrypt -f ${tmp} ${BACKUP_FENCE_OBJECT} >/dev/null 2>&1 || exit 1`,
    `rm -f ${tmp}`,
    'echo FENCE_WRITTEN',
  ].join('; ');
}

/**
 * Write the fence naming the database `exec` reaches as the primary.
 *
 * @param {object} args
 * @param {(sql: string) => Promise<string>} args.exec - psql on the primary
 * @param {(script: string) => Promise<unknown>} args.runInDb - `sh -c` in its db container
 * @param {string} args.primaryNode - name or address, for the operator
 * @param {() => Date} [args.now]
 * @returns {Promise<{ ok: true, skipped?: true, fence?: object } | { ok: false, reason: string }>}
 */
export async function writeBackupFence({ exec, runInDb, primaryNode, now = () => new Date() }) {
  let state;
  try {
    state = parseBackupFenceState(await exec(BACKUP_FENCE_STATE_SQL));
  } catch {
    state = null;
  }
  if (!state) {
    return { ok: false, reason: "could not read the primary's system identifier and timeline" };
  }
  let switchSegment = null;
  try {
    switchSegment = parseBackupFenceSwitch(await exec(BACKUP_FENCE_SWITCH_SQL), state.timeline);
  } catch {
    switchSegment = null;
  }
  const fence = { primaryNode, ...state, switchSegment, at: now().toISOString() };
  let out;
  try {
    out = String((await runInDb(backupFenceWriteScript(fence))) ?? '');
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err).split('\n')[0] };
  }
  if (out.includes('FENCE_SKIPPED')) return { ok: true, skipped: true };
  if (!out.includes('FENCE_WRITTEN')) {
    return { ok: false, reason: 'wal-g st put did not confirm the write' };
  }
  return { ok: true, fence };
}

/**
 * The `ha.backupFence` record for a write result: `{ written: false, at,
 * reason }` after a failure (status shows it until a write lands), `{ written:
 * true, at }` after a success (`skipped: true` when the db has no backup
 * target, so there is nothing to fence).
 *
 * @param {{ ok: boolean, skipped?: boolean, reason?: string }} result
 * @param {() => Date} [now]
 * @returns {{ written: boolean, at: string, reason?: string, skipped?: true }}
 */
export function backupFenceRecord(result, now = () => new Date()) {
  const at = now().toISOString();
  if (!result?.ok) return { written: false, at, reason: result?.reason ?? 'unknown' };
  return { written: true, at, ...(result.skipped && { skipped: true }) };
}

/**
 * Persist a write result as `ha.backupFence`, through a fresh config load (the
 * failover and deploy paths save mid-run). A save that fails warns only: the
 * record is an operator hint, never a reason to fail the run.
 *
 * @param {{ environment: string }} ctx
 * @param {{ ok: boolean, skipped?: boolean, reason?: string }} result
 * @returns {object} the record
 */
export function recordBackupFence(ctx, result) {
  const record = backupFenceRecord(result);
  try {
    const config = loadProjectConfig();
    const envConfig = config?.environments?.[ctx.environment];
    if (!envConfig) return record;
    envConfig.ha = {
      ...(typeof envConfig.ha === 'object' ? envConfig.ha : {}),
      backupFence: record,
    };
    saveProjectConfig(config);
  } catch (err) {
    p.log.warn(
      `could not record the backup-prefix fence outcome in .vibecarbon.json ` +
        `(${String(err?.message ?? err).split('\n')[0]})`,
    );
  }
  return record;
}

/**
 * The `vibecarbon status` row for a fence the last write could not land, or
 * null when it landed (or none was ever attempted).
 *
 * @param {object} envConfig
 * @returns {string|null}
 */
export function backupFenceRow(envConfig) {
  const rec = envConfig?.ha?.backupFence;
  if (rec?.written !== false) return null;
  return (
    `not written (${rec.reason}): an old primary that comes back unreached could still push ` +
    'backups into the shared prefix. run vibecarbon deploy to write it'
  );
}

/**
 * The warning for a fence that could not be written.
 *
 * @param {string} primaryNode
 * @param {string} reason
 * @returns {string}
 */
export function backupFenceWarning(primaryNode, reason) {
  return (
    `could not write the backup-prefix fence for ${primaryNode} (${reason}). an old primary ` +
    'that comes back unreached could push backups into the shared prefix until vibecarbon ' +
    'status or deploy fences it'
  );
}

/**
 * Write the fence from a compose node's db container. BACKUP_FENCE_STATE_SQL
 * and the write script carry no single quote, so both nest in `'...'`.
 *
 * @param {{ ip: string, sshKeyPath: string, projectName: string, primaryNode?: string, deps?: object }} args
 */
export function writeComposeBackupFence({ ip, sshKeyPath, projectName, primaryNode, deps = {} }) {
  const { run = sshRun } = deps;
  const remoteDir = `/opt/${projectName}`;
  return writeBackupFence({
    primaryNode: primaryNode ?? ip,
    exec: async (sql) => {
      const out = await run(
        ip,
        sshKeyPath,
        `cd ${remoteDir} && docker compose exec -T db psql -U postgres -d postgres -tAc '${sql}'`,
        { silent: true, timeout: 20_000 },
      );
      return typeof out === 'string' ? out : '';
    },
    runInDb: (script) =>
      run(ip, sshKeyPath, `cd ${remoteDir} && docker compose exec -T db sh -c '${script}'`, {
        silent: true,
        timeout: 60_000,
      }),
  });
}

/**
 * Write the fence from a k8s cluster's db pod.
 *
 * @param {{ ip: string, sshKeyPath: string, primaryNode?: string, deps?: object }} args
 */
export function writeK8sBackupFence({ ip, sshKeyPath, primaryNode, deps = {} }) {
  const {
    psql = (host) => k8sPsqlRunner(host, sshKeyPath),
    kubectl = (host, argv, opts) => sshKubectl(host, sshKeyPath, argv, opts),
  } = deps;
  return writeBackupFence({
    primaryNode: primaryNode ?? ip,
    exec: psql(ip),
    runInDb: (script) =>
      kubectl(
        ip,
        ['-n', 'vibecarbon', 'exec', DB_POD, '-c', DB_CONTAINER, '--', 'sh', '-c', script],
        {
          timeout: 60_000,
        },
      ),
  });
}
