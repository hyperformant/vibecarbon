/**
 * Infrastructure health verification checks for e2e tests.
 *
 * Verifies that deployed infrastructure is healthy after deploy, scale,
 * restore, and failover steps by probing key service endpoints.
 */

import dns from 'node:dns';
import https from 'node:https';
import type { HealthLatencies, VerificationResult } from '../scenarios/types.js';
import { pinnedIpFor } from '../utils/dns-pin.js';

// Use Cloudflare + Google DNS to bypass stale negative cache entries from prior test runs.
// The system resolver caches NXDOMAIN responses for domains that were destroyed
// and recreated between test scenarios, causing health checks to fail indefinitely.
const resolver = new dns.promises.Resolver();
resolver.setServers(['1.1.1.1', '8.8.8.8']);

/**
 * Resolve a domain using our custom resolver (bypasses system DNS cache).
 * NEVER pinned — this is the real, published-record answer.
 *
 * 0.0.0.0 is treated as "not resolved yet" — it's the sentinel the deploy
 * orchestrator plants during DNS warmup (so Cloudflare/Hetzner edges cache
 * the zone before the real IP is known). One of our two upstream resolvers
 * (1.1.1.1, 8.8.8.8) sometimes still serves the cached 0.0.0.0 even after
 * the post-deploy update lands and the other resolver has refreshed —
 * dnsSafeFetch then connects to 0.0.0.0:443 and ECONNREFUSEs. Filtering it
 * out forces callers to retry until both resolvers agree on a real IP.
 * Observed run #7 compose db_insert (PR 1Y).
 */
export async function resolvePublicIp(domain: string): Promise<string | null> {
  try {
    const addresses = await resolver.resolve4(domain);
    const real = addresses.find((ip) => ip && ip !== '0.0.0.0');
    return real ?? null;
  } catch {
    return null;
  }
}

/**
 * The address a VERIFICATION CHECK should dial for `domain`.
 *
 * This is the single resolution seam every HTTP check in the e2e harness goes
 * through (dnsSafeFetch, waitForHealthy, checkSslValid, and the realtime
 * pre-resolve in checks/app-functional.ts). Under an active resolution pin
 * (tests/e2e/utils/dns-pin.ts — entered only for verify-failover on compose-ha)
 * it returns the pinned IP so the checks reach the PROMOTED node regardless of
 * where the operator's resolver chain is in the A-record's TTL. Callers keep
 * sending the domain as `Host` and TLS `servername`, so certificate validity
 * and name-based routing are still fully exercised.
 *
 * Outside a pin it is exactly `resolvePublicIp` — the customer cold path.
 *
 * `fallback` is injectable so the unpinned branch is unit-testable without
 * touching the network.
 */
