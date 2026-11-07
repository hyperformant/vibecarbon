/**
 * Who holds a stack's Pulumi lock, and whether that run is gone.
 *
 * The lock is the only guard between two `vibecarbon` processes on one stack:
 * state-lock.js serializes the calls inside one process and nothing else
 * crosses processes. `pulumi cancel` deletes a lock without looking at who
 * holds it, so it runs only on evidence the holder is gone. Cleared without
 * that evidence, a destroy reported a clean teardown while the deploy it raced
 * went on creating servers nothing tracks, and the deleted stack file came back
 * listing resources that no longer existed.
 *
 * Pulumi names every holder in the error it raises on a locked stack, so this
 * reads no state bucket, and an unlocked stack costs nothing: no `pulumi cancel`
 * runs unless an operation actually hit a lock.
 */

import { hostname } from 'node:os';
import { pidAlive } from '../config.js';

/**
 * Past this age a lock counts as stale whoever holds it, which is what frees a
 * lock from a machine we cannot look at (a dead CI runner, another laptop) with
 * no flag to remember. Each server create is capped at 15 minutes
 * (create-timeout.js), so no live `up` gets near it.
 */
export const LOCK_EXPIRY_MS = 2 * 60 * 60 * 1000;

const LOCK_COUNT = /currently locked by (\d+) lock\(s\)/;
const LOCK_HOLDER = /: created by (.+)@(\S+) \(pid (\d+)\) at (\S+)/g;

/**
 * A stack another run may still be working on. Its message deliberately avoids
 * Pulumi's own wording, which state-error.js classifies as retry-in-place:
 * waiting out the backoff would only give the same answer.
 */
export class StackHeldError extends Error {
  constructor(stackName, holders) {
    const names = holders.map((h) => `${h.user}@${h.host} (pid ${h.pid}), started ${h.at}`);
    const expiries = holders.map((h) => Date.parse(h.at) + LOCK_EXPIRY_MS);
    const expires = Math.max(...expiries);
    super(
      `Stack "${stackName}" is in use by another run: ${names.join('; ')}. Stopping here, because ` +
        'working over a live run leaves servers nothing tracks. Let it finish, then run this again.' +
        (Number.isNaN(expires)
          ? ''
          : ` If it has died, its hold expires at ${new Date(expires).toISOString()}.`),
    );
    this.name = 'StackHeldError';
    this.holders = holders;
  }
}

/**
 * The holders named in a locked-stack error.
 *
 * Null when the message is not a locked-stack error, or names fewer holders than
 * it counts locks: a lock we cannot read is not one we may clear, so the failure
 * stays Pulumi's own. The automation API repeats the command's output in its
 * error, so a holder can appear twice; the result lists each once.
 *
 * @param {string} message
 * @returns {Array<{user: string, host: string, pid: number, at: string}>|null}
 */
export function lockHolders(message) {
  const count = Number(LOCK_COUNT.exec(message)?.[1]);
  if (!count) return null;
  const named = [...message.matchAll(LOCK_HOLDER)];
  if (named.length < count) return null;
  const holders = new Map(
    named.map(([line, user, host, pid, at]) => [line, { user, host, pid: Number(pid), at }]),
  );
  return [...holders.values()];
}

/**
 * Whether a holder is provably gone: past the expiry, or a dead process on this
 * machine. A process on another machine cannot be checked, so it counts as alive
 * until the expiry.
 *
 * @param {{host: string, pid: number, at: string}} holder
 * @param {number} [now]
 * @returns {boolean}
 */
export function holderIsGone(holder, now = Date.now()) {
  if (now - Date.parse(holder.at) > LOCK_EXPIRY_MS) return true;
  return holder.host === hostname() && !pidAlive(holder.pid);
}

/**
 * Run a stack operation, getting past a lock only when every holder is gone.
 * Runs inside withStateBackendRetry so a retry that meets the lock its own failed
 * attempt left clears it the same way.
 *
 * @template T
 * @param {{name: string, cancel: () => Promise<unknown>}} stack
 * @param {() => Promise<T>} op
 * @returns {Promise<T>}
 * @throws {StackHeldError} when a holder may still be running
 */
export async function runPastStaleLock(stack, op) {
  try {
    return await op();
  } catch (err) {
    const holders = lockHolders(err?.message ?? '');
    if (!holders) throw err;
    const alive = holders.filter((holder) => !holderIsGone(holder));
    if (alive.length > 0) throw new StackHeldError(stack.name, alive);
    await stack.cancel();
    return op();
  }
}
