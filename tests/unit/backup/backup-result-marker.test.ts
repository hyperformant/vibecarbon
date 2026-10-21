/**
 * Every backup script run that exits 0 says what it did: exactly one
 * `BACKUP_RESULT=pushed:<name>` or `BACKUP_RESULT=skipped:<reason>` line on
 * stdout. Before this, a skip (no S3 target, a standby, a db in recovery,
 * another backup holding the lock) exited 0 exactly like a push, so destroy
 * and scale read "no backup was taken" as "backed up".
 *
 * The scripts run for real here, with bash (their shebang, and the
 * `bash backup/compose-backup.sh` invocation composeBackupCmd builds), against
 * stub `wal-g`, `psql` and `flock` binaries and a `docker` / `kubectl` shim
 * that runs the in-container part locally: the stub-binary pattern of
 * tests/unit/deploy/backup-fence.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { parseBackupResult, pushedBackupNames } from '../../../src/lib/walg/backup-result.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const COMPOSE_BACKUP = join(ROOT, 'carbon/backup/compose-backup.sh');
const CRONJOB = join(ROOT, 'carbon/k8s/base/backup/cronjob.yaml');
const NAME = 'base_000000020000000000000007';

describe('parseBackupResult', () => {
  it('reads a pushed name or a skip reason from the one marker line', () => {
    expect(parseBackupResult(`…\nBACKUP_RESULT=pushed:${NAME}\n`)).toEqual({
      result: 'pushed',
      name: NAME,
    });
    expect(parseBackupResult('BACKUP_RESULT=skipped:standby-role\n')).toEqual({
      result: 'skipped',
      reason: 'standby-role',
    });
    // CRLF from a container log stream reads the same.
    expect(parseBackupResult(`x\r\nBACKUP_RESULT=pushed:${NAME}\r\n`)).toEqual({
      result: 'pushed',
      name: NAME,
    });
  });

  it('throws on zero markers, two markers, or an unknown result', () => {
    expect(() => parseBackupResult('no marker')).toThrow(/no BACKUP_RESULT/);
    expect(() => parseBackupResult('')).toThrow(/no BACKUP_RESULT/);
    expect(() => parseBackupResult(undefined)).toThrow(/no BACKUP_RESULT/);
    expect(() =>
      parseBackupResult(`BACKUP_RESULT=pushed:${NAME}\nBACKUP_RESULT=skipped:in-recovery\n`),
    ).toThrow(/2 BACKUP_RESULT/);
    expect(() => parseBackupResult('BACKUP_RESULT=done:x\n')).toThrow(/BACKUP_RESULT/);
    expect(() => parseBackupResult('BACKUP_RESULT=pushed:\n')).toThrow(/BACKUP_RESULT/);
  });

  it('pushedBackupNames lists every pushed name in a log (a retried job may push twice)', () => {
    expect(
      pushedBackupNames(
        `BACKUP_RESULT=pushed:base_1\nretention failed\nBACKUP_RESULT=pushed:base_2\nBACKUP_RESULT=skipped:in-recovery\n`,
      ),
    ).toEqual(['base_1', 'base_2']);
    expect(pushedBackupNames('nothing')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The scripts, run against stubs
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'vc-bresult-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

type Stub = {
  recovery?: 't' | 'f';
  /**
   * stderr wal-g backup-push prints. The default is what wal-g 3.0.9 logs
   * (verified on postgres:17.11-walg3.0.9-r2): a Started line, then the Wrote
   * line that only a finished push prints.
   */
  pushOutput?: string;
  pushFails?: boolean;
  retainFails?: boolean;
  /** The fence object disappears when `delete before` runs. */
  fenceVanishes?: boolean;
  lockHeld?: boolean;
  fence?: string | null;
  /** The bases wal-g backup-list reports, by age in days (finish time = now - age). */
  bases?: Array<{ name: string; ageDays: number }>;
};

/** Bases the stub lists by default: 10 days old, 3 days old, just pushed. */
const OLD = 'base_000000010000000000000001';
const MID = 'base_000000010000000000000005';
const DEFAULT_BASES = [
  { name: OLD, ageDays: 10 },
  { name: MID, ageDays: 3 },
  { name: NAME, ageDays: 0 },
];

