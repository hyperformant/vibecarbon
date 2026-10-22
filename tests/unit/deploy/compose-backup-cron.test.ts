import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  DEFAULT_BACKUP_SCHEDULE,
} from '../../../carbon/scripts/render-backup-settings.mjs';
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
    expect(s).toContain(`RETAIN=${DEFAULT_BACKUP_RETENTION_DAYS} bash backup/compose-backup.sh`);
    expect(s).toContain('cd /opt/myapp');
    expect(s).toContain('/opt/myapp/backups/backup.log');
  });

  it('defaults the schedule and retain to the shared defaults when no backupConfig is given', () => {
    const { script, runScript } = capture();
    setupComposeBackupCron('10.0.0.1', '/tmp/key', 'myapp', undefined, { runScript });

    const s = script();
    expect(s).toContain(`${DEFAULT_BACKUP_SCHEDULE} cd /opt/myapp`);
    expect(s).toContain(`RETAIN=${DEFAULT_BACKUP_RETENTION_DAYS}`);
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

  it('removes any prior compose-backup.sh and tls-retry.sh cron line so reinstalls are idempotent', () => {
    const { script, runScript } = capture();
    setupComposeBackupCron('10.0.0.1', '/tmp/key', 'myapp', undefined, { runScript });

    // The install script strips existing compose-backup.sh and tls-retry.sh
    // lines before appending the fresh ones: re-running deploy never stacks
    // duplicate crons.
    expect(script()).toContain("grep -v -e 'compose-backup.sh' -e 'tls-retry.sh'");
  });

  it.each([-3, 0, Number.NaN, 2.5])(
    'refuses a retentionDays of %j instead of installing some other number',
    async (retentionDays) => {
      const { runScript } = capture();
      await expect(
        setupComposeBackupCron('10.0.0.1', '/tmp/key', 'myapp', { retentionDays }, { runScript }),
      ).rejects.toThrow(/positive whole number of days/);
      expect(runScript).not.toHaveBeenCalled();
    },
  );

  it('installs the tls-retry line every 30 minutes beside the backup line, with the apex', () => {
    const { script, runScript } = capture();
    setupComposeBackupCron('10.0.0.1', '/tmp/key', 'myapp', undefined, {
      runScript,
      domain: 'app.example.com',
    });

    const lines = script().split('\n');
    expect(
      lines.filter(
        (l) =>
          l ===
          '*/30 * * * * cd /opt/myapp && bash backup/tls-retry.sh app.example.com >> /opt/myapp/backups/tls-retry.log 2>&1',
      ),
    ).toHaveLength(1);
  });

  it('no domain: no tls-retry line, and any earlier one is still stripped', () => {
    const { script, runScript } = capture();
    setupComposeBackupCron('10.0.0.1', '/tmp/key', 'myapp', undefined, { runScript });
    expect(script()).not.toContain('bash backup/tls-retry.sh');
    expect(script()).toContain("-e 'tls-retry.sh'");
  });

  it.each(['bad domain', 'x;rm -rf /', '-flag.example.com', 'nodot'])(
    'refuses an apex of %j instead of writing it into the crontab',
    async (domain) => {
      const { runScript } = capture();
      await expect(
        setupComposeBackupCron('10.0.0.1', '/tmp/key', 'myapp', undefined, { runScript, domain }),
      ).rejects.toThrow(/not a valid domain/);
      expect(runScript).not.toHaveBeenCalled();
    },
  );

  it('re-arms the retry budget: a deploy clears the give-up counter and the logged state', () => {
    const { script, runScript } = capture();
    setupComposeBackupCron('10.0.0.1', '/tmp/key', 'myapp', undefined, {
      runScript,
      domain: 'app.example.com',
    });
    expect(script()).toContain(
      'rm -f /opt/myapp/backups/tls-retry.count /opt/myapp/backups/tls-retry.state',
    );
  });

  describe('run against a stub crontab', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'backup-cron-'));
    afterAll(() => rmSync(scratch, { recursive: true, force: true }));

    /** Run the install script with /opt/myapp moved into scratch and `crontab` stubbed. */
    function install(state: string, remote: string) {
      const { script, runScript } = capture();
      setupComposeBackupCron('10.0.0.1', '/tmp/key', 'myapp', undefined, {
        runScript,
        domain: 'app.example.com',
      });
      const bin = join(scratch, 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, 'crontab'),
        `#!/bin/sh\nif [ "$1" = "-l" ]; then cat "${state}" 2>/dev/null; exit 0; fi\ncat "$1" > "${state}"\n`,
      );
      chmodSync(join(bin, 'crontab'), 0o755);
      const r = spawnSync('bash', ['-c', script().replaceAll('/opt/myapp', remote)], {
        encoding: 'utf-8',
        env: { PATH: `${bin}:${process.env.PATH}` },
      });
      expect(r.status, r.stderr).toBe(0);
      return readFileSync(state, 'utf-8');
    }

    it('re-running it never duplicates either line, and keeps other cron lines', () => {
      const state = join(scratch, 'crontab.txt');
      const remote = join(scratch, 'opt-myapp');
      writeFileSync(state, '0 1 * * * /usr/bin/unrelated\n');
      install(state, remote);
      const after = install(state, remote).split('\n').filter(Boolean);

      expect(after.filter((l) => l.includes('compose-backup.sh'))).toHaveLength(1);
      expect(after.filter((l) => l.includes('tls-retry.sh'))).toHaveLength(1);
      expect(after).toContain('0 1 * * * /usr/bin/unrelated');
    });
  });
});
