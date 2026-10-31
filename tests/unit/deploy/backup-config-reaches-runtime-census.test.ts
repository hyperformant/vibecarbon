/**
 * Census: every `envConfig.backup.*` setting the deploy collects reaches the
 * backup that runs, per environment, on every path a cluster gets its manifests.
 *
 * Class: "a backup setting the CLI records and then drops". Instance: the k8s
 * backup CronJob hardcoded `schedule: 0 2 * * *` and read BACKUP_RETENTION_DAYS
 * from a ConfigMap that said "7", so `-backup-schedule` and
 * `-backup-retention-days` were honoured on compose and silently ignored on
 * k8s; and retention itself was a COUNT of bases under a setting named days.
 *
 * The settings are per environment but the committed k8s/base is shared by
 * every environment Flux reconciles from the branch, so the CronJob is
 * DEPLOY-owned: Flux's vibecarbon-base drops it, the retention lives in a
 * per-cluster vibecarbon-backup-settings ConfigMap, and ONE renderer
 * (carbon/scripts/render-backup-settings.mjs) fills both in for the CLI deploy
 * and for deploy.yml (from the GitHub Environment vars the GitOps deploy seeds).
 *
 * Halves, so none can pass alone:
 * - the walk (tests/unit/helpers/runtime-reach-walk.ts, shared with the deploy
 *   flag census) proves each field is USED by the compose cron installer and
 *   the k8s renderer, not only copied along;
 * - rendered output: the compose crontab line, the k8s CronJob and ConfigMap
 *   for two environments with different settings, the committed tree carrying
 *   neither;
 * - the deploy workflow applies the settings from the environment vars the
 *   GitOps deploy seeds, and Flux cannot revert the CLI's values.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll, load as loadYaml } from 'js-yaml';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  DEFAULT_BACKUP_SCHEDULE,
  renderBackupManifests,
  resolveBackupSettings,
} from '../../../carbon/scripts/render-backup-settings.mjs';
import { setupComposeBackupCron } from '../../../src/lib/deploy/compose/index.js';
import { resolveBackupConfig } from '../../../src/lib/deploy/prompts.js';
import {
  formatReachSites,
  loadSourceTree,
  maskSource,
  walkRuntimeReach,
} from '../helpers/runtime-reach-walk.js';

const FIXTURE = { schedule: '0 */6 * * *', retentionDays: 14 };
const RENDERER = 'carbon/scripts/render-backup-settings.mjs';
const FILES = [
  ...loadSourceTree('src/lib/deploy'),
  { path: RENDERER, src: readFileSync(RENDERER, 'utf8') },
];

/** The fields prompts.js builds into the backup config the deploy carries. */
function collectedFields(): string[] {
  const src = readFileSync('src/lib/deploy/prompts.js', 'utf8');
  const code = maskSource(src);
  const start = code.indexOf(
    'const config = {',
    code.indexOf('export function resolveBackupConfig'),
  );
  const end = code.indexOf('\n  };', start);
  const body = src.slice(start, end);
  return [...body.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);
}

describe('every collected backup setting reaches the runtime', () => {
  it('collects exactly schedule and retentionDays (a new field needs a row here)', () => {
    expect(collectedFields().sort()).toEqual(['retentionDays', 'schedule']);
  });

  for (const field of ['schedule', 'retentionDays']) {
    it(`${field}: used by the one resolver both runtimes render from`, () => {
      const { sites } = walkRuntimeReach({
        files: FILES,
        start: [field],
        objects: ['backupConfig', 'backup'],
      });
      const used = new Set(sites.filter((s) => s.kind === 'use').map((s) => s.file));
      expect(used, `${field} is never used in ${RENDERER}:\n${formatReachSites(sites)}`).toContain(
        RENDERER,
      );
    });
  }
});