/** wal-g 3.0.9 backup-list --detail --json: one line, backup_name first (verified in Docker). */
function backupListJson(bases: Array<{ name: string; ageDays: number }>) {
  const iso = (ms: number) => new Date(ms).toISOString();
  return JSON.stringify(
    bases.map((b) => ({
      backup_name: b.name,
      time: iso(Date.now() - b.ageDays * 86_400_000 + 500),
      wal_file_name: b.name.slice(5),
      storage_name: 'default',
      start_time: iso(Date.now() - b.ageDays * 86_400_000 - 1500),
      finish_time: iso(Date.now() - b.ageDays * 86_400_000),
      date_fmt: '%Y-%m-%dT%H:%M:%S.%fZ',
      hostname: 'db',
      is_permanent: false,
    })),
  );
}

function stubs(name: string, opts: Stub) {
  const {
    recovery = 'f',
    pushOutput = [
      `INFO: 2026/10/21 02:00:00.000001 Started backup with name ${NAME} at LSN 0/7000028`,
      `INFO: 2026/10/21 02:00:01.123456 Wrote backup with name ${NAME} to storage default`,
    ].join('\n'),
    pushFails = false,
    retainFails = false,
    fenceVanishes = false,
    lockHeld = false,
    fence = null,
    bases = DEFAULT_BASES,
  } = opts;
  const bin = join(work, name);
  mkdirSync(bin, { recursive: true });
  const log = join(bin, 'walg.log');
  writeFileSync(log, '');
  writeFileSync(join(bin, 'fence-present'), '');
  writeFileSync(join(bin, 'list.json'), `${backupListJson(bases)}\n`);
  writeFileSync(
    join(bin, 'wal-g'),
    `#!/bin/bash
if [ "$1" = st ] && [ "$2" = cat ]; then
  ${fence !== null ? `[ -e ${join(bin, 'fence-present')} ] || { echo "ERROR: object 'p/vibecarbon-fence.json' not found in storage" >&2; exit 1; }` : ''}
  ${fence === null ? `echo "ERROR: object 'p/vibecarbon-fence.json' not found in storage" >&2; exit 1` : `printf '%s\\n' '${fence}'`}
  exit 0
fi
echo "$*" >> ${log}
if [ "$1" = backup-list ]; then cat ${join(bin, 'list.json')}; fi
if [ "$1" = backup-push ]; then
  ${pushFails ? 'echo "ERROR: pg_backup_start: permission denied" >&2; exit 1' : `printf '%s\\n' "${pushOutput}" >&2`}
fi
if [ "$1" = delete ] && [ "$2" = before ]; then
  ${fenceVanishes ? `rm -f ${join(bin, 'fence-present')}` : ''}
  ${retainFails ? 'echo "ERROR: failed to list s3 folder: AccessDenied" >&2; exit 1' : ''}
  :
fi
exit 0
`,
  );
  writeFileSync(
    join(bin, 'psql'),
    `#!/bin/bash
case "$*" in
  *pg_is_in_recovery*) echo ${recovery} ;;
  *system_identifier*) echo 7699032860122738725 ;;
  *pg_walfile_name*) echo 00000001 ;;
esac
`,
  );
  writeFileSync(join(bin, 'flock'), `#!/bin/bash\nexit ${lockHeld ? 1 : 0}\n`);
  writeFileSync(
    join(bin, 'pg_controldata'),
    '#!/bin/sh\necho "Database system identifier:           7699032860122738725"\n',
  );
  writeFileSync(join(bin, 'docker'), '#!/bin/bash\nshift 4\nexec "$@"\n');
  writeFileSync(
    join(bin, 'kubectl'),
    '#!/bin/bash\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
  );
  for (const f of ['wal-g', 'psql', 'flock', 'docker', 'kubectl', 'pg_controldata']) {
    chmodSync(join(bin, f), 0o755);
  }
  return { bin, walg: () => readFileSync(log, 'utf-8') };
}

const baseEnv = (bin: string): Record<string, string> => ({
  PATH: `${bin}:${process.env.PATH}`,
  // walg-env.sh (the real file) turns the base into the lineage folder, with
  // pg_controldata stubbed below.
  WALG_S3_PREFIX_BASE: 's3://bkt/backups/p/e/walg',
  WALG_ENV_SH: join(ROOT, 'carbon/volumes/db/walg-env.sh'),
  AWS_ACCESS_KEY_ID: 'k',
  AWS_SECRET_ACCESS_KEY: 's',
  PGDATA: join(work, 'pgdata-none'),
  RETAIN: '2',
  BACKUP_RETENTION_DAYS: '2',
});

