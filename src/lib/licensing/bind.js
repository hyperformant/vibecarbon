/**
 * Bind / release clients for vibecarbon.com. Modeled on check.js: injectable
 * fetchImpl, hard timeout, env.VIBECARBON_API_BASE is the only env read and
 * only changes the host. Never throws.
 *
 * `/bind` binds an unbound key to the current project (idempotent for the
 * same project). `/release` never releases anything itself: the server
 * emails the buyer a single-use link, and the reply is only `sent: true`.
 * The key is committed to the repository, so possession of it must never be
 * enough to move the subscription.
 */
import { VERSION } from '../version.js';

const KNOWN_BIND_REFUSALS = new Set([
  'bad_signature',
  'bound_to_other_project',
  'project_already_licensed',
  'subscription_inactive',
  'unknown_key',
]);

async function post(path, body, { env = process.env, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const base = env.VIBECARBON_API_BASE || 'https://vibecarbon.com';
  let res;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, cliVersion: VERSION }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      kind: 'unreachable',
      detail: err?.name === 'TimeoutError' ? 'timeout' : err?.code || err?.name || 'network',
    };
  }
  if (res.status === 429 || res.status >= 500) {
    return { kind: 'unreachable', detail: `HTTP ${res.status}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    if (typeof parsed?.error === 'string')
      return { kind: 'error', status: res.status, body: parsed };
    return { kind: 'unreachable', detail: `HTTP ${res.status}` };
  }
  return { kind: 'ok', body: parsed ?? {} };
}

/**
 * @returns {Promise<{ ok: true, projectId: string, tier: string, status: string, periodEnd: string } |
 *   { ok: false, reason: 'bound_to_other_project' | 'project_already_licensed' | 'subscription_inactive' | 'unknown_key' | 'bad_signature' | 'unreachable' | 'rejected', message?: string, switchPlan?: boolean, detail?: string }>}
 */
export async function bindLicense({ key, projectId, env, fetchImpl, timeoutMs }) {
  const pid = projectId.toLowerCase();
  const r = await post(
    '/api/v1/license/bind',
    { key, projectId: pid },
    { env, fetchImpl, timeoutMs },
  );
  if (r.kind === 'unreachable') return { ok: false, reason: 'unreachable', detail: r.detail };
  if (r.kind === 'error') {
    if (KNOWN_BIND_REFUSALS.has(r.body.error)) {
      const out = { ok: false, reason: r.body.error };
      if (typeof r.body.message === 'string') out.message = r.body.message;
      if (typeof r.body.switchPlan === 'boolean') out.switchPlan = r.body.switchPlan;
      return out;
    }
    return { ok: false, reason: 'rejected', detail: r.body.error };
  }
  const b = r.body;
  if (typeof b.projectId !== 'string' || b.projectId.toLowerCase() !== pid) {
    return { ok: false, reason: 'rejected', detail: 'bind response named a different project' };
  }
  return {
    ok: true,
    projectId: pid,
    tier: String(b.tier),
    status: String(b.status),
    periodEnd: String(b.periodEnd),
  };
}

/** @returns {Promise<{ ok: true } | { ok: false, reason: 'unknown_key' | 'bad_signature' | 'unreachable' | 'rejected', detail?: string }>} */
export async function requestRelease({ key, env, fetchImpl, timeoutMs }) {
  const r = await post('/api/v1/license/release', { key }, { env, fetchImpl, timeoutMs });
  if (r.kind === 'unreachable') return { ok: false, reason: 'unreachable', detail: r.detail };
  if (r.kind === 'error') {
    if (r.body.error === 'unknown_key' || r.body.error === 'bad_signature')
      return { ok: false, reason: r.body.error };
    return { ok: false, reason: 'rejected', detail: r.body.error };
  }
  return r.body.sent === true
    ? { ok: true }
    : { ok: false, reason: 'rejected', detail: 'no sent flag' };
}
