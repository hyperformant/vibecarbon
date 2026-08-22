/**
 * One place that decides what a state-backend failure was and what may be done
 * about it.
 *
 * WHY THIS EXISTS. The previous design answered this question in seven nested
 * recovery branches, each inside its own catch block. Two properties of that
 * shape caused the 2026-08-15 failure of run 31898658781 and are structurally
 * unfixable by adding an eighth branch:
 *
 *   1. Every branch re-answered the mutation-safety question — did cloud
 *      resources change before this failed? — independently, from a string.
 *      With N branches that is N analyses that can disagree.
 *   2. A recovery invoked from inside another recovery's catch block could not
 *      reach the handler that knew the right answer. The re-run helper's own
 *      post-update outputs read failed with `no stack named`, and the handler
 *      holding exactly that recovery was the catch block it was already inside.
 *
 * So: classification is pure, total, and happens once. Callers act on the
 * result; they do not re-derive it.
 *
 * THE MUTATION-SAFETY RULE, stated once. `pulumi up` resolves the stack, loads
 * the checkpoint and takes the lock BEFORE it loads the program, spawns a
 * language host or starts a provider plugin. A failure from the `up` verb at
 * one of those reads is therefore PRE-mutation and re-running is not a
 * double-provision risk. The Automation API then runs `pulumi stack output`
 * AFTER the update succeeds — a failure from the `stack` verb is POST-mutation,
 * where re-running could read stale-empty state and provision everything a
 * second time, and the only safe recovery is a read-only re-read.
 *
 * `unknown` is the fail-safe and means "not provably pre-mutation". The
 * recogniser set is always a lagging subset of the failure set, so anything
 * unrecognised must land here.
 *
 * Every signature below is an incident that actually happened. The evidence
 * lives in tests/unit/iac/fixtures/state-error-corpus.ts, which quotes each
 * one verbatim with its date. Change a rule here and that corpus tells you
 * which incident you just stopped handling.
 */

/** What actually went wrong, at the storage layer. */
export const STATE_CAUSE = {
  /** The store asked us to slow down. Real backpressure; retry is correct. */
  THROTTLE: 'throttle',
  /** A lock is held. Contention we generally caused ourselves. */
  LOCK_CONTENTION: 'lock-contention',
  /** The backend 404'd the lock blob it had just written. */
  LOCK_BLOB_MISSING: 'lock-blob-missing',
  /** The bucket itself 404'd. */
  BUCKET_MISSING: 'bucket-missing',
  /** The bucket answered AccessDenied with valid credentials. */
  BUCKET_AUTH_LAG: 'bucket-auth-lag',
  /** The checkpoint blob was absent at the pre-plan read. */
  CHECKPOINT_STALE: 'checkpoint-stale',
  /** The stack file lookup 404'd. */
  STACK_FILE_MISSING: 'stack-file-missing',
  /** The cosmetic `.pulumi/history/` write failed after a completed update. */
  HISTORY_WRITE: 'history-write',
  /** Not a signature we recognise. */
  UNKNOWN: 'unknown',
};

/** Did cloud resources change before this failed? */
export const STATE_PHASE = {
  PRE_MUTATION: 'pre-mutation',
  POST_MUTATION: 'post-mutation',
  UNKNOWN: 'unknown',
};

/** What the caller is permitted to do about it. */
export const STATE_RECOVERY = {
  /** Retry the same operation. Only for failures that are idempotent-safe. */
  RETRY_IN_PLACE: 'retry-in-place',
  /** The mutation landed; verify state read-only and continue. */
  VERIFY_AND_CONTINUE: 'verify-and-continue',
  /** Surface it. */
  FAIL: 'fail',
};