const markers = (out: string) => out.split('\n').filter((l) => l.startsWith('BACKUP_RESULT='));

function runCompose(
  name: string,
  opts: Stub = {},
  env: Record<string, string> = {},
  { retired = false } = {},
) {
  const st = stubs(`compose-${name}`, opts);
  const dir = join(work, `proj-${name}`);
  mkdirSync(join(dir, 'backup'), { recursive: true });
  writeFileSync(join(dir, 'backup/compose-backup.sh'), readFileSync(COMPOSE_BACKUP));
  if (retired) writeFileSync(join(dir, '.vibecarbon-retired'), '');
  const r = spawnSync('bash', ['backup/compose-backup.sh'], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...baseEnv(st.bin), ...env },
    timeout: 10_000,
  });
  return { ...r, walg: st.walg() };
}

function runCron(name: string, opts: Stub = {}, env: Record<string, string> = {}) {
  const st = stubs(`k8s-${name}`, opts);
  const cron = loadYaml(readFileSync(CRONJOB, 'utf-8')) as {
    spec: {
      jobTemplate: { spec: { template: { spec: { containers: Array<{ command: string[] }> } } } };
    };
  };
  const script = cron.spec.jobTemplate.spec.template.spec.containers[0].command[2];
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf-8',
    env: { ...baseEnv(st.bin), ...env },
    timeout: 10_000,
  });
  return { ...r, walg: st.walg() };
}

describe('compose-backup.sh prints one BACKUP_RESULT per exit-0 run', () => {
  it.each([
    ['no S3 target', {}, { WALG_S3_PREFIX_BASE: 's3:///backups/p/e/walg' }, 'no-s3-target'],
    ['empty S3 target', {}, { WALG_S3_PREFIX_BASE: '' }, 'no-s3-target'],
    ['no S3 credentials', {}, { AWS_SECRET_ACCESS_KEY: '' }, 'no-s3-credentials'],
    ['standby role', {}, { WALG_ROLE: 'standby' }, 'standby-role'],
    ['in recovery', { recovery: 't' as const }, {}, 'in-recovery'],
  ])('%s: exit 0, skipped, no push', (_label, opts, env, reason) => {
    const r = runCompose(reason + String(Object.keys(env).length), opts, env);
    expect(r.status, r.stderr).toBe(0);
    expect(markers(r.stdout)).toEqual([`BACKUP_RESULT=skipped:${reason}`]);
    expect(r.walg).not.toContain('backup-push');
  });

  it('another backup holds the lock: skipped:already-running, exit 75 (EX_TEMPFAIL)', () => {
    const r = runCompose('locked', { lockHeld: true });
    expect(r.status).toBe(75);
    expect(markers(r.stdout)).toEqual(['BACKUP_RESULT=skipped:already-running']);
    expect(r.walg).toBe('');
  });

  it('success: pushed with the name from wal-g backup-push, then retention runs', () => {
    const r = runCompose('ok');
    expect(r.status, r.stderr).toBe(0);
    expect(markers(r.stdout)).toEqual([`BACKUP_RESULT=pushed:${NAME}`]);
    expect(parseBackupResult(r.stdout)).toEqual({ result: 'pushed', name: NAME });
    expect(r.walg).toMatch(
      /backup-push[\s\S]*delete garbage BACKUPS[\s\S]*delete before FIND_FULL \S+ --confirm/,
    );
  });

  it('a retention failure after the push: exit 3, the pushed marker stands, the cause names the base', () => {
    const r = runCompose('retain-fail', { retainFails: true });
    // 3, not 1: the one exit code that means "the base landed, retention did
    // not" (the CronJob fails the Job on it instead of re-pushing).
    expect(r.status).toBe(3);
    expect(markers(r.stdout)).toEqual([`BACKUP_RESULT=pushed:${NAME}`]);
    expect(r.stderr).toContain(`retention failed after pushing ${NAME}: `);
    expect(r.stderr).toContain('AccessDenied');
  });

  it('a failed push: exit 1, no marker', () => {
    const r = runCompose('push-fail', { pushFails: true });
    expect(r.status).toBe(1);
    expect(markers(r.stdout)).toEqual([]);
    expect(r.stderr).toContain('permission denied');
    expect(r.walg).not.toContain('delete');
  });

  it('a push that names no backup: exit 1, no marker (nothing proves what landed)', () => {
    const r = runCompose('no-name', { pushOutput: 'INFO: done' });
    expect(r.status).toBe(1);
    expect(markers(r.stdout)).toEqual([]);
    expect(r.stderr).toMatch(/printed no backup name/);
    expect(r.walg).not.toContain('delete');
  });

  it('a Started line alone is not a pushed base: exit 1, no marker', () => {
    const r = runCompose('started-only', {
      pushOutput: `INFO: 2026/10/21 02:00:00.000001 Started backup with name ${NAME} at LSN 0/7000028`,
    });
    expect(r.status).toBe(1);
    expect(markers(r.stdout)).toEqual([]);
    expect(r.walg).not.toContain('delete');
  });

  it('the retired-node refusal: exit 1, no marker, wal-g never runs', () => {
    const r = runCompose('retired', {}, {}, { retired: true });
    expect(r.status).toBe(1);
    expect(markers(r.stdout)).toEqual([]);
    expect(r.stderr).toContain('retired node: backups refused');
    expect(r.walg).toBe('');
  });

  it('the backup-prefix fence refusals: exit 1, no marker', () => {
    const fenced = JSON.stringify({ systemIdentifier: '7699032860122738725', timeline: 2 });
    const a = runCompose('fenced', { fence: fenced });
    expect(a.status).toBe(1);
    expect(markers(a.stdout)).toEqual([]);
    expect(a.stderr).toContain('backup prefix fenced to another primary');
    const b = runCompose('fence-garbage', { fence: '{"garbage":true}' });
    expect(b.status).toBe(1);
    expect(markers(b.stdout)).toEqual([]);
    expect(b.stderr).toContain('could not compare this node with the backup-prefix fence');
  });
});

