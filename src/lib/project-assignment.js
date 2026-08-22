/**
 * Best-effort call-site wrapper for provider.ensureProjectAssignment — the
 * cross-provider "dedicated cloud project" hook (see BaseProvider's doc:
 * Hetzner satisfies it by credential, Scaleway by request parameter; only
 * DigitalOcean does post-hoc assignment).
 *
 * Runs AFTER deploy/scale already succeeded, so it never throws: filing
 * resources into a project is organizational, and an API blip here must not
 * turn a green deploy red. Failures warn loudly instead (never silently —
 * the provider side throws on partial sweeps rather than under-assigning).
 *
 * Also owns persistence: when the provider resolves a project id, it is
 * written to the provider's PROJECT_ID_ENV in .env.local (operator secret
 * store — localOnly, same contract as the guided-setup savers) and
 * process.env, so later deploys skip the find-or-create and a console
 * rename never causes a duplicate project.
 */

import { log } from '@clack/prompts';
import { setEnvVar } from './project.js';

/**
 * @param {import('./providers/base.js').BaseProvider} provider
 * @param {{ projectName: string, environment: string }} opts
 * @returns {Promise<{projectId: string, created: boolean, assigned: number}|null>}
 */
export async function runProjectAssignment(provider, { projectName, environment }) {
  try {
    const result = await provider.ensureProjectAssignment({ projectName, environment });
    if (!result) return null;

    const envKey = provider.constructor.PROJECT_ID_ENV;
    if (envKey && process.env[envKey] !== result.projectId) {
      process.env[envKey] = result.projectId;
      setEnvVar(envKey, result.projectId, process.cwd(), { localOnly: true });
    }

    if (result.assigned > 0) {
      log.info(
        `Filed ${result.assigned} resource${result.assigned === 1 ? '' : 's'} into the ` +
          `${created(result)} cloud project for ${projectName}`,
      );
    }
    return result;
  } catch (error) {
    log.warn(`Cloud project assignment skipped (deploy is unaffected): ${error.message}`);
    return null;
  }
}

function created(result) {
  return result.created ? 'newly created' : 'existing';
}
