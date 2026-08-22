/**
 * Cross-process operator-uplink lock — the class-level fix the mitigation
 * registry carried as OPEN since the per-process tunnel-push mutex landed
 * (91a66a3e): "matrix siblings still share the uplink". The mutex cannot see
 * another `vibecarbon` process, and the e2e record shows a tunnel push
 * failing after 5 attempts one day after it landed.
 *
 * Same one-writer-per-contended-resource shape that took the state backend
 * from 38 backpressure events to 0. The contended resource is the operator
 * machine's uplink; its natural scope is the operator HOST, so the lock is a
 * lock DIRECTORY (atomic `mkdir` — the one primitive that is atomic on every
 * filesystem we run on) under ~/.vibecarbon/locks/, holding a holder.json
 * `{pid, startedAt, label}`.
 *
 * Reaping, because a SIGKILLed deploy never runs its release:
 *   - DEAD HOLDER: `process.kill(pid, 0)` throws ESRCH — reap immediately.
 *   - OVER-AGE HOLDER: alive pid but older than the staleness budget (a hung
 *     push, or a recycled pid) — reap. The budget sits above any legitimate
 *     push (the k8s settle ladder tops out ~4 min; 10 min is comfortably
 *     clear).
 *   - CORRUPT holder.json: counts as stale — a parse error must degrade to
 *     "reap and proceed", never to a permanent block.
 *
 * Waiting is logged (an operator watching a silent deploy would otherwise
 * read the queue as a hang), and acquisition after a wait emits an `[uplink]`
 * line mirroring the `[state]` telemetry so matrix logs show the contention
 * this lock absorbs.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { progressLog } from '../cli/progress.js';

/**
 * Default host-wide lock location. VIBECARBON_UPLINK_LOCK_DIR overrides it —
 * the unit suite sets a per-worker temp dir there, because vitest workers are
 * real separate processes and would otherwise genuinely serialize the whole
 * test run through one home-dir lock (observed on this lock's first parallel
 * run). Operators never set it.
 */
export const UPLINK_LOCK_DIR =
  process.env.VIBECARBON_UPLINK_LOCK_DIR ||
  join(homedir(), '.vibecarbon', 'locks', 'uplink-push.lock');

/** Above any legitimate push (settle ladders top out ~4 min). */
const DEFAULT_STALE_MS = 600_000;

const POLL_MS = 2000;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const holderPath = (lockDir) => join(lockDir, 'holder.json');

function readHolder(lockDir) {
  try {
    return JSON.parse(readFileSync(holderPath(lockDir), 'utf-8'));
  } catch {
    // Missing OR corrupt: either way the holder cannot be trusted to release.
    return null;
  }
}

function holderIsStale(holder, staleMs, now) {
  if (!holder || typeof holder.pid !== 'number') return true;
  if (typeof holder.startedAt !== 'number' || now - holder.startedAt > staleMs) return true;
  try {
    process.kill(holder.pid, 0);
    return false; // alive and within budget
  } catch {
    return true; // ESRCH (dead) — EPERM can't occur for same-user vibecarbon processes
  }
}

/**
 * Acquire the host-wide uplink lock. Resolves with an idempotent release.
 *
 * @param {object} [params]
 * @param {string} [params.lockDir]
 * @param {string} [params.label] - short tag for the wait/acquire log lines
 * @param {number} [params.staleMs]
 * @param {(ms: number) => Promise<void>} [params.sleep] - test seam
 * @returns {Promise<() => void>}
 */
export async function acquireUplinkLock({
  lockDir = UPLINK_LOCK_DIR,
  label = 'push',
  staleMs = DEFAULT_STALE_MS,
  sleep = defaultSleep,
} = {}) {
  mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });
  const queuedAt = Date.now();
  let waitedLogged = false;

  for (;;) {
    try {
      mkdirSync(lockDir); // atomic: exactly one process wins
      writeFileSync(
        holderPath(lockDir),
        JSON.stringify({ pid: process.pid, startedAt: Date.now(), label }),
      );
      if (waitedLogged) {
        progressLog(
          `[uplink] ${label}: lock acquired after ${Math.round((Date.now() - queuedAt) / 1000)}s wait`,
        );
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Only remove OUR lock: if a reaper raced us out and someone else now
        // holds it, their holder.json names a different pid.
        const holder = readHolder(lockDir);
        if (holder && holder.pid !== process.pid) return;
        rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const holder = readHolder(lockDir);
      if (holderIsStale(holder, staleMs, Date.now())) {
        progressLog(
          `[uplink] ${label}: reaping stale lock (holder pid ${holder?.pid ?? 'unknown'})`,
        );
        rmSync(lockDir, { recursive: true, force: true });
        continue; // race back to the atomic mkdir
      }
      if (!waitedLogged) {
        waitedLogged = true;
        // Without this a queued push looks like a hang — no docker output,
        // nothing, until the other process's transfer drains.
        progressLog(
          `[uplink] ${label}: waiting for a concurrent transfer in another process (pid ${holder.pid})`,
        );
      }
      await sleep(POLL_MS);
    }
  }
}