describe('the backup CronJob prints the same markers', () => {
  it('standby role and in-recovery skip with their reasons', () => {
    const a = runCron('standby', {}, { WALG_ROLE: 'standby' });
    expect(a.status, a.stderr).toBe(0);
    expect(markers(a.stdout)).toEqual(['BACKUP_RESULT=skipped:standby-role']);
    const b = runCron('recovery', { recovery: 't' });
    expect(b.status, b.stderr).toBe(0);
    expect(markers(b.stdout)).toEqual(['BACKUP_RESULT=skipped:in-recovery']);
    expect(b.walg).not.toContain('backup-push');
  });

  it('success prints the pushed name; a retention failure keeps it and exits 3', () => {
    const ok = runCron('ok');
    expect(ok.status, ok.stderr).toBe(0);
    expect(markers(ok.stdout)).toEqual([`BACKUP_RESULT=pushed:${NAME}`]);
    const bad = runCron('retain-fail', { retainFails: true });
    expect(bad.status).toBe(3);
    expect(markers(bad.stdout)).toEqual([`BACKUP_RESULT=pushed:${NAME}`]);
    expect(bad.stderr).toContain(`retention failed after pushing ${NAME}: `);
  });

  it('the retired refusal and a nameless push exit 1 with no marker', () => {
    const r = runCron('retired', {}, { VIBECARBON_ROLE: 'retired' });
    expect(r.status).toBe(1);
    expect(markers(r.stdout)).toEqual([]);
    const n = runCron('no-name', { pushOutput: 'INFO: done' });
    expect(n.status).toBe(1);
    expect(markers(n.stdout)).toEqual([]);
    const st = runCron('started-only', {
      pushOutput: `INFO: 2026/10/21 02:00:00.000001 Started backup with name ${NAME} at LSN 0/7000028`,
    });
    expect(st.status).toBe(1);
    expect(markers(st.stdout)).toEqual([]);
  });
});

/**
 * Retention is by time and keeps the full window: the target is the newest base
 * that finished at or before now minus RETAIN days, and `wal-g delete before
 * FIND_FULL <that base>` keeps it and its WAL. No base that old: no delete, and
 * the newest base always survives (proved against the real wal-g in
 * tests/integration/docker/db-restore-staged.test.ts).
 */
