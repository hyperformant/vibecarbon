/**
 * Verification-result tallying.
 *
 * A `skip` verdict means a check could not run because a PRECONDITION was
 * missing (no SSH handle, feature not enabled, browser absent). It is counted
 * on its own axis — never folded into `passed` (that was the skip-as-pass bug
 * this replaced, where a broken standby-IP resolver turned replication checks
 * into green no-ops) and never into `failed` (a missing precondition is not a
 * regression). A `fail` is still a fail, so a genuine breakage reddens the run.
 */

export interface VerificationTally {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

/**
 * Tally verification results by status. Accepts anything with a `status`
 * string, so it works on both live `VerificationResult`s and the reporter's
 * DB rows.
 */
export function summarizeVerifications(
  results: ReadonlyArray<{ status: string }>,
): VerificationTally {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    const s = String(r.status).toLowerCase();
    if (s === 'skip') skipped++;
    else if (s === 'pass') passed++;
    // fail, error, or any unexpected status reddens the run — a skip must be
    // spelled 'skip' to escape the failed bucket.
    else failed++;
  }
  return { passed, failed, skipped, total: results.length };
}
