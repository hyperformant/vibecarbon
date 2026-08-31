/**
 * Async update check. The notice always renders from the on-disk cache
 * (zero added latency); the network refresh is fire-and-forget with a 3s
 * timeout and runs at most once per 24h. The GET carries no body, no
 * identifiers, no cookies — it is a feature, not tracking (see
 * vibecarbon.com/docs/telemetry) — so it runs regardless of analytics
 * opt-out. CI skips it entirely.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { c } from '../colors.js';
import { VERSION } from '../version.js';
import { isNewerVersion } from './semver.js';

const DEFAULT_DIR = join(homedir(), '.vibecarbon');
const FILE_NAME = 'update-check.json';
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * One-line update notice from the cached check, or null.
 *
 * @param {{ currentVersion?: string, stateDir?: string }} [opts]
 * @returns {string|null}
 */
export function getUpdateNotice({ currentVersion = VERSION, stateDir = DEFAULT_DIR } = {}) {
  try {
    const cache = JSON.parse(readFileSync(join(stateDir, FILE_NAME), 'utf-8'));
    if (isNewerVersion(cache.latestVersion, currentVersion)) {
      return c.dim(
        `Update available ${currentVersion} → ${cache.latestVersion} · npm i -g vibecarbon`,
      );
    }
  } catch {
    // no cache / corrupt cache — no notice
  }
  return null;
}

/**
 * Refresh the cached latest-version if stale. Never throws, never rejects.
 * Persists attempt time on success or failure to throttle outage retries.
 *
 * @param {{ env?: NodeJS.ProcessEnv, stateDir?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<void>}
 */
export async function refreshUpdateCache({
  env = process.env,
  stateDir = DEFAULT_DIR,
  fetchImpl = fetch,
} = {}) {
  try {
    if (env.CI !== undefined && env.CI !== '' && env.CI !== '0') return;
    const file = join(stateDir, FILE_NAME);
    let priorLatestVersion;
    try {
      const cache = JSON.parse(readFileSync(file, 'utf-8'));
      if (Date.now() - Date.parse(cache.checkedAt) < TTL_MS) return;
      priorLatestVersion = cache.latestVersion;
    } catch {
      // missing/corrupt cache — proceed to fetch
    }
    const base = env.VIBECARBON_API_BASE || 'https://vibecarbon.com';
    let latestVersion = priorLatestVersion;
    try {
      const res = await fetchImpl(`${base}/api/v1/cli/version`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const { latest } = await res.json();
        if (typeof latest === 'string') {
          latestVersion = latest;
        }
      }
    } catch {
      // Network error, timeout, bad JSON — latestVersion stays as prior or undefined
    }
    // Always persist checkedAt on every attempt (success or failure) to throttle retries.
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const cacheData = { checkedAt: new Date().toISOString() };
    if (latestVersion !== undefined) cacheData.latestVersion = latestVersion;
    writeFileSync(file, `${JSON.stringify(cacheData, null, 2)}\n`);
  } catch {
    // read-only disk, mkdirSync failure, etc. — all fine, try next time.
  }
}
