/**
 * `vibecarbon status` Backups row (M5): newest base age in the recorded
 * lineage, last archived WAL and failures from the role primary, the 24 h
 * WAL_ARCHIVE_FAILED count, and the last scheduled backup Job.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backupHealthRow,
  checkBackupHealth,
  cronIntervalMs,
} from '../../../src/lib/status/backup-health.js';

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const HOUR = 3_600_000;
const SYSID = '7000000000000000001';
const base = (hoursAgo: number) => ({
  name: 'base_x',
  finishTime: new Date(NOW - hoursAgo * HOUR),
});

const input = (over = {}) => ({
  lineage: SYSID,
  schedule: '0 3 * * *',
  backups: [base(2)],
  archiver: { lastArchivedAgeSeconds: 120, failedCount: 0 },
  walFailures: 0,
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
    expect(r.text).toContain('WAL archived 2m ago');
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

  it('a last archived WAL older than 2 x archive_timeout is red', () => {
    const r = backupHealthRow(
      input({ archiver: { lastArchivedAgeSeconds: 1801, failedCount: 0 } }),
    );
    expect(r.level).toBe('error');
    expect(r.text).toContain('last WAL archived 30m ago');
  });

  it('a nonzero WAL_ARCHIVE_FAILED count is red', () => {
    const r = backupHealthRow(input({ walFailures: 4 }));
    expect(r.level).toBe('error');
    expect(r.text).toContain('4 WAL_ARCHIVE_FAILED in 24h');
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
        return sql.includes('pg_stat_archiver') ? '60|0' : '';
      },
      countWalFailures: async (ip: string) => {
        calls.ssh.push(ip);
        return 0;
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

  it('stale last-archived WAL and a WAL_ARCHIVE_FAILED count surface in the row', async () => {
    const { deps: d } = deps({
      runOnPrimary: async () => '4000|2',
      countWalFailures: async () => 7,
    });
    const r = await checkBackupHealth('prod', composeHa(), 'proj', d);
    expect(r?.level).toBe('error');
    expect(r?.text).toContain('last WAL archived');
    expect(r?.text).toContain('7 WAL_ARCHIVE_FAILED in 24h');
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

describe('census: status.js backup reads take their target from the recorded primary/lineage', () => {
  const src = readFileSync(join(__dirname, '../../../src/lib/status/backup-health.js'), 'utf8');
  const status = readFileSync(join(__dirname, '../../../src/status.js'), 'utf8');
  it('every pg_stat_archiver read and base listing goes through resolvePrimary / live lineage', () => {
    expect(src).toContain('resolvePrimary(');
    expect(src).toContain('live: true');
    expect(src).not.toMatch(/servers\s*\[/);
    expect(src).not.toMatch(/walgPrefixFor|listBaseBackups\(/);
    expect(status).not.toMatch(/pg_stat_archiver|listBaseBackups\(/);
  });
});
