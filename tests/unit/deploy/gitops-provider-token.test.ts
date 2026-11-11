/**
 * GitHub keeps no copy of the provider API token.
 *
 * `vibecarbon deploy` hands the token to the cluster itself on every deploy
 * (applyCloudSecrets, tests/unit/deploy/k8s-cloud-secrets.test.ts), so the
 * GitOps layer (`vibecarbon configure cicd`) has nothing to write it for:
 * deploy.yml applies no kube-system/hcloud Secret, and deployK8sGitOps seeds
 * no HETZNER_API_TOKEN repo secret and no HCLOUD_NETWORK_ID variable. A copy
 * at GitHub would be one more place the token lives, and one the CLI no
 * longer updates: after a token rotation, a run of the old step would write
 * the revoked token back over the one the deploy applied.
 *
 * A project whose deploy.yml still has that step is refused before anything
 * is committed, pushed or seeded, with the way out.
 *
 * Runs deployK8sGitOps for real (a real git repo and a local bare origin) with
 * only the GitHub API calls stubbed, as gitops-backup-config.test.ts does.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitSafeEnv } from '../../../src/lib/command.js';

vi.mock('../../../src/lib/github-environments.js', () => ({
  seedEnvironmentSecrets: vi.fn(async () => {}),
  uploadKubeconfig: vi.fn(async () => {}),
  triggerDeployWorkflow: vi.fn(async () => {}),
  waitForLatestWorkflowRun: vi.fn(async () => ({ runId: 1 })),
}));

const github = await import('../../../src/lib/github-environments.js');
const { deployK8sGitOps } = await import('../../../src/lib/deploy/k8s/gitops-deploy.js');

const SENTINEL = 'vc-sentinel-hcloud-token-91c4';
const TEMPLATE_WORKFLOW = readFileSync('carbon/.github/workflows/deploy.yml', 'utf-8');
/** The step every deploy.yml before this one carried, verbatim. */
const LEGACY_STEP = [
  '      - name: Apply kube-system/hcloud Secret (CCM + CSI)',
  '        env:',
  `          HETZNER_API_TOKEN: \${{ secrets.HETZNER_API_TOKEN }}`,
  `          HCLOUD_NETWORK_ID: \${{ vars.HCLOUD_NETWORK_ID }}`,
  '        run: |',
  '          kubectl create secret generic hcloud \\',
  '            --namespace=kube-system \\',
  '            --from-literal=token="$HETZNER_API_TOKEN" \\',
  '            --from-literal=network="$HCLOUD_NETWORK_ID" \\',
  '            --dry-run=client -o yaml \\',
  '          | kubectl apply --server-side --force-conflicts \\',
  '              --field-manager=github-actions-deploy -f -',
].join('\n');
const LEGACY_WORKFLOW = TEMPLATE_WORKFLOW.replace(
  /^ {2}bootstrap-flux:$/m,
  `${LEGACY_STEP}\n\n  bootstrap-flux:`,
);

