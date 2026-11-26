/**
 * What the CLI reads and writes at GitHub through the `gh` CLI (argv form, no
 * shell interpolation).
 *
 * The one write is seedBuildVars: the repo-level VITE_* variables the build
 * workflow (vibecarbon-build.yml) bakes into the app image. Nothing at GitHub
 * reaches a cluster any more: `configure cicd <env>` hands each k8s cluster
 * to Flux from the operator's machine, `vibecarbon deploy <env>` applies its
 * secrets from .env.local, and no provider token goes to GitHub
 * (applyCloudSecrets in src/lib/deploy/k8s/k3s.js hands it to the cluster).
 *
 * The rest only list names, never values (GitHub returns none), for the notes
 * `configure cicd` prints about copies an earlier vibecarbon left there: the
 * repo's provider token secret (noteUnreadTokenSecrets) and what it seeded
 * into each GitHub Environment for the retired deploy.yml, KUBECONFIG_B64
 * among it (noteLeftoverGitopsCopies, both in src/lib/deploy/k8s/gitops-deploy.js).
 * Neither deletes anything.
 */

import { runCommandAsync } from './command.js';

/** The `-q .[].name` lines of a `gh ... list --json name` answer. */
function nameLines(out) {
  return String(out ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The names of the secrets or variables (`kind`) a GitHub Environment holds,
 * never a value; [] when the environment does not exist (gh answers HTTP 404).
 * Any other failure throws.
 *
 * @param {'secret'|'variable'} kind
 * @param {string} envName
 * @param {number} [timeout] - for the gh call, in ms
 * @returns {Promise<string[]>}
 */
async function environmentNames(kind, envName, timeout) {
  try {
    const out = await runCommandAsync(
      ['gh', kind, 'list', '--env', envName, '--json', 'name', '-q', '.[].name'],
      { cleanEnv: true, silent: true, timeout },
    );
    return nameLines(out);
  } catch (err) {
    if (/HTTP 404|Not Found/i.test(String(err?.stderr ?? ''))) return [];
    throw err;
  }
}

/**
 * The names of the secrets a GitHub Environment holds (environmentNames).
 *
 * @param {string} envName
 * @param {{ timeout?: number }} [options] - for the gh call, in ms
 * @returns {Promise<string[]>}
 */
export function listEnvironmentSecretNames(envName, { timeout } = {}) {
  return environmentNames('secret', envName, timeout);
}

/**
 * The names of the variables a GitHub Environment holds (environmentNames).
 *
 * @param {string} envName
 * @param {{ timeout?: number }} [options] - for the gh call, in ms
 * @returns {Promise<string[]>}
 */
export function listEnvironmentVariables(envName, { timeout } = {}) {
  return environmentNames('variable', envName, timeout);
}

/**
 * The names of the repo's own Actions secrets, never their values (GitHub
 * never returns one). Any failure throws.
 *
 * @param {{ timeout?: number }} [options] - for the gh call, in ms
 * @returns {Promise<string[]>}
 */
export async function listRepoSecretNames({ timeout } = {}) {
  const out = await runCommandAsync(['gh', 'secret', 'list', '--json', 'name', '-q', '.[].name'], {
    cleanEnv: true,
    silent: true,
    timeout,
  });
  return nameLines(out);
}

/**
 * Set a repo-level variable (non-secret). `gh variable set` takes no stdin
 * body, so the value goes on argv: acceptable for these, which are shipped to
 * browsers anyway.
 */
async function setVariable(key, value) {
  if (value === undefined || value === null || value === '') return false;
  await runCommandAsync(['gh', 'variable', 'set', key, '--body', String(value)], {
    cleanEnv: true,
    silent: true,
  });
  return true;
}

/**
 * Seed repo-level GitHub Actions variables that the build workflow
 * (vibecarbon-build.yml) reads as `--build-arg` inputs. Vite inlines these
 * VITE_* values into the browser bundle at image-build time; without them the
 * CI-built GHCR image ships empty client config (VITE_PUBLIC_URL, feature
 * flags).
 *
 * These are non-secret build inputs (everything VITE_* is shipped to
 * browsers), so they go to repo VARIABLES, not secrets.
 * Repo-level (not per-environment) because vibecarbon-build.yml builds one
 * push-triggered image per repo — it reflects the most recent push-mode
 * deploy's domain/config. Multi-domain setups should use local-build deploys
 * for non-canonical environments.
 *
 * Empty values are skipped (setVariable returns false) so optional VITE_*
 * (e.g. unconfigured analytics) don't create blank variables.
 *
 * @param {Record<string,string>} viteArgs - VITE_* build args (from collectComposeBuildArgs).
 * @returns {Promise<string[]>} applied variable names.
 */
export async function seedBuildVars(viteArgs) {
  const applied = [];
  for (const [key, value] of Object.entries(viteArgs)) {
    if (!key.startsWith('VITE_')) continue;
    if (await setVariable(key, value)) applied.push(key);
  }
  return applied;
}
