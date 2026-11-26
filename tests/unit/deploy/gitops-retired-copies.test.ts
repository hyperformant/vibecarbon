/**
 * CI/CD on k8s is pull only: `configure cicd <env>` hands each cluster to Flux
 * from the operator's machine, and nothing at GitHub reaches the cluster. So
 * the template ships no deploy workflow, and the CLI copies no secret, no
 * variable and no kubeconfig into a GitHub Environment for one to read; a
 * failover has no GitHub copy to refresh.
 *
 * What an earlier vibecarbon copied there for its old deploy.yml is still
 * there, KUBECONFIG_B64 (admin access to the cluster) first among it. The
 * CLI names those copies once per run, with the command that deletes one,
 * and deletes nothing itself (noteLeftoverGitopsCopies). Only names the old
 * seeding wrote count: one it never wrote is the operator's own. And since
 * vibecarbon makes no GitHub Environment, `vibecarbon destroy` deletes none.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CICD_WORKFLOW_FILES } from '../../../src/lib/ci-setup.js';
import { SHIPPED_WORKFLOWS } from '../../../src/lib/shipped-workflows.js';
import { REPO_ROOT, readRepoFile, sourceFiles } from '../../_shared/source-files.js';
import { createTempDir } from '../../_shared/temp-dir.js';

vi.mock('../../../src/lib/github-environments.js', () => ({
  listEnvironmentSecretNames: vi.fn(async (): Promise<string[]> => []),
  listEnvironmentVariables: vi.fn(async (): Promise<string[]> => []),
  listRepoSecretNames: vi.fn(async (): Promise<string[]> => []),
  seedBuildVars: vi.fn(async (): Promise<string[]> => []),
}));

const github = await import('../../../src/lib/github-environments.js');
const { noteLeftoverGitopsCopies } = await import('../../../src/lib/deploy/k8s/gitops-deploy.js');
const p = await import('@clack/prompts');

/**
 * Each string literal naming a GitHub Environments API path in a `gh` call
 * that deletes (DELETE within the call's reach).
 */
function environmentDeletes(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(/['"`][^'"`\n]*\/environments\b[^'"`\n]*['"`]/g)) {
    const at = m.index ?? 0;
    const call = text.slice(Math.max(0, at - 200), at + m[0].length + 200);
    if (/['"`]gh['"`]|\bgh api\b/.test(call) && /\bDELETE\b/.test(call)) hits.push(m[0]);
  }
  return hits;
}

const BUILD_WORKFLOW = '.github/workflows/vibecarbon-build.yml';
const DEPLOY_WORKFLOW = '.github/workflows/deploy.yml';

describe('nothing at GitHub reaches the cluster', () => {
  it('the template ships no deploy workflow, and configure installs only the build workflow', () => {
    expect(existsSync(join('carbon', DEPLOY_WORKFLOW))).toBe(false);
    expect(CICD_WORKFLOW_FILES).toEqual([BUILD_WORKFLOW]);
    expect(Object.keys(SHIPPED_WORKFLOWS)).toEqual([BUILD_WORKFLOW]);
  });

  it('nothing copies a secret, a variable or a kubeconfig to a GitHub Environment', async () => {
    const environments = await vi.importActual<Record<string, unknown>>(
      '../../../src/lib/github-environments.js',
    );
    for (const name of [
      'seedEnvironmentSecrets',
      'uploadKubeconfig',
      'triggerDeployWorkflow',
      'waitForLatestWorkflowRun',
      'ensureEnvironment',
    ]) {
      expect(Object.keys(environments), name).not.toContain(name);
    }
    const gitops = await vi.importActual<Record<string, unknown>>(
      '../../../src/lib/deploy/k8s/gitops-deploy.js',
    );
    for (const name of ['buildPerEnvSecrets', 'refreshGitopsTlsVars', 'gitopsTlsCertificateVars']) {
      expect(Object.keys(gitops), name).not.toContain(name);
    }
  });

  it('nothing in src deletes a GitHub Environment, so destroy leaves GitHub alone', () => {
    // An Environment vibecarbon did not make is the operator's own, with its
    // protection rules and secrets; leftover copies are the note's to name.
    const files = sourceFiles(join(REPO_ROOT, 'src'), {
      exts: ['.js', '.mjs'],
      relativeTo: REPO_ROOT,
    });
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((rel) =>
      environmentDeletes(readFileSync(join(REPO_ROOT, rel), 'utf8')).map((hit) => `${rel}: ${hit}`),
    );
    expect(hits).toEqual([]);
  });

  it('the guard bites a gh delete at an Environments path, and spares a read', () => {
    // Source text fed to the guard as input, so its `${}` stays literal.
    const deletes = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source fed to the guard
      "runCommand(['gh', 'api', `repos/${repo}/environments/${env}`, '-X', 'DELETE'], {});",
      "run('gh api --method DELETE repos/acme/app/environments/prod');",
    ];
    for (const text of deletes) expect(environmentDeletes(text), text).toHaveLength(1);
    const reads = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source fed to the guard
      "run(['gh', 'api', `repos/${repo}/environments/${env}`]);",
      "run(['gh', 'secret', 'list', '--env', env]);",
    ];
    for (const text of reads) expect(environmentDeletes(text), text).toEqual([]);
  });

  it('a failover leaves GitHub alone', () => {
    expect(readRepoFile('src/failover.js')).not.toMatch(/gitops-deploy\.js|refreshGitopsTls/);
  });

  it('the renderers are modules only', () => {
    for (const rel of [
      'carbon/scripts/render-backup-settings.mjs',
      'carbon/scripts/render-cert-manager.mjs',
      'carbon/scripts/render-tls-certificate.mjs',
    ]) {
      expect(readRepoFile(rel), rel).not.toContain('process.argv');
    }
    expect(existsSync('carbon/scripts/await-cert-manager-leader.sh')).toBe(false);
  });
});

