/**
 * Counts what this process actually does to the Pulumi state backend, so a
 * failure log can distinguish a REQUEST-BUDGET problem from a genuine
 * consistency problem instead of us inferring it after the fact.
 *
 * Why this exists: the 2026-08-15 analysis of run 31898658781 had to be done by
 * grepping recovery log lines out of a 12k-line CI log, and the collapse of
 * seven distinct causes into one "throttled" line is why the whole class was
 * misread as read-after-write staleness for months. The per-event lines now
 * name their cause (classifyStateError); this module adds the aggregate, so
 * every `up` ends with one greppable line stating what the deploy did to the
 * store and what the store pushed back on.
 *
 * HONEST LIMIT, stated once: we count OPERATIONS (pulumi invocations we start)
 * and the retry/wait events they generate. The raw S3 request rate lives inside
 * the Pulumi subprocess and is not observable from here — an `up` is many
 * requests we cannot see. So the summary reports operation counts and
 * backpressure events NEXT TO the strictest documented provider ceilings,
 * rather than pretending to measure requests per second. Backpressure events
 * are the store telling us we exceeded its budget; that signal is real even
 * when the request count isn't.
 *
 * Counters are process-wide and cumulative on purpose: the HA runners fan two
 * stacks out in one process, and the load they generate against the shared
 * bucket is the sum, not either half.
 */

import { progressLog } from '../cli/progress.js';
import { getProviderClass } from '../providers/index.js';

/** Operations started, keyed by kind (`up`, `stack-select`, ...). */
const ops = new Map();
/** Retry events, keyed by classifier cause (`throttle`, `lock-contention`, ...). */
const retries = new Map();
/** Lock contention: how often an operation queued, and for how long in total. */
let lockWaits = 0;
let lockWaitMs = 0;

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

/** An operation was started. `kind` is the first word of the lock label. */
export function recordStateOp(kind) {
  bump(ops, kind);
}

/** A retry ladder fired, for the given classified cause. */
export function recordStateRetry(cause) {
  bump(retries, cause);
}

/** An operation had to queue behind the per-bucket lock. */
export function recordLockWait(waitedMs) {
  lockWaits += 1;
  lockWaitMs += waitedMs;
}

/** Snapshot for tests and for the emitter below. */
export function stateTelemetrySummary() {
  return {
    ops: Object.fromEntries(ops),
    retries: Object.fromEntries(retries),
    lockWaits,
    lockWaitMs,
  };
}

/**
 * The strictest documented object-storage ceilings across every provider we
 * ship — the numbers a uniform, provider-agnostic budget has to respect. Nulls
 * mean "no provider documents a limit for this dimension".
 */
export function strictestObjectStorageLimits(providerIds) {
  const min = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
  let out = {
    requestsPerSecondPerBucket: null,
    requestsPerSecondPerSourceIp: null,
    parallelConnectionsPerSourceIp: null,
  };
  for (const id of providerIds) {
    const limits = getProviderClass(id).OBJECT_STORAGE_LIMITS;
    if (!limits) continue;
    out = {
      requestsPerSecondPerBucket: min(
        out.requestsPerSecondPerBucket,
        limits.requestsPerSecondPerBucket,
      ),
      requestsPerSecondPerSourceIp: min(
        out.requestsPerSecondPerSourceIp,
        limits.requestsPerSecondPerSourceIp,
      ),
      parallelConnectionsPerSourceIp: min(
        out.parallelConnectionsPerSourceIp,
        limits.parallelConnectionsPerSourceIp,
      ),
    };
  }
  return out;
}

/**
 * Emit the one-line cumulative summary. Called at the end of every `upStack`
 * (success and failure — failure logs are where this matters most). Routed
 * through progressLog so an active spinner's line updates instead of
 * corrupting, and so tests capture it the same way they capture the retry
 * lines.
 *
 * @param {string} label - e.g. `up e2-primary`
 * @param {string} [providerId] - names the declared ceilings when known
 */
export function emitStateTelemetry(label, providerId) {
  const fmt = (map) => [...map.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
  let ceilings = '';
  if (providerId) {
    try {
      const l = getProviderClass(providerId).OBJECT_STORAGE_LIMITS;
      if (l) {
        const parts = [
          l.requestsPerSecondPerBucket != null && `${l.requestsPerSecondPerBucket} rps/bucket`,
          l.requestsPerSecondPerSourceIp != null && `${l.requestsPerSecondPerSourceIp} rps/ip`,
          l.parallelConnectionsPerSourceIp != null && `${l.parallelConnectionsPerSourceIp} conn/ip`,
        ].filter(Boolean);
        ceilings = parts.length
          ? ` | documented ceilings (${providerId}): ${parts.join(', ')}`
          : ` | documented ceilings (${providerId}): none published`;
      }
    } catch {
      /* unknown provider — ceilings stay silent, counts still print */
    }
  }
  const waits = lockWaits > 0 ? `${lockWaits} (${Math.round(lockWaitMs / 1000)}s)` : '0';
  progressLog(
    `[state] ${label}: ops ${fmt(ops)} | backpressure ${fmt(retries)} | lock-waits ${waits}${ceilings}`,
  );
}

/** Test-only. */
export function resetStateTelemetryForTest() {
  ops.clear();
  retries.clear();
  lockWaits = 0;
  lockWaitMs = 0;
}
