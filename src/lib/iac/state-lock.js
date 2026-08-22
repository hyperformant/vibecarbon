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
 * COST, stated honestly (review finding 2026-08-15 — an earlier version of
 * this header understated it): the lock is held for the ENTIRE wrapped Pulumi
 * operation, and for `up` that includes the full cloud PROVISIONING the engine
 * performs, plus any retry backoff the holder sleeps through (deliberate: the
 * store is already throttling, and letting the sibling engine in mid-backoff
 * adds load at the worst moment). So an HA deploy's two `up`s serialize
 * end-to-end: compose-ha's provisioning wall-clock roughly doubles (~2min on a
 * ~15min deploy), and k8s-ha's primary/standby INFRA provisioning serializes
 * (~1-3min added) while everything after upStack returns — k3s install, helm,
 * cert-manager, rollouts, the bulk of its 50+ minutes — still runs in
 * parallel. Serializing the engine any more narrowly is not possible from
 * outside the pulumi subprocess; the engine interleaves state reads and writes
 * throughout the operation.
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