describe('configure cicd names what an earlier vibecarbon left at GitHub, once, and deletes nothing', () => {
  let infos: string[];
  beforeEach(() => {
    vi.clearAllMocks();
    infos = [];
    vi.spyOn(p.log, 'info').mockImplementation((line: string) => {
      infos.push(line);
    });
  });

  /** What each GitHub Environment holds, by name. */
  const holds = (secrets: Record<string, string[]>, vars: Record<string, string[]> = {}): void => {
    vi.mocked(github.listEnvironmentSecretNames).mockImplementation(
      async (env: string) => secrets[env] ?? [],
    );
    vi.mocked(github.listEnvironmentVariables).mockImplementation(
      async (env: string) => vars[env] ?? [],
    );
  };

  /** A project, with the old deploy workflow when asked. */
  const project = ({ deployYml = false } = {}) => {
    const dir = createTempDir('vc-gitops-leftovers-');
    if (deployYml) {
      mkdirSync(join(dir, '.github/workflows'), { recursive: true });
      writeFileSync(join(dir, DEPLOY_WORKFLOW), 'on: workflow_dispatch\n');
    }
    return dir;
  };

  /** Every GitHub call but the two lists: the note makes none. */
  const otherCalls = () =>
    Object.entries(github)
      .filter(
        ([name, fn]) =>
          !['listEnvironmentSecretNames', 'listEnvironmentVariables'].includes(name) &&
          vi.isMockFunction(fn),
      )
      .flatMap(([, fn]) => (fn as ReturnType<typeof vi.fn>).mock.calls);

  const HA = ['prod-primary', 'prod-standby'];

  it('names what an earlier vibecarbon left in each environment, once, with the delete command, and deletes nothing', async () => {
    holds(
      { 'prod-primary': ['KUBECONFIG_B64', 'DB_PASSWORD'], 'prod-standby': ['KUBECONFIG_B64'] },
      { 'prod-primary': ['TLS_CERT_ISSUER'] },
    );
    const named = await noteLeftoverGitopsCopies({ projectDir: project(), envNames: HA });
    expect(named).toEqual([
      'prod-primary:KUBECONFIG_B64',
      'prod-primary:DB_PASSWORD',
      'prod-primary:TLS_CERT_ISSUER',
      'prod-standby:KUBECONFIG_B64',
    ]);
    expect(infos).toEqual([
      'github still holds copies an earlier vibecarbon made for its old deploy workflow: ' +
        'prod-primary has KUBECONFIG_B64 (admin access to the cluster), 1 more secret and 1 variable; ' +
        'prod-standby has KUBECONFIG_B64 (admin access to the cluster). ' +
        'nothing reads them now: vibecarbon deploy applies your secrets from .env.local, and flux ' +
        'pulls from inside the cluster. this command leaves them alone, so delete them when you ' +
        'like, for example: gh secret delete KUBECONFIG_B64 --env prod-primary',
    ]);
    // The command ends the message, so a double-click copies it clean.
    expect(infos[0].endsWith('gh secret delete KUBECONFIG_B64 --env prod-primary')).toBe(true);
    // Each environment's secrets and variables, each list bounded.
    for (const env of HA) {
      expect(github.listEnvironmentSecretNames).toHaveBeenCalledWith(env, { timeout: 20_000 });
      expect(github.listEnvironmentVariables).toHaveBeenCalledWith(env, { timeout: 20_000 });
    }
    expect(otherCalls()).toEqual([]);
    // Nothing in the GitOps layer can delete a copy: the command is only
    // ever said, never run.
    for (const file of ['src/lib/github-environments.js', 'src/lib/deploy/k8s/gitops-deploy.js']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/'(secret|variable)',\s*'delete'/);
    }
  });

  it('names the old deploy workflow file when the repo still has it', async () => {
    holds(
      { prod: ['KUBECONFIG_B64', 'DB_PASSWORD', 'BETTER_AUTH_SECRET'] },
      { prod: ['SITE_URL'] },
    );
    const named = await noteLeftoverGitopsCopies({
      projectDir: project({ deployYml: true }),
      envNames: ['prod'],
    });
    expect(named).toEqual([
      'prod:KUBECONFIG_B64',
      'prod:DB_PASSWORD',
      'prod:BETTER_AUTH_SECRET',
      'prod:SITE_URL',
      DEPLOY_WORKFLOW,
    ]);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain(
      'prod has KUBECONFIG_B64 (admin access to the cluster), 2 more secrets and 1 variable; ' +
        'and your repo has .github/workflows/deploy.yml. nothing reads them now',
    );
    expect(infos[0].endsWith('for example: gh secret delete KUBECONFIG_B64 --env prod')).toBe(true);

    // The workflow alone: the command is the one that removes it.
    infos.length = 0;
    holds({});
    expect(
      await noteLeftoverGitopsCopies({
        projectDir: project({ deployYml: true }),
        envNames: ['prod'],
      }),
    ).toEqual([DEPLOY_WORKFLOW]);
    // One repo file: said as one, not as copies at GitHub, the command last.
    expect(infos).toEqual([
      'your repo still has .github/workflows/deploy.yml, the deploy workflow an earlier ' +
        'vibecarbon installed. nothing dispatches it now: vibecarbon deploy applies your secrets ' +
        'from .env.local, and flux pulls from inside the cluster. this command leaves it alone, ' +
        'so remove it when you like with: git rm .github/workflows/deploy.yml',
    ]);
  });

  it("leaves out a secret of the operator's own", async () => {
    holds({ prod: ['MY_OWN_TOKEN', 'S3_ACCESS_KEY'] }, { prod: ['MY_OWN_VAR'] });
    expect(await noteLeftoverGitopsCopies({ projectDir: project(), envNames: ['prod'] })).toEqual([
      'prod:S3_ACCESS_KEY',
    ]);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('prod has 1 secret. nothing reads them now');
    expect(infos[0]).not.toMatch(/MY_OWN/);
    expect(infos[0].endsWith('for example: gh secret delete S3_ACCESS_KEY --env prod')).toBe(true);

    // Variables only: the variable's own delete command.
    infos.length = 0;
    holds({}, { prod: ['MY_OWN_VAR', 'KUBECTL_IMAGE', 'TRAEFIK_VERSION'] });
    expect(await noteLeftoverGitopsCopies({ projectDir: project(), envNames: ['prod'] })).toEqual([
      'prod:KUBECTL_IMAGE',
      'prod:TRAEFIK_VERSION',
    ]);
    expect(infos[0]).toContain('prod has 2 variables. nothing reads them now');
    expect(infos[0].endsWith('for example: gh variable delete KUBECTL_IMAGE --env prod')).toBe(
      true,
    );
  });

  it("names only what the old seeding wrote: a key it never wrote is the operator's, wherever it sits", async () => {
    // GitHub lists the operator's own first; the example must still be a real copy.
    holds(
      { prod: ['REPL_PASSWORD', 'CORS_ORIGINS', 'DB_PASSWORD', 'N8N_ENCRYPTION_KEY'] },
      { prod: ['CORS_ORIGINS', 'DNS_PROVIDER'] },
    );
    expect(await noteLeftoverGitopsCopies({ projectDir: project(), envNames: ['prod'] })).toEqual([
      'prod:DB_PASSWORD',
      'prod:N8N_ENCRYPTION_KEY',
      'prod:DNS_PROVIDER',
    ]);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('prod has 2 secrets and 1 variable. nothing reads them now');
    expect(infos[0]).not.toMatch(/REPL_PASSWORD|CORS_ORIGINS/);
    expect(infos[0].endsWith('for example: gh secret delete DB_PASSWORD --env prod')).toBe(true);

    // Variables the seeding wrote before it dropped them are leftovers too.
    infos.length = 0;
    holds({}, { prod: ['DNS_PROVIDER', 'HCLOUD_NETWORK_ID'] });
    expect(await noteLeftoverGitopsCopies({ projectDir: project(), envNames: ['prod'] })).toEqual([
      'prod:DNS_PROVIDER',
      'prod:HCLOUD_NETWORK_ID',
    ]);
    expect(infos[0].endsWith('for example: gh variable delete DNS_PROVIDER --env prod')).toBe(true);

    // The keys the cluster's Secret holds that the seeding never wrote, and
    // SITE_URL as a secret (the seeding wrote it as a variable): none counts.
    infos.length = 0;
    const neverSeeded = [
      'REPL_PASSWORD',
      'SITE_URL',
      'CORS_ORIGINS',
      'MAGIC_LINK_ENABLED',
      'TRUSTED_PROXY_HOPS',
      'PROJECT_NAME',
      'REDIS_ENABLED',
      'N8N_ENABLED',
      'METABASE_ENABLED',
      'OBSERVABILITY_ENABLED',
      'VITE_PLAUSIBLE_DOMAIN',
      'VITE_PLAUSIBLE_SCRIPT_URL',
    ];
    holds({ prod: neverSeeded });
    expect(await noteLeftoverGitopsCopies({ projectDir: project(), envNames: ['prod'] })).toEqual(
      [],
    );
    expect(infos).toEqual([]);
  });

  it('the list is frozen: it follows neither SECRET_KEYS nor the registry', () => {
    const src = readRepoFile('src/lib/deploy/k8s/gitops-deploy.js');
    expect(src).not.toMatch(/import\s*\{[^}]*\bSECRET_KEYS\b[^}]*\}\s*from/);
    expect(src).not.toMatch(/from\s+['"][^'"]*config-registry\.js['"]/);
  });

  it('nothing left: says nothing', async () => {
    holds({ prod: ['MY_OWN_TOKEN'] });
    expect(await noteLeftoverGitopsCopies({ projectDir: project(), envNames: ['prod'] })).toEqual(
      [],
    );
    expect(infos).toEqual([]);
  });

  it('a list that fails says nothing and stops nothing', async () => {
    holds({ 'prod-primary': ['KUBECONFIG_B64'] });
    vi.mocked(github.listEnvironmentSecretNames).mockImplementation(async (env: string) => {
      if (env === 'prod-standby') throw new Error('gh: HTTP 502');
      return ['KUBECONFIG_B64'];
    });
    expect(
      await noteLeftoverGitopsCopies({ projectDir: project({ deployYml: true }), envNames: HA }),
    ).toEqual([]);
    holds({ prod: ['KUBECONFIG_B64'] });
    vi.mocked(github.listEnvironmentVariables).mockRejectedValue(new Error('gh: HTTP 403'));
    expect(await noteLeftoverGitopsCopies({ projectDir: project(), envNames: ['prod'] })).toEqual(
      [],
    );
    expect(infos).toEqual([]);
  });

  it('configure cicd notes it once per run, beside the token note, before its per-cluster loop', () => {
    const src = readRepoFile('src/configure.js');
    const body = src.slice(src.indexOf('export async function runConfigureCicd('));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn.match(/noteLeftoverGitopsCopies\(/g)).toHaveLength(1);
    const noteAt = fn.indexOf(
      'await noteLeftoverGitopsCopies({ projectDir: cwd, envNames: targets.map((t) => t.envName) });',
    );
    expect(noteAt).toBeGreaterThan(fn.indexOf('await noteUnreadTokenSecrets('));
    expect(noteAt).toBeLessThan(fn.indexOf('for (const target of targets) {'));
  });
});
