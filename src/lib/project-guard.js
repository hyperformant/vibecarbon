/**
 * Shared "are we in a Vibecarbon project?" guard.
 *
 * Every CLI subcommand that mutates or reads a project's tree must call
 * `assertInProjectDir()` as its FIRST action — before banners, secret
 * scans, prompt-clears, or anything else that touches the cwd. An
 * accidental invocation from a parent directory (e.g. ~/repos) would
 * otherwise descend into every sibling repo, dump real tokens to the
 * scrollback (when a secret-scan runs), or print a confusing fatal
 * error before any "not in a project" message ever appears.
 *
 * The check is deliberately strict: a Vibecarbon project always has
 * `docker-compose.yml` at its root (templated by `vibecarbon create`),
 * even for cloud-only k8s deploys. Requiring both `.vibecarbon.json`
 * (loadProjectConfig, with package.json fallback) AND `docker-compose.yml`
 * means the Vibecarbon source repo itself — which has a package.json but
 * no docker-compose.yml — is correctly rejected.
 */

import * as p from '@clack/prompts';
import { findProjectRoot, hasDockerCompose, loadProjectConfig } from './config.js';

/**
 * Verify the current working directory is a Vibecarbon project. On
 * failure, print the canonical error/info pair and exit 1. Returns the
 * loaded project config so callers don't have to reload it.
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {object} - Project config from `loadProjectConfig`
 */
export function assertInProjectDir(cwd = process.cwd()) {
  const projectConfig = loadProjectConfig(cwd);
  if (!projectConfig || !hasDockerCompose(cwd)) {
    p.log.error('Not in a Vibecarbon project directory.');
    // Refusing is still right when the cwd is *inside* a project: every
    // command resolves docker-compose.yml, .env.local, k8s overlays and
    // relative arguments against the cwd, so running from a subdirectory
    // would read a tree the user did not mean. But the generic message is
    // misleading there, since they are within a created project. Name the
    // root and hand over the cd instead.
    const root = findProjectRoot(cwd);
    if (root) {
      p.log.info(`The project root is ${root}. Run this command from there: cd ${root}`);
    } else {
      p.log.info('Run this command from within a project created with `vibecarbon create`.');
    }
    process.exit(1);
  }
  return projectConfig;
}