const work = mkdtempSync(join(tmpdir(), 'vc-gitops-token-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitSafeEnv(), encoding: 'utf-8' }).trim();

/**
 * A project with its deploy.yml committed (`committed`) and, when it differs,
 * left in the working tree (`working`), and an empty origin.
 */
function project(name: string, committed: string, working = committed) {
  const origin = join(work, `${name}-origin.git`);
  const dir = join(work, `${name}-project`);
  mkdirSync(origin, { recursive: true });
  git(origin, 'init', '--bare', '-b', 'main');
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'remote', 'add', 'origin', origin);
  cpSync('carbon/k8s/base/backup', join(dir, 'k8s/base/backup'), { recursive: true });
  cpSync('carbon/k8s/base/config', join(dir, 'k8s/base/config'), { recursive: true });
  const workflow = join(dir, '.github/workflows/deploy.yml');
  writeFileSync(workflow, committed);
  git(dir, 'add', '.github');
  git(dir, 'commit', '-m', 'the project as it was made');
  if (working !== committed) writeFileSync(workflow, working);
  return { dir, origin };
}

const deploy = (dir: string) =>
  deployK8sGitOps({
    projectDir: dir,
    environment: 'prod',
    domain: 'app.example.test',
    projectName: 'proj',
    kubeconfigPath: join(dir, 'kubeconfig'),
    // What a caller from before this change passed: never uploaded.
    networkId: '4711',
    providerCreds: { hetznerApiToken: SENTINEL },
    appStorage: { accessKey: 'a', secretKey: 'b' },
    githubOwner: 'acme',
  });

/** Every argument any GitHub call was given, as one string. */
const githubCalls = () =>
  JSON.stringify(Object.values(github).map((fn) => (vi.isMockFunction(fn) ? fn.mock.calls : [])));

beforeEach(() => vi.clearAllMocks());

describe('the template deploy.yml writes no provider token into the cluster', () => {
  it('reads no HETZNER_API_TOKEN secret or HCLOUD_NETWORK_ID variable, and creates no hcloud Secret', () => {
    expect(TEMPLATE_WORKFLOW).not.toMatch(/secrets\.HETZNER_API_TOKEN/);
    expect(TEMPLATE_WORKFLOW).not.toMatch(/HCLOUD_NETWORK_ID/);
    expect(TEMPLATE_WORKFLOW).not.toMatch(/create secret generic hcloud\b/);
    // Still kept out of the app and infra Secrets, should a repo hold one.
    expect(TEMPLATE_WORKFLOW).toMatch(/\.HETZNER_API_TOKEN, \.HCLOUD_TOKEN/);
  });

  it('the legacy workflow this file builds really carries the step', () => {
    expect(LEGACY_WORKFLOW).not.toBe(TEMPLATE_WORKFLOW);
    expect(LEGACY_WORKFLOW).toContain(`\${{ secrets.HETZNER_API_TOKEN }}`);
  });
});

describe('deployK8sGitOps seeds no provider token', () => {
  it('a project on the template workflow: no token and no network id reach GitHub', async () => {
    const { dir } = project('template', TEMPLATE_WORKFLOW);
    await deploy(dir);
    expect(vi.mocked(github.seedEnvironmentSecrets)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(github.triggerDeployWorkflow)).toHaveBeenCalledTimes(1);
    const [, secrets, vars] = vi.mocked(github.seedEnvironmentSecrets).mock.calls[0];
    expect(Object.keys(secrets as object)).not.toContain('HETZNER_API_TOKEN');
    expect(Object.keys(vars as object)).not.toContain('HCLOUD_NETWORK_ID');
    expect(githubCalls()).not.toContain(SENTINEL);
    expect(githubCalls()).not.toContain('4711');
  });

  it('a project whose deploy.yml still writes kube-system/hcloud is refused before anything is pushed or seeded', async () => {
    const { dir, origin } = project('legacy', LEGACY_WORKFLOW);
    const refusal = await deploy(dir).then(
      () => null,
      (err: Error) => err.message,
    );
    expect(refusal).toBe(
      'Your .github/workflows/deploy.yml still writes your Hetzner Cloud API token into the cluster ' +
        'from a GitHub copy of it (secrets.HETZNER_API_TOKEN). `vibecarbon deploy` hands the token ' +
        'to the cluster itself now and no longer updates that copy, so after you rotate the token, ' +
        'a run of this workflow would write the old one back. Run `vibecarbon upgrade` for a ' +
        'deploy.yml without that step, or delete every step that reads secrets.HETZNER_API_TOKEN ' +
        'yourself; commit the change and run this again. Then remove the copy: ' +
        '`gh secret delete HETZNER_API_TOKEN`.',
    );
    expect(git(origin, 'for-each-ref')).toBe('');
    expect(githubCalls()).toBe(JSON.stringify(Object.values(github).map(() => [])));
  });

  it('the step deleted in the working tree but not committed is still refused: the commit is what gets pushed', async () => {
    const { dir, origin } = project('uncommitted', LEGACY_WORKFLOW, TEMPLATE_WORKFLOW);
    await expect(deploy(dir)).rejects.toThrow(/secrets\.HETZNER_API_TOKEN/);
    expect(git(origin, 'for-each-ref')).toBe('');
  });

  it('the step added back in the working tree is refused too', async () => {
    const { dir } = project('reintroduced', TEMPLATE_WORKFLOW, LEGACY_WORKFLOW);
    await expect(deploy(dir)).rejects.toThrow(/secrets\.HETZNER_API_TOKEN/);
  });
});