describe('retention deletes by time, inside the current lineage', () => {
  const deletes = (walg: string) =>
    walg
      .split('\n')
      .filter((l) => l.startsWith('delete before '))
      .map((l) => l.match(/^delete before FIND_FULL (\S+) --confirm$/)?.[1] ?? l);

  it.each([
    ['compose', (b?: Stub['bases']) => runCompose('time-compose', { bases: b })],
    ['k8s CronJob', (b?: Stub['bases']) => runCron('time-cron', { bases: b })],
  ])(
    '%s: sweeps orphans, lists, then deletes before the newest base at least RETAIN days old',
    (_t, run) => {
      const r = run();
      expect(r.status, r.stderr).toBe(0);
      expect(r.walg).toMatch(
        /delete garbage BACKUPS --confirm\nbackup-list --detail --json\ndelete before FIND_FULL \S+ --confirm/,
      );
      expect(r.walg).not.toMatch(/retain/);
      // RETAIN is 2: the 3-day-old base, not the 10-day-old one and not the new one.
      expect(deletes(r.walg)).toEqual([MID]);
      // Nothing reaches the delete but the base name (no bare timestamp).
      expect(r.walg).not.toMatch(/delete before FIND_FULL \d{4}-/);
    },
  );

  it.each([
    ['compose', (b: Stub['bases']) => runCompose('young-compose', { bases: b })],
    ['k8s CronJob', (b: Stub['bases']) => runCron('young-cron', { bases: b })],
  ])('%s: no base that old, no delete; the run still succeeds', (_t, run) => {
    for (const bases of [
      [{ name: NAME, ageDays: 0 }],
      [
        { name: MID, ageDays: 1 },
        { name: NAME, ageDays: 0 },
      ],
    ]) {
      const r = run(bases);
      expect(r.status, r.stderr).toBe(0);
      expect(markers(r.stdout)).toEqual([`BACKUP_RESULT=pushed:${NAME}`]);
      expect(deletes(r.walg)).toEqual([]);
      expect(r.stderr).toContain('nothing to delete');
    }
  });

  it('only old bases: the newest of them is the target, so it stays', () => {
    const r = runCompose('old-only', {
      bases: [
        { name: OLD, ageDays: 10 },
        { name: MID, ageDays: 3 },
      ],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(deletes(r.walg)).toEqual([MID]);
  });

  it('the scripts hold no count-based retention', () => {
    for (const file of [COMPOSE_BACKUP, CRONJOB]) {
      const code = readFileSync(file, 'utf-8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      expect(code, file).toContain('delete before FIND_FULL');
      expect(code, file).not.toMatch(/retain FULL/);
    }
  });

  it('RETAIN reaches the cutoff: 5 days picks the 10-day base, 20 days picks none', () => {
    const r = runCompose('time-5', {}, { RETAIN: '5' });
    expect(r.status, r.stderr).toBe(0);
    expect(deletes(r.walg)).toEqual([OLD]);
    const c = runCron('time-5', {}, { BACKUP_RETENTION_DAYS: '5' });
    expect(c.status, c.stderr).toBe(0);
    expect(deletes(c.walg)).toEqual([OLD]);
    const none = runCompose('time-20', {}, { RETAIN: '20' });
    expect(none.status, none.stderr).toBe(0);
    expect(deletes(none.walg)).toEqual([]);
  });

  it.each(['0', '-1', '7; rm -rf /', 'abc', '01', '2.5'])(
    'a RETAIN of %j is refused before any wal-g call',
    (bad) => {
      const a = runCompose(`bad-${bad.length}${bad.charCodeAt(0)}`, {}, { RETAIN: bad });
      expect(a.status).toBe(1);
      expect(a.stderr).toMatch(/RETAIN must be a positive whole number of days/);
      expect(a.walg).toBe('');
      const b = runCron(
        `bad-${bad.length}${bad.charCodeAt(0)}`,
        {},
        { BACKUP_RETENTION_DAYS: bad },
      );
      expect(b.status).toBe(1);
      expect(b.stderr).toMatch(/BACKUP_RETENTION_DAYS must be a positive whole number of days/);
      expect(b.walg).toBe('');
    },
  );

  it('the fence object surviving the delete is checked: unchanged passes, vanished is exit 3', () => {
    const fence = JSON.stringify({ systemIdentifier: '7699032860122738725', timeline: 1 });
    const ok = runCompose('fence-kept', { fence });
    expect(ok.status, ok.stderr).toBe(0);
    for (const run of [
      () => runCompose('fence-gone', { fence, fenceVanishes: true }),
      () => runCron('fence-gone', { fence, fenceVanishes: true }),
    ]) {
      const r = run();
      // The base landed; only retention failed: exit 3 with the marker kept.
      expect(r.status).toBe(3);
      expect(markers(r.stdout)).toEqual([`BACKUP_RESULT=pushed:${NAME}`]);
      expect(r.stderr).toContain('retention failed after pushing');
      expect(r.stderr).toContain('fence (vibecarbon-fence.json) changed or vanished');
    }
  });

  /**
   * The db image is Alpine: busybox date, tr, sed, awk and sort, no coreutils or
   * jq, so a relative date ("-7 days") is rejected and the cutoff and the list
   * parsing have to be plain POSIX. Run the scripts' own retention chain in the
   * pinned db image (its date is /bin/busybox) against a stub wal-g function.
   */
  const dockerUp = spawnSync('docker', ['info'], { timeout: 20_000 }).status === 0;
  const DB_IMAGE = 'ghcr.io/hyperformant/postgres:17.11-walg3.0.9-r2';
  it.skipIf(!dockerUp)(
    'the retention chain runs under the db image busybox and picks the right base',
    { timeout: 300_000 },
    () => {
      const chain = (src: string) => src.match(/retain_out="\$\( \{ (.*?) \} 2>&1\)"/s)?.[1] ?? '';
      const fromCompose = chain(readFileSync(COMPOSE_BACKUP, 'utf-8'));
      expect(fromCompose).toContain('delete before FIND_FULL');
      expect(chain(readFileSync(CRONJOB, 'utf-8'))).toBe(fromCompose);
      const script = [
        'wal-g() { case "$1" in backup-list) printf "%s\\n" "$LISTJSON";; *) echo "wal-g $*";; esac; }',
        'fence=""; RETAIN_DAYS=2',
        `{ ${fromCompose} } 2>&1`,
      ].join('\n');
      const name = `vcdate${process.pid}`;
      try {
        const r = spawnSync(
          'docker',
          [
            'run',
            '--rm',
            '--name',
            name,
            '-e',
            `LISTJSON=${backupListJson(DEFAULT_BASES)}`,
            '--entrypoint',
            'bash',
            DB_IMAGE,
            '-c',
            script,
          ],
          { encoding: 'utf-8', timeout: 280_000 },
        );
        expect(r.status, r.stderr + r.stdout).toBe(0);
        const out = r.stdout.split('\n').filter((l) => l.startsWith('wal-g '));
        expect(out).toEqual([
          'wal-g delete garbage BACKUPS --confirm',
          `wal-g delete before FIND_FULL ${MID} --confirm`,
        ]);
      } finally {
        spawnSync('docker', ['rm', '-f', '-v', name], { timeout: 30_000 });
      }
    },
  );
});

/**
 * A retention failure must not re-push. Under restartPolicy OnFailure the
 * container restarted and every attempt pushed another base. Now the pod
 * never restarts in place, and exit 3 (retention failed after a pushed base)
 * fails the Job at once through a podFailurePolicy rule; a failed push (exit
 * 1) still retries under backoffLimit. podFailurePolicy is GA in Kubernetes
 * 1.31, the line K3S_VERSION pins.
 */
describe('the backup Job fails, not retries, on a retention failure', () => {
  const cron = loadYaml(readFileSync(CRONJOB, 'utf-8')) as {
    spec: {
      jobTemplate: {
        spec: {
          backoffLimit: number;
          podFailurePolicy?: { rules: Array<Record<string, unknown>> };
          template: { spec: { restartPolicy: string } };
        };
      };
    };
  };
  const job = cron.spec.jobTemplate.spec;

  it('restartPolicy Never and a FailJob rule on exit 3 of the backup container', () => {
    expect(job.template.spec.restartPolicy).toBe('Never');
    expect(job.backoffLimit).toBeGreaterThan(0);
    expect(job.podFailurePolicy?.rules).toContainEqual({
      action: 'FailJob',
      onExitCodes: { containerName: 'backup', operator: 'In', values: [3] },
    });
  });

  it('the pinned k3s is on a line where podFailurePolicy is GA (>= 1.31)', async () => {
    const { K3S_VERSION } = await import('../../../src/lib/deploy/k8s/k3s.js');
    const [maj, min] = K3S_VERSION.replace(/^v/, '').split('.').map(Number);
    expect(maj * 100 + min).toBeGreaterThanOrEqual(131);
  });
});
