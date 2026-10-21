/**
 * `vibecarbon status` Backups row (M5): newest base age in the recorded
 * lineage, last archived WAL and failures from the role primary, the 24 h
 * count of WAL segments wal-archive.sh gave up on, the durable record of the
 * segments it dropped under disk pressure, and the last scheduled backup Job.
 *
 * Since the final review ruling (e), wal-archive.sh holds a segment on a
 * failing bucket (exit 1, pg_stat_archiver shows it), so WAL_ARCHIVE_FAILED is
 * a retried attempt, not a drop. Only WAL_ARCHIVE_DROPPED (disk pressure,
 * recorded in $PGDATA/vibecarbon-wal-gap) and WAL_ARCHIVE_OVERWRITE_REFUSED
 * give a segment up.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVER_SQL,
  backupHealthRow,
  checkBackupHealth,
  composeRunningProbe,
  cronIntervalMs,
  parseArchiverRow,
  parseComposeBackupLog,
  parseWalFailureLog,
  parseWalGapRecord,
  parseWalName,
} from '../../../src/lib/status/backup-health.js';
import { attachBackups } from '../../../src/status.js';

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const HOUR = 3_600_000;
const SYSID = '7000000000000000001';
const base = (hoursAgo: number) => ({
  name: 'base_x',
  finishTime: new Date(NOW - hoursAgo * HOUR),
});

const WAL = (seg: number, tl = 1) =>
  `${tl.toString(16).padStart(8, '0')}${Math.floor(seg / 256)
    .toString(16)
    .padStart(8, '0')}${(seg % 256).toString(16).padStart(8, '0')}`;
const arch = (over = {}) => ({
  lastArchivedAgeSeconds: 120,
  lastArchivedWal: WAL(10),
  currentWal: WAL(10),
  failing: false,
  ...over,
});
const input = (over = {}) => ({
  lineage: SYSID,
  schedule: '0 3 * * *',
  backups: [base(2)],
  archiver: arch(),
  walFailures: null,
  walGap: null,
  job: null,
  unrestoredPrior: null,
  now: NOW,
  ...over,
});

describe('cronIntervalMs', () => {
  it('reads the longest gap of the schedule', () => {
    expect(cronIntervalMs('0 3 * * *')).toBe(24 * HOUR);
    expect(cronIntervalMs('0 */6 * * *')).toBe(6 * HOUR);
    expect(cronIntervalMs('15 2,14 * * *')).toBe(12 * HOUR);
    expect(cronIntervalMs('0 3 * * 0')).toBe(7 * 24 * HOUR);
  });
  it('is null for a schedule it cannot read', () => {
    expect(cronIntervalMs('0 3 * JAN *')).toBeNull();
  });
});

