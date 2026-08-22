/**
 * Environment-picker prompt for env-scoped commands.
 *
 * A verb-aware picker suited to the interactive-default CLI:
 *   - The prompt + empty-state error speak in terms of the operation
 *     ("back up", "deploy to", "destroy") so the message reads as
 *     guidance, not a generic env picker.
 *   - The picker hint includes the deploy status, server IP, and
 *     primary region so multi-env operators can pick by metadata
 *     instead of memorized name.
 *   - The seed (positional or flag) is passed in explicitly rather
 *     than read from a parsed-args struct, so callers using either
 *     the new `parse-flags.js` or hand-rolled argv can both consume
 *     it without an adapter.
 *
 * Returns `{ envName, envConfig }`. On empty state, missing seed
 * with no TTY, cancel, or invalid seed, exits the process with a
 * canonical message — same model the rest of the CLI uses for
 * unrecoverable conditions.
 */

import * as p from '@clack/prompts';
import { c } from '../colors.js';
import { exitCancelled } from './exit-guard.js';

/**
 * @param {object} projectConfig - parsed `.vibecarbon.json`.
 * @param {object} options
 * @param {string} options.actionVerb - imperative phrase describing
 *   the operation, e.g. "back up", "deploy to", "restore", "destroy".
 *   Used in prompts and empty-state messaging.
 * @param {string|null} [options.seed] - operator-supplied env name
 *   (from positional or flag). When set, skip the prompt and use it
 *   directly. When null/undefined, prompt (or use the single env if
 *   only one exists).
 * @returns {Promise<{ envName: string, envConfig: object }>}
 */
export async function selectEnvironment(projectConfig, options) {
  const { actionVerb, seed } = options;
  const environments = projectConfig.environments || {};
  const envNames = Object.keys(environments);

  if (envNames.length === 0) {
    p.log.error(`No deployed environments to ${actionVerb}.`);
    p.log.info(`Run ${c.info('vibecarbon deploy')} first.`);
    process.exit(1);
  }

  // Seed from caller — validate against known envs, fail loudly if
  // the operator typed a name that doesn't exist (so a typo doesn't
  // silently fall through to a prompt that gets misinterpreted).
  if (seed) {
    if (!environments[seed]) {
      p.log.error(`Environment '${seed}' not found.`);
      p.log.info(`Available: ${envNames.join(', ')}`);
      process.exit(1);
    }
    return { envName: seed, envConfig: environments[seed] };
  }

  // Single-env shortcut: no point prompting when there's only one
  // answer. The operator might still want to see which env they're
  // operating on; surface that as a log line so the prompt isn't
  // silently bypassed.
  if (envNames.length === 1) {
    const only = envNames[0];
    p.log.info(`Using environment: ${c.bold(only)} (only deployed env)`);
    return { envName: only, envConfig: environments[only] };
  }

  // Multi-env: render a picker with metadata-rich hints.
  const choice = await p.select({
    message: `Which environment to ${actionVerb}?`,
    options: envNames.map((name) => ({
      value: name,
      label: name,
      hint: formatEnvHint(environments[name]),
    })),
  });

  if (p.isCancel(choice)) {
    exitCancelled();
  }

  return { envName: /** @type {string} */ (choice), envConfig: environments[choice] };
}

/**
 * Build the hint string shown next to each env in the picker.
 * Combines status + region + first server IP so operators can
 * disambiguate by deploy state at a glance.
 *
 * @param {object} envConfig
 * @returns {string}
 */
function formatEnvHint(envConfig) {
  const parts = [];
  if (envConfig.status) parts.push(envConfig.status);
  if (envConfig.region) parts.push(envConfig.region);
  const ip = envConfig.servers?.[0]?.ip;
  if (ip) parts.push(ip);
  return parts.join(' · ');
}
