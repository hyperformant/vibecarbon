/**
 * No path ships an unfilled `{{TOKEN}}` to a cluster through Flux. Flux
 * applies a project's committed k8s/ tree as it is, so a k8s/base from one
 * template version and a Flux cluster file from another (what `upgrade -y`
 * left after `configure cicd` edited the cluster files) put a literal
 * `{{TRAEFIK_IMAGE}}` on the cluster. The walk (unrendered-placeholders.js)
 * reads a project's own files; the template itself is checked with a real
 * kustomize build in flux-base-placeholder-census.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PLACEHOLDERS, SECRET_PLACEHOLDERS } from '../../../src/create.js';
import { gitSafeEnv } from '../../../src/lib/command.js';
import {
  describeFluxPlaceholders,
  fluxPlaceholders,
  unrenderedPlaceholders,
} from '../../../src/lib/deploy/k8s/unrendered-placeholders.js';
import { createTempDir } from '../../_shared/temp-dir.js';

vi.mock('../../../src/lib/github-environments.js', () => ({
  listEnvironmentVariables: vi.fn(async () => []),
  listRepoSecretNames: vi.fn(async () => []),
  seedEnvironmentSecrets: vi.fn(async () => {}),
  uploadKubeconfig: vi.fn(async () => {}),
  triggerDeployWorkflow: vi.fn(async () => {}),
  waitForLatestWorkflowRun: vi.fn(async () => ({ runId: 1 })),
}));

const { seedEnvironmentSecrets } = await import('../../../src/lib/github-environments.js');
const { deployK8sGitOps } = await import('../../../src/lib/deploy/k8s/gitops-deploy.js');
const { PROVIDERS } = await import('../../../src/lib/providers/index.js');

const CARBON_K8S = join(process.cwd(), 'carbon', 'k8s');
const PRIMARY = 'k8s/flux/clusters/primary/vibecarbon.yaml';
const TRAEFIK = 'k8s/base/traefik/deployment.yaml';
const TRAEFIK_STRIP =
  / {4}# Traefik's image comes from[\s\S]*?\n {6}target:\n {8}kind: Deployment\n {8}name: traefik\n/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** A project's k8s/ tree as `vibecarbon create` lays it down. */
function createdProject(): string {
  const dir = createTempDir('vc-flux-ph-');
  const fill = Object.keys(PLACEHOLDERS).filter((k) => !SECRET_PLACEHOLDERS.has(k));
  for (const src of walk(CARBON_K8S)) {
    let text = readFileSync(src, 'utf-8');
    for (const key of fill) text = text.replaceAll(`{{${key}}}`, 'proj');
    const dest = join(dir, 'k8s', relative(CARBON_K8S, src));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
  return dir;
}

const edit = (dir: string, rel: string, fn: (text: string) => string) => {
  const before = readFileSync(join(dir, rel), 'utf-8');
  const after = fn(before);
  expect(after, `${rel} edited`).not.toBe(before);
  writeFileSync(join(dir, rel), after);
};

describe('fluxPlaceholders', () => {
  it('a created project: Flux builds no token (the deploy-time ones are all stripped)', () => {
    const dir = createdProject();
    expect(fluxPlaceholders(dir)).toEqual([]);
    // The walk is real: without the Flux strips the base still carries the
    // deploy-time tokens, and only files the kustomizations list are read
    // (cluster-autoscaler/ sits in k8s/base but is applied on its own).
    const all = unrenderedPlaceholders(join(dir, 'k8s/base'), { root: dir });
    const files = all.map((f) => f.file);
    expect(files).toContain(TRAEFIK);
    expect(files).toContain('k8s/base/db/statefulset.yaml');
    expect(files).toContain('k8s/base/registry/local-registry.yaml');
    expect(files.some((f) => f.includes('cluster-autoscaler'))).toBe(false);
  });

  it('a cluster file from before the Traefik move builds the Traefik Deployment with its token', () => {
    const dir = createdProject();
    edit(dir, PRIMARY, (t) => t.replace(TRAEFIK_STRIP, ''));
    const findings = fluxPlaceholders(dir);
    expect(findings).toEqual([
      { file: TRAEFIK, placeholders: ['{{TRAEFIK_IMAGE}}'], via: PRIMARY },
    ]);
    expect(describeFluxPlaceholders(findings)).toEqual([
      `${TRAEFIK} would reach the cluster with {{TRAEFIK_IMAGE}} (Flux applies it through ${PRIMARY})`,
    ]);
  });

  it('reads tokens, not comments, and names a token in the cluster file itself', () => {
    const dir = createdProject();
    edit(dir, 'k8s/base/app/deployment.yaml', (t) => `# image: {{SOME_IMAGE}}\n${t}`);
    expect(fluxPlaceholders(dir)).toEqual([]);
    edit(dir, 'k8s/base/app/deployment.yaml', (t) =>
      t.replace(/image: ghcr\.io\/proj\/proj:main/g, 'image: "{{APP_IMAGE}}"'),
    );
    edit(dir, PRIMARY, (t) =>
      t.replace('github.com/proj/proj', 'github.com/{{GITHUB_OWNER}}/proj'),
    );
    const findings = fluxPlaceholders(dir);
    expect(findings).toContainEqual({
      file: 'k8s/base/app/deployment.yaml',
      placeholders: ['{{APP_IMAGE}}'],
      via: PRIMARY,
    });
    expect(findings).toContainEqual({
      file: PRIMARY,
      placeholders: ['{{GITHUB_OWNER}}'],
      via: PRIMARY,
    });
  });
});

describe('deployK8sGitOps refuses a tree Flux would apply with a token', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: gitSafeEnv(), encoding: 'utf-8' }).trim();

  function gitopsProject() {
    const project = createdProject();
    const origin = createTempDir('vc-flux-ph-origin-');
    git(origin, 'init', '--bare', '-q', '-b', 'main');
    git(project, 'init', '-q', '-b', 'main');
    // A name of its own, so a write that ever lands outside the temp repo
    // says which test made it.
    git(project, 'config', 'user.email', 'flux-placeholders@test.invalid');
    git(project, 'config', 'user.name', 'flux-placeholders-test');
    git(project, 'remote', 'add', 'origin', origin);
    return { project, origin };
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

  it('stops before anything is committed, pushed or seeded, naming the file and the token', async () => {
    const { project, origin } = gitopsProject();
    edit(project, PRIMARY, (t) => t.replace(TRAEFIK_STRIP, ''));
    vi.mocked(seedEnvironmentSecrets).mockClear();
    await expect(deploy(project)).rejects.toThrow(
      `${TRAEFIK} would reach the cluster with {{TRAEFIK_IMAGE}} (Flux applies it through ${PRIMARY})`,
    );
    expect(() => git(origin, 'rev-parse', '--verify', '-q', 'main')).toThrow();
    expect(() => git(project, 'rev-parse', '--verify', '-q', 'HEAD')).toThrow();
    expect(seedEnvironmentSecrets).not.toHaveBeenCalled();
  });

  it('a consistent tree deploys, with the Flux URL pointed at the real owner', async () => {
    const { project, origin } = gitopsProject();
    await deploy(project);
    expect(git(origin, 'show', `main:${PRIMARY}`)).toContain('url: https://github.com/acme/proj\n');
  });
});