describe('backupHealthRow', () => {
  it('a fresh base with recent WAL is green', () => {
    const r = backupHealthRow(input());
    expect(r.level).toBe('ok');
    expect(r.text).toContain('newest base 2h old');
    expect(r.text).toContain('archived 2m ago');
  });

  it('a 3-day-old base on a daily schedule is red', () => {
    const r = backupHealthRow(input({ backups: [base(72)] }));
    expect(r.level).toBe('error');
    expect(r.text).toContain('newest base backup 3 days old');
  });

  it('no base in the lineage is red and names the lineage', () => {
    const r = backupHealthRow(input({ backups: [] }));
    expect(r.level).toBe('error');
    expect(r.text).toContain(`no base backup in lineage ${SYSID}`);
  });

  it('an idle caught-up db with an old archive time is green', () => {
    const r = backupHealthRow(
      input({ archiver: arch({ lastArchivedAgeSeconds: 86_400, currentWal: WAL(11) }) }),
    );
    expect(r.level).toBe('ok');
    expect(r.text).toContain('WAL caught up');
  });

  it('pending segments and an old archive time is red', () => {
    const r = backupHealthRow(
      input({ archiver: arch({ lastArchivedAgeSeconds: 1801, currentWal: WAL(13) }) }),
    );
    expect(r.level).toBe('error');
    expect(r.text).toContain('last WAL archived 30m ago, 2 segments pending');
  });

  it('pending segments but a recent archive is green', () => {
    const r = backupHealthRow(
      input({ archiver: arch({ lastArchivedAgeSeconds: 300, currentWal: WAL(13) }) }),
    );
    expect(r.level).toBe('ok');
  });

  it('a failure newer than the last archive is red', () => {
    const r = backupHealthRow(input({ archiver: arch({ failing: true }) }));
    expect(r.level).toBe('error');
    expect(r.text).toContain('archiver failing');
  });

  it('an old failure followed by a successful archive is not yellow', () => {
    expect(backupHealthRow(input({ archiver: arch({ failing: false }) })).level).toBe('ok');
  });

  it('another timeline skips the comparison: old age is not red, a failure still is', () => {
    const other = arch({ lastArchivedAgeSeconds: 86_400, currentWal: WAL(900, 2) });
    expect(backupHealthRow(input({ archiver: other })).level).toBe('ok');
    expect(backupHealthRow(input({ archiver: { ...other, failing: true } })).level).toBe('error');
  });

  it('segment arithmetic crosses a log file (0x100 segments)', () => {
    const r = backupHealthRow(
      input({ archiver: arch({ lastArchivedWal: WAL(255), currentWal: WAL(256) }) }),
    );
    expect(r.text).toContain('WAL caught up');
  });

  it('an unreadable schedule is yellow and applies no age limit', () => {
    const r = backupHealthRow(input({ schedule: '0 3 * JAN *', backups: [base(9000)] }));
    expect(r.level).toBe('warn');
    expect(r.text).toContain('schedule unreadable, no age limit');
  });

  it('drops after the last archive are red; labelled since the container start when short', () => {
    const lastAt = new Date(NOW - 60_000);
    const r = backupHealthRow(
      input({
        walFailures: { count: 4, lastAt, since: new Date('2026-10-21T10:00:00Z') },
      }),
    );
    expect(r.level).toBe('error');
    expect(r.text).toContain('4 WAL segments dropped since 2026-10-21T10:00Z');
  });

  it('drops with a later archive and a later base are yellow, recovered', () => {
    const r = backupHealthRow(
      input({
        backups: [base(1)],
        archiver: arch({ lastArchivedAgeSeconds: 60 }),
        walFailures: { count: 3, lastAt: new Date(NOW - 5 * HOUR), since: null },
      }),
    );
    expect(r.level).toBe('warn');
    expect(r.text).toContain(
      '3 WAL segments dropped in the last 24h (a newer base backup covers them)',
    );
  });

  it('a drop older than both the last archive and the newest base is yellow, not red', () => {
    const r = backupHealthRow(
      input({
        backups: [base(2)],
        archiver: arch({ lastArchivedAgeSeconds: 60 }),
        walFailures: { count: 1, lastAt: new Date(NOW - 3 * HOUR), since: null },
      }),
    );
    expect(r.level).toBe('warn');
    expect(r.text).not.toContain('since 20');
  });

  it('the gap record is red, names the dropped range, and says what fixes it', () => {
    const r = backupHealthRow(
      input({
        walGap: { count: 3, first: WAL(12), last: WAL(14) },
        walFailures: { count: 3, overwrite: 0, lastAt: new Date(NOW - 60_000), since: null },
      }),
    );
    expect(r.level).toBe('error');
    expect(r.text).toContain(
      `WAL segments dropped under disk pressure: ${WAL(12)}..${WAL(14)}, a restore across them stops at the gap; take a fresh base backup`,
    );
    // The log lines for those same drops are not counted a second time.
    expect(r.text).not.toContain('3 WAL segments dropped');
  });

  it('with the gap record, overwrite refusals in the log still show', () => {
    const r = backupHealthRow(
      input({
        walGap: { count: 1, first: WAL(12), last: WAL(12) },
        walFailures: { count: 3, overwrite: 2, lastAt: new Date(NOW - 60_000), since: null },
      }),
    );
    expect(r.text).toContain(`WAL segments dropped under disk pressure: ${WAL(12)},`);
    expect(r.text).toContain('2 WAL segments dropped in 24h');
  });

  it('a drop newer than the newest base stays red even after archiving recovered', () => {
    const r = backupHealthRow(
      input({
        backups: [base(10)],
        archiver: arch({ lastArchivedAgeSeconds: 60 }),
        walFailures: { count: 1, lastAt: new Date(NOW - 5 * HOUR), since: null },
      }),
    );
    expect(r.level).toBe('error');
  });

  it('a failed scheduled job is red; exit 3 says retention failed after a push', () => {
    const r = backupHealthRow(
      input({ job: { name: 'backup-29', failed: true, retentionFailed: true } }),
    );
    expect(r.level).toBe('error');
    expect(r.text).toContain('last scheduled backup job backup-29 failed');
    expect(r.text).toContain('base pushed, retention failed');
  });

  it('shows unrestoredPrior and names -lineage', () => {
    const r = backupHealthRow(input({ unrestoredPrior: '7000000000000000000' }));
    expect(r.level).toBe('warn');
    expect(r.text).toContain('bare restore will refuse');
    expect(r.text).toContain('-lineage');
    expect(r.text).toContain('7000000000000000000');
  });

  it('never prints credential values', () => {
    const r = backupHealthRow(input());
    expect(JSON.stringify(r)).not.toMatch(/secret|AKIA/i);
  });
});

