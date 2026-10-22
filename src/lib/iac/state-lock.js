/**
 * Serialize state-backend operations per bucket, within this process.
 *
 * WHY. Both HA runners fan primary and standby out under `Promise.all`
 * (`deploy/effects/compose-ha.js`, `deploy/effects/k8s-ha.js`) against ONE
 * state bucket, so two Pulumi engines do their stack-selects, checkpoint writes
 * and lock acquisitions against the same S3 prefix at the same time. That is
 * self-inflicted load, and the evidence says load is the problem: of the 40
 * state-backend recovery events in run 31898658781's hetzner leg, 38 were
 * throttle and only 2 were staleness-shaped. They cluster exactly where the
 * concurrency is —
 *
 *     11  up
 *      8  stack-select ci4-standby   <- the k8s-ha pair, one bucket,
 *      8  stack-select ci4-primary   <- both in flight together
 *      8  stack-select ci3
 *
 * Note where the mass is: stack-select outnumbers up two to one. Serializing
 * only the mutating operations would miss most of it, so this covers reads too.
 *
 * Hetzner documents 750 requests/s per bucket, 750/s per source IP and 256
 * active parallel TCP sessions per source IP, and says that as a shared-resource
 * product, contention "could lead to slow response times or timeout errors". We
 * have never modelled any of that. One engine at a time per bucket is the
 * structural version of staying inside it.
 *
 * WHY NOT a bucket per stack, which would raise the per-bucket ceiling: the
 * per-source-IP ceilings are NOT per bucket, and every deploy runs from one
 * operator host, so more buckets does not raise the limit that actually binds
 * us — and it manufactures more freshly-created buckets, which the code
 * documents as the worst window for this whole class.
 *
 * WHY NOT stagger or a wider retry ladder: every retry is one more request
 * against the store that is already failing to keep up. The ladder increases
 * volume under exactly the conditions that trigger it.
 *
 * SCOPE is per-process and per-bucket. Two separate `vibecarbon` processes, or
 * e2e matrix siblings, still share the source IP; that is what the retry
 * classifier remains for.
 *
 * WHAT IT COVERS depends on the state bucket's age (Ruling A′, 2026-10-21).
 * `upStack` takes `options.stateBucketYoung`, read once per deploy against
 * the provider's declared settle window (`static bucketSettleWindowMs`:
 * Hetzner 20 min, every other provider 0, so they never read the age):
 *
 *   - past the window: the lock covers the state-backend preparation only,
 *     stack select, stale-lock cancel, pre-up refresh and the Vultr repair
 *     (labels `stack-select <s>` and `refresh <s>`), and is released before
 *     `stack.up()`. An HA pair's two engines provision in parallel.
 *   - inside the window, or with an unknown age: the whole `upStack` holds it
 *     (label `up <s>`), provisioning and any retry backoff included, so the
 *     two `up`s serialize end to end as they did from 2026-08-15 on.
 *
 * The evidence for the split (run 31898658781, job 95045761606 log, re-read
 * 2026-10-21): all 11 `up` throttles landed 39-150 s after their state bucket
 * was created, every `stack-select` throttle 2-14 s after it, and four of the
 * `up` throttles came from a single-cluster deploy with no second engine at
 * all. Young buckets throttle; settled ones did not. The one compose-ha pair
 * that overlapped its `up`s did it on a ~95 s old bucket, and failed, which is
 * why a young bucket keeps the whole-operation lock: a customer's first HA
 * deploy runs on a minutes-old bucket. Holding it past the window cost every
 * HA deploy the primary's whole provisioning time (compose-ha's standby `up`
 * finished ~95 s after the primary's, `state lock acquired after 93s`).
 *
 * If that is wrong, two `up`s overlap on a settled bucket and any throttle is
 * still absorbed by withStateBackendRetry and counted as `backpressure` in the
 * `[state]` line, which the e2e budgets fail on. The second engine always
 * waits a few seconds for the first one's select and refresh.
 *
 * `syncServerState` (server-state.js) keeps a whole-operation lock in every
 * case: it is a state read-modify-write, not provisioning.
 *
 * RE-ENTRANCY is the part that has to be right. The public operations nest:
 * `upStack` calls `getOrCreateStack`, which calls `listStacks`; `destroyStack`
 * and `getStackOutputs` call `getOrCreateStack` too. A plain mutex would
 * deadlock on the first deploy — the outer holder would wait for itself. So a
 * holder is tracked in async context and a nested acquisition of a key this
 * context already holds runs straight through.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { progressLog } from '../cli/progress.js';
import { recordLockWait, recordStateOp } from './state-telemetry.js';

/**
 * Keys held by the current async context. Propagates across await points and
 * promise chains, which is what makes nested acquisition detectable without
 * threading a token through every signature.
 * @type {AsyncLocalStorage<Set<string>>}
 */
const heldKeys = new AsyncLocalStorage();

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
 * Run `fn` with exclusive access to `key` within this process.
 *
 * Nested calls for a key the current async context already holds run inline —
 * see the re-entrancy note above.
 *
 * @template T
 * @param {string} key - Serialization key. The state backend URL, so distinct
 *   buckets never block each other.
 * @param {string} label - Short tag for the contention log line.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withStateLock(key, label, fn) {
  // Counted for BOTH the nested and queued paths: a nested acquisition still
  // runs its own pulumi invocation, and the telemetry's job is to state what
  // this process did to the store, not how the lock happened to route it.
  recordStateOp(label.split(' ')[0]);
  const held = heldKeys.getStore();
  if (held?.has(key)) return fn();

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

  const nested = new Set(held ?? []);
  nested.add(key);
  try {
    return await heldKeys.run(nested, fn);
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
