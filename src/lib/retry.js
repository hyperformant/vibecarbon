/**
 * Shared retry/polling primitives for the exec layer.
 *
 * Two shapes cover every bespoke loop in the codebase:
 *  - runWithRetry: N attempts with explicit inter-attempt delays
 *    (kubectl transient retries, ssh transient retries, sideload/push settles).
 *  - pollUntil: probe under a time budget with capped exponential backoff
 *    (wait-for-k3s, wait-for-schema, wait-for-API-healthy, delete-until-404).
 */
import { setTimeout as sleep } from 'node:timers/promises';

export async function runWithRetry(
  fn,
  { delaysMs = [5000, 5000], isTransient = () => true, onRetry } = {},
) {
  let attempt = 0;
  // attempts = delaysMs.length + 1
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= delaysMs.length || !isTransient(err)) throw err;
      attempt += 1;
      if (onRetry) onRetry(err, attempt);
      await sleep(delaysMs[attempt - 1]);
    }
  }
}

export async function pollUntil(
  probe,
  {
    budgetMs,
    initialDelayMs = 2000,
    maxDelayMs = 15_000,
    backoffFactor = 2,
    description = 'condition',
  } = {},
) {
  const deadline = Date.now() + budgetMs;
  let delay = initialDelayMs;
  let lastErr;
  for (;;) {
    try {
      const result = await probe();
      if (result) return result;
      lastErr = undefined;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() + delay > deadline) break;
    await sleep(delay);
    delay = Math.min(delay * backoffFactor, maxDelayMs);
  }
  const cause = lastErr ? `: ${lastErr.message}` : '';
  const err = new Error(`Timed out after ${budgetMs}ms waiting for ${description}${cause}`);
  err.cause = lastErr;
  throw err;
}