const composeHa = (extra = {}) => ({
  deployMode: 'compose-ha',
  provider: 'hetzner',
  backup: { lineage: SYSID, schedule: '0 3 * * *' },
  ha: { primary: { masterIp: '10.0.0.1' } },
  servers: [
    { ip: '10.0.0.1', name: 'a', role: 'primary' },
    { ip: '10.0.0.2', name: 'b', role: 'standby' },
  ],
  ...extra,
});

function deps(over: Record<string, unknown> = {}) {
  const calls: { listed: unknown[]; ssh: string[] } = { listed: [], ssh: [] };
  return {
    calls,
    deps: {
      now: NOW,
      readBases: async (args: Record<string, unknown>) => {
        calls.listed.push(args);
        return { s3Config: { bucket: 'b' }, lineage: SYSID, backups: [base(1)] };
      },
      runOnPrimary: async (ip: string, sql: string) => {
        calls.ssh.push(ip);
        return sql === ARCHIVER_SQL ? `60|${WAL(10)}|${WAL(10)}|f` : '';
      },
      countWalFailures: async (ip: string) => {
        calls.ssh.push(ip);
        return { count: 0, lastAt: null, since: null };
      },
      readWalGap: async (ip: string) => {
        calls.ssh.push(ip);
        return null;
      },

      lastJob: async () => null,
      credentialVars: () => 'HCLOUD_S3_ACCESS_KEY and HCLOUD_S3_SECRET_KEY',
      ...over,
    },
  };
}

