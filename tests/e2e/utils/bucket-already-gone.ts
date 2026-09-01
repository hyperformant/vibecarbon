/**
 * Is this bucket-delete error really "the bucket is already gone"?
 *
 * Object-storage LISTINGS lag DELETEs on every provider we sweep (the same
 * staleness family as the wal-g NoSuchBucket class): a post-scenario sweep
 * can enumerate a bucket that final-destroy removed seconds earlier, then
 * watch its own delete answer "The specified bucket does not exist". That
 * is the sweep's GOAL STATE, not an enumeration failure — but every
 * provider sweep's catch block treated ANY delete error as `enumFailed`
 * and branded the scenario a destroy REGRESSION.
 *
 * Live veto (run 33538738831, DO k8s-ha, 2026-09-01): every lifecycle step
 * green — deploy, failover, reconverge, final-destroy — and the scenario
 * still read [regression] because the sweep's stale listing named a bucket
 * the destroy had already removed. The hetzner standalone sweep
 * (scripts/sweep-hetzner.js) already shrugs at the same spelling.
 *
 * Deliberately narrow: only the not-exists spellings S3-compatible APIs
 * emit for a missing BUCKET. A 403, a network error, or an object-level
 * failure keeps failing the sweep loudly.
 */
export function isBucketAlreadyGone(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /NoSuchBucket|specified bucket does not exist|bucket .{0,60}(does not exist|not found)/i.test(
    message,
  );
}
