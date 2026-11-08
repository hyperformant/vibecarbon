/**
 * The CLI arguments `scripts/iter-step.js` runs one step with against a kept
 * rig. Kept apart from the script so a test can check them: the script runs
 * its step as soon as it is loaded.
 */

import { COMMANDS } from '../../../src/lib/cli/command-registry.js';

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