export async function resolveCheckIp(
  domain: string,
  fallback: (domain: string) => Promise<string | null> = resolvePublicIp,
): Promise<string | null> {
  const pinned = pinnedIpFor(domain);
  if (pinned) return pinned;
  return fallback(domain);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an AbortSignal that fires after `ms` milliseconds. */
function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * DNS-cache-bypassing fetch. Resolves the domain via Cloudflare/Google DNS
 * and connects directly to the IP with the correct Host header and TLS SNI.
 * Falls back to standard fetch if custom resolution fails.
 */
/**
 * Wait (bounded) for `domain` to resolve to `expectedIp` on the pinned public
 * resolvers (1.1.1.1/8.8.8.8) — the same resolvers every check's dnsSafeFetch
 * uses. verify-failover calls this before its check battery: after a fast
 * failover the A-record flip may not have propagated yet, and the checks
 * would otherwise hit the OLD scaled-down primary (Kong 502 upstream /
 * "missing" tables — overnight 2026-07-09 run 2; masked before by the buggy
 * 4m48s readiness-gate stall). Best-effort: returns false on timeout so the
 * caller can proceed and let the checks fail loudly with fresh context.
 *
 * DELIBERATELY UNPINNED. Its default resolver is `resolvePublicIp`, never
 * `resolveCheckIp` — under a verify-failover resolution pin the latter would
 * hand back the pinned IP and this gate would return true instantly without
 * having observed a single real DNS answer. Its whole job is to watch the
 * PUBLISHED record move; a pin-aware version of it would be a false green.
 * (Whether the flip published at all is asserted separately and
 * authoritatively by `dns_failover_flip` — tests/e2e/checks/dns-flip.ts.)
 */
export async function waitForDnsToPoint(
  domain: string,
  expectedIp: string,
  opts: {
    budgetMs?: number;
    intervalMs?: number;
    resolve?: (domain: string) => Promise<string | null>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const {
    budgetMs = 300_000,
    intervalMs = 5_000,
    resolve = resolvePublicIp,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const ip = await resolve(domain);
    if (ip === expectedIp) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * Injectable transport seam for {@link dnsSafeFetch}. Production leaves both
 * undefined; the unit tier supplies stubs so the pin's effect on the wire-level
 * request (dial address vs. Host/SNI) is assertable without a network or a
 * `node:https` module mock.
 */
export interface DnsSafeFetchDeps {
  resolveIp?: (domain: string) => Promise<string | null>;
  httpsRequest?: typeof https.request;
}

export async function dnsSafeFetch(
  url: string,
  init?: RequestInit,
  deps: DnsSafeFetchDeps = {},
): Promise<Response> {
  const resolveIp = deps.resolveIp ?? resolveCheckIp;
  const httpsRequest = deps.httpsRequest ?? https.request;
  const parsed = new URL(url);
  const domain = parsed.hostname;
  // Retry resolveCheckIp — one of our two pinned upstreams (1.1.1.1, 8.8.8.8)
  // sometimes still serves the cached 0.0.0.0 warmup record after the
  // post-deploy update has landed. resolvePublicIp filters 0.0.0.0 to null, so
  // retrying tends to land on the resolver that has the fresh record.
  // Without this, db_insert / etc. immediately ECONNREFUSE to 0.0.0.0:443
  // (PR 1Y). And on a freshly-created Hetzner DNS record both upstreams
  // can take >10s to publish — observed compose-only fanout5b 2026-05-01:
  // verify-deploy failed in 113s with "fetch failed" while a manual run
  // 35 min later resolved on attempt 0. Bumped from 5×2s=10s to 10×3s=30s.
  let ip: string | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    ip = await resolveIp(domain);
    if (ip) break;
    await new Promise((r) => setTimeout(r, 3_000));
  }

  if (ip && parsed.protocol === 'https:') {
    // Use undici/fetch with custom lookup to bypass system DNS cache.
    // Node.js fetch doesn't support `servername`, so we use https.request.
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      const req = httpsRequest(
        {
          // The DIAL address — the pinned IP under a verify-failover pin, the
          // publicly-resolved one otherwise. `Host` and `servername` below stay
          // on the domain either way, so the server must still route by name
          // and present a certificate valid for the domain, never for the IP.
          hostname: ip,
          port: Number(parsed.port) || 443,
          path: parsed.pathname + parsed.search,
          method: (init?.method ?? 'GET').toUpperCase(),
          headers: {
            Host: domain,
            ...(init?.headers instanceof Headers
              ? Object.fromEntries(init.headers.entries())
              : (init?.headers as Record<string, string>)),
          },
          servername: domain,
          // RESIDUAL per-call TLS-off — deliberately NOT flipped when the
          // runner's process-wide NODE_TLS_REJECT_UNAUTHORIZED was replaced by
          // explicit Let's Encrypt staging-root trust (tests/e2e/utils/
          // e2e-env.js). This is the transport for every functional check, and
          // those run in a window where cert-manager/Traefik may still be
          // serving the default self-signed cert while the ACME order settles
          // — verifying here would turn "app is up, cert pending" into a hard
          // failure of the app checks. Certificate correctness is asserted by
          // checkSslValid() below, which is the check that owns that concern.
          // Flipping this to `true` needs a live rig to validate the issuance
          // timing against; do not change it blind.
          rejectUnauthorized: false,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          clearTimeout(timer);
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            resolve(
              new Response(body, {
                status: res.statusCode ?? 500,
                statusText: res.statusMessage ?? '',
                headers: res.headers as Record<string, string>,
              }),
            );
          });
        },
      );

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      if (init?.body) {
        req.write(typeof init.body === 'string' ? init.body : JSON.stringify(init.body));
      }
      req.end();
    });
  }

  // No IP after retries: throw (don't silently fall back to system fetch,
  // which would use system DNS and quietly mask the propagation failure
  // as a generic "fetch failed"). The outer per-check retry loop will
  // re-enter dnsSafeFetch with a fresh resolveCheckIp attempt budget.
  if (!ip && parsed.protocol === 'https:') {
    throw new Error(`DNS resolution failed for ${domain} after retries`);
  }

  // HTTP (not HTTPS) — fall back to standard fetch.
  return fetch(url, { ...init, signal: timeoutSignal(REQUEST_TIMEOUT_MS) });
}

