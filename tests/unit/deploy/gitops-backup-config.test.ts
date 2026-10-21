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
import { gitSafeEnv } from '../../../src/lib/command.js';

vi.mock('../../../src/lib/github-environments.js', () => ({
  seedOrgSecrets: vi.fn(async () => {}),
  seedEnvironmentSecrets: vi.fn(async () => {}),
  uploadKubeconfig: vi.fn(async () => {}),
  triggerDeployWorkflow: vi.fn(async () => {}),
  waitForLatestWorkflowRun: vi.fn(async () => ({ runId: 1 })),
}));

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
  await deployK8sGitOps({
    projectDir: project,
    environment: 'prod',
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
  return { cronjob: show('backup/cronjob.yaml'), configmap: show('config/configmap.yaml') };
}

describe('deployK8sGitOps commits the configured backup settings', () => {
  it('the schedule and retention are in the files Flux reconciles', async () => {
    const { cronjob, configmap } = await deployWith('cfg', {
      schedule: '0 */6 * * *',
      retentionDays: 14,
    });
    expect(cronjob).toMatch(/^ {2}schedule: "0 \*\/6 \* \* \*"$/m);
    expect(configmap).toMatch(/^ {2}BACKUP_RETENTION_DAYS: "14"$/m);
  });

  it('no recorded backup config commits the manifest defaults', async () => {
    const { cronjob, configmap } = await deployWith('none', undefined);
    expect(cronjob).toMatch(/^ {2}schedule: "0 2 \* \* \*"$/m);
    expect(configmap).toMatch(/^ {2}BACKUP_RETENTION_DAYS: "7"$/m);
  });
});
