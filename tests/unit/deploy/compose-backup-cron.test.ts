import { describe, expect, it, vi } from 'vitest';
import { setupComposeBackupCron } from '../../../src/lib/deploy/compose/index.js';

// ---------------------------------------------------------------------------
// setupComposeBackupCron() — builds + installs the scheduled wal-g backup cron.
//
// Wired into compose-single (orchestrator) + compose-ha (both nodes) deploys
// so a fresh deploy schedules backups instead of relying on a later
// `vibecarbon scale` event. The SSH script runner is injected so the cron-line
// construction is unit-testable without a real server.
// ---------------------------------------------------------------------------

function capture() {
  const runScript = vi.fn();
  return {
    runScript,
    script: () => runScript.mock.calls[0]?.[2] ?? '',
  };
}

describe('setupComposeBackupCron', () => {
  it('installs a cron that runs the wal-g backup command on the project dir', () => {
    const { runScript, script } = capture();
    setupComposeBackupCron('10.0.0.1', '/tmp/key', 'myapp', undefined, { runScript });

    expect(runScript).toHaveBeenCalledTimes(1);
    const s = script();
    expect(s).toContain('crontab');
    expect(s).toContain('RETAIN=7 bash backup/compose-backup.sh');
    expect(s).toContain('cd /opt/myapp');
    expect(s).toContain('/opt/myapp/backups/backup.log');
  });

  it('defaults the schedule to 0 2 * * * and retain to 7 when no backupConfig is given', () => {
    const { script, runScript } = capture();
    setupComposeBackupCron('10.0.0.1', '/tmp/key', 'myapp', undefined, { runScript });

    const s = script();
    expect(s).toContain('0 2 * * * cd /opt/myapp');
    expect(s).toContain('RETAIN=7');
  });

  it('honours a provided schedule and retentionDays', () => {
    const { script, runScript } = capture();
    setupComposeBackupCron(
      '10.0.0.1',
      '/tmp/key',
      'myapp',
      { schedule: '30 4 * * *', retentionDays: 14 },
      { runScript },
    );

    const s = script();
    expect(s).toContain('30 4 * * * cd /opt/myapp');
    expect(s).toContain('RETAIN=14');
  });

  it('removes any prior compose-backup.sh cron line so reinstalls are idempotent', () => {
    const { script, runScript } = capture();
    setupComposeBackupCron('10.0.0.1', '/tmp/key', 'myapp', undefined, { runScript });

    // The install script strips existing compose-backup.sh lines before
    // appending the fresh one — re-running deploy never stacks duplicate crons.
    expect(script()).toContain("grep -v 'compose-backup.sh'");
  });

  it('falls back to retain 7 for a non-positive / non-integer retentionDays', () => {
    const { script, runScript } = capture();
    setupComposeBackupCron('10.0.0.1', '/tmp/key', 'myapp', { retentionDays: -3 }, { runScript });
    expect(script()).toContain('RETAIN=7');
  });
});
