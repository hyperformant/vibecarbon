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
    try {
      const cache = JSON.parse(readFileSync(file, 'utf-8'));
      if (Date.now() - Date.parse(cache.checkedAt) < TTL_MS) return;
    } catch {
      // missing/corrupt cache — proceed to fetch
    }
    const base = env.VIBECARBON_API_BASE || 'https://vibecarbon.com';
    const res = await fetchImpl(`${base}/api/v1/cli/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const { latest } = await res.json();
    if (typeof latest !== 'string') return;
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      file,
      `${JSON.stringify({ latestVersion: latest, checkedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch {
    // Offline, timeout, bad JSON, read-only disk — all fine, try next time.
  }
}
