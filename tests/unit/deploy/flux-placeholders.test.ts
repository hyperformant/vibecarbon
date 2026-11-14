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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PLACEHOLDERS, SECRET_PLACEHOLDERS } from '../../../src/create.js';
import { gitSafeEnv } from '../../../src/lib/command.js';
import {
  describeFluxPlaceholders,
  fluxClusterFilesApplied,
  fluxPlaceholders,
  unrenderedPlaceholders,
} from '../../../src/lib/deploy/k8s/unrendered-placeholders.js';
import { addKustomizationEntry } from '../../../src/lib/template-edits.js';
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

const CARBON = join(process.cwd(), 'carbon');
const CARBON_K8S = join(CARBON, 'k8s');
const SERVICES = join(process.cwd(), 'services');
const DEPLOY_WORKFLOW = '.github/workflows/deploy.yml';
const PRIMARY = 'k8s/flux/clusters/primary/vibecarbon.yaml';
const STANDBY = 'k8s/flux/clusters/standby/vibecarbon.yaml';
const TRAEFIK = 'k8s/base/traefik/deployment.yaml';
const TRAEFIK_STRIP =
  / {4}# Traefik's image comes from[\s\S]*?\n {6}target:\n {8}kind: Deployment\n {8}name: traefik\n/;
const CLAIM_STRIP =
  / {4}# Volumes are the CLI's too[\s\S]*?\n {6}target:\n {8}kind: PersistentVolumeClaim\n/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * A project's k8s/ tree as `vibecarbon create` lays it down, with the deploy
 * workflow `configure cicd` installs as it is (it names the Flux cluster file
 * the workflow applies).
 */
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
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, DEPLOY_WORKFLOW), readFileSync(join(CARBON, DEPLOY_WORKFLOW), 'utf-8'));
  return dir;
}

/** Every add-on `vibecarbon add` wires into k8s/base (it declares an entry). */
const BASE_ADDONS = readdirSync(SERVICES).flatMap((name) => {
  const manifest = join(SERVICES, name, 'manifest.json');
  if (!existsSync(manifest)) return [];
  const { files = {}, kustomization } = JSON.parse(readFileSync(manifest, 'utf-8'));
  const into = files['k8s/'];
  return kustomization?.entry && into ? [{ name, entry: kustomization.entry, into }] : [];
});

/**
 * The project with every one of those add-ons, as `add` installs them: their
 * k8s files copied (add fills none of the k8s tokens; the PVCs keep
 * {{K8S_STORAGE_CLASS}} for the deploy to render) and listed in the base.
 */
function withBaseAddons(dir: string): string {
  for (const { name, entry, into } of BASE_ADDONS) {
    const from = join(SERVICES, name, 'k8s');
    for (const src of walk(from)) {
      const dest = join(dir, into, relative(from, src));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(src, 'utf-8'));
    }
    const base = join(dir, 'k8s/base/kustomization.yaml');
    writeFileSync(base, addKustomizationEntry(readFileSync(base, 'utf-8'), entry));
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
    // The cluster file this CLI ships strips the Traefik Deployment.
    expect(findings).toEqual([
      { file: TRAEFIK, placeholders: ['{{TRAEFIK_IMAGE}}'], via: PRIMARY, upgradeStrips: true },
    ]);
    expect(describeFluxPlaceholders(findings)).toEqual([
      `${TRAEFIK} would reach the cluster with {{TRAEFIK_IMAGE}} (Flux applies it through ${PRIMARY})`,
    ]);
  });

  it("a project with the add-ons that join k8s/base: Flux builds no token (their claims are the deploy's)", () => {
    expect(BASE_ADDONS.length).toBeGreaterThan(2);
    const dir = withBaseAddons(createdProject());
    expect(fluxPlaceholders(dir)).toEqual([]);
    // Each add-on claim keeps {{K8S_STORAGE_CLASS}} for the deploy to render,
    // and only the cluster file's strip keeps it off the cluster.
    const claims = walk(join(dir, 'k8s/base'))
      .filter((f) => /^kind: PersistentVolumeClaim$/m.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(dir, f))
      .sort();
    expect(claims.length).toBeGreaterThan(2);
    edit(dir, PRIMARY, (t) => t.replace(CLAIM_STRIP, ''));
    const byFile = (a: { file: string }, b: { file: string }) => a.file.localeCompare(b.file);
    expect(fluxPlaceholders(dir).sort(byFile)).toEqual(
      claims.map((file) => ({
        file,
        placeholders: ['{{K8S_STORAGE_CLASS}}'],
        via: PRIMARY,
        upgradeStrips: true,
      })),
    );
  });

  it('reads only the cluster file the deploy workflow applies, and names each finding once', () => {
    const dir = createdProject();
    expect(fluxClusterFilesApplied(dir)).toEqual([PRIMARY]);
    // deploy.yml applies the primary file on every cluster, the standby's
    // too: an old standby file reaches no cluster.
    edit(dir, STANDBY, (t) => t.replace(TRAEFIK_STRIP, ''));
    expect(fluxPlaceholders(dir)).toEqual([]);
    edit(dir, DEPLOY_WORKFLOW, (t) => t.replaceAll(PRIMARY, STANDBY));
    expect(fluxClusterFilesApplied(dir)).toEqual([STANDBY]);
    expect(fluxPlaceholders(dir)).toEqual([
      { file: TRAEFIK, placeholders: ['{{TRAEFIK_IMAGE}}'], via: STANDBY, upgradeStrips: true },
    ]);
    const none = createdProject();
    rmSync(join(none, DEPLOY_WORKFLOW));
    expect(fluxClusterFilesApplied(none)).toEqual([]);
  });

  // CodeQL js/redos (alerts 200 and 201): the strip parser once matched
  // `$patch: delete`, then `kind:`, then `name:` with nested quantifiers over
  // whitespace and newlines, exponential on these inputs. It reads line by
  // line now, so a cluster file built to stall it is read at once.
  for (const prefix of ['$patch:delete\n', '$patch:delete\n\tkind:!\n']) {
    it(`reads a hostile cluster file in linear time: ${JSON.stringify(prefix)} then 50,000 tab lines`, () => {
      const dir = createdProject();
      const kustomization = (body: string) =>
        '---\napiVersion: kustomize.toolkit.fluxcd.io/v1\nkind: Kustomization\n' +
        `metadata:\n  name: hostile\nspec:\n  path: ./k8s/base\n${body}`;
      const pad = '\t\t\n'.repeat(50_000);
      // Loose in the document as reported, and inside a patch item.
      const inItem = `  patches:\n    - patch: |\n        ${prefix.replaceAll('\n', '\n        ')}${pad}`;
      edit(dir, PRIMARY, (t) => `${t}${kustomization(prefix + pad)}${kustomization(inItem)}`);
      const started = performance.now();
      fluxPlaceholders(dir);
      expect(performance.now() - started).toBeLessThan(500);
    });
  }

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
    // No cluster file of ours strips either: they have to be filled in.
    expect(findings).toContainEqual({
      file: 'k8s/base/app/deployment.yaml',
      placeholders: ['{{APP_IMAGE}}'],
      via: PRIMARY,
      upgradeStrips: false,
    });
    expect(findings).toContainEqual({
      file: PRIMARY,
      placeholders: ['{{GITHUB_OWNER}}'],
      via: PRIMARY,
      upgradeStrips: false,
    });
  });
});

