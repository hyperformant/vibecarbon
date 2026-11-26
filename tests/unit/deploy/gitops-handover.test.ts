/**
 * `configure cicd <env>` hands the cluster to Flux from the operator's
 * machine (handOverCluster) instead of dispatching a GitHub workflow that
 * would reach the cluster from a runner the firewall never lets in. The push
 * comes first: Flux's first sync reads main, and the push is all that goes
 * to GitHub. Runs deployK8sGitOps for real (a real git repo and a local bare
 * origin) with the GitHub calls and the handover faked, and its spinner and
 * git's push lines kept off the terminal.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gitSafeEnv } from '../../../src/lib/command.js';
import { createdK8sProject, withGitOrigin } from '../../_shared/gitops-project.js';

vi.mock('@clack/prompts', async (orig) =>
  (await import('../../_shared/clack-fake.js')).quietClack(await orig(), {
    log: ['info', 'success', 'warn', 'error'],
  }),
);
vi.mock('../../../src/lib/github-environments.js', async (orig) =>
  Object.fromEntries(
    Object.keys((await orig()) as Record<string, unknown>).map((name) => [name, vi.fn()]),
  ),
);
vi.mock('../../../src/lib/deploy/k8s/flux-handover.js', () => ({ handOverCluster: vi.fn() }));

const github = await import('../../../src/lib/github-environments.js');
const { handOverCluster } = await import('../../../src/lib/deploy/k8s/flux-handover.js');
const { deployK8sGitOps, gitopsTargets } = await import(
  '../../../src/lib/deploy/k8s/gitops-deploy.js'
);
const { FLUX_CLUSTER_FILE } = await import(
  '../../../src/lib/deploy/k8s/unrendered-placeholders.js'
);

/** Every call made at GitHub, by function: the push is all that goes there. */
const githubCalls = () =>
  Object.entries(github).flatMap(([name, fn]) =>
    vi.isMockFunction(fn) ? fn.mock.calls.map((call) => [name, call]) : [],
  );

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

/** The pull credential configure cicd resolved, handed through as it is. */
const GHCR_PULL = { mode: 'token', username: 'octo', token: 'pull-token-fixture' };

const deploy = async (project: string) => {
  // git push reports to stderr, which execFileSync passes on to ours.
  const pushLines = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    return await deployK8sGitOps({
      projectDir: project,
      environment: 'prod',
      projectName: 'proj',
      kubeconfigPath: join(project, 'kubeconfig'),
      githubOwner: 'acme',
      ghcrPull: GHCR_PULL,
    });
  } finally {
    pushLines.mockRestore();
  }
};

beforeEach(() => vi.clearAllMocks());

describe('deployK8sGitOps hands the cluster to Flux itself', () => {
  it('pushes first, then hands the cluster to Flux, and copies nothing to GitHub', async () => {
    const { project, origin } = gitopsProject();
    const originHadMain: boolean[] = [];
    vi.mocked(handOverCluster).mockImplementation(async () => {
      originHadMain.push(hasMain(origin));
    });
    const result = await deploy(project);
    expect(handOverCluster).toHaveBeenCalledTimes(1);
    // The repo the deploy key goes on: the owner given, the repo the
    // project is named for (no GitHub remote to ask here).
    expect(handOverCluster).toHaveBeenCalledWith({
      projectDir: project,
      envName: 'prod',
      kubeconfigPath: join(project, 'kubeconfig'),
      owner: 'acme',
      repo: 'proj',
      ghcrPull: GHCR_PULL,
    });
    expect(vi.mocked(handOverCluster).mock.calls[0][0].ghcrPull).toBe(GHCR_PULL);
    expect(originHadMain).toEqual([true]);
    // No secret, variable or kubeconfig copy, and no workflow to dispatch.
    expect(githubCalls()).toEqual([]);
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

  it('a cluster file that still clones over https is refused before anything is written, naming upgrade', async () => {
    vi.mocked(handOverCluster).mockResolvedValue(undefined);
    const { project, origin } = gitopsProject();
    const clusterFile = join(project, FLUX_CLUSTER_FILE);
    const https = readFileSync(clusterFile, 'utf-8').replace(
      'url: ssh://git@github.com/proj/proj',
      'url: https://github.com/proj/proj',
    );
    writeFileSync(clusterFile, https);
    const err = await deploy(project).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe(
      `${FLUX_CLUSTER_FILE} still has flux read your repo over https, which needs a token github ` +
        'takes back after every workflow run. run vibecarbon upgrade and take the new ' +
        `${FLUX_CLUSTER_FILE}, then rerun vibecarbon configure cicd prod`,
    );
    // Nothing written, pushed or handed over.
    expect(readFileSync(clusterFile, 'utf-8')).toBe(https);
    expect(JSON.parse(readFileSync(join(project, '.vibecarbon.json'), 'utf-8'))).toEqual({
      projectName: 'proj',
    });
    expect(hasMain(origin)).toBe(false);
    expect(githubCalls()).toEqual([]);
    expect(handOverCluster).not.toHaveBeenCalled();
  });
});

describe('gitopsTargets', () => {
  it('reads the roles from ha.primary.stack, so a failed-over pair hands the promoted side over as primary', () => {
    expect(gitopsTargets('prod', { deployMode: 'k8s-ha' })).toEqual([
      { suffix: 'primary', envName: 'prod-primary', role: 'primary' },
      { suffix: 'standby', envName: 'prod-standby', role: 'standby' },
    ]);
    expect(
      gitopsTargets('prod', { deployMode: 'k8s-ha', ha: { primary: { stack: 'prod-standby' } } }),
    ).toEqual([
      { suffix: 'primary', envName: 'prod-primary', role: 'standby' },
      { suffix: 'standby', envName: 'prod-standby', role: 'primary' },
    ]);
    expect(gitopsTargets('dev', { deployMode: 'k8s' })).toEqual([
      { suffix: null, envName: 'dev', role: 'primary' },
    ]);
  });
});