describe('checkBackupHealth', () => {
  it('reads the recorded lineage live, and only from the role primary', async () => {
    const { deps: d, calls } = deps();
    const r = await checkBackupHealth('prod', composeHa(), 'proj', d);
    expect(r?.level).toBe('ok');
    expect(calls.listed[0]).toMatchObject({ live: true, skipPrompts: true, envName: 'prod' });
    expect(calls.ssh.every((ip) => ip === '10.0.0.1')).toBe(true);
  });

  it('a retired HA side is never the source: ha.primary decides, whatever servers[] order says', async () => {
    const { deps: d, calls } = deps();
    const env = composeHa({
      ha: { primary: { masterIp: '10.0.0.2' } },
      servers: [
        { ip: '10.0.0.1', name: 'a', role: 'standby' },
        { ip: '10.0.0.2', name: 'b', role: 'primary' },
      ],
    });
    await checkBackupHealth('prod', env, 'proj', d);
    expect(calls.ssh.every((ip) => ip === '10.0.0.2')).toBe(true);
  });

  it('without backup credentials: yellow unknown naming the variables, never a throw', async () => {
    const { deps: d } = deps({
      readBases: async () => ({ s3Config: null, lineage: null, backups: [] }),
    });
    const r = await checkBackupHealth('prod', composeHa(), 'proj', d);
    expect(r?.level).toBe('warn');
    expect(r?.text).toBe(
      'backups: unknown (backup credentials not set: HCLOUD_S3_ACCESS_KEY and HCLOUD_S3_SECRET_KEY)',
    );
  });

  it('stale last-archived WAL and a dropped-segment count surface in the row', async () => {
    const { deps: d } = deps({
      runOnPrimary: async () => `4000|${WAL(10)}|${WAL(20)}|f`,
      countWalFailures: async () => ({ count: 7, lastAt: null, since: null }),
    });
    const r = await checkBackupHealth('prod', composeHa(), 'proj', d);
    expect(r?.level).toBe('error');
    expect(r?.text).toContain('segments pending');
    expect(r?.text).toContain('7 WAL segments dropped in 24h');
  });

  it('the gap record is read from the role primary and turns the row red', async () => {
    const { deps: d, calls } = deps({
      readWalGap: async (ip: string) => {
        calls.ssh.push(ip);
        return { count: 1, first: WAL(5), last: WAL(5) };
      },
    });
    const r = await checkBackupHealth('prod', composeHa(), 'proj', d);
    expect(r?.level).toBe('error');
    expect(r?.walGap).toEqual({ count: 1, first: WAL(5), last: WAL(5) });
    expect(calls.ssh.every((ip) => ip === '10.0.0.1')).toBe(true);
  });

  it('an unreadable gap record is yellow unknown, never green', async () => {
    const { deps: d } = deps({
      readWalGap: async () => {
        throw new Error('exec failed');
      },
    });
    const r = await checkBackupHealth('prod', composeHa(), 'proj', d);
    expect(r?.level).toBe('warn');
    expect(r?.text).toContain('WAL gap record unknown (exec failed)');
  });

  it('a probe that throws is reported in the row, not thrown', async () => {
    const { deps: d } = deps({
      runOnPrimary: async () => {
        throw new Error('ssh timed out');
      },
    });
    const r = await checkBackupHealth('prod', composeHa(), 'proj', d);
    expect(r?.level).toBe('warn');
    expect(r?.text).toContain('WAL archiving unknown (ssh timed out)');
  });

  it('nothing deployed: no row', async () => {
    const { deps: d } = deps();
    expect(
      await checkBackupHealth('prod', { deployMode: 'compose', servers: [] }, 'proj', d),
    ).toBeNull();
  });
});

