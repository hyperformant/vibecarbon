/**
 * Serialize one state read-modify-write per bucket, within this process.
 *
 * `syncServerState` (server-state.js) is the only holder: it exports a stack's
 * state, edits it and imports it back, and that must not interleave with
 * another one on the same bucket.
 *
 * WHY NOTHING ELSE HOLDS IT. Both HA runners fan primary and standby out under
 * `Promise.all` against one state bucket (`deploy/effects/compose-ha.js`,
 * `deploy/effects/k8s-ha.js`). From 2026-08-15 this lock kept the two Pulumi
 * engines apart, first for each whole `upStack`, later for its select and
 * refresh and, on a new Hetzner bucket, still its whole `up`. The evidence was
 * run 31898658781's hetzner leg: 38 of 40 state-backend recovery events were
 * throttle, all 11 `up` throttles landed 39-150 s after their state bucket was
 * created and every `stack-select` throttle 2-14 s after it. Those buckets had
 * been probed in their first second, the thing `bucketQuietMs` (hetzner-s3.js)
 * now prevents, and with that pause the throttles do not come back:
 *
 *   - `up` outside the lock on new Hetzner buckets (cpx22, hel1 and fsn1):
 *     compose-ha 212 s became 184 and 201 s, k8s-ha 330 s became 260 and 247 s,
 *     no backpressure in any run.
 *   - two unlocked preparations at once (select, stack list, create, cancel,
 *     export, refresh, the Vultr repair) with the real Pulumi CLI, 2026-11-05:
 *     80 pairs and 7,520 requests across Hetzner hel1, DigitalOcean nyc3, Vultr
 *     ewr1, Scaleway nl-ams and Linode us-iad-10, no 503, 429 or SlowDown, no
 *     retry, no state error. Pulumi's S3 client retries a 503 twice without
 *     saying so, so every request's status was read at a proxy in front of it.
 *     A Hetzner pair's median was 14 s side by side, 26 s one after the other.
 *
 * 49 of those were the first pair on a brand-new bucket, 25 of them on Hetzner.
 * That is the case to watch: two selects there both initialize
 * `.pulumi/meta.yaml`, the shape a 2026-04-28 k8s-ha deploy died in (`could not
 * list bucket: blob (code=NotFound): NoSuchKey`), on a bucket with no quiet
 * pause.
 *
 * WHY NOT stagger or a wider retry ladder if this turns out wrong: every retry
 * is one more request against a store that is already failing to keep up. A
 * throttle is absorbed by withStateBackendRetry and counted as `backpressure`
 * in the `[state]` line, which the e2e budgets fail on, and they alarm on a
 * lock wait too, which should now be near zero.
 *
 * SCOPE is per-process and per-bucket. Two separate `vibecarbon` processes, or
 * e2e matrix siblings, are not serialized.
 */

import { progressLog } from '../cli/progress.js';
import { recordLockWait, recordStateOp } from './state-telemetry.js';

/**
 * Tail of the wait chain per key. Each holder's slot is settled by its release
 * callback and never by the operation's own outcome, so an operation that
 * throws cannot poison the chain for the waiters behind it.
 * @type {Map<string, Promise<void>>}
 */
const tails = new Map();

/** Holders plus waiters per key, tracked synchronously so logs are accurate. */
const depths = new Map();

/** Test seam: observe contention without scraping log lines. */
let waitObserver = null;

/**
 * Run `fn` with exclusive access to `key` within this process. Not re-entrant:
 * a holder that takes its own key again waits for itself.
 *
 * @template T
 * @param {string} key - Serialization key. The state backend URL, so distinct
 *   buckets never block each other.
 * @param {string} label - Short tag for the contention log line.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withStateLock(key, label, fn) {
  recordStateOp(label.split(' ')[0]);

  const prior = tails.get(key) ?? Promise.resolve();
  let releaseSlot;
  const slot = new Promise((resolve) => {
    releaseSlot = resolve;
  });
  tails.set(
    key,
    prior.then(() => slot),
  );

  // Read depth BEFORE incrementing, synchronously: two calls made in the same
  // tick would both still see 0 after an await.
  const contended = (depths.get(key) ?? 0) > 0;
  depths.set(key, (depths.get(key) ?? 0) + 1);
  const queuedAt = Date.now();
  if (contended) {
    // Without this a waiting operation looks like a hang — no Pulumi output,
    // nothing, until the peer drains.
    progressLog(`[pulumi] ${label}: waiting for a concurrent state operation on this bucket`);
  }

  await prior;
  if (contended) {
    const waitedMs = Date.now() - queuedAt;
    progressLog(`[pulumi] ${label}: state lock acquired after ${Math.round(waitedMs / 1000)}s`);
    recordLockWait(waitedMs);
    waitObserver?.({ key, label, waitedMs });
  }

  try {
    return await fn();
  } finally {
    depths.set(key, Math.max(0, (depths.get(key) ?? 1) - 1));
    releaseSlot();
  }
}

/**
 * Register a callback fired whenever an acquisition had to wait. Returns a
 * disposer. Test-only.
 * @param {null | ((info: {key: string, label: string, waitedMs: number}) => void)} fn
 */
export function observeStateLockWaits(fn) {
  waitObserver = fn;
  return () => {
    waitObserver = null;
  };
}

/** Test-only: drop all chains so one test's contention cannot leak into another. */
export function resetStateLocksForTest() {
  tails.clear();
  depths.clear();
  waitObserver = null;
}
