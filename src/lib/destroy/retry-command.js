/**
 * The one spelling of a destroy rerun in anything destroy prints.
 *
 * A `-purge` destroy that keeps the environment's entry keeps its buckets for
 * the rerun (deleteAppBucketEffect, handleBackupBucket, retainStateBucket in
 * src/destroy.js). A rerun without `-purge` would move the entry and keep
 * those buckets too, and then no destroy can reach them: the environment is
 * gone from `.vibecarbon.json`. So every line that tells you to run the
 * destroy again names it through retryDestroyCommand, which carries `-purge`
 * exactly when this destroy had it.
 * tests/unit/destroy/retry-command-census.test.ts fails on any destroy source
 * that spells the command by hand.
 */

/**
 * The command that retries this destroy of `environment`.
 * @param {string} environment - as you name it on the command line
 * @param {{purgeBackups?: boolean}} [args] - this destroy's parsed flags
 * @param {string[]} [extra] - flags the line adds for its own case, such as
 *   `-force` to skip the pre-destroy backup
 * @returns {string}
 */
export function retryDestroyCommand(environment, args, extra = []) {
  return ['vibecarbon destroy', environment, ...(args?.purgeBackups ? ['-purge'] : []), ...extra]
    .filter(Boolean)
    .join(' ');
}

/**
 * The command that finishes an orphan-stack cleanup. It names no environment,
 * and -purge means nothing to it: an orphan stack has no environment entry,
 * so no bucket of one is kept for it.
 */
export const ORPHANS_DESTROY_COMMAND = 'vibecarbon destroy -orphans';
