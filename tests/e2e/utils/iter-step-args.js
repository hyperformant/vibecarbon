/**
 * The CLI arguments `scripts/iter-step.js` runs one step with against a kept
 * rig. Kept apart from the script so a test can check them: the script runs
 * its step as soon as it is loaded.
 */

import { COMMANDS } from '../../../src/lib/cli/command-registry.js';
import { parseFlags } from '../../../src/lib/cli/parse-flags.js';
import { selectE2EDbImage } from './db-image-select.js';

/** The steps iter-step can run, each a vibecarbon command of the same name. */
export const ITER_STEPS = [
  'deploy',
  'failover',
  'scale',
  'backup',
  'restore',
  'destroy',
  'status',
  'diagnose',
];

/**
 * @param {string} step - one of ITER_STEPS
 * @param {string} envPrefix - the rig's environment name
 * @param {string[]} extraArgs - the caller's own arguments, passed through
 * @returns {Promise<string[]>} argv for `node src/cli.js`
 */
export async function iterStepCliArgs(step, envPrefix, extraArgs) {
  // `backup` has its own TTY guard for the action prompt (create/list/
  // download) that fires independently of `-y`: off-TTY it needs an explicit
  // `-action` seed or it exits asking for one. `create` is the only sensible
  // default here (list/download need a `-source` the caller would have to
  // supply anyway), so it goes in only when the caller hasn't passed
  // `-action` (or `-l`, its list shorthand).
  const stepArgs =
    step === 'backup' && !extraArgs.includes('-action') && !extraArgs.includes('-l')
      ? [...extraArgs, '-action', 'create']
      : extraArgs;
  // The env positional and `-y` go only to a command whose spec declares them.
  // `status` reads the env from the project dir (iter-step runs there) and
  // `diagnose` never prompts, so neither takes `-y`.
  const entry = COMMANDS.find((c) => c.name === step);
  if (!entry) throw new Error(`no vibecarbon command named "${step}"`);
  const spec = await entry.loadSpec();
  const takesEnv = (spec.positional ?? []).some((p) => p.name === 'env');
  const takesYes = (spec.flags ?? []).some((f) => f.name === 'y');
  return [step, ...(takesEnv ? [envPrefix] : []), ...(takesYes ? ['-y'] : []), ...stepArgs];
}

/**
 * Is this step a full teardown: `destroy` with `-purge`? Only then does
 * iter-step run the lifecycle's post-destroy cleanup (tests/e2e/utils/
 * rig-teardown.ts). A plain destroy keeps the backup bucket on purpose, and
 * the orphan sweep would delete it. Read with the CLI's own parser and spec,
 * so it means what `vibecarbon destroy` itself takes the flag to mean.
 *
 * @param {string} step
 * @param {string[]} extraArgs - the caller's own arguments
 * @returns {Promise<boolean>}
 */
export async function isPurgeDestroy(step, extraArgs) {
  if (step !== 'destroy') return false;
  const entry = COMMANDS.find((c) => c.name === 'destroy');
  if (!entry) throw new Error('no vibecarbon command named "destroy"');
  const { values } = parseFlags(extraArgs, await entry.loadSpec());
  return values.purge === true;
}

/**
 * Steps that never pull the db image: destroy removes infra, status and
 * diagnose only read it. Every other step can start a node or container that
 * pulls it (deploy, scale, failover, restore) or runs next to one (backup),
 * so those keep the check.
 */
export const STEPS_WITHOUT_IMAGE_PULL = ['destroy', 'status', 'diagnose'];

/**
 * Choose the e2e db image for a step that may pull it; do nothing for one
 * that never does. A rig being torn down should not need ghcr.io reachable.
 * Throws E2EDbImageError when the image cannot be chosen (including an
 * unreachable registry).
 *
 * @param {string} step - one of ITER_STEPS
 * @param {{ select?: typeof selectE2EDbImage }} [deps]
 * @returns {Promise<boolean>} true when the check ran
 */
export async function ensureStepDbImage(step, { select = selectE2EDbImage } = {}) {
  if (STEPS_WITHOUT_IMAGE_PULL.includes(step)) return false;
  await select();
  return true;
}
