/**
 * The CLI puts no copy of the provider API token at GitHub.
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
 * is committed, pushed or seeded, with the way out, naming the environment's
 * own provider and token: the old step ran on every provider, and on
 * DigitalOcean and Linode it wrote a Hetzner token into a Secret nothing
 * there reads. One whose deploy.yml no longer reads the repo secret is told
 * once that the secret is still at GitHub (noteUnreadTokenSecrets), which
 * nothing deletes for it.
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
import { LEGACY_GITOPS_STEP } from '../../_shared/legacy-gitops-secrets.js';

vi.mock('../../../src/lib/github-environments.js', () => ({
  listRepoSecretNames: vi.fn(async (): Promise<string[]> => []),
  seedEnvironmentSecrets: vi.fn(async () => {}),
  uploadKubeconfig: vi.fn(async () => {}),
  triggerDeployWorkflow: vi.fn(async () => {}),
  waitForLatestWorkflowRun: vi.fn(async () => ({ runId: 1 })),
}));

const github = await import('../../../src/lib/github-environments.js');
const { deployK8sGitOps, noteUnreadTokenSecrets } = await import(
  '../../../src/lib/deploy/k8s/gitops-deploy.js'
);
const { PROVIDERS } = await import('../../../src/lib/providers/index.js');
const p = await import('@clack/prompts');

const SENTINEL = 'vc-sentinel-hcloud-token-91c4';
const TEMPLATE_WORKFLOW = readFileSync('carbon/.github/workflows/deploy.yml', 'utf-8');
/** The step every deploy.yml before this one carried, verbatim. */
const LEGACY_WORKFLOW = TEMPLATE_WORKFLOW.replace(
  /^ {2}bootstrap-flux:$/m,
  `${LEGACY_GITOPS_STEP}\n\n  bootstrap-flux:`,
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

const deploy = (dir: string, Provider: unknown = PROVIDERS.hetzner) =>
  deployK8sGitOps({
    ProviderClass: Provider,
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

  it.each([
    ['digitalocean', 'DigitalOcean', 'DIGITALOCEAN_API_TOKEN'],
    ['linode', 'Linode', 'LINODE_API_TOKEN'],
  ])(
    "%s: the refusal names the cluster's own token, and the Hetzner one the step copies",
    async (id, name, variable) => {
      const Provider = PROVIDERS[id as keyof typeof PROVIDERS];
      expect([Provider.NAME, Provider.TOKEN_ENV]).toEqual([name, variable]);
      const { dir, origin } = project(`legacy-${id}`, LEGACY_WORKFLOW);
      const refusal = await deploy(dir, Provider).then(
        () => null,
        (err: Error) => err.message,
      );
      expect(refusal).toBe(
        'Your .github/workflows/deploy.yml still writes a kube-system/hcloud Secret into the ' +
          "cluster from your repo's HETZNER_API_TOKEN Actions secret (secrets.HETZNER_API_TOKEN), " +
          'which an earlier vibecarbon filled from your HETZNER_API_TOKEN, a Hetzner Cloud token, ' +
          `whatever the provider. Your ${name} cluster reads neither: \`vibecarbon deploy\` hands ` +
          `it your ${name} API token (${variable}) itself and removes that Secret, so each run of ` +
          'this workflow would only put it back. Run `vibecarbon upgrade` for a deploy.yml ' +
          'without that step, or delete every step that reads secrets.HETZNER_API_TOKEN ' +
          'yourself; commit the change and run this again. Then remove the copy: ' +
          '`gh secret delete HETZNER_API_TOKEN`.',
      );
      expect(refusal).not.toContain('your Hetzner Cloud API token');
      expect(git(origin, 'for-each-ref')).toBe('');
      expect(githubCalls()).toBe(JSON.stringify(Object.values(github).map(() => [])));
    },
  );

  it('a caller that names no provider is refused before anything is pushed or seeded', async () => {
    const { dir, origin } = project('no-provider', TEMPLATE_WORKFLOW);
    await expect(deploy(dir, null)).rejects.toThrow(
      "deployK8sGitOps needs the environment's ProviderClass",
    );
    expect(git(origin, 'for-each-ref')).toBe('');
    expect(githubCalls()).toBe(JSON.stringify(Object.values(github).map(() => [])));
  });
});

describe('configure cicd names a token secret still at GitHub that no workflow reads, once, and deletes nothing', () => {
  let infos: string[];
  beforeEach(() => {
    infos = [];
    vi.spyOn(p.log, 'info').mockImplementation((line: string) => {
      infos.push(line);
    });
  });
  const listed = (...names: string[]) =>
    vi.mocked(github.listRepoSecretNames).mockResolvedValueOnce(names);
  const note = (dir: string, Provider: unknown = PROVIDERS.hetzner) =>
    noteUnreadTokenSecrets({ projectDir: dir, ProviderClass: Provider as never });
  /** Every GitHub call but the list: the note makes none. */
  const otherCalls = () =>
    Object.entries(github)
      .filter(([name, fn]) => name !== 'listRepoSecretNames' && vi.isMockFunction(fn))
      .flatMap(([, fn]) => (fn as ReturnType<typeof vi.fn>).mock.calls);

  it('an upgraded deploy.yml and the secret still there: one line, with the command, and no delete', async () => {
    const { dir } = project('note-upgraded', TEMPLATE_WORKFLOW);
    listed('KUBECONFIG_B64', 'HETZNER_API_TOKEN');
    expect(await note(dir)).toEqual(['HETZNER_API_TOKEN']);
    expect(infos).toEqual([
      'Your repo still has a HETZNER_API_TOKEN Actions secret, and no workflow in ' +
        '.github/workflows reads it. `vibecarbon deploy` hands your cloud API token to the ' +
        'cluster itself and puts no copy at GitHub any more, so that copy is one more place a ' +
        'token lives, and nothing keeps it current. Delete it when you like with ' +
        '`gh secret delete HETZNER_API_TOKEN`; this command leaves it alone.',
    ]);
    expect(vi.mocked(github.listRepoSecretNames)).toHaveBeenCalledTimes(1);
    // Bounded: a stalled gh holds up no setup for advice.
    expect(vi.mocked(github.listRepoSecretNames)).toHaveBeenCalledWith({ timeout: 20_000 });
    expect(otherCalls()).toEqual([]);
    // Nothing in the GitOps layer can delete a secret: the command is only
    // ever said, never run.
    for (const file of ['src/lib/github-environments.js', 'src/lib/deploy/k8s/gitops-deploy.js']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/'secret',\s*'delete'/);
    }
  });

  it("names the provider's own token variable too, should a secret by that name be there", async () => {
    const { dir } = project('note-do', TEMPLATE_WORKFLOW);
    listed('HETZNER_API_TOKEN', 'DIGITALOCEAN_API_TOKEN');
    expect(await note(dir, PROVIDERS.digitalocean)).toEqual([
      'HETZNER_API_TOKEN',
      'DIGITALOCEAN_API_TOKEN',
    ]);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain(
      'Your repo still has HETZNER_API_TOKEN and DIGITALOCEAN_API_TOKEN Actions secrets, and no ' +
        'workflow in .github/workflows reads them.',
    );
    expect(infos[0]).toContain(
      '`gh secret delete HETZNER_API_TOKEN` and `gh secret delete DIGITALOCEAN_API_TOKEN`; this ' +
        'command leaves them alone.',
    );
    expect(otherCalls()).toEqual([]);
  });

  it('a secret no one has: no line', async () => {
    const { dir } = project('note-none', TEMPLATE_WORKFLOW);
    listed('KUBECONFIG_B64');
    expect(await note(dir)).toEqual([]);
    expect(infos).toEqual([]);
  });

  it("a secret the old step still reads is the refusal's to name, not this", async () => {
    const { dir } = project('note-legacy', LEGACY_WORKFLOW);
    listed('HETZNER_API_TOKEN');
    expect(await note(dir)).toEqual([]);
    expect(infos).toEqual([]);
  });

  it('a secret only the committed workflow reads is still read: the push sends that one', async () => {
    const { dir } = project('note-committed', LEGACY_WORKFLOW, TEMPLATE_WORKFLOW);
    listed('HETZNER_API_TOKEN');
    expect(await note(dir)).toEqual([]);
  });

  it("a secret the operator's own workflow reads, either way GitHub spells it, is theirs", async () => {
    for (const read of ['secrets.HETZNER_API_TOKEN', "secrets['HETZNER_API_TOKEN']"]) {
      const { dir } = project(`note-own-${read.length}`, TEMPLATE_WORKFLOW);
      writeFileSync(
        join(dir, '.github/workflows/my-tool.yaml'),
        `on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n        env:\n          T: \${{ ${read} }}\n`,
      );
      listed('HETZNER_API_TOKEN');
      expect(await note(dir), read).toEqual([]);
    }
    // A name that only starts the same is not a read of it.
    const { dir } = project('note-prefix', TEMPLATE_WORKFLOW);
    writeFileSync(
      join(dir, '.github/workflows/other.yml'),
      `on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n        env:\n          T: \${{ secrets.HETZNER_API_TOKEN_OLD }}\n`,
    );
    listed('HETZNER_API_TOKEN');
    expect(await note(dir)).toEqual(['HETZNER_API_TOKEN']);
  });

  it('a list that fails says nothing and stops nothing', async () => {
    const { dir } = project('note-fails', TEMPLATE_WORKFLOW);
    vi.mocked(github.listRepoSecretNames).mockRejectedValueOnce(new Error('gh: HTTP 403'));
    expect(await note(dir)).toEqual([]);
    expect(infos).toEqual([]);
  });

  it('docs/security.md says what an earlier vibecarbon left at GitHub and in the cluster, and what to do', () => {
    const doc = readFileSync('docs/security.md', 'utf8');
    const gitops = doc.slice(doc.indexOf('**GitOps** (`vibecarbon configure cicd`)'));
    const para = gitops.slice(0, gitops.indexOf('\n'));
    expect(doc).not.toContain('GitHub keeps no copy');
    expect(doc).not.toContain('and never at GitHub');
    for (const said of [
      'the CLI puts no copy of the token at GitHub. An earlier one did',
      "whatever the environment's provider",
      '`configure cicd` refuses to run while your deploy.yml still does',
      'Once no workflow reads the secret, `configure cicd` names it each time it runs, with ' +
        '`gh secret delete HETZNER_API_TOKEN`, and leaves deleting it to you.',
      'On a DigitalOcean or Linode cluster nothing reads `kube-system/hcloud`, and a deploy removes it',
      'so rotate that token too.',
    ]) {
      expect(para).toContain(said);
    }
  });

  it('configure cicd asks once, before its per-cluster loop, and hands each deploy the provider', () => {
    const src = readFileSync('src/configure.js', 'utf8');
    const body = src.slice(src.indexOf('export async function runConfigureCicd('));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn.match(/noteUnreadTokenSecrets\(/g)).toHaveLength(1);
    const noteAt = fn.indexOf('await noteUnreadTokenSecrets({ projectDir: cwd, ProviderClass });');
    const loopAt = fn.indexOf('for (const target of targets) {');
    expect(noteAt).toBeGreaterThan(-1);
    expect(noteAt).toBeLessThan(loopAt);
    const call = fn.slice(fn.indexOf('await deployK8sGitOps({'));
    expect(call.slice(0, call.indexOf('});'))).toMatch(/\bProviderClass,\n/);
    expect(fn).toMatch(/const ProviderClass = getProviderClass\(storageProviderId\);/);
    expect(fn).toMatch(
      /const storageProviderId = \(envConfig\.provider \|\| 'hetzner'\)\.toLowerCase\(\);/,
    );
  });
});