export interface ServingGateResult {
  ok: boolean;
  attempts: number;
  elapsedMs: number;
  lastStatus: number | null;
  lastError: string | null;
}

/**
 * Wait (bounded) for the app root to actually SERVE — HTTP 200 with a
 * non-empty body. verify-scale calls this before its frontend render check:
 * a k8s master resize reboots the k3s control plane and restarts every pod
 * (traefik included), so "Pods Ready" can land ~40–60s before the ingress
 * path reliably serves again (CI run 29180322032: the render check's single
 * navigation hit that window, and its 30s DOM poll can't recover from a
 * failed navigation — while diagnostics seconds later saw HTTP/2 200).
 * Compose scale benefits too: it blue-green-replaces the VPS, so the domain
 * points at a freshly-booted stack. Best-effort: returns ok:false on timeout
 * so the caller proceeds and lets the render check fail loudly with fresh
 * context. Cannot mask a genuinely blank SPA — that still serves 200 + HTML
 * instantly and the render assertion still runs.
 */
export async function waitForAppServing(
  domain: string,
  opts: {
    budgetMs?: number;
    intervalMs?: number;
    fetchImpl?: (url: string) => Promise<{ status: number; text: () => Promise<string> }>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<ServingGateResult> {
  const {
    budgetMs = 120_000,
    intervalMs = 3_000,
    fetchImpl = (url: string) => dnsSafeFetch(url),
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  const start = Date.now();
  const deadline = start + budgetMs;
  let attempts = 0;
  let lastStatus: number | null = null;
  let lastError: string | null = null;
  for (;;) {
    attempts++;
    try {
      const res = await fetchImpl(`https://${domain}/`);
      lastStatus = res.status;
      lastError = null;
      if (res.status === 200) {
        const body = await res.text();
        if (body.trim().length > 0) {
          return { ok: true, attempts, elapsedMs: Date.now() - start, lastStatus, lastError };
        }
        lastError = 'HTTP 200 with empty body';
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) {
      return { ok: false, attempts, elapsedMs: Date.now() - start, lastStatus, lastError };
    }
    await sleep(intervalMs);
  }
}

/** High-resolution elapsed time in milliseconds since `start`. */
function elapsedMs(start: [number, number]): number {
  const [s, ns] = process.hrtime(start);
  return Math.round(s * 1_000 + ns / 1_000_000);
}

/** Calculate a percentile from a sorted array of numbers. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

const REQUEST_TIMEOUT_MS = 10_000;

// Adaptive backoff between health-check retries: fast on the happy path
// (most failures recover within a couple of seconds once DNS/Kong propagate)
// while still tolerating ~35s of cold-start latency. Was 8 fixed retries ×
// 10s = 80s — over-budget for the typical sub-second recovery.
//
// Was bumped up to recover from a 113s flake (compose fanout5b 2026-05-01,
// e1 verify-deploy: "fetch failed" with curl --resolve working seconds
// later). The total budget here still allows >35s of recovery and the
// underlying DNS stale-cache issue is independently addressed by resolvePublicIp's
// 0.0.0.0 filter.
const HEALTH_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 10_000, 10_000];

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkApiHealth(domain: string): Promise<VerificationResult> {
  const url = `https://${domain}/api/health`;
  const start = process.hrtime();

  // waitForHealthy succeeded but DNS can lapse between then and the detail
  // checks (1.1.1.1 / 8.8.8.8 sometimes refresh out of sync for a freshly
  // created Hetzner DNS record); without retry, dnsSafeFetch falls through to
  // standard fetch which uses system DNS and immediately ENOTFOUNDs. Adaptive
  // backoff (HEALTH_RETRY_DELAYS_MS) keeps the happy path fast while
  // tolerating cold-start propagation.
  const MAX_RETRIES = HEALTH_RETRY_DELAYS_MS.length;
  let lastErr: Error | null = null;
  let lastStatus = 0;
  let lastBody = '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await dnsSafeFetch(url);
      const responseTimeMs = elapsedMs(start);
      const body = await res.text().catch(() => '');

      if (res.status === 200) {
        return {
          checkName: 'api_health',
          status: 'pass',
          responseTimeMs,
          details: { httpStatus: res.status, body: body.slice(0, 256), attempt },
        };
      }
      lastStatus = res.status;
      lastBody = body;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, HEALTH_RETRY_DELAYS_MS[attempt]));
    }
  }

  return {
    checkName: 'api_health',
    status: 'fail',
    responseTimeMs: elapsedMs(start),
    errorMessage: lastErr
      ? `${lastErr.message}${(lastErr as Error & { cause?: unknown }).cause ? ` (cause: ${String((lastErr as Error & { cause?: unknown }).cause)})` : ''}`
      : `Expected HTTP 200, got ${lastStatus} after ${MAX_RETRIES + 1} attempts`,
    details: {
      httpStatus: lastStatus,
      body: lastBody.slice(0, 256),
      attempts: MAX_RETRIES + 1,
      lastErrorName: lastErr?.name,
    },
  };
}

async function checkAuthHealth(domain: string, anonKey?: string): Promise<VerificationResult> {
  const url = `https://${domain}/auth/v1/health`;
  const start = process.hrtime();

  // GoTrue (via Kong) may still be starting when the app health check passes.
  // Adaptive backoff (HEALTH_RETRY_DELAYS_MS): fast on the happy path, ~35s
  // total budget for K8s cold-start tail.
  const MAX_RETRIES = HEALTH_RETRY_DELAYS_MS.length;

  // Pass the anon key — Supabase Helm chart's Kong declarative config has a
  // key-auth plugin on the `/auth/v1/*` consumer. Without apikey, Kong
  // returns 401 before GoTrue is even reached, so the check fails even
  // when auth is fully healthy.
  const headers: Record<string, string> = {};
  if (anonKey) {
    headers.apikey = anonKey;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await dnsSafeFetch(url, { headers });
      const responseTimeMs = elapsedMs(start);
      const body = await res.text().catch(() => '');
      const contentType = res.headers.get('content-type') ?? '';

      // An HTML 200 is the app's SPA fallback answering — the apex /auth/v1
      // route to Kong is missing/misprioritized. Never count that as healthy.
      if (res.status === 200 && contentType.includes('text/html')) {
        if (attempt === MAX_RETRIES) {
          return {
            checkName: 'auth_health',
            status: 'fail',
            responseTimeMs,
            errorMessage:
              'Got 200 text/html (SPA fallback) — /auth/v1 is not routed to Kong on the apex',
            details: { httpStatus: res.status, contentType, attempts: attempt + 1 },
          };
        }
      } else if (res.status === 200) {
        return {
          checkName: 'auth_health',
          status: 'pass',
          responseTimeMs,
          details: { httpStatus: res.status, body: body.slice(0, 256), attempt },
        };
      }

      // Non-200 on last attempt → fail
      if (attempt === MAX_RETRIES) {
        return {
          checkName: 'auth_health',
          status: 'fail',
          responseTimeMs,
          errorMessage: `Expected HTTP 200 from GoTrue, got ${res.status}`,
          details: { httpStatus: res.status, body: body.slice(0, 256), attempts: attempt + 1 },
        };
      }
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        return {
          checkName: 'auth_health',
          status: 'fail',
          responseTimeMs: elapsedMs(start),
          errorMessage: err instanceof Error ? err.message : String(err),
          details: { attempts: attempt + 1 },
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_DELAYS_MS[attempt]));
  }

  // Unreachable, but TypeScript needs it
  return {
    checkName: 'auth_health',
    status: 'fail',
    responseTimeMs: elapsedMs(start),
    errorMessage: 'Exhausted retries',
  };
}

/**
 * The SPA owns /auth/callback (OAuth landing page) — routing must send it to
 * the app, NOT to Kong. Only the VERSIONED /auth/v1 prefix belongs to Kong;
 * a bare /auth prefix rule swallows this page (Kong 404s it, breaking every
 * OAuth login). Regression probe for the routing-priority contract.
 */
async function checkSpaAuthCallback(domain: string): Promise<VerificationResult> {
  const url = `https://${domain}/auth/callback`;
  const start = process.hrtime();
  const MAX_RETRIES = HEALTH_RETRY_DELAYS_MS.length;
  let lastErr: string | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await dnsSafeFetch(url);
      const responseTimeMs = elapsedMs(start);
      const contentType = res.headers.get('content-type') ?? '';
      const body = await res.text().catch(() => '');

      if (res.status === 200 && contentType.includes('text/html')) {
        return {
          checkName: 'spa_auth_callback',
          status: 'pass',
          responseTimeMs,
          details: { httpStatus: res.status, contentType, attempt },
        };
      }
      lastErr = `Expected 200 text/html (SPA), got ${res.status} ${contentType} — /auth/callback is being swallowed by Kong`;
      if (attempt === MAX_RETRIES) {
        return {
          checkName: 'spa_auth_callback',
          status: 'fail',
          responseTimeMs,
          errorMessage: lastErr,
          details: {
            httpStatus: res.status,
            contentType,
            body: body.slice(0, 256),
            attempts: attempt + 1,
          },
        };
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_RETRIES) {
        return {
          checkName: 'spa_auth_callback',
          status: 'fail',
          responseTimeMs: elapsedMs(start),
          errorMessage: lastErr,
          details: { attempts: attempt + 1 },
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_DELAYS_MS[attempt]));
  }

  return {
    checkName: 'spa_auth_callback',
    status: 'fail',
    responseTimeMs: elapsedMs(start),
    errorMessage: lastErr ?? 'Exhausted retries',
  };
}

async function checkRestApi(domain: string, anonKey?: string): Promise<VerificationResult> {
  const url = `https://${domain}/rest/v1/`;
  const start = process.hrtime();

  const headers: Record<string, string> = {};
  if (anonKey) {
    headers.apikey = anonKey;
  }

  // Retry on the same DNS/cold-start race as api_health (Kong can come up
  // after the app router on the shared apex). Adaptive backoff
  // (HEALTH_RETRY_DELAYS_MS) — fast happy path, ~35s total.
  const MAX_RETRIES = HEALTH_RETRY_DELAYS_MS.length;
  let lastErr: Error | null = null;
  let lastStatus = 0;
  let lastBody = '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await dnsSafeFetch(url, { headers });
      const responseTimeMs = elapsedMs(start);
      const body = await res.text().catch(() => '');

      // PostgREST returns 200 (with apikey) or 401 (missing apikey).
      // Either confirms the endpoint is reachable and PostgREST is running.
      if (res.status === 200 || res.status === 401) {
        return {
          checkName: 'rest_api',
          status: 'pass',
          responseTimeMs,
          details: { httpStatus: res.status, body: body.slice(0, 256), attempt },
        };
      }
      lastStatus = res.status;
      lastBody = body;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, HEALTH_RETRY_DELAYS_MS[attempt]));
    }
  }

  return {
    checkName: 'rest_api',
    status: 'fail',
    responseTimeMs: elapsedMs(start),
    errorMessage: lastErr
      ? `${lastErr.message}${(lastErr as Error & { cause?: unknown }).cause ? ` (cause: ${String((lastErr as Error & { cause?: unknown }).cause)})` : ''}`
      : `Expected HTTP 200 or 401, got ${lastStatus} after ${MAX_RETRIES + 1} attempts`,
    details: {
      httpStatus: lastStatus,
      body: lastBody.slice(0, 256),
      attempts: MAX_RETRIES + 1,
      lastErrorName: lastErr?.name,
    },
  };
}

