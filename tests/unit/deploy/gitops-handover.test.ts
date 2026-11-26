/**
 * `configure cicd <env>` hands the cluster to Flux from the operator's
 * machine (handOverCluster) instead of dispatching a GitHub workflow that
 * would reach the cluster from a runner the firewall never lets in. The push
 * comes first: Flux's first sync reads main. Runs deployK8sGitOps for real
 * (a real git repo and a local bare origin) with the GitHub calls and the
 * handover faked.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gitSafeEnv } from '../../../src/lib/command.js';
import { createdK8sProject, withGitOrigin } from '../../_shared/gitops-project.js';

vi.mock('../../../src/lib/github-environments.js', async (orig) =>
  Object.fromEntries(
    Object.keys((await orig()) as Record<string, unknown>).map((name) => [name, vi.fn()]),
  ),
);
vi.mock('../../../src/lib/deploy/k8s/flux-handover.js', () => ({ handOverCluster: vi.fn() }));

const github = await import('../../../src/lib/github-environments.js');
const { handOverCluster } = await import('../../../src/lib/deploy/k8s/flux-handover.js');
const { deployK8sGitOps } = await import('../../../src/lib/deploy/k8s/gitops-deploy.js');
const { PROVIDERS } = await import('../../../src/lib/providers/index.js');

/** Whether the bare origin has a main branch yet. */
const hasMain = (origin: string) => {
  try {
    execFileSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/main'], {
      cwd: origin,
      env: gitSafeEnv(),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

function gitopsProject() {
  const made = withGitOrigin(createdK8sProject());
  writeFileSync(
    join(made.project, '.vibecarbon.json'),
    `${JSON.stringify({ projectName: 'proj' })}\n`,
  );
  return made;
}

const deploy = (project: string) =>
  deployK8sGitOps({
    projectDir: project,
    environment: 'prod',
    domain: 'app.example.test',
    projectName: 'proj',
    kubeconfigPath: join(project, 'kubeconfig'),
    appStorage: { accessKey: 'a', secretKey: 'b' },
    githubOwner: 'acme',
    ProviderClass: PROVIDERS.hetzner,
  });

beforeEach(() => vi.clearAllMocks());

describe('deployK8sGitOps hands the cluster to Flux itself', () => {
  it('pushes first, then hands the cluster to Flux, and dispatches no workflow', async () => {
    const { project, origin } = gitopsProject();
    const originHadMain: boolean[] = [];
    vi.mocked(handOverCluster).mockImplementation(async () => {
      originHadMain.push(hasMain(origin));
    });
    const result = await deploy(project);
    expect(handOverCluster).toHaveBeenCalledTimes(1);
    expect(handOverCluster).toHaveBeenCalledWith({
      projectDir: project,
      envName: 'prod',
      kubeconfigPath: join(project, 'kubeconfig'),
    });
    expect(originHadMain).toEqual([true]);
    expect(github.triggerDeployWorkflow).not.toHaveBeenCalled();
    expect(github.waitForLatestWorkflowRun).not.toHaveBeenCalled();
    expect(result).toEqual({ pushed: true });
  });

  it("a handover failure fails the command with Flux's words", async () => {
    const { project } = gitopsProject();
    vi.mocked(handOverCluster).mockRejectedValue(new Error('flux did not finish'));
    const err = await deploy(project).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe('flux did not finish');
  });
});
