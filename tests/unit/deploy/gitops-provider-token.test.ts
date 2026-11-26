/**
 * The CLI puts no copy of the provider API token at GitHub.
 *
 * `vibecarbon deploy` hands the token to the cluster itself on every deploy
 * (applyCloudSecrets, tests/unit/deploy/k8s-cloud-secrets.test.ts), and the
 * GitOps layer (`vibecarbon configure cicd`) copies nothing to GitHub at all
 * (gitops-handover.test.ts). An earlier vibecarbon seeded a HETZNER_API_TOKEN
 * repo secret for the kube-system/hcloud step of its deploy.yml, on every
 * provider. Once no workflow reads that secret, `configure cicd` says once
 * that it is still at GitHub (noteUnreadTokenSecrets), and nothing deletes it
 * for the operator. A deploy.yml that still reads it is named with the other
 * copies an earlier vibecarbon left (gitops-retired-copies.test.ts).
 *
 * Reads real git repos; only the GitHub API calls are stubbed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitSafeEnv } from '../../../src/lib/command.js';
import { LEGACY_GITOPS_STEP } from '../../_shared/legacy-gitops-secrets.js';
import { cleanupTempDir, createTempDir } from '../../_shared/temp-dir.js';

vi.mock('../../../src/lib/github-environments.js', () => ({
  listRepoSecretNames: vi.fn(async (): Promise<string[]> => []),
}));

const github = await import('../../../src/lib/github-environments.js');
const { noteUnreadTokenSecrets } = await import('../../../src/lib/deploy/k8s/gitops-deploy.js');
const { PROVIDERS } = await import('../../../src/lib/providers/index.js');
const p = await import('@clack/prompts');

/** A workflow that reads no token secret: the build workflow this vibecarbon ships. */
const TEMPLATE_WORKFLOW = readFileSync('carbon/.github/workflows/vibecarbon-build.yml', 'utf-8');
/** The deploy.yml an earlier vibecarbon installed, with the step it carried, verbatim. */
const LEGACY_WORKFLOW = [
  'on: workflow_dispatch',
  'jobs:',
  '  bootstrap-flux:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  LEGACY_GITOPS_STEP,
  '',
].join('\n');

const work = createTempDir('vc-gitops-token-');
afterAll(() => cleanupTempDir(work));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitSafeEnv(), encoding: 'utf-8' }).trim();

/**
 * A project with this workflow committed (`committed`) and, when it differs,
 * left in the working tree (`working`).
 */
function project(name: string, committed: string, working = committed) {
  const dir = join(work, `${name}-project`);
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 'T');
  const workflow = join(dir, '.github/workflows/deploy.yml');
  writeFileSync(workflow, committed);
  git(dir, 'add', '.github');
  git(dir, 'commit', '-m', 'the project as it was made');
  if (working !== committed) writeFileSync(workflow, working);
  return { dir };
}

beforeEach(() => vi.clearAllMocks());

describe('the record of the old step', () => {
  it('the legacy workflow this file builds really reads the repo secret', () => {
    expect(TEMPLATE_WORKFLOW).not.toMatch(/secrets\.HETZNER_API_TOKEN/);
    expect(LEGACY_WORKFLOW).toContain(`\${{ secrets.HETZNER_API_TOKEN }}`);
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

  it('a workflow without the step and the secret still there: one line, with the command, and no delete', async () => {
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

  it('a secret the old deploy.yml still reads is not named: the leftover note names that workflow', async () => {
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
    expect(para).not.toContain('refuses');
    for (const said of [
      'the CLI puts no copy of the token at GitHub. An earlier one did',
      "whatever the environment's provider",
      'An old deploy.yml that still writes it is named with the other copies an earlier ' +
        'vibecarbon left at GitHub each time `configure cicd` runs, and nothing dispatches it now.',
      'Once no workflow reads the secret, `configure cicd` names it each time it runs, with ' +
        '`gh secret delete HETZNER_API_TOKEN`, and leaves deleting it to you.',
      'On a DigitalOcean or Linode cluster nothing reads `kube-system/hcloud`, and a deploy removes it',
      'so rotate that token too.',
    ]) {
      expect(para).toContain(said);
    }
  });

  it('configure cicd asks once, before its per-cluster loop, with the environment provider', () => {
    const src = readFileSync('src/configure.js', 'utf8');
    const body = src.slice(src.indexOf('export async function runConfigureCicd('));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn.match(/noteUnreadTokenSecrets\(/g)).toHaveLength(1);
    const noteAt = fn.indexOf('await noteUnreadTokenSecrets({ projectDir: cwd, ProviderClass });');
    const loopAt = fn.indexOf('for (const target of targets) {');
    expect(noteAt).toBeGreaterThan(-1);
    expect(noteAt).toBeLessThan(loopAt);
    // The deploy itself needs no provider: it copies nothing to GitHub.
    const call = fn.slice(fn.indexOf('await deployK8sGitOps({'));
    expect(call.slice(0, call.indexOf('});'))).not.toMatch(/\bProviderClass\b/);
    expect(fn).toContain(
      "const ProviderClass = getProviderClass((envConfig.provider || 'hetzner').toLowerCase());",
    );
  });
});
