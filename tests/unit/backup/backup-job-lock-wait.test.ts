/**
 * The k8s post-promotion push waits for another backup Job, and every wait is
 * bounded by the Job's own deadline instead of a fixed 300s.
 *
 * A post-promote push (restore, failover, deploy -restore) that took longer
 * than 5 minutes failed its command although the Job was still pushing, and
 * the remedy it named ("run vibecarbon backup now") started a second Job
 * beside the first. The Job now takes a lock in the db container (see
 * backup-result-marker.test.ts), the post-promote Job carries LOCK_WAIT so a
 * held lock is waited out, and the poll lasts as long as the Job may run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/cli/progress.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lib/cli/progress.js')>(
    '../../../src/lib/cli/progress.js',
  );
  return { ...actual, progressLog: vi.fn() };
});

const { BACKUP_JOB_ACTIVE_DEADLINE_S, buildBackupJobWaitScript, triggerBackupJob } = await import(
  '../../../src/backup.js'
);

const CRONJOB = join(__dirname, '../../../carbon/k8s/base/backup/cronjob.yaml');

const jobFromCron = (name: string) => {
  const cron = loadYaml(readFileSync(CRONJOB, 'utf-8')) as {
    spec: { jobTemplate: { spec: Record<string, unknown> } };
  };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: 'vibecarbon' },
    spec: cron.spec.jobTemplate.spec,
  };
};

describe('the backup Job wait', () => {
  it('the deadline constant is the CronJob activeDeadlineSeconds', () => {
    const cron = loadYaml(readFileSync(CRONJOB, 'utf-8')) as {
      spec: { jobTemplate: { spec: { activeDeadlineSeconds: number } } };
    };
    expect(cron.spec.jobTemplate.spec.activeDeadlineSeconds).toBe(BACKUP_JOB_ACTIVE_DEADLINE_S);
  });

  it('polls until the Job deadline (plus the controller grace), not a fixed 300s', () => {
    const script = buildBackupJobWaitScript('j');
    expect(script).not.toContain('date +%s) + 300)');
    expect(script).toContain(`date +%s) + ${BACKUP_JOB_ACTIVE_DEADLINE_S + 60})`);
  });

  it('the ssh budget for the wait outlasts the poll', async () => {
    const kubectlImpl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      if (argv.includes('pg_isready')) return 'accepting connections';
      if (argv[0] === 'logs') return 'BACKUP_RESULT=pushed:base_000000010000000000000004';
      return '';
    });
    const runScriptImpl = vi.fn(async () => 'JOB_RESULT=complete');
    await triggerBackupJob('1.2.3.4', '/k', { kubectlImpl, runScriptImpl, sleep: async () => {} });
    const [, , , opts] = runScriptImpl.mock.calls[0] as unknown as [
      string,
      string,
      string,
      { timeout: number },
    ];
    expect(opts.timeout).toBeGreaterThan((BACKUP_JOB_ACTIVE_DEADLINE_S + 60) * 1000);
  });
});

describe('triggerBackupJob lockWaitS', () => {
  it('creates the Job with LOCK_WAIT on the backup container, from the CronJob template', async () => {
    const created: string[] = [];
    const kubectlImpl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      if (argv.includes('pg_isready')) return 'accepting connections';
      if (argv[0] === 'create' && argv.includes('--dry-run=client')) {
        return JSON.stringify(jobFromCron(argv[3]));
      }
      if (argv[0] === 'logs') return 'BACKUP_RESULT=pushed:base_000000020000000000000004';
      return '';
    });
    const runScriptImpl = vi.fn(async (_ip: string, _key: string, script: string) => {
      if (script.includes('kubectl create -f -')) {
        created.push(script);
        return 'job.batch/x created';
      }
      return 'JOB_RESULT=complete';
    });
    const out = await triggerBackupJob('1.2.3.4', '/k', {
      kubectlImpl,
      runScriptImpl,
      sleep: async () => {},
      lockWaitS: 900,
    });
    expect(out.result).toBe('pushed');
    // The dry-run renders the Job from the CronJob template.
    const dry = kubectlImpl.mock.calls.map((c) => c[2]).find((a) => a.includes('--dry-run=client'));
    expect(dry).toEqual(
      expect.arrayContaining(['create', 'job', '--from=cronjob/backup', '-n', 'vibecarbon']),
    );
    // No plain create beside it.
    expect(
      kubectlImpl.mock.calls.filter(
        (c) => c[2][0] === 'create' && !c[2].includes('--dry-run=client'),
      ),
    ).toEqual([]);
    expect(created).toHaveLength(1);
    const body = created[0].slice(created[0].indexOf('{'), created[0].lastIndexOf('}') + 1);
    const job = JSON.parse(body);
    const backup = job.spec.template.spec.containers.find(
      (c: { name: string }) => c.name === 'backup',
    );
    expect(backup.env).toContainEqual({ name: 'LOCK_WAIT', value: '900' });
    // The CronJob env is kept.
    expect(backup.env.map((e: { name: string }) => e.name)).toContain('BACKUP_RETENTION_DAYS');
    expect(job.metadata.name).toBe(out.job);
  });

  it('the lock wait fits inside the Job deadline', async () => {
    const { POST_PROMOTE_LOCK_WAIT_S } = await import(
      '../../../src/lib/walg/post-promote-backup.js'
    );
    expect(POST_PROMOTE_LOCK_WAIT_S).toBeLessThan(BACKUP_JOB_ACTIVE_DEADLINE_S / 2);
  });

  it('refuses a lock wait that is not a positive whole number of seconds', async () => {
    const kubectlImpl = vi.fn(async () => 'accepting connections');
    await expect(
      triggerBackupJob('1.2.3.4', '/k', {
        kubectlImpl,
        runScriptImpl: vi.fn(),
        sleep: async () => {},
        lockWaitS: -1,
      }),
    ).rejects.toThrow(/lockWaitS/);
  });
});
