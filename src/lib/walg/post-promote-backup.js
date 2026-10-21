/**
 * The first base backup on a new timeline (H2b, B5).
 *
 * A promotion (a failover's promote, the end of a restore's recovery) starts a
 * new timeline in the same lineage folder (the system identifier does not
 * change). Until a base is pushed on it, the newest base in that folder is one
 * from before the promotion: a later `restore latest` starts there and must
 * replay across the switch, and retention can prune the WAL that bridges it.
 * So every command that promotes a database ends with this push
 * (census: tests/unit/walg/post-promote-backup-census.test.ts).
 *
 * Where it runs, on every site: after the RTO-critical steps (DNS flip,
 * health, add-on starts), after the WALG_ROLE move (a node still reading
 * standby skips the push) and after the save that clears
 * ha.failoverInFlight. On a restore, after the CLI retired `.vc-prev`
 * (RETIRE_PREVIOUS_SH + REMOVE_DISCARD_SH): wal-g cannot exclude a path from
 * a base, so the order is the only thing keeping the old cluster out of it.
 * The backup-prefix fence allows it: the promoted node is on the fenced
 * timeline (or a newer one after a restore), and only an older one is refused.
 *
 * It requires `pushed`. A skip is a failure here: the new timeline still has
 * no base. A retention failure after the push is not (the base is in the
 * bucket); it warns. `failover -abort` never calls it: the old primary stays
 * on its own timeline.
 */

import * as p from '@clack/prompts';

/**
 * The one message a failed post-promotion push fails its command with.
 *
 * @param {string} cause one line
 * @param {string} envName
 * @returns {string}
 */
export function postPromoteBackupFailedMessage(cause, envName) {
  return `promoted, but the first base backup on the new timeline failed: ${cause}; run vibecarbon backup ${envName} now`;
}

/** A post-promotion push that did not land a base. */
export class PostPromoteBackupError extends Error {
  /**
   * @param {string} cause
   * @param {string} envName
   */
  constructor(cause, envName) {
    super(postPromoteBackupFailedMessage(cause, envName));
    this.name = 'PostPromoteBackupError';
  }
}

/**
 * How long the compose push waits for another backup run's lock (cron) before
 * it reads as skipped:already-running. That run is a fast standby-role skip or
 * a push of the very base wanted here, so it is waited out, not counted as a
 * failure; the budget matches the push's own ssh timeout, which backupCompose
 * extends by it. k8s has no lock: each backup Job is its own pod.
 */
export const POST_PROMOTE_LOCK_WAIT_S = 900;

const firstLine = (err) =>
  String(err instanceof Error ? err.message : err)
    .split('\n')[0]
    .trim();

/**
 * Push a base backup on the node a promotion just made primary.
 *
 * @param {object} args
 * @param {'compose'|'k8s'} args.tier
 * @param {string} args.ip the promoted node (compose) or cluster master (k8s)
 * @param {string} args.sshKeyPath
 * @param {string} [args.projectName] compose: the project (its /opt/<project> dir)
 * @param {string} args.envName the environment as the operator names it
 * @param {number} [args.retain] compose: days of base backups to keep (envConfig.backup.retentionDays)
 * @param {{ warn?: (msg: string) => void }} [args.deps]
 * @returns {Promise<{ name: string }>}
 * @throws {PostPromoteBackupError} when no base was pushed
 */
export async function pushBaseBackupAfterPromote({
  tier,
  ip,
  sshKeyPath,
  projectName,
  envName,
  retain,
  deps = {},
}) {
  const { warn = (msg) => p.log.warn(msg) } = deps;
  if (tier !== 'compose' && tier !== 'k8s') {
    throw new Error(`pushBaseBackupAfterPromote: unknown tier ${JSON.stringify(tier)}`);
  }
  let outcome;
  try {
    if (tier === 'compose') {
      // Lazy: compose/index.js and backup.js sit above the modules that call this.
      const { backupCompose } = await import('../deploy/compose/index.js');
      outcome = await backupCompose(ip, sshKeyPath, projectName, {
        retain,
        lockWaitS: POST_PROMOTE_LOCK_WAIT_S,
      });
    } else {
      const { triggerBackupJob } = await import('../../backup.js');
      outcome = await triggerBackupJob(ip, sshKeyPath);
    }
  } catch (err) {
    throw new PostPromoteBackupError(firstLine(err), envName);
  }
  if (outcome.result !== 'pushed') {
    throw new PostPromoteBackupError(`the backup was skipped (${outcome.reason})`, envName);
  }
  if (outcome.retentionError) {
    warn(
      `Base backup ${outcome.name} is in the bucket, but pruning old backups failed: ${outcome.retentionError}`,
    );
  }
  return { name: outcome.name };
}