const tmp = mkdtempSync(join(tmpdir(), 'vc-backup-cfg-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the configured backup renders into both runtimes, per environment', () => {
  it('compose: the crontab line carries the schedule and the days', async () => {
    const runScript = vi.fn();
    await setupComposeBackupCron('10.0.0.1', '/tmp/key', 'myapp', FIXTURE, { runScript });
    const script = String(runScript.mock.calls[0][2]);
    expect(script).toContain(
      '0 */6 * * * cd /opt/myapp && RETAIN=14 bash backup/compose-backup.sh',
    );
  });

  it('two environments with different settings each render their own CronJob and ConfigMap', () => {
    const render = (cfg: unknown) =>
      loadAll(renderBackupManifests('carbon/k8s/base', resolveBackupSettings(cfg))) as Array<{
        kind: string;
        metadata: { name: string };
        spec?: { schedule: string };
        data?: Record<string, string>;
      }>;
    const staging = render({ schedule: '0 */6 * * *', retentionDays: 14 });
    const prod = render({ schedule: '30 4 * * *', retentionDays: 90 });
    const pick = (docs: ReturnType<typeof render>) => ({
      schedule: docs.find((d) => d.kind === 'CronJob')?.spec?.schedule,
      days: docs.find((d) => d.kind === 'ConfigMap')?.data?.BACKUP_RETENTION_DAYS,
      cm: docs.find((d) => d.kind === 'ConfigMap')?.metadata.name,
    });
    expect(pick(staging)).toEqual({
      schedule: '0 */6 * * *',
      days: '14',
      cm: 'vibecarbon-backup-settings',
    });
    expect(pick(prod)).toEqual({
      schedule: '30 4 * * *',
      days: '90',
      cm: 'vibecarbon-backup-settings',
    });
  });

  it('the committed tree carries neither value: a placeholder and no retention', () => {
    const cron = readFileSync('carbon/k8s/base/backup/cronjob.yaml', 'utf8');
    expect(cron).toContain('schedule: "{{BACKUP_SCHEDULE}}"');
    expect(readFileSync('carbon/k8s/base/config/configmap.yaml', 'utf8')).not.toContain(
      'BACKUP_RETENTION_DAYS',
    );
    // The CronJob reads the per-cluster ConfigMap, with no default in the script.
    const doc = loadYaml(cron) as {
      spec: {
        jobTemplate: {
          spec: {
            template: {
              spec: {
                containers: Array<{ env: Array<Record<string, unknown>>; command: string[] }>;
              };
            };
          };
        };
      };
    };
    const c = doc.spec.jobTemplate.spec.template.spec.containers[0];
    const ref = c.env.find((e) => e.name === 'BACKUP_RETENTION_DAYS') as {
      valueFrom: { configMapKeyRef: { name: string } };
    };
    expect(ref.valueFrom.configMapKeyRef.name).toBe('vibecarbon-backup-settings');
    expect(c.command.join('\n')).not.toMatch(/BACKUP_RETENTION_DAYS:-[0-9]/);
  });

  it('one default, shared: a plain config and an empty environment agree', () => {
    expect(resolveBackupSettings(undefined)).toEqual({
      schedule: DEFAULT_BACKUP_SCHEDULE,
      retentionDays: DEFAULT_BACKUP_RETENTION_DAYS,
    });
    expect(resolveBackupConfig({}, {})).toEqual({
      schedule: DEFAULT_BACKUP_SCHEDULE,
      retentionDays: DEFAULT_BACKUP_RETENTION_DAYS,
    });
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
  });

  it.each([0, -1, Number.NaN, 1.5, '0', 'abc'])(
    'a retention of %j is refused, never coerced to a default',
    (retentionDays) => {
      expect(() => resolveBackupSettings({ retentionDays: retentionDays as number })).toThrow(
        /positive whole number of days/,
      );
    },
  );

  it('gatherDeploymentConfig validates through it, before any server exists', () => {
    expect(() => resolveBackupConfig({ backupRetentionDays: '0' }, {})).toThrow(/positive whole/);
    expect(() => resolveBackupConfig({ backupRetentionDays: 'abc' }, {})).toThrow(/positive whole/);
    expect(() => resolveBackupConfig({ backupSchedule: '@daily' }, {})).toThrow(/5-field cron/);
    // A recorded bad value is caught the same way (a hand-edited config).
    expect(() => resolveBackupConfig({}, { backup: { schedule: 'x', retentionDays: 3 } })).toThrow(
      /5-field cron/,
    );
    const src = readFileSync('src/lib/deploy/prompts.js', 'utf8');
    const gather = src.slice(src.indexOf('export async function gatherDeploymentConfig'));
    expect(gather.indexOf('resolveBackupConfig(args, envConfig)')).toBeGreaterThan(-1);
  });

  it('a plain redeploy keeps the recorded values; a flag overrides them', () => {
    const recorded = { backup: { schedule: '30 4 * * *', retentionDays: 14 } };
    expect(resolveBackupConfig({}, recorded)).toEqual({
      schedule: '30 4 * * *',
      retentionDays: 14,
    });
    expect(resolveBackupConfig({ backupRetentionDays: '5' }, recorded)).toEqual({
      schedule: '30 4 * * *',
      retentionDays: 5,
    });
  });
});

describe('Flux cannot revert a deploy-owned backup, and the workflow applies it from env vars', () => {
  const wf = readFileSync('carbon/.github/workflows/deploy.yml', 'utf8');

  it('deploy.yml renders with the shared script from the environment vars and applies it', () => {
    expect(wf).toMatch(/BACKUP_SCHEDULE: \$\{\{ vars\.BACKUP_SCHEDULE \}\}/);
    expect(wf).toMatch(/BACKUP_RETENTION_DAYS: \$\{\{ vars\.BACKUP_RETENTION_DAYS \}\}/);
    expect(wf).toContain('node scripts/render-backup-settings.mjs k8s/base');
    expect(wf).toMatch(
      /kubectl apply --namespace=vibecarbon[^\n]*\\\n[^\n]*-f "\$RUNNER_TEMP\/backup\.yaml"/,
    );
  });

  it('the renderer refuses to run without the vars, naming the fix', () => {
    const dir = join(tmp, 'norun');
    cpSync('carbon/k8s/base', join(dir, 'k8s/base'), { recursive: true });
    cpSync(RENDERER, join(dir, 'render.mjs'));
    const env = { PATH: process.env.PATH ?? '' };
    const none = spawnSync('node', [join(dir, 'render.mjs'), join(dir, 'k8s/base')], {
      encoding: 'utf8',
      env,
    });
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/BACKUP_SCHEDULE and BACKUP_RETENTION_DAYS are not set/);
    expect(none.stderr).toContain('vibecarbon configure cicd');
    const ok = spawnSync('node', [join(dir, 'render.mjs'), join(dir, 'k8s/base')], {
      encoding: 'utf8',
      env: { ...env, BACKUP_SCHEDULE: '15 3 * * *', BACKUP_RETENTION_DAYS: '21' },
    });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('schedule: "15 3 * * *"');
    expect(ok.stdout).toContain('BACKUP_RETENTION_DAYS: "21"');
    writeFileSync(join(dir, 'out.yaml'), ok.stdout);
    const bad = spawnSync('node', [join(dir, 'render.mjs'), join(dir, 'k8s/base')], {
      encoding: 'utf8',
      env: { ...env, BACKUP_SCHEDULE: '15 3 * * *', BACKUP_RETENTION_DAYS: '0' },
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/positive whole number of days/);
  });

  // The Flux Kustomizations of both clusters (and the production overlay) drop the
  // CronJob with $patch: delete and the object carries prune: disabled: proved on
  // the kustomize build in tests/unit/deploy/flux-base-placeholder-census.test.ts.
  it('both cluster files and the production overlay delete the CronJob from Flux builds', () => {
    for (const f of [
      'carbon/k8s/flux/clusters/primary/vibecarbon.yaml',
      'carbon/k8s/flux/clusters/standby/vibecarbon.yaml',
      'carbon/k8s/overlays/production/kustomization.yaml',
    ]) {
      expect(readFileSync(f, 'utf8'), f).toMatch(
        /\$patch: delete\n\s+apiVersion: batch\/v1\n\s+kind: CronJob\n\s+metadata:\n\s+name: backup/,
      );
    }
  });
});
