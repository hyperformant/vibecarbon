/**
 * Read-only snapshot of "where is this project right now" for the `?`
 * "what's next" guide: is the cwd a Vibecarbon project at all, is the local
 * dev stack up, which configure.js features are configured, and what state
 * each deployed environment is in.
 *
 * This module (and everything under src/lib/next/) is a pure library: it
 * never prints, prompts, or exits. src/next.js is the only place that turns
 * this snapshot into a guide the user reads. Keeping the split means the
 * "what's next" logic can be unit-tested against real temp directories
 * without a terminal, docker, or configure.js's prompt flow in the loop.
 *
 * The project predicate mirrors `assertInProjectDir`
 * (src/lib/project-guard.js) minus the exit: a directory needs BOTH a
 * loadable manifest AND docker-compose.yml, because loadProjectConfig falls
 * back to package.json alone (so the Vibecarbon source repo itself, and any
 * plain Node project, would otherwise look like a project).
 *
 * One caveat on the injected `cwd`: configure.js's `globalization` feature
 * reads `process.cwd()` in its `isConfigured`, not the directory passed
 * here, so the configured-feature list is fully correct only when `cwd ===
 * process.cwd()`. That always holds for the guide, which passes its own
 * cwd; tests that point at a temp directory inject `features` instead.
 */

import { findProjectRoot, hasDockerCompose, loadProjectConfig } from '../config.js';
import { operatorSecretKeys } from '../config-registry.js';
import { loadEnvVariables } from '../project.js';
import { composeRunningServices } from '../status/compose-ps.js';

/**
 * @typedef {{ value: string, label: string, isConfigured: (env: object, ctx: { projectConfig: object }) => boolean }} FeatureLike
 */

/**
 * @param {string} [cwd]
 * @param {{
 *   loadConfig?: typeof loadProjectConfig,
 *   hasCompose?: typeof hasDockerCompose,
 *   findRoot?: typeof findProjectRoot,
 *   composePs?: typeof composeRunningServices,
 *   loadEnv?: typeof loadEnvVariables,
 *   operatorKeys?: typeof operatorSecretKeys,
 *   features?: FeatureLike[],
 * }} [deps]
 * @returns {Promise<
 *   { kind: 'no-project', cwd: string } |
 *   { kind: 'project', cwd: string, subdir: string|null, projectConfig: object,
 *     project: { name: string },
 *     localDev: { dockerAvailable: boolean, running: string[] },
 *     configured: { any: boolean, features: string[], providers: boolean },
 *     environments: Array<{ name: string, status: string|null, deployMode: string|null,
 *                           region: string|null, domain: string|null, deployedAt: string|null }> }>}
 */
export async function detectProjectState(cwd = process.cwd(), deps = {}) {
  const {
    loadConfig = loadProjectConfig,
    hasCompose = hasDockerCompose,
    findRoot = findProjectRoot,
    composePs = composeRunningServices,
    loadEnv = loadEnvVariables,
    operatorKeys = operatorSecretKeys,
    features,
  } = deps;

  const projectConfig = loadConfig(cwd);
  if (!(projectConfig && hasCompose(cwd))) {
    // Below a project root (e.g. `src/client`) the user is in a project,
    // just not where commands run. Answer for the project above rather than
    // proposing `create`, which from here would scaffold a second project
    // nested inside the first. `subdir` records where they actually are, so
    // the guide can hand over the cd instead of launching anything: every
    // command asserts the root as its cwd (src/lib/project-guard.js), and
    // this process cannot change the user's shell directory.
    const root = findRoot(cwd);
    if (root && root !== cwd) {
      return { ...(await detectProjectState(root, deps)), subdir: cwd };
    }
    return { kind: 'no-project', cwd };
  }

  const { available, running } = composePs(cwd);
  const env = loadEnv(cwd) ?? {};

  // Lazily imported, and only reached on the project path, so the
  // no-project path never loads configure.js (its prompt flow, clack, etc).
  const featureList = features ?? (await import('../../configure.js')).FEATURES;

  const configuredFeatures = [];
  for (const feature of featureList) {
    if (feature.value === 'providers') continue;
    let isConfigured = false;
    try {
      isConfigured = Boolean(feature.isConfigured(env, { projectConfig }));
    } catch {
      // A throwing predicate counts as not configured.
      isConfigured = false;
    }
    if (isConfigured) configuredFeatures.push(feature.label);
  }

  const providers = operatorKeys().some((key) => {
    const value = env[key];
    return typeof value === 'string' && value.trim() !== '';
  });

  const environments = Object.entries(projectConfig.environments ?? {}).map(
    ([name, envConfig]) => ({
      name,
      status: envConfig?.status ?? null,
      deployMode: envConfig?.deployMode ?? null,
      region: envConfig?.region ?? null,
      domain: envConfig?.domain ?? null,
      deployedAt: envConfig?.deployedAt ?? null,
    }),
  );

  return {
    kind: 'project',
    cwd,
    subdir: null,
    projectConfig,
    project: { name: projectConfig.projectName },
    localDev: { dockerAvailable: available, running },
    configured: {
      any: configuredFeatures.length > 0 || providers,
      features: configuredFeatures,
      providers,
    },
    environments,
  };
}
