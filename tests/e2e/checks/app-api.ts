/**
 * Application API-layer verification checks.
 *
 * These exercise the app's OWN Hono routes under `/api/v1/*` on the main
 * domain — the layer the rest of the e2e suite never touched. Everything else
 * hits Supabase services directly (Kong: /auth/v1, /rest/v1, /storage/v1,
 * /realtime/v1), so a broken app backend (missing schema, dead route, bad DB
 * wiring) could 500 while every platform check stayed green.
 *
 * RCA prod-1 2026-05-26: /api/v1/notifications 500'd (PGRST205, empty schema)
 * and nothing in e2e noticed because nothing called the app's API layer.
 *
 * All checks are fault-tolerant — they never throw.
 */

import type { VerificationResult } from '../scenarios/types.js';
import { dnsSafeFetch } from './health.js';

const TIMEOUT_MS = 10_000;

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/**
 * Check a single app API route returns 200 and (optionally) a body that passes
 * a shape predicate. Retries briefly — the app container may still be warming
 * up right after deploy even once Traefik routes traffic to it.
 */
async function checkRoute(
  checkName: string,
  url: string,
  validate: (body: unknown) => string | null,
): Promise<VerificationResult> {
  const start = Date.now();
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 5_000;
  let lastError = '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await dnsSafeFetch(url, { signal: timeoutSignal(TIMEOUT_MS) });
      if (res.status !== 200) {
        const text = await res.text();
        lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        // 502/503/404 can be transient while the app boots behind Traefik.
        if ([404, 502, 503].includes(res.status) && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        return {
          checkName,
          status: 'fail',
          responseTimeMs: Date.now() - start,
          errorMessage: lastError,
          details: { url, statusCode: res.status },
        };
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        return {
          checkName,
          status: 'fail',
          responseTimeMs: Date.now() - start,
          errorMessage: `200 but invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
          details: { url },
        };
      }

      const shapeError = validate(body);
      if (shapeError) {
        return {
          checkName,
          status: 'fail',
          responseTimeMs: Date.now() - start,
          errorMessage: `200 but unexpected shape: ${shapeError}`,
          details: { url, body },
        };
      }

      return {
        checkName,
        status: 'pass',
        responseTimeMs: Date.now() - start,
        details: { url, attempt },
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  return {
    checkName,
    status: 'fail',
    responseTimeMs: Date.now() - start,
    errorMessage: lastError || 'Exhausted retries',
    details: { url },
  };
}

/**
 * Run app API-layer checks against the main domain (where the app's Hono
 * server serves /api/v1/*, distinct from the /auth/v1|/rest/v1|... paths
 * Traefik routes to Kong on the same apex).
 */
export async function runAppApiChecks(domain: string): Promise<VerificationResult[]> {
  const base = `https://${domain}/api/v1`;

  return Promise.all([
    // Public notifications feed — unauthenticated, served via the admin DB
    // client. This is the exact route that 500'd on prod-1. Expect a
    // { notifications: [...] } envelope.
    checkRoute('app_api_notifications', `${base}/notifications`, (body) => {
      const b = body as { notifications?: unknown };
      if (!b || typeof b !== 'object') return 'not an object';
      if (!Array.isArray(b.notifications)) return 'missing notifications[] array';
      return null;
    }),
    // Auth settings — public config the login UI reads on first paint.
    // Exercises the app layer's read of app_settings/auth config.
    checkRoute('app_api_auth_settings', `${base}/auth/settings`, (body) => {
      const b = body as { settings?: unknown };
      if (!b || typeof b !== 'object') return 'not an object';
      if (!b.settings || typeof b.settings !== 'object') return 'missing settings object';
      return null;
    }),
  ]);
}
