/**
 * Key refresh client: ask vibecarbon.com for the current key covering this
 * project's stored v2 license, proving possession by sending the stored key
 * itself. Used by the provisioning gate when a stored key is lapsed or too
 * low a tier, and by `vibecarbon activate -refresh`.
 *
 * Modeled on src/lib/telemetry/update-check.js's fetch/timeout/injection
 * pattern: an injectable `fetchImpl`, a hard timeout via
 * `AbortSignal.timeout`, and `env.VIBECARBON_API_BASE` as the only env read
 * (and it only ever changes the host — see
 * tests/unit/licensing/no-dev-bypass.test.ts).
 *
 * Never throws. Never deletes or downgrades the stored license, and never
 * writes anything on any failure path — only a key that verifies, is
 * `format: 'v2'`, and matches the stored key's customerId/projectId with a
 * paidThrough at or after the one already on disk gets activated (via
 * `activateLicense(..., { source: 'refresh' })`, which is the only thing
 * that ever touches disk here).
 */

import { VERSION } from '../version.js';
import { activateLicense, listStoredLicenses } from './index.js';
import { getReleaseDate } from './release-date.js';
import { validateLicenseKey } from './validator.js';

/**
 * @param {{
 *   projectDir?: string,
 *   stateDir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   publicKeyPem?: string,
 * }} [options]
 * @returns {Promise<
 *   | { ok: true, updated: true, paidThrough: string, tier: string }
 *   | { ok: false, reason: 'no-key' | 'invalid' | 'not-renewed' | 'not-found' | 'offline' }
 * >}
 */
export async function refreshLicense({
  projectDir = process.cwd(),
  stateDir,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 5000,
  publicKeyPem,
} = {}) {
  try {
    // The PROJECT slot only, never the legacy (v1, global) slot — a v1
    // holder has nothing per-project to refresh.
    const storedEntry = listStoredLicenses({ projectDir, stateDir }).find(
      (entry) => entry.slot === 'project' && entry.key,
    );
    if (!storedEntry) {
      return { ok: false, reason: 'no-key' };
    }

    // Re-validate the stored key ourselves (with the caller's publicKeyPem,
    // which listStoredLicenses' own internal check doesn't take) rather than
    // trust whatever fields the file happens to carry — the customerId /
    // projectId / paidThrough compared below must come from something that
    // actually verifies.
    const storedValidation = validateLicenseKey(storedEntry.key, { publicKeyPem });
    if (!storedValidation.valid || storedValidation.format !== 'v2') {
      return { ok: false, reason: 'no-key' };
    }

    const base = env.VIBECARBON_API_BASE || 'https://vibecarbon.com';
    let res;
    try {
      res = await fetchImpl(`${base}/api/v1/license/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: storedEntry.key,
          cliVersion: VERSION,
          releaseDate: getReleaseDate(),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Network error or timeout.
      return { ok: false, reason: 'offline' };
    }

    if (res.status === 402) return { ok: false, reason: 'not-renewed' };
    if (res.status === 404) return { ok: false, reason: 'not-found' };
    // Any other non-2xx (400 malformed/v1 key, 401 bad signature, 5xx, …):
    // the server was reached, it just didn't hand back a usable key. That is
    // a different failure than "couldn't reach the host" — the offline
    // upsell line would be misleading here.
    if (!res.ok) return { ok: false, reason: 'invalid' };

    let body;
    try {
      body = await res.json();
    } catch {
      // Non-JSON body on a 200 — treat like any other unreachable-server case.
      return { ok: false, reason: 'offline' };
    }

    const newKey = body?.key;
    if (typeof newKey !== 'string' || !newKey) {
      return { ok: false, reason: 'invalid' };
    }

    const newValidation = validateLicenseKey(newKey, { publicKeyPem });
    if (
      !newValidation.valid ||
      newValidation.format !== 'v2' ||
      newValidation.customerId !== storedValidation.customerId ||
      newValidation.projectId !== storedValidation.projectId ||
      newValidation.paidThrough < storedValidation.paidThrough
    ) {
      return { ok: false, reason: 'invalid' };
    }

    const activation = activateLicense(newKey, {
      projectDir,
      stateDir,
      publicKeyPem,
      source: 'refresh',
    });
    if (!activation.success) {
      return { ok: false, reason: 'invalid' };
    }

    return { ok: true, updated: true, paidThrough: activation.paidThrough, tier: activation.tier };
  } catch {
    // Never throw — a refresh attempt is always best-effort.
    return { ok: false, reason: 'offline' };
  }
}
