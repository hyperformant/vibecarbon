/**
 * Lightweight performance-timing helper for deploy-path sub-steps.
 *
 * Enabled via `VIBECARBON_PERF=1`. When enabled, every `perfAsync` /
 * `perfTimer` call emits a single stderr line in the form:
 *
 *   [perf] <stage.name> <ms>ms [<optional-note>]
 *
 * The e2e harness captures this and the post-run reporter
 * aggregates every sub-step across all scenarios, sorted descending,
 * so we can see exactly where the critical path spends its time.
 *
 * Writing to stderr (never stdout) keeps @clack/prompts spinners on
 * stdout undisturbed.
 *
 * When the env var is unset, all of these are near-zero overhead:
 * one Date.now() call and a boolean guard.
 */

const enabled =
  process.env.VIBECARBON_PERF === '1' ||
  process.env.VIBECARBON_PERF === 'true' ||
  process.env.VIBECARBON_PERF === 'yes';

/**
 * Returns whether perf tracing is enabled. Cheap; call at boundaries
 * you don't want to pay for when perf is off.
 */
export function perfEnabled() {
  return enabled;
}

/**
 * Open a manually-controlled timer. Call .end(note?) to emit the
 * measurement. Always returns the ms duration whether or not perf
 * tracing is enabled so callers can persist timings elsewhere.
 */
export function perfTimer(name) {
  const start = Date.now();
  let ended = false;
  return {
    end(note) {
      if (ended) return 0;
      ended = true;
      const ms = Date.now() - start;
      if (enabled) {
        const suffix = note ? ` ${note}` : '';
        process.stderr.write(`[perf] ${name} ${ms}ms${suffix}\n`);
      }
      return ms;
    },
  };
}

/**
 * Wrap a promise-returning function in a perf timer. The returned
 * promise resolves/rejects identically to the original; timing is
 * captured on both paths (success notes nothing, failure notes
 * `(failed)` so a reader can see which branch blew the budget).
 */
export async function perfAsync(name, fn) {
  const t = perfTimer(name);
  try {
    const result = await fn();
    t.end();
    return result;
  } catch (err) {
    t.end('(failed)');
    throw err;
  }
}