/**
 * Extract the pulumi sub-command from an Automation API error message.
 *
 * The Automation API surfaces the failing command's full argv. execa rejects on
 * a nonzero exit and builds its message as `Command failed with exit code N:
 * <binary> <verb> <args...>`, so that argv is the only thing distinguishing
 * `pulumi up` (the update) from the `pulumi stack output` read that `Stack.up()`
 * runs afterwards — and both can fail with identical text.
 *
 * Returns the lowercased verb, or null when the message carries no recognizable
 * pulumi argv. null is the fail-safe answer.
 *
 * @param {string} [message]
 * @returns {string|null}
 */
export function failingPulumiCommandVerb(message) {
  const match = /command failed[^\n:]*:\s*(\S+)\s+(\S+)(?:\s+(\S+))?/i.exec(message || '');
  if (!match) return null;
  const [, binary, verb, sub] = match;
  // Guard against matching some other tool's "command failed" line.
  if (!/(?:^|[/\\])pulumi(?:\.exe)?$/i.test(binary)) return null;
  // `stack` alone is ambiguous — `pulumi stack select` fails PRE-mutation with
  // text identical to the post-update `pulumi stack output` read, and treating
  // the two alike hands out the wrong mutation-safety answer (review finding,
  // 2026-08-15). Return the two-word form so callers discriminate on the
  // subcommand; flags (`--foo`) are not subcommands.
  const v = verb.toLowerCase();
  if (v === 'stack' && sub && !sub.startsWith('-')) return `stack ${sub.toLowerCase()}`;
  return v;
}

// Server-side backpressure. Deliberately does NOT include lock wording: a held
// lock is contention, usually ours, and collapsing the two is what made this
// class unreadable in our own logs for months (38 of 40 events in run
// 31898658781 printed the same line regardless of which of these it was).
const THROTTLE_PATTERN =
  /SlowDown|ServiceUnavailable|RequestLimitExceeded|throttl|too many requests|\b503\b/i;

// A lock that EXISTS and is held.
const LOCK_CONTENTION_PATTERN = /currently locked|lock\(s\)/i;

// The DIY backend writes its own lock blob and then reads the lock directory
// back; a lagging frontend 404s the blob it just wrote. Must name a key under
// `.pulumi/locks/` on ONE line, so a plain NoSuchKey on a state key can never
// opt in — a missing STATE read is a real answer. Both orderings accepted
// because a gocloud/aws-sdk message reshuffle must not silently un-fix this.
const LOCK_BLOB_MISSING_PATTERN =
  /\.pulumi\/locks\/[^\n]*?(?:code=NotFound|NoSuchKey)|(?:code=NotFound|NoSuchKey)[^\n]*?\.pulumi\/locks\//i;

// The blob `pulumi up` must load before it can plan. Requires the not-found-ness
// on the SAME line as the checkpoint-load prefix: a checkpoint that fails to
// load because it is CORRUPT is an honest failure, and retrying only burns
// backoff before the same answer.
// Exported: iac/index.js's recovery machinery consumes these SAME objects, so
// the classifier and the recoveries cannot drift apart (review finding,
// 2026-08-15: index.js carried live duplicates of all three).
export const CHECKPOINT_STALE_PATTERN =
  /failed to load checkpoint[^\n]*(?:NoSuchKey|NoSuchBucket|code=NotFound)/i;

// LIST authorization answering 403 with credentials that work. Observed
// outlasting a six-minute window, which is longer than any retry budget worth
// spending — recognised so it can be named, not so it can be retried.
const BUCKET_AUTH_LAG_PATTERN = /could not list bucket[^\n]*AccessDenied/i;

const BUCKET_MISSING_PATTERN = /NoSuchBucket/i;

const STACK_FILE_MISSING_PATTERN = /no stack named/i;

// The cosmetic write, pinned to its target rather than to a status code: a
// degraded cluster can 403, 503 or 404 the same write, but the same error on a
// checkpoint key is real state loss and must stay fatal. Anchored to column 0
// because Pulumi indents per-resource diagnostics under their resource header —
// only top-level CLI errors start flush left.
export const HISTORY_WRITE_PATTERN = /^error:\s*saving update info:[^\n]*\.pulumi\/history\//im;

