/**
 * GitOps: Flux reconciles the committed ./k8s/base every 10 minutes with
 * prune, so the configured backup schedule and retention must be IN the
 * committed files, or the next reconcile writes the base defaults back over
 * them. Runs deployK8sGitOps for real (a real git repo and a local bare
 * origin) with only the GitHub API calls stubbed, and reads what landed on
 * origin/main.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  DEFAULT_BACKUP_SCHEDULE,
} from '../../../carbon/scripts/render-backup-settings.mjs';
import { gitSafeEnv } from '../../../src/lib/command.js';

vi.mock('../../../src/lib/github-environments.js', () => ({
  seedOrgSecrets: vi.fn(async () => {}),
  seedEnvironmentSecrets: vi.fn(async () => {}),
  uploadKubeconfig: vi.fn(async () => {}),
  triggerDeployWorkflow: vi.fn(async () => {}),
  waitForLatestWorkflowRun: vi.fn(async () => ({ runId: 1 })),
}));

const { seedEnvironmentSecrets } = await import('../../../src/lib/github-environments.js');
const { deployK8sGitOps } = await import('../../../src/lib/deploy/k8s/gitops-deploy.js');

const work = mkdtempSync(join(tmpdir(), 'vc-gitops-backup-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitSafeEnv(), encoding: 'utf-8' }).trim();

async function deployWith(name: string, backupConfig: unknown) {
  const origin = join(work, `${name}-origin.git`);
  const project = join(work, `${name}-project`);
  mkdirSync(origin, { recursive: true });
  git(origin, 'init', '--bare', '-b', 'main');
  mkdirSync(project, { recursive: true });
  git(project, 'init', '-b', 'main');
  git(project, 'config', 'user.email', 't@example.test');
  git(project, 'config', 'user.name', 'T');
  git(project, 'remote', 'add', 'origin', origin);
  cpSync('carbon/k8s/base/backup', join(project, 'k8s/base/backup'), { recursive: true });
  cpSync('carbon/k8s/base/config', join(project, 'k8s/base/config'), { recursive: true });
  vi.mocked(seedEnvironmentSecrets).mockClear();
  await deployK8sGitOps({
    projectDir: project,
    environment: name,
    domain: 'app.example.test',
    projectName: 'proj',
    kubeconfigPath: join(project, 'kubeconfig'),
    networkId: '',
    dnsProvider: 'manual',
    providerCreds: {},
    appStorage: { accessKey: 'a', secretKey: 'b' },
    githubOwner: 'acme',
    backupConfig,
  });
  const show = (f: string) => git(origin, 'show', `main:k8s/base/${f}`);
  const [, , vars] = vi.mocked(seedEnvironmentSecrets).mock.calls[0];
  return {
    vars: vars as Record<string, string>,
    cronjob: show('backup/cronjob.yaml'),
    configmap: show('config/configmap.yaml'),
  };
}

describe('deployK8sGitOps seeds the backup settings per environment, never into the shared base', () => {
  it('two environments get their own GitHub Environment vars; the committed tree carries neither', async () => {
    const staging = await deployWith('staging', { schedule: '0 */6 * * *', retentionDays: 14 });
    const prod = await deployWith('prod', { schedule: '30 4 * * *', retentionDays: 90 });
    expect(staging.vars).toMatchObject({
      BACKUP_SCHEDULE: '0 */6 * * *',
      BACKUP_RETENTION_DAYS: '14',
    });
    expect(prod.vars).toMatchObject({ BACKUP_SCHEDULE: '30 4 * * *', BACKUP_RETENTION_DAYS: '90' });
    for (const t of [staging, prod]) {
      expect(t.cronjob).toContain('schedule: "{{BACKUP_SCHEDULE}}"');
      expect(t.cronjob + t.configmap).not.toMatch(/\*\/6|30 4|BACKUP_RETENTION_DAYS: "/);
    }
  });

  it('no recorded backup config seeds the shared defaults', async () => {
    const t = await deployWith('dev', undefined);
    expect(t.vars).toMatchObject({
      BACKUP_SCHEDULE: DEFAULT_BACKUP_SCHEDULE,
      BACKUP_RETENTION_DAYS: String(DEFAULT_BACKUP_RETENTION_DAYS),
    });
  });

  it('a malformed backup config stops the deploy before anything is committed or seeded', async () => {
    await expect(deployWith('bad', { schedule: '@daily', retentionDays: 7 })).rejects.toThrow(
      /5-field cron/,
    );
    await expect(deployWith('bad0', { retentionDays: 0 })).rejects.toThrow(/positive whole number/);
  });
});
