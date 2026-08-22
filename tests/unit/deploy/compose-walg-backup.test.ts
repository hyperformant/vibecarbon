import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeBackupCmd } from '../../../src/lib/deploy/compose/index.js';

const SCRIPT_PATH = fileURLToPath(
  new URL('../../../carbon/backup/compose-backup.sh', import.meta.url),
);

describe('composeBackupCmd', () => {
  it('routes through compose-backup.sh with an explicit RETAIN binding to bash', () => {
    const cmd = composeBackupCmd('/opt/x', 5);
    expect(cmd).toContain('cd /opt/x');
    expect(cmd).toContain('RETAIN=5');
    expect(cmd).toContain('bash backup/compose-backup.sh');
    // RETAIN must bind to `bash` (a real command), not the `cd` builtin where
    // the assignment would be discarded.
    expect(cmd).toMatch(/RETAIN=5 bash backup\/compose-backup\.sh/);
  });

  it('defaults RETAIN to 7 when omitted', () => {
    expect(composeBackupCmd('/opt/x')).toContain('RETAIN=7');
  });

  it('rejects non-positive / non-integer retain values (falls back to 7)', () => {
    // @ts-expect-error — exercising runtime guard with a bad value
    expect(composeBackupCmd('/opt/x', '5; rm -rf /')).toContain('RETAIN=7');
    expect(composeBackupCmd('/opt/x', 0)).toContain('RETAIN=7');
    expect(composeBackupCmd('/opt/x', -3)).toContain('RETAIN=7');
    expect(composeBackupCmd('/opt/x', 2.5)).toContain('RETAIN=7');
  });
});

describe('compose-backup.sh (the single source of truth)', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf-8');

  it('connects as the superuser and runs a guarded wal-g base backup', () => {
    expect(script).toContain('PGUSER=supabase_admin');
    expect(script).toContain('pg_is_in_recovery');
    expect(script).toContain('wal-g backup-push');
    expect(script).toContain('wal-g delete retain FULL');
    expect(script).toContain('--confirm');
  });

  it('skips cleanly (exit 0) on a standby, so only the primary backs up', () => {
    // The recovery guard must short-circuit with exit 0 — a non-zero exit on a
    // standby would fail the cron / scale step on the HA failover server.
    expect(script).toMatch(/pg_is_in_recovery[\s\S]*exit 0/);
  });

  it('skips cleanly (exit 0) when no S3 backup target is configured', () => {
    // An always-installed cron must NOT hard-fail nightly on a no-S3 deploy.
    // docker-compose.yml renders WALG_S3_PREFIX as s3://${S3_BACKUP_BUCKET:-
    // ${S3_BUCKET:-}}/... so an unconfigured deploy gets the empty-bucket form
    // `s3:///...`. The guard matches "" and s3:///* and exits 0 before wal-g.
    expect(script).toMatch(/WALG_S3_PREFIX[\s\S]*s3:\/\/\/\*[\s\S]*exit 0/);
  });

  it('skips cleanly (exit 0) when S3 credentials are absent', () => {
    expect(script).toContain('AWS_ACCESS_KEY_ID');
    expect(script).toMatch(/AWS_SECRET_ACCESS_KEY[\s\S]*exit 0/);
  });

  it('runs the wal-g backup only AFTER the no-S3 + standby guards', () => {
    // Ordering matters: both skip-guards must precede backup-push so a no-S3 or
    // standby node never reaches wal-g.
    const prefixGuard = script.indexOf('WALG_S3_PREFIX');
    const credsGuard = script.indexOf('AWS_ACCESS_KEY_ID');
    const recoveryGuard = script.indexOf('pg_is_in_recovery');
    const backupPush = script.indexOf('wal-g backup-push');
    expect(prefixGuard).toBeGreaterThan(-1);
    expect(prefixGuard).toBeLessThan(backupPush);
    expect(credsGuard).toBeLessThan(backupPush);
    expect(recoveryGuard).toBeLessThan(backupPush);
  });

  it('honours the host-provided RETAIN with a 7 default', () => {
    expect(script).toMatch(/RETAIN.*:-7/);
  });
});
