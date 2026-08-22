/**
 * Collect VITE_* build args for compose production deploys.
 *
 * Why this exists: Vite inlines `import.meta.env.VITE_*` at build time —
 * the values are baked into the JS bundle that the browser downloads.
 * The Dockerfile declares matching `ARG VITE_*` directives. Without
 * `docker build --build-arg KEY=VALUE` flags, the ARGs default to empty
 * strings, `ENV VITE_*=$VITE_*` propagates "" to the Vite build, and the
 * shipped bundle has e.g. `VITE_SUPABASE_URL=""`. The runtime guard at
 * carbon/src/client/lib/supabase.ts throws "Missing Supabase environment
 * variables" the moment the page loads.
 *
 * Local dev sidesteps this via `docker compose up --build` reading
 * docker-compose.yml's `build.args:` block (which sources from .env.local).
 * Production uses docker-compose.prod.yml which does `build: !reset null`
 * — the prod stack pulls a pre-built image rather than building, so the
 * args block doesn't run. The image is built earlier by vibecarbon's own
 * code (orchestrator.js / compose/ha.js calling buildRemote or a plain
 * `docker build`), and THAT path was passing no build args at all.
 *
 * Customer RCA: vibecarbon.com 2026-05-19, post-cert-fix the browser
 * threw "Missing Supabase environment variables" because the bundle had
 * empty VITE_SUPABASE_URL.
 *
 * Selection rule: every key in .env.local that starts with `VITE_` is
 * pulled through. We further rewrite a couple of values that must differ
 * between local dev and production (mirrors bundle.js's runtime .env
 * rewrites at src/lib/deploy/bundle.js:147-152):
 *   - VITE_PROJECT_NAME: forced to the deploy's projectName (the operator
 *     might have changed it in .env.local during local dev iteration)
 *   - VITE_SUPABASE_URL: rewritten to https://${domain} — production serves
 *     ONE origin; Traefik path-routes /auth/v1|/rest/v1|/realtime/v1|
 *     /storage/v1 on the apex to Kong, so the browser's Supabase calls are
 *     same-origin (dev keeps hitting Kong's localhost port directly)
 *
 * All other VITE_* values (feature flags, plausible config, etc.) flow
 * through unchanged.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDotenv } from '../../shell.js';

/**
 * @param {string} cwd - Project root (where .env.local lives)
 * @param {{ projectName?: string, domain?: string }} [opts]
 * @returns {Record<string, string>} Build args keyed by ARG name
 */
export function collectComposeBuildArgs(cwd, opts = {}) {
  const { projectName, domain } = opts;
  const args = {};
  const envPath = join(cwd, '.env.local');
  if (existsSync(envPath)) {
    const parsed = parseDotenv(readFileSync(envPath, 'utf-8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (k.startsWith('VITE_')) args[k] = v;
    }
  }
  // Prod rewrites — these must match what bundle.js writes into the
  // server's runtime .env so the client + server agree on the URL.
  if (projectName) args.VITE_PROJECT_NAME = projectName;
  // Single public origin: Supabase is reached on the apex via Traefik's
  // versioned-path routing to Kong, so this equals VITE_PUBLIC_URL.
  if (domain) args.VITE_SUPABASE_URL = `https://${domain}`;
  // Public canonical URL (apex domain) baked into the client at build time —
  // drives og:url / og:image / twitter:image and the generated sitemap.
  // Without this the client falls back to the create-time SITE_URL
  // (localhost), so social previews + sitemap point at localhost on every
  // deployed site.
  if (domain) args.VITE_PUBLIC_URL = `https://${domain}`;
  return args;
}

/**
 * Flatten a build-args dict into a `[..., '--build-arg', 'K=V', ...]`
 * argv tail suitable for `docker build`. Skips entries with empty/null
 * values — Docker treats empty `--build-arg K=` as a literal empty
 * value which is rarely what callers want.
 */
export function buildArgFlags(args) {
  /** @type {string[]} */
  const out = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === '') continue;
    out.push('--build-arg', `${k}=${v}`);
  }
  return out;
}