describe('parsers', () => {
  it('parseWalName takes the leading 24 hex of .history/.backup/.partial names', () => {
    expect(parseWalName(`${WAL(3)}.00000028.backup`)).toEqual({ timeline: 1, segment: 3 });
    expect(parseWalName(`${WAL(300, 2)}.partial`)).toEqual({ timeline: 2, segment: 300 });
    expect(parseWalName('00000002.history')).toBeNull();
    expect(parseWalName('')).toBeNull();
  });

  it('parseArchiverRow reads the -tA row', () => {
    expect(parseArchiverRow(`60|${WAL(1)}|${WAL(2)}|t`)).toMatchObject({
      lastArchivedAgeSeconds: 60,
      failing: true,
    });
    expect(parseArchiverRow('')).toBeNull();
  });

  it('parseWalFailureLog counts drops (not held retries), finds the newest, labels short coverage', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    const out = parseWalFailureLog(
      [
        'STARTED=2026-10-21T09:00:00Z',
        'db-1  | 2026-10-21T10:00:00.5Z WAL_ARCHIVE_DROPPED: a',
        // A held segment is retried by postgres: pg_stat_archiver reports it.
        'db-1  | 2026-10-21T10:30:00Z WAL_ARCHIVE_FAILED: wal-g wal-push x failed after 3 attempts; keeping the segment, postgres retries it',
        'db-1  | 2026-10-21T11:00:00Z WAL_ARCHIVE_OVERWRITE_REFUSED: b',
      ].join('\n'),
      { now },
    );
    expect(out.count).toBe(2);
    expect(out.overwrite).toBe(1);
    expect(out.lastAt?.toISOString()).toBe('2026-10-21T11:00:00.000Z');
    expect(out.since?.toISOString()).toBe('2026-10-21T09:00:00.000Z');
    expect(
      parseWalFailureLog('STARTED=2026-10-21T09:00:00Z', { now, previousRead: true }).since,
    ).toBeNull();
    expect(parseWalFailureLog('STARTED=2026-10-01T09:00:00Z', { now }).since).toBeNull();
  });

  it('parseWalGapRecord reads the first and last dropped segment, needs the read sentinel', () => {
    expect(parseWalGapRecord('VC_OK\n')).toBeNull();
    expect(
      parseWalGapRecord(
        `${WAL(14)} 2026-10-21T10:02:00Z\n${WAL(12)} 2026-10-21T10:00:00Z\n${WAL(13)} 2026-10-21T10:01:00Z\nVC_OK\n`,
      ),
    ).toEqual({ count: 3, first: WAL(12), last: WAL(14) });
    expect(() => parseWalGapRecord(`${WAL(12)} 2026-10-21T10:00:00Z\n`)).toThrow(/unreadable/);
  });
});

describe('compose scheduled backup log', () => {
  const ok = [
    'Started at x',
    'Retain: 30 days',
    'BACKUP_RESULT=pushed:base_1',
    '=== Backup completed at y',
  ];
  it('a pushed or skipped marker shows as today (no failure)', () => {
    expect(parseComposeBackupLog(`${ok.join('\n')}\n__RUNNING__=0`)).toBeNull();
    expect(
      parseComposeBackupLog('Started at x\nBACKUP_RESULT=skipped:standby-role\n__RUNNING__=0'),
    ).toBeNull();
  });
  it('a block with no marker that is not running failed: last stderr line only, secrets redacted', () => {
    const r = parseComposeBackupLog(
      'Started at old\nBACKUP_RESULT=pushed:b\n=== Backup completed\nStarted at x\nRetain: 30\nboom AWS_SECRET_ACCESS_KEY=abc123 fail\n__RUNNING__=0',
    );
    expect(r).toMatchObject({ failed: true, retentionFailed: false });
    expect(r?.detail).toBe('boom AWS_SECRET_ACCESS_KEY=<redacted> fail');
    expect(r?.detail).not.toContain('abc123');
  });
  it('redacts bearer tokens and credentials in URLs too', () => {
    const r = parseComposeBackupLog(
      'Started at x\ncurl -H Authorization: Bearer eyJhbGciOi.tok https://ak:sk123@s3.example.com/b fail\n__RUNNING__=0',
    );
    expect(r?.detail).not.toContain('eyJhbGciOi.tok');
    expect(r?.detail).not.toContain('sk123');
    expect(r?.detail).toContain('Bearer <redacted>');
    expect(r?.detail).toContain('https://<redacted>@s3.example.com/b');
  });
  it('a block still running is not a failure', () => {
    expect(parseComposeBackupLog('Started at x\nRetain: 30\n__RUNNING__=1')).toBeNull();
  });
  it('pushed then retention failed (no completed line) is a failure', () => {
    const r = parseComposeBackupLog(
      'Started at x\nBACKUP_RESULT=pushed:b\nretention failed after pushing b: nope\n__RUNNING__=0',
    );
    expect(r).toMatchObject({ failed: true, retentionFailed: true });
  });
  it('the row names backups/backup.log', () => {
    const job = parseComposeBackupLog('Started at x\nboom\n__RUNNING__=0');
    const r = backupHealthRow(input({ job }));
    expect(r.level).toBe('error');
    expect(r.text).toContain('last scheduled backup failed (see backups/backup.log): boom');
  });
});

