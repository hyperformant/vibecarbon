import { existsSync, readFileSync } from 'node:fs';
import { parseDotenv } from '../../../src/lib/project.js';

/**
 * Load the operator's e2e token file (`tests/.env.e2e`, gitignored — see
 * `tests/.env.e2e.example` for the key list) into `target` (defaults to
 * `process.env`).
 *
 * This REPLACES the retired credentials.json e2e profile (A5) as the
 * operator's local convenience store for e2e API tokens — `setupE2EEnv()`
 * (./e2e-env.js) calls this once at startup, before the token-resolution
 * block, so every existing env-first read site (Hetzner/DigitalOcean/
 * Cloudflare/S3/Docker Hub) picks the values up unchanged.
 *
 * - REAL ENV WINS: a key already present in `target` (CI secret, explicit
 *   shell export) is left untouched — this loader only fills gaps.
 * - Missing file is a no-op (fresh checkouts / CI have no `tests/.env.e2e`
 *   and must behave exactly as before this loader existed).
 * - No allowlist: unlike `bootstrapOperatorEnv`'s `.env.local` loader (which
 *   must filter out app secrets sharing that file), `tests/.env.e2e` is
 *   dedicated exclusively to operator e2e tokens, so every key it defines
 *   is eligible.
 *
 * PLAIN JS ON PURPOSE: `scripts/iter-step.js` runs under bare `node` (no
 * tsx), and it needs this loader to reach the same operator tokens the
 * runner sees. A `.ts` module would be unimportable there. Types are carried
 * in JSDoc; `tsconfig.e2e.json` has `allowJs: true` so `runner.ts` imports
 * it unchanged.
 *
 * @param {string} filePath - Absolute path to the env file (normally
 *   `<repoRoot>/tests/.env.e2e`).
 * @param {NodeJS.ProcessEnv} [target] - Env object to populate. Defaults to
 *   `process.env`; overridable in tests so assertions don't touch the real
 *   process env.
 * @returns {Set<string>} Set of keys actually applied — empty when the file
 *   is absent or every key it defines was already set in `target`.
 */
export function loadE2EEnvFile(filePath, target = process.env) {
  /** @type {Set<string>} */
  const applied = new Set();
  if (!existsSync(filePath)) return applied;
  /** @type {Record<string, string>} */
  const fileVars = parseDotenv(readFileSync(filePath, 'utf-8'));
  for (const [key, value] of Object.entries(fileVars)) {
    if (!(key in target)) {
      target[key] = value;
      applied.add(key);
    }
  }
  return applied;
}
