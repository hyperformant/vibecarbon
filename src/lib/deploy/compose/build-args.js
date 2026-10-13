/**
 * Collect VITE_* build args for compose production deploys.
 *
 * Why this exists: Vite inlines `import.meta.env.VITE_*` at build time —
 * the values are baked into the JS bundle that the browser downloads.
 * The Dockerfile declares matching `ARG VITE_*` directives. Without
 * `docker build --build-arg KEY=VALUE` flags, the ARGs default to empty
 * strings, `ENV VITE_*=$VITE_*` propagates "" to the Vite build, and the
 * shipped bundle carries empty client config (customer RCA: vibecarbon.com
 * 2026-05-19, the browser bundle shipped with empty client config and the
 * SPA failed at page load).
 *
 * Local dev sidesteps this via `docker compose up --build` reading
 * docker-compose.yml's `build.args:` block (which sources from .env.local).
 * Production uses docker-compose.prod.yml which does `build: !reset null`
 * — the prod stack pulls a pre-built image rather than building, so the
 * args block doesn't run. The image is built earlier by vibecarbon's own
 * code (orchestrator.js / compose/ha.js calling buildRemote or a plain
 * `docker build`), and THAT path was passing no build args at all.
 *
 * Selection rule: every key starting with `VITE_` is pulled through —
 * seeded from .env.local, then overridden by any non-empty value in `.env`
 * (the deploy's server-runtime baseline, so the client is built from the
 * same config the server runs with). We further rewrite the values that
 * must differ between local dev and production (mirrors bundle.js's
 * runtime .env rewrites):
 *   - VITE_PROJECT_NAME: forced to the deploy's projectName (the operator
 *     might have changed it in .env.local during local dev iteration)
 *   - VITE_PUBLIC_URL: https://${domain}, the one public origin
 *
 * All other VITE_* values (feature flags, plausible config, etc.) flow
 * through unchanged. The browser talks only to the app's own origin (auth
 * included, at /api/auth), so no gateway URL or key is baked in.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDotenv } from '../../dotenv.js';

/**
 * @param {string} cwd - Project root (where .env.local lives)
 * @param {{ projectName?: string, domain?: string }} [opts]
 * @returns {Record<string, string>} Build args keyed by ARG name
 */
export function collectComposeBuildArgs(cwd, opts = {}) {
  const { projectName, domain } = opts;
  const args = {};
  // .env.local seeds the args, but `.env` overrides it for any key it holds
  // non-empty: `.env` is the SAME baseline bundle.js ships as the server's
  // runtime env, and client-baked values must agree with the server's.
  // (vibecarbon.com 2026-08-22: an .env.local migrated from another project
  // baked a foreign client key while the server ran this project's .env.)
  // .env.local still fills keys .env lacks, preserving the 2026-05-19 fix.
  const localPath = join(cwd, '.env.local');
  if (existsSync(localPath)) {
    const parsed = parseDotenv(readFileSync(localPath, 'utf-8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (k.startsWith('VITE_')) args[k] = v;
    }
  }
  const envPath = join(cwd, '.env');
  if (existsSync(envPath)) {
    const parsed = parseDotenv(readFileSync(envPath, 'utf-8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (k.startsWith('VITE_') && v && v.trim() !== '') args[k] = v;
    }
  }
  // Prod rewrites — these must match what bundle.js writes into the
  // server's runtime .env so the client + server agree on the URL.
  if (projectName) args.VITE_PROJECT_NAME = projectName;
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