describe('--json', () => {
  it('carries checks.backups', async () => {
    const { deps: d } = deps();
    const value = await checkBackupHealth('prod', composeHa(), 'proj', d);
    const checks = {};
    attachBackups(checks, { status: 'fulfilled', value });
    const json = JSON.parse(JSON.stringify({ environments: { prod: { checks } } }));
    expect(json.environments.prod.checks.backups).toMatchObject({
      level: 'ok',
      lineage: SYSID,
      baseCount: 1,
      walSegmentsDropped24h: 0,
      walGap: null,
    });
    expect(readFileSync(join(__dirname, '../../../src/status.js'), 'utf8')).toContain(
      'JSON.stringify(allData',
    );
  });
});

describe('census: backup reads take their target from the recorded primary/lineage', () => {
  const src = readFileSync(join(__dirname, '../../../src/lib/status/backup-health.js'), 'utf8');
  const status = readFileSync(join(__dirname, '../../../src/status.js'), 'utf8');

  it('every ssh/kubectl/psql call in backup-health.js targets the resolvePrimary ip', () => {
    expect(src).toContain('resolvePrimary(');
    expect(src).not.toMatch(/servers\s*\[|\.servers\b/);
    expect(src).not.toMatch(/masterIp|standby/);
    // Every call site passes an `ip` parameter, which checkBackupHealth only
    // ever feeds primary.ip.
    const calls = [...src.matchAll(/\b(sshRun|sshKubectl|getPostgresPod)\(\s*([^,\s]+)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, fn, target] of calls) {
      if (fn === 'sshRun' || fn === 'sshKubectl' || fn === 'getPostgresPod')
        expect(target).toBe('ip');
    }
    const feeds = [...src.matchAll(/probes\.\w+\(([^)]*)\)/g)].map((m) =>
      m[1].split(',')[0].trim(),
    );
    expect(feeds.length).toBeGreaterThan(0);
    for (const f of feeds) expect(f).toBe('primary.ip');
    expect(src).not.toMatch(/\bsshRun\(\s*primary|ip:\s*['"]/);
  });

  it('the listing is read live from the recorded lineage, never resolved or by bare prefix', () => {
    expect(src).toMatch(/readBases\(\{[^}]*live: true/s);
    expect(src).not.toMatch(/walgPrefixFor|listBaseBackups\(|listLineages/);
  });

  it('a compose backup in progress is read from its lock, not a process-name match', () => {
    expect(src).not.toContain('pgrep');
    expect(src).not.toMatch(/flock -n \/tmp/);
    expect(src).toContain('/proc/locks');
  });

  it('checkBackupHealth( is the only backup read in status.js', () => {
    expect(status).not.toMatch(/pg_stat_archiver|listBaseBackups\(|readEnvBaseBackups\(|walg\//);
    expect([...status.matchAll(/checkBackupHealth\(/g)].length).toBe(1);
  });
});

describe('composeRunningProbe reads the backup lock without taking it', () => {
  const probe = (lock: string) =>
    spawnSync('sh', ['-c', composeRunningProbe(lock)], { encoding: 'utf-8' }).stdout.trim();

  it('absent file: 0; unlocked file: 0; flock held: 1; and the probe never locks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'running-probe-'));
    const lock = join(dir, 'backup.lock');
    try {
      expect(probe(lock)).toBe('0');
      writeFileSync(lock, '');
      expect(probe(lock)).toBe('0');
      const holder = spawn('flock', [lock, 'sleep', '1'], { stdio: 'ignore' });
      try {
        let seen = '0';
        for (let i = 0; i < 100 && seen !== '1'; i++) {
          await new Promise((r) => setTimeout(r, 20));
          seen = probe(lock);
        }
        expect(seen).toBe('1');
        // Still held by the sleeper alone: the probe left no lock of its own.
        expect(probe(lock)).toBe('1');
      } finally {
        holder.kill('SIGKILL');
      }
      // The holder's sleep ends on its own; the probe then reads 0 again.
      for (let i = 0; i < 200 && probe(lock) !== '0'; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(probe(lock)).toBe('0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
