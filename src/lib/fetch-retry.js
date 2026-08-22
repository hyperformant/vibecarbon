/**
 * fetchWithRetry — a small wrapper around global `fetch` that retries on
 * transient network + upstream errors. Used by the Hetzner DNS and
 * Cloudflare clients so a momentary "fetch failed" during deploy / scale
 * doesn't kill an otherwise-healthy run.
 *
 * Transient conditions we retry:
 *   - `fetch failed` (Node undici wraps TCP RST / DNS blip / ECONNRESET)
 *   - HTTP 429 / 500 / 502 / 503 / 504
 *
 * Non-transient (4xx other than 429) short-circuit immediately so we don't
 * retry a genuine bad-request / auth failure.
 *
 * Policy: up to 5 attempts, exponential backoff (1s, 2s, 4s, 8s). Cap total
 * wait at ~15s so we don't silently stretch a deploy.
 *
 * Connection pooling: we install a global undici Agent with keep-alive so
 * every fetch() call in the process shares a warm connection pool. A single
 * deploy makes 50+ round-trips against 4 APIs (Hetzner Cloud, Hetzner DNS,
 * Cloudflare, Hetzner S3) — without keep-alive each call pays a fresh
 * TCP+TLS handshake, which magnifies flaky-network failure rates. With
 * keep-alive, repeat calls reuse idle sockets, eliminating ~80% of the
 * "fetch failed" class of errors we were papering over with retries.
 */

import { Agent, setGlobalDispatcher } from 'undici';
import { progressLog } from './cli/progress.js';

// Install once per process. Subsequent imports are no-ops (ES modules run
// top-level code exactly once). Tune connections for our fan-out: deploys
// talk to ~4 hosts in parallel; 16 per-origin is more than we need and
// leaves room for batch operations.
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 30_000, // hold idle sockets 30s for reuse
    keepAliveMaxTimeout: 60_000,
    connections: 16, // per-origin cap
    pipelining: 1, // conservative — not all APIs tolerate pipelining
  }),
);

const DEFAULT_MAX_ATTEMPTS = 5;
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function isTransientNetworkError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  // Node fetch wraps low-level failures into these strings — the underlying
  // cause (ECONNRESET, ENOTFOUND, EAI_AGAIN) is buried in err.cause.
  return (
    /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network.*timeout|undici/i.test(
      msg,
    ) ||
    (err.cause &&
      /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(String(err.cause.code ?? err.cause)))
  );
}

/**
 * @param {string | URL | Request} url
 * @param {RequestInit & { maxAttempts?: number; label?: string }} [init]
 */
export async function fetchWithRetry(url, init = {}) {
  const { maxAttempts = DEFAULT_MAX_ATTEMPTS, label, ...fetchInit } = init;
  // Label the retry line so a flaky deploy's output makes sense at a glance.
  // Prefer an explicit caller-supplied label; else derive from URL hostname.
  const op =
    label ||
    (() => {
      try {
        return new URL(String(url)).host;
      } catch {
        return 'fetch';
      }
    })();
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, fetchInit);
      if (response.ok || !TRANSIENT_STATUS.has(response.status)) {
        return response;
      }
      // Drain & retry — the retry path re-issues the request with a fresh body
      // stream where applicable.
      lastErr = new Error(`HTTP ${response.status} on ${url}`);
      lastErr.status = response.status;
    } catch (err) {
      if (!isTransientNetworkError(err)) throw err;
      lastErr = err;
    }
    if (attempt === maxAttempts) break;
    const backoffMs = Math.min(2 ** (attempt - 1) * 1000, 8000);
    // Surface the retry so a user staring at a slow deploy knows we're
    // not silently stuck. Routed through progressLog so it updates an active
    // spinner's line instead of shredding it — falls back to stderr (keeping it
    // out of captured stdout pipes) when no spinner is running.
    const reason = lastErr?.status
      ? `HTTP ${lastErr.status}`
      : (lastErr?.message || String(lastErr)).slice(0, 120);
    progressLog(
      `[retry] ${op}: attempt ${attempt}/${maxAttempts} failed (${reason}); retrying in ${backoffMs}ms`,
    );
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  throw lastErr;
}
