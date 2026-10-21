/**
 * Census: every `envConfig.backup.*` setting the deploy collects reaches the
 * backup that runs.
 *
 * Class: "a backup setting the CLI records and then drops". Instance: the k8s
 * backup CronJob hardcoded `schedule: 0 2 * * *` and read BACKUP_RETENTION_DAYS
 * from a ConfigMap that said "7", so `-backup-schedule` and
 * `-backup-retention-days` were honoured on compose and silently ignored on
 * k8s; and retention itself was a COUNT of bases (`retain FULL n`) under a
 * setting named days.
 *
 * Two halves, so neither can pass alone:
 * - the walk (tests/unit/helpers/runtime-reach-walk.ts, shared with the deploy
 *   flag census) proves each field is USED by the compose cron installer and by
 *   the k8s backup patcher, not only copied along;
 * - the rendered output proves the values land: the compose crontab line and
 *   the k8s CronJob/ConfigMap merge patches for a six-hourly schedule kept 14
 *   days, and that the deploy applies those patches to the cluster.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { setupComposeBackupCron } from '../../../src/lib/deploy/compose/index.js';
import { buildBackupConfigPatches } from '../../../src/lib/deploy/k8s/k3s.js';
import {
  formatReachSites,
  loadSourceTree,
  maskSource,
  walkRuntimeReach,
} from '../helpers/runtime-reach-walk.js';

const FIXTURE = { schedule: '0 */6 * * *', retentionDays: 14 };
const FILES = loadSourceTree('src/lib/deploy');

/** The fields prompts.js builds into the backup config the deploy carries. */
function collectedFields(): string[] {
  const src = readFileSync('src/lib/deploy/prompts.js', 'utf8');
  const code = maskSource(src);
  const start = code.indexOf('const backupConfig = {');
  const end = code.indexOf('\n  };', start);
  const body = src.slice(start, end);
  return [...body.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);
}

describe('every collected backup setting reaches the runtime', () => {
  it('collects exactly schedule and retentionDays (a new field needs a row here)', () => {
    expect(collectedFields().sort()).toEqual(['retentionDays', 'schedule']);
  });

  const SINKS: Record<string, string[]> = {
    schedule: ['src/lib/deploy/compose/index.js', 'src/lib/deploy/k8s/k3s.js'],
    retentionDays: ['src/lib/deploy/compose/index.js', 'src/lib/deploy/k8s/k3s.js'],
  };

  for (const field of Object.keys(SINKS)) {
    it(`${field}: used by the compose cron installer and the k8s backup patcher`, () => {
      const { sites } = walkRuntimeReach({
        files: FILES,
        start: [field],
        objects: ['backupConfig', 'backup'],
      });
      const used = new Set(sites.filter((s) => s.kind === 'use').map((s) => s.file));
      for (const sink of SINKS[field]) {
        expect(used, `${field} is never used in ${sink}:\n${formatReachSites(sites)}`).toContain(
          sink,
        );
      }
    });
  }
});

describe('the configured backup renders into both runtimes', () => {
  it('compose: the crontab line carries the schedule and the days', async () => {
    const runScript = vi.fn();
    await setupComposeBackupCron('10.0.0.1', '/tmp/key', 'myapp', FIXTURE, { runScript });
    const script = String(runScript.mock.calls[0][2]);
    expect(script).toContain(
      '0 */6 * * * cd /opt/myapp && RETAIN=14 bash backup/compose-backup.sh',
    );
  });

  it('k8s: the CronJob schedule and the ConfigMap retention carry them', () => {
    expect(buildBackupConfigPatches(FIXTURE)).toEqual({
      configMapData: { BACKUP_RETENTION_DAYS: '14' },
      cronJobSpec: { schedule: '0 */6 * * *' },
    });
  });

  it('k8s: no config falls back to the manifest defaults, the same as the compose cron', () => {
    expect(buildBackupConfigPatches(undefined)).toEqual({
      configMapData: { BACKUP_RETENTION_DAYS: '7' },
      cronJobSpec: { schedule: '0 2 * * *' },
    });
  });

  it.each(['0 2 * * *"}', '0 2 * * *\n', "0 2 * * *'; x"])(
    'k8s: a schedule that is not a cron expression is refused (%j)',
    (schedule) => {
      expect(() => buildBackupConfigPatches({ schedule, retentionDays: 7 })).toThrow(
        /not a cron expression/,
      );
    },
  );

  it('the deploy applies both patches to the cluster, from the deploy backup config', () => {
    const src = readFileSync('src/lib/deploy/k8s/k3s.js', 'utf8');
    expect(src).toMatch(/const backupPatches = buildBackupConfigPatches\(backupConfig\)/);
    expect(src).toMatch(/\.\.\.backupPatches\.configMapData/);
    expect(src).toMatch(/spec: backupPatches\.cronJobSpec/);
    expect(src).toMatch(/backupConfig: options\.backupConfig/);
  });
});