/**
 * The same root cause reaching us as a panic instead of an error: pulumi's DIY
 * backend nil-dereferences on the stale checkpoint read.
 *
 * Three markers must CO-OCCUR, matched by package and method and never by line
 * number, which moves every release. `newUpdate` is the one that proves the
 * window — it runs inside `apply` BEFORE the deployment executes, so nothing
 * was mutated. A `getTarget` panic reached from any other caller does not carry
 * that proof and must not qualify.
 */
export function isDiyGetTargetPanic(message) {
  return (
    /The Pulumi CLI encountered a fatal error/i.test(message) &&
    /backend\/diy\.\(\*diyBackend\)\.getTarget\b/.test(message) &&
    /backend\/diy\.\(\*diyBackend\)\.newUpdate\b/.test(message)
  );
}

/**
 * True when the ONLY thing that reported an error was the history write.
 *
 * This is the guard that makes continuing defensible. Pulumi records FAILED
 * updates in history too, so a history-write 403 can co-occur with a genuinely
 * failed update — and reporting success there would be the worst failure mode
 * in this module. execa's message carries the entire streamed update as well as
 * stderr, so this sees resource-level failures printed to the stream, not just
 * the final CLI error: every top-level `error:` line has to be the history
 * write.
 */
export function isHistoryWriteOnlyFailure(message) {
  const topLevelErrors = (message || '').match(/^error:[^\n]*/gm) ?? [];
  if (topLevelErrors.length === 0) return false;
  return topLevelErrors.every((line) => HISTORY_WRITE_PATTERN.test(line));
}

/**
 * @typedef {object} StateErrorClassification
 * @property {string} cause    One of STATE_CAUSE.
 * @property {string} phase    One of STATE_PHASE.
 * @property {string} recovery One of STATE_RECOVERY.
 * @property {string|null} verb The failing pulumi sub-command, when known.
 */

/**
 * Classify a state-backend failure. Pure and total.
 *
 * @param {object} params
 * @param {string} [params.message]   Full error text, execa envelope included.
 * @param {string} [params.operation] Our own label for the call site. Accepted
 *   and deliberately unread since the 2026-08-16 band-aid removal collapsed the
 *   destroy-vs-deploy switch it used to gate; callers still pass it, and it
 *   stays in the signature so re-introducing a call-site-dependent answer does
 *   not have to re-thread it through every caller.
 * @returns {StateErrorClassification}
 */