// Internal sentinel union for checkSslValid: 'retry' means "cert error on the
// TRUSTED attempt" — it never leaves the function (the loop maps it to a real
// pass/fail before returning). Exported shape only via the deps seam.
type SslAttemptResult = Omit<VerificationResult, 'status'> & {
  status: VerificationResult['status'] | 'retry';
};

export async function checkSslValid(
  domain: string,
  deps: {
    attemptFn?: (rejectUnauthorized: boolean) => Promise<SslAttemptResult>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<VerificationResult> {
  const start = process.hrtime();

  // Resolve IP via custom DNS (like other checks) to bypass stale system DNS cache.
  const ip = await resolveCheckIp(domain);

  // First try with full CA validation. Since the harness trusts the Let's
  // Encrypt STAGING roots explicitly (tests/e2e/utils/e2e-env.js), the
  // trusted attempt covers BOTH production and staging chains.
  //
  // AN UNTRUSTED CERT IS A FAILURE (d4 runs 5 and 7, 2026-08-28): with
  // staging trusted, the only things that reach the untrusted path are the
  // Traefik default cert and the pilot-standby's self-signed cert — and the
  // old pass-with-a-note branch let verify-failover GRADE GREEN twice while
  // the promoted cluster served exactly those. The insecure attempt below
  // survives only as DIAGNOSTICS (it reads the served cert's identity for
  // the failure message); it can never produce a pass. Budget calibration
  // (the reason this stayed tolerant until now) came from run 11b: with the
  // single-ACME-issuer promote in place, the post-failover issuance lands
  // inside ~2 minutes; 180s of trusted retries clears it with margin while
  // staying well inside the verify step's 600s budget.
  const attempt = (rejectUnauthorized: boolean) =>
    new Promise<SslAttemptResult>((resolve) => {
      const req = https.request(
        {
          hostname: ip || domain,
          port: 443,
          path: '/',
          method: 'HEAD',
          timeout: REQUEST_TIMEOUT_MS,
          rejectUnauthorized,
          ...(ip && { servername: domain, headers: { Host: domain } }),
        },
        (res) => {
          const responseTimeMs = elapsedMs(start);
          const socket = res.socket as import('node:tls').TLSSocket;
          const cert = socket.getPeerCertificate?.();
          const validTo = cert?.valid_to;
          const issuer = cert?.issuer?.O ?? 'unknown';

          res.resume();

          resolve({
            checkName: 'ssl_valid',
            status: 'pass',
            responseTimeMs,
            details: {
              validTo: validTo ?? 'unknown',
              subject: cert?.subject?.CN ?? 'unknown',
              issuer,
              staging: !rejectUnauthorized,
            },
          });
        },
      );

      req.on('timeout', () => {
        req.destroy();
        resolve({
          checkName: 'ssl_valid',
          status: 'fail',
          responseTimeMs: elapsedMs(start),
          errorMessage: `SSL connection timed out after ${REQUEST_TIMEOUT_MS}ms`,
        });
      });

      req.on('error', (err) => {
        resolve({
          checkName: 'ssl_valid',
          status: rejectUnauthorized ? 'retry' : 'fail',
          responseTimeMs: elapsedMs(start),
          errorMessage: `SSL validation failed: ${err.message}`,
        });
      });

      req.end();
    });

  // 12 x 15s = 180s of TRUSTED retries — covers the post-failover ACME
  // issuance window (run 11b: ~2 min) with margin, inside the verify step's
  // 600s budget. There is no untrusted pass path.
  const MAX_SSL_RETRIES = 12;
  const SSL_RETRY_DELAY_MS = 15_000;
  const attemptFn = deps.attemptFn ?? attempt;
  const sleepFn = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastServed: SslAttemptResult['details'] | undefined;
  for (let retryNum = 0; retryNum <= MAX_SSL_RETRIES; retryNum++) {
    const result = await attemptFn(true);
    if (result.status === 'pass') return { ...result, status: 'pass' };

    if (result.status === 'retry') {
      // DIAGNOSTICS ONLY: read what the endpoint is actually serving so the
      // failure names the cert (TRAEFIK DEFAULT CERT / the standby
      // self-signed) instead of a bare handshake error. Never a pass.
      const served = await attemptFn(false);
      if (served.status === 'pass') lastServed = served.details;
    }

    if (retryNum < MAX_SSL_RETRIES) {
      await sleepFn(SSL_RETRY_DELAY_MS);
    } else {
      if (result.status === 'retry') {
        return {
          checkName: 'ssl_valid',
          status: 'fail',
          responseTimeMs: result.responseTimeMs,
          errorMessage:
            `certificate not trusted after ${Math.round((MAX_SSL_RETRIES * SSL_RETRY_DELAY_MS) / 1000)}s ` +
            `of trusted retries (staging roots ARE in the trust store, so this is a real ` +
            `defect — Traefik default or standby self-signed cert). ` +
            `Served: subject=${lastServed?.subject ?? 'unknown'} issuer=${lastServed?.issuer ?? 'unknown'}. ` +
            `Underlying: ${result.errorMessage ?? 'unknown'}`,
          details: lastServed,
        };
      }
      return { ...result, status: result.status };
    }
  }

  // Unreachable, but TypeScript needs it
  return {
    checkName: 'ssl_valid',
    status: 'fail',
    responseTimeMs: elapsedMs(start),
    errorMessage: 'Exhausted SSL retries',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all infrastructure health checks against a deployed environment.
 * Returns an array of individual check results.
 *
 * All checks are fault-tolerant -- they catch errors and return a fail status
 * rather than throwing.
 */
export async function runHealthChecks(
  domain: string,
  anonKey?: string,
): Promise<VerificationResult[]> {
  // Run checks concurrently -- they are independent of each other.
  const results = await Promise.all([
    checkApiHealth(domain),
    checkAuthHealth(domain, anonKey),
    checkRestApi(domain, anonKey),
    checkSpaAuthCallback(domain),
    checkSslValid(domain),
  ]);

  return results;
}

/**
 * Measure health endpoint latencies by making N rapid sequential requests.
 * Returns p50, p95, p99 latencies.
 */
export async function measureHealthLatencies(
  domain: string,
  endpoint: string = '/api/health',
  samples: number = 10,
): Promise<HealthLatencies> {
  const latencies: number[] = [];
  const url = `https://${domain}${endpoint}`;

  for (let i = 0; i < samples; i++) {
    const start = process.hrtime();
    try {
      const res = await dnsSafeFetch(url);
      // Consume the body so the connection can be reused.
      await res.text().catch(() => '');
    } catch {
      // Count failed requests as the full timeout duration so they
      // surface clearly in percentile calculations.
    }
    latencies.push(elapsedMs(start));
  }

  const sorted = latencies.sort((a, b) => a - b);

  return {
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
  };
}

/**
 * Wait for a domain to become healthy (with retries).
 * Used after deploy/failover to wait for services to come up.
 *
 * Polls `GET https://{domain}/api/health` at the given interval
 * until an HTTP 200 is received or the timeout expires.
 *
 * Returns `true` if the service became healthy, `false` on timeout.
 */
export async function waitForHealthy(
  domain: string,
  timeoutMs: number = 300_000,
  intervalMs: number = 10_000,
  path: string = '/api/health',
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Adaptive interval: probe at 1s, 2s, 4s, 8s, then settle at intervalMs.
  // Most services come up within a few seconds of the first failed probe,
  // and the old fixed 10s sleep made waitForHealthy add up to 10s of pure
  // wall-clock per scenario beyond when the service was actually ready.
  // Worst-case timeout is unchanged — we never sleep longer than intervalMs.
  let attempt = 0;
  const sleepFor = () => {
    const ramped = Math.min(intervalMs, 1000 * 2 ** attempt);
    const remaining = deadline - Date.now();
    return Math.max(0, Math.min(ramped, remaining));
  };

  while (Date.now() < deadline) {
    try {
      // Resolve DNS via Cloudflare/Google instead of system resolver to bypass
      // stale negative cache entries from prior test runs that destroyed/recreated domains.
      const ip = await resolveCheckIp(domain);
      if (!ip) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, sleepFor()));
        attempt++;
        continue;
      }

      // Use https.get with explicit servername to bypass system DNS and handle
      // TLS SNI correctly when connecting directly to the IP.
      const ok = await new Promise<boolean>((resolve) => {
        const req = https.get(
          {
            hostname: ip,
            port: 443,
            path,
            headers: { Host: domain },
            servername: domain,
            // Residual per-call TLS-off — same reasoning as dnsSafeFetch: this
            // gate deliberately runs while the cert may still be provisioning.
            rejectUnauthorized: false,
            timeout: REQUEST_TIMEOUT_MS,
          },
          (res) => {
            res.resume(); // drain body
            resolve(res.statusCode === 200);
          },
        );
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
        req.on('error', () => resolve(false));
      });

      if (ok) return true;
    } catch {
      // Service not yet reachable -- will retry.
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, sleepFor()));
    attempt++;
  }

  return false;
}
