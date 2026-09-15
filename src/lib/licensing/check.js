/**
 * Live license check: ask vibecarbon.com for this project's subscription
 * verdict, cache the SIGNED token per machine, and fall back to that cache
 * when the server cannot be reached. Modeled on refresh.js and
 * src/lib/telemetry/update-check.js: injectable fetchImpl, hard timeout,
 * env.VIBECARBON_API_BASE is the only env read and only changes the host.
 *
 * Trust rule: every field the decision table consumes comes out of
 * verifyVerdictToken(). The cache file's JSON mirror is never read for
 * entitlement; an edited file simply fails verification and is ignored.
 *
 * rejected vs unreachable: 429 and any 5xx are ALWAYS `unreachable`
 * (fall back to the cache, or warn), whatever the body says. A rate
 * limiter or our own 500 handler can emit JSON shaped exactly like the
 * app's error response without meaning "this key is invalid"; treating it
 * as a refusal would hard-block a paying customer during an outage or a
 * rate-limit blip. Every other non-ok status (400/401/403/404/408/...) is
 * `rejected` (hard block, no cache fallback) ONLY when its body parses as
 * JSON and carries a string `error` field, the app's own error shape for
 * "the server answered and does not recognize this key" (`{ error:
 * 'invalid_key' | 'bad_signature' | 'lifetime_key' | 'not_found' | ...
 * }`). Anything else there, an HTML 403 from a WAF, an empty 408, is also
 * `unreachable`. The body is read once via `res.text()` and parsed
 * defensively; a body that isn't JSON, or is JSON without an `error`
 * string, never throws and never counts as a refusal.
 *
 * Never throws.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { VERSION } from '../version.js';
import { verifyVerdictToken } from './validator.js';

const DEFAULT_STATE_DIR = join(homedir(), '.vibecarbon');

export function cachePathFor(stateDir, projectId) {
  return join(stateDir || DEFAULT_STATE_DIR, 'license-checks', `${projectId.toLowerCase()}.json`);
}

export function readCachedVerdict({ stateDir, projectId, publicKeyPem }) {
  const path = cachePathFor(stateDir, projectId);
  if (!existsSync(path)) return null;
  let stored;
  try {
    stored = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (typeof stored?.token !== 'string') return null;
  const verified = verifyVerdictToken(stored.token, { publicKeyPem });
  if (!verified.valid || verified.projectId !== projectId.toLowerCase()) return null;
  const { valid, ...verdict } = verified;
  return { verdict, cancelAtPeriodEnd: stored.cancelAtPeriodEnd === true };
}

function writeCache({ stateDir, projectId, token, cancelAtPeriodEnd }) {
  const path = cachePathFor(stateDir, projectId);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    JSON.stringify(
      { token, checkedAt: new Date().toISOString(), cancelAtPeriodEnd: cancelAtPeriodEnd === true },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

function fallback({ stateDir, projectId, publicKeyPem, unreachable }) {
  const cached = readCachedVerdict({ stateDir, projectId, publicKeyPem });
  if (cached)
    return {
      source: 'cache',
      verdict: cached.verdict,
      cancelAtPeriodEnd: cached.cancelAtPeriodEnd,
      unreachable,
    };
  return { source: 'none', verdict: null, unreachable };
}

/**
 * @returns {Promise<{ source: 'live'|'cache'|'none'|'rejected', verdict: object|null, unreachable?: string, cancelAtPeriodEnd?: boolean }>}
 */
export async function checkLicense({
  key,
  projectId,
  stateDir,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 5000,
  publicKeyPem,
} = {}) {
  const pid = projectId.toLowerCase();
  const base = env.VIBECARBON_API_BASE || 'https://vibecarbon.com';
  let res;
  try {
    res = await fetchImpl(`${base}/api/v1/license/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, cliVersion: VERSION }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fallback({
      stateDir,
      projectId: pid,
      publicKeyPem,
      unreachable: err?.name === 'TimeoutError' ? 'timeout' : err?.code || err?.name || 'network',
    });
  }

  if (!res.ok) {
    // 429 and any 5xx are ALWAYS an outage from this client's point of
    // view, whatever the body says. A rate limiter or a 500 handler can
    // easily emit JSON shaped like the app's own error response (e.g.
    // { error: 'rate_limited' } or { error: 'internal' }) without meaning
    // "this key is invalid" the way a 400/401/404 refusal does; treating
    // that as 'rejected' would hard-block a paying customer, bypassing the
    // cache, during our own outage or a rate-limit blip. So these two never
    // reach the body sniff below.
    if (res.status === 429 || res.status >= 500) {
      return fallback({
        stateDir,
        projectId: pid,
        publicKeyPem,
        unreachable: `HTTP ${res.status}`,
      });
    }
    // Every other non-ok status (400/401/403/404/408/...): only a body
    // shaped like the app's own error response ({ error: '<string>' })
    // counts as a genuine refusal ('rejected', no cache fallback). Anything
    // else, an HTML body from a WAF, an empty body, is an outage from this
    // client's point of view, not an answer: 'unreachable', fall back to
    // the cache.
    let errorField;
    try {
      const text = await res.text();
      const parsed = JSON.parse(text);
      if (typeof parsed?.error === 'string') errorField = parsed.error;
    } catch {
      // Non-JSON or unreadable body: falls through to unreachable below.
    }
    if (errorField !== undefined) {
      return { source: 'rejected', verdict: null };
    }
    return fallback({ stateDir, projectId: pid, publicKeyPem, unreachable: `HTTP ${res.status}` });
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return fallback({ stateDir, projectId: pid, publicKeyPem, unreachable: 'bad-json' });
  }

  const verified =
    typeof body?.token === 'string'
      ? verifyVerdictToken(body.token, { publicKeyPem })
      : { valid: false };
  if (!verified.valid || verified.projectId !== pid) {
    return { source: 'rejected', verdict: null };
  }
  const cancelAtPeriodEnd = body.cancelAtPeriodEnd === true;
  try {
    writeCache({ stateDir, projectId: pid, token: body.token, cancelAtPeriodEnd });
  } catch {
    // A read-only home dir must not turn a good verdict into a failure.
  }
  const { valid, ...verdict } = verified;
  return { source: 'live', verdict, cancelAtPeriodEnd };
}
