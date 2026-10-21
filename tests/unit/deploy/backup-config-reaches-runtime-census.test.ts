/**
 * Census: every `envConfig.backup.*` setting the deploy collects reaches the
 * backup that runs, on every path the manifests take to a cluster.
 *
 * Class: "a backup setting the CLI records and then drops". Instance: the k8s
 * backup CronJob hardcoded `schedule: 0 2 * * *` and read BACKUP_RETENTION_DAYS
 * from a ConfigMap that said "7", so `-backup-schedule` and
 * `-backup-retention-days` were honoured on compose and silently ignored on
 * k8s; and retention itself was a COUNT of bases under a setting named days.
 *
 * ONE mechanism on k8s: the values are written into the manifest files
 * (writeBackupConfigIntoTree), because Flux reconciles ./k8s/base every 10
 * minutes with prune and would write a patched live value straight back. The
 * CLI deploy writes them into the rendered temp copy it applies; the GitOps
 * commit writes them into the project tree Flux reads.
 *
 * Halves, so none can pass alone:
 * - the walk (tests/unit/helpers/runtime-reach-walk.ts, shared with the deploy
 *   flag census) proves each field is USED by the compose cron installer and by
 *   the k8s writer, not only copied along;
 * - the rendered output proves the values land: the compose crontab line and
 *   the k8s CronJob/ConfigMap files, for a six-hourly schedule kept 14 days;
 * - the GitOps path commits the same values, and a plain redeploy reads them
 *   back from the recorded environment.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { setupComposeBackupCron } from '../../../src/lib/deploy/compose/index.js';
import {
  resolveBackupSettings,
  writeBackupConfigIntoTree,
} from '../../../src/lib/deploy/k8s/backup-config.js';
import { resolveBackupConfig } from '../../../src/lib/deploy/prompts.js';
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
  const start = code.indexOf('export function resolveBackupConfig');
  const end = code.indexOf('\n  };\n}', start);
  const body = src.slice(start, end);
  return [...body.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);
}

describe('every collected backup setting reaches the runtime', () => {
  it('collects exactly schedule and retentionDays (a new field needs a row here)', () => {
    expect(collectedFields().sort()).toEqual(['retentionDays', 'schedule']);
  });

  const SINKS: Record<string, string[]> = {
    schedule: ['src/lib/deploy/compose/index.js', 'src/lib/deploy/k8s/backup-config.js'],
    retentionDays: ['src/lib/deploy/compose/index.js', 'src/lib/deploy/k8s/backup-config.js'],
  };

  for (const field of Object.keys(SINKS)) {
    it(`${field}: used by the compose cron installer and the k8s writer`, () => {
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

  const tmp = mkdtempSync(join(tmpdir(), 'vc-backup-cfg-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const baseCopy = (name: string) => {
    const dir = join(tmp, name);
    cpSync('carbon/k8s/base', dir, { recursive: true });
    return dir;
  };
  const cronSchedule = (dir: string) =>
    (
      loadYaml(readFileSync(join(dir, 'backup/cronjob.yaml'), 'utf8')) as {
        spec: { schedule: string };
      }
    ).spec.schedule;
  const retention = (dir: string) =>
    (
      loadYaml(readFileSync(join(dir, 'config/configmap.yaml'), 'utf8')) as {
        data: Record<string, string>;
      }
    ).data.BACKUP_RETENTION_DAYS;

  it('k8s: the CronJob file and the ConfigMap file carry them', () => {
    const dir = baseCopy('cfg');
    writeBackupConfigIntoTree(dir, FIXTURE);
    expect(cronSchedule(dir)).toBe('0 */6 * * *');
    expect(retention(dir)).toBe('14');
    // Re-running over its own output is stable (a redeploy).
    writeBackupConfigIntoTree(dir, { schedule: '30 4 * * *', retentionDays: 3 });
    expect(cronSchedule(dir)).toBe('30 4 * * *');
    expect(retention(dir)).toBe('3');
  });

  it('k8s: no config leaves the manifest defaults, the same as the compose cron', () => {
    const dir = baseCopy('defaults');
    writeBackupConfigIntoTree(dir, undefined);
    expect(cronSchedule(dir)).toBe('0 2 * * *');
    expect(retention(dir)).toBe('7');
  });

  it('the checked-in base carries concrete values, never a placeholder', () => {
    expect(readFileSync('carbon/k8s/base/backup/cronjob.yaml', 'utf8')).not.toMatch(/\{\{/);
    expect(readFileSync('carbon/k8s/base/config/configmap.yaml', 'utf8')).not.toMatch(/\{\{/);
  });

  it.each([
    '0 2 * * *"}',
    '0 2 * * *\n- x',
    "0 2 * * *'; x",
    '0 2 * *',
    '0 2 * * * *',
    '@daily',
    '0 2 * * * # x',
  ])('a schedule that is not a 5-field cron expression is refused (%j)', (schedule) => {
    expect(() => resolveBackupSettings({ schedule, retentionDays: 7 })).toThrow(
      /5-field cron expression/,
    );
    expect(() => writeBackupConfigIntoTree(baseCopy('bad'), { schedule })).toThrow();
  });

  // The GitOps commit is proved behaviourally in
  // tests/unit/deploy/gitops-backup-config.test.ts (a real deployK8sGitOps into
  // a local origin: the committed files carry the configured values).
  it('configure hands the recorded backup config to the GitOps deploy', () => {
    expect(readFileSync('src/configure.js', 'utf8')).toMatch(
      /backupConfig: subEnvConfig\.backup \|\| envConfig\.backup/,
    );
  });

  // The CLI deploy's rendered copy is proved behaviourally in
  // tests/unit/deploy/k8s-deploy-restore.test.ts (the files kubectl apply -k
  // is handed carry the configured values).

  it('a plain redeploy keeps the recorded values; a flag overrides them; only a new env gets defaults', () => {
    const recorded = { backup: { schedule: '30 4 * * *', retentionDays: 14 } };
    expect(resolveBackupConfig({}, recorded)).toEqual({
      schedule: '30 4 * * *',
      retentionDays: 14,
    });
    expect(resolveBackupConfig({ backupRetentionDays: '5' }, recorded)).toEqual({
      schedule: '30 4 * * *',
      retentionDays: 5,
    });
    expect(resolveBackupConfig({}, {})).toEqual({ schedule: '0 */6 * * *', retentionDays: 30 });
  });
});
