/**
 * A GitOps project for the tests that run deployK8sGitOps for real: the k8s/
 * tree `vibecarbon create` lays down, and a git repo with a local bare origin
 * to push it to. Only the GitHub and cluster calls are left to fake.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { PLACEHOLDERS, SECRET_PLACEHOLDERS } from '../../src/create.js';
import { gitSafeEnv } from '../../src/lib/command.js';
import { REPO_ROOT, sourceFiles } from './source-files.js';
import { createTempDir } from './temp-dir.js';

const CARBON = join(REPO_ROOT, 'carbon');
const CARBON_K8S = join(CARBON, 'k8s');
const DEPLOY_WORKFLOW = '.github/workflows/deploy.yml';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitSafeEnv(), encoding: 'utf-8' }).trim();

/**
 * A project's k8s/ tree as `vibecarbon create` lays it down, with the deploy
 * workflow `configure cicd` installs as it is.
 */
export function createdK8sProject(): string {
  const dir = createTempDir('vc-gitops-project-');
  const fill = Object.keys(PLACEHOLDERS).filter((k) => !SECRET_PLACEHOLDERS.has(k));
  for (const src of sourceFiles(CARBON_K8S)) {
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

/**
 * The project as a git repo on main with an empty bare origin, nothing
 * committed yet.
 */
export function withGitOrigin(project: string): { project: string; origin: string } {
  const origin = createTempDir('vc-gitops-origin-');
  git(origin, 'init', '--bare', '-q', '-b', 'main');
  git(project, 'init', '-q', '-b', 'main');
  // A name of its own, so a write that ever lands outside the temp repo
  // says which test made it.
  git(project, 'config', 'user.email', 'gitops-project@test.invalid');
  git(project, 'config', 'user.name', 'gitops-project-test');
  git(project, 'remote', 'add', 'origin', origin);
  return { project, origin };
}