describe('deployK8sGitOps refuses a tree Flux would apply with a token', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: gitSafeEnv(), encoding: 'utf-8' }).trim();

  function gitopsProject({ addons = false } = {}) {
    const project = addons ? withBaseAddons(createdProject()) : createdProject();
    writeFileSync(
      join(project, '.vibecarbon.json'),
      `${JSON.stringify({ projectName: 'proj' })}\n`,
    );
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

  /** Every file of the project outside .git, with its content. */
  const snapshot = (dir: string) =>
    Object.fromEntries(
      walk(dir)
        .map((f) => relative(dir, f))
        .filter((rel) => !rel.startsWith('.git/'))
        .map((rel) => [rel, readFileSync(join(dir, rel), 'utf-8')]),
    );

  const deploy = (project: string, imageTag?: string) =>
    deployK8sGitOps({
      projectDir: project,
      environment: 'prod',
      domain: 'app.example.test',
      projectName: 'proj',
      kubeconfigPath: join(project, 'kubeconfig'),
      appStorage: { accessKey: 'a', secretKey: 'b' },
      imageTag,
      githubOwner: 'acme',
      ProviderClass: PROVIDERS.hetzner,
    });

  it('stops before anything is written, committed, pushed or seeded, naming the file, the token and the way out', async () => {
    const { project, origin } = gitopsProject();
    edit(project, PRIMARY, (t) => t.replace(TRAEFIK_STRIP, ''));
    const before = snapshot(project);
    vi.mocked(seedEnvironmentSecrets).mockClear();
    const err = await deploy(project).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain(
      `${TRAEFIK} would reach the cluster with {{TRAEFIK_IMAGE}} (Flux applies it through ${PRIMARY})`,
    );
    // The current template's cluster file strips that object, so upgrade is
    // the way out.
    expect(err?.message).toContain(`Run vibecarbon upgrade and take the new ${PRIMARY}`);
    // Nothing changed on disk: not the GitHub refs, not .vibecarbon.json.
    expect(snapshot(project)).toEqual(before);
    expect(() => git(origin, 'rev-parse', '--verify', '-q', 'main')).toThrow();
    expect(() => git(project, 'rev-parse', '--verify', '-q', 'HEAD')).toThrow();
    expect(seedEnvironmentSecrets).not.toHaveBeenCalled();
  });

  it('a token no template version strips is named with its own way out, not upgrade', async () => {
    const { project } = gitopsProject();
    edit(project, 'k8s/base/app/deployment.yaml', (t) =>
      t.replace(/image: ghcr\.io\/proj\/proj:main/g, 'image: "{{APP_IMAGE}}"'),
    );
    const err = await deploy(project).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain(
      `k8s/base/app/deployment.yaml would reach the cluster with {{APP_IMAGE}}`,
    );
    expect(err?.message).toContain(
      'Put the real value in place of {{APP_IMAGE}} in k8s/base/app/deployment.yaml',
    );
    expect(err?.message).not.toMatch(/vibecarbon upgrade/);
  });

  it('a consistent tree deploys, with the Flux URL pointed at the real owner', async () => {
    const { project, origin } = gitopsProject();
    await deploy(project);
    expect(git(origin, 'show', `main:${PRIMARY}`)).toContain('url: https://github.com/acme/proj\n');
  });

  it('a project with the add-ons that join k8s/base deploys', async () => {
    const { project, origin } = gitopsProject({ addons: true });
    await deploy(project);
    expect(git(origin, 'show', 'main:k8s/base/kustomization.yaml')).toContain('  - redis/\n');
  });

  it('the image tag it fills itself is no reason to stop', async () => {
    const { project, origin } = gitopsProject();
    edit(project, 'k8s/base/app/deployment.yaml', (t) =>
      t.replace(/image: ghcr\.io\/proj\/proj:main/g, 'image: ghcr.io/proj/proj:{{IMAGE_TAG}}'),
    );
    await deploy(project, 'sha-abc123');
    expect(git(origin, 'show', 'main:k8s/base/app/deployment.yaml')).toContain(
      'image: ghcr.io/acme/proj:sha-abc123\n',
    );
  });
});