export function classifyStateError({ message } = {}) {
  const msg = message || '';
  const verb = failingPulumiCommandVerb(msg);
  const decide = (cause, phase, recovery) => ({ cause, phase, recovery, verb });

  // Since the 2026-08-16 band-aid removal every staleness spelling FAILS on
  // every path, so the old destroy-conservatism switch has nothing left to
  // gate — destroy and deploy now get the identical, maximally-conservative
  // answer. THROTTLE and LOCK_CONTENTION stay retryable everywhere:
  // backpressure and a held lock are never "already gone" answers.

  // Post-mutation and cosmetic. Checked first because the message also carries
  // an AccessDenied that later rules would otherwise read as a storage fault.
  if (isHistoryWriteOnlyFailure(msg)) {
    return decide(
      STATE_CAUSE.HISTORY_WRITE,
      STATE_PHASE.POST_MUTATION,
      STATE_RECOVERY.VERIFY_AND_CONTINUE,
    );
  }

  // The checkpoint read, in both of its spellings. Pre-mutation by the frames
  // in the panic case and by the read's position in the error case; the guarded
  // re-run gates on a zero-resource probe regardless, so even a misclassified
  // panic cannot double-provision.
  if (isDiyGetTargetPanic(msg) || CHECKPOINT_STALE_PATTERN.test(msg)) {
    // FAIL (band-aid removal 2026-08-16): the guarded re-run this used to
    // grant absorbed fresh-bucket checkpoint staleness — a trigger the root
    // fixes removed. The phase stays PRE_MUTATION (the frames/read position
    // prove it), which tells the operator a plain re-run is safe.
    return decide(STATE_CAUSE.CHECKPOINT_STALE, STATE_PHASE.PRE_MUTATION, STATE_RECOVERY.FAIL);
  }

  // Lock acquisition happens at startup, so both lock shapes are pre-mutation
  // and idempotent-safe to retry. Contention is checked before throttling
  // precisely so the two stop being reported as the same thing.
  if (LOCK_BLOB_MISSING_PATTERN.test(msg)) {
    // FAIL everywhere (band-aid removal 2026-08-16): the backend 404ing a
    // lock blob it just wrote was a fresh/recreated-bucket staleness spelling,
    // and that trigger is root-fixed (retention, warm buckets, visibility
    // gate). If it occurs now it is a store fault the operator must see.
    return decide(STATE_CAUSE.LOCK_BLOB_MISSING, STATE_PHASE.PRE_MUTATION, STATE_RECOVERY.FAIL);
  }
  if (LOCK_CONTENTION_PATTERN.test(msg)) {
    return decide(
      STATE_CAUSE.LOCK_CONTENTION,
      STATE_PHASE.PRE_MUTATION,
      STATE_RECOVERY.RETRY_IN_PLACE,
    );
  }

  // Backpressure. Phase is genuinely unknown — a SlowDown can interrupt an
  // update mid-flight — but retrying is safe anyway because `up` reconciles
  // from the checkpoint, which is why this is the one recovery permitted
  // without a definite phase.
  if (THROTTLE_PATTERN.test(msg)) {
    return decide(STATE_CAUSE.THROTTLE, STATE_PHASE.UNKNOWN, STATE_RECOVERY.RETRY_IN_PLACE);
  }

  // Longer than any budget worth spending. Named so the operator gets a real
  // diagnosis instead of a generic storage error.
  if (BUCKET_AUTH_LAG_PATTERN.test(msg)) {
    return decide(STATE_CAUSE.BUCKET_AUTH_LAG, STATE_PHASE.PRE_MUTATION, STATE_RECOVERY.FAIL);
  }

  if (BUCKET_MISSING_PATTERN.test(msg)) {
    // FAIL everywhere (band-aid removal 2026-08-16): the deploy path gates
    // bucket visibility on HEAD+LIST before any state op, so NoSuchBucket
    // past that gate is a real answer or a store fault — never a race to
    // retry through.
    return decide(STATE_CAUSE.BUCKET_MISSING, STATE_PHASE.UNKNOWN, STATE_RECOVERY.FAIL);
  }

  // The case the whole rewrite is named after. Identical text, and the verb is
  // the entire answer: from `up` the stack-file lookup happened before the
  // engine ran; from `stack` it is the post-update outputs read and the update
  // already applied.
  if (STACK_FILE_MISSING_PATTERN.test(msg)) {
    // FAIL in every position (band-aid removal 2026-08-16): the recoveries
    // this verb-split used to grant (guarded re-run pre-mutation, read-only
    // reread post-mutation) absorbed recreated-bucket staleness, and that
    // trigger is root-fixed. The verb still discriminates the PHASE — it is
    // the mutation-safety answer the operator needs: pre-mutation means a
    // plain re-run is safe; post-mutation means resources exist and the state
    // read must be inspected before anything re-runs.
    if (verb === 'up') {
      return decide(STATE_CAUSE.STACK_FILE_MISSING, STATE_PHASE.PRE_MUTATION, STATE_RECOVERY.FAIL);
    }
    if (verb === 'stack output') {
      return decide(STATE_CAUSE.STACK_FILE_MISSING, STATE_PHASE.POST_MUTATION, STATE_RECOVERY.FAIL);
    }
    return decide(STATE_CAUSE.STACK_FILE_MISSING, STATE_PHASE.UNKNOWN, STATE_RECOVERY.FAIL);
  }

  return decide(STATE_CAUSE.UNKNOWN, STATE_PHASE.UNKNOWN, STATE_RECOVERY.FAIL);
}
