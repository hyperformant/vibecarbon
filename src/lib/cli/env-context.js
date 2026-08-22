/**
 * Shared env-resolution preamble for env-scoped deploy-side commands
 * (backup / restore / failover): env seed → TTY guard → env picker →
 * per-mode license gate → (optionally) target server IP. Collapses the
 * near-verbatim ~40-line block each of those commands used to copy.
 *
 * Callers run `assertInProjectDir()` first and pass its return value as
 * `projectConfig` — this helper never reloads the config (the old copies
 * each re-called loadProjectConfig and discarded the guard's return).
 */

import * as p from '@clack/prompts';
import { resolveTier } from '../deploy/tier-registry.js';
import { requirePaidTier } from '../licensing/index.js';
import { selectEnvironment } from './select-environment.js';
import { requireTTYOrFlags } from './tty-guard.js';

/**
 * @param {object} opts
 * @param {string} opts.command - command name for the license gate (e.g. 'backup')
 * @param {string} opts.actionVerb - verb for the env picker prompt (e.g. 'back up')
 * @param {string} opts.envRequirement - TTY-guard description of the env
 *   requirement (e.g. 'name an environment to back up')
 * @param {Record<string, any>} opts.values - parsed flag values
 * @param {Record<string, any>} opts.positional - parsed positionals
 * @param {object} opts.projectConfig - return value of assertInProjectDir()
 * @param {Array<{flag: string, description: string, satisfied: boolean}>} [opts.extraRequirements]
 *   - additional TTY-guard requirements, appended after the env requirement
 * @param {'first'|'primary'} [opts.serverIp] - also resolve the target server
 *   IP (exit 1 with the canonical message when none exists):
 *   - 'primary': pick the CURRENT primary by role — a prior failover may have
 *     swapped roles while preserving array order, so servers[0] is not
 *     reliably the primary. Falls back to servers[0] for non-HA modes that
 *     have no role.
 *   - 'first': servers[0].
 * @returns {Promise<{envName: string, envConfig: object, serverIp?: string}>}
 */
export async function resolveEnvContext({
  command,
  actionVerb,
  envRequirement,
  values,
  positional,
  projectConfig,
  extraRequirements = [],
  serverIp,
}) {
  const envCount = Object.keys(projectConfig.environments || {}).length;
  // Positional wins over flag when both are supplied — bare-form is the
  // canonical surface, the flag is the scripting alternative.
  const envSeed =
    /** @type {string|undefined} */ (positional.env) ||
    /** @type {string|null} */ (values.env) ||
    null;

  requireTTYOrFlags({
    requirements: [
      {
        flag: 'env',
        description: envRequirement,
        satisfied: !!envSeed || envCount <= 1,
      },
      ...extraRequirements,
    ],
  });

  const { envName, envConfig } = await selectEnvironment(projectConfig, {
    actionVerb,
    seed: envSeed,
  });

  // Gate immediately once the environment's deploy mode is known — before
  // any paid work. Single-server Compose is free; every other mode
  // requires a paid license.
  requirePaidTier(command, resolveTier(envConfig));

  if (!serverIp) return { envName, envConfig };

  const primaryServer =
    serverIp === 'primary' ? envConfig.servers?.find((sv) => sv.role === 'primary') : undefined;
  const ip = primaryServer?.ip || envConfig.servers?.[0]?.ip;
  if (!ip) {
    p.log.error(`No server IP found for environment '${envName}'.`);
    process.exit(1);
  }
  return { envName, envConfig, serverIp: ip };
}
