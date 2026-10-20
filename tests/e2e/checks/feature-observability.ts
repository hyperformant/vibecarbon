/**
 * Observability feature verification checks (Grafana, Prometheus).
 *
 * Grafana sits behind the super-admin ForwardAuth middleware in every mode:
 *   - k8s:     https://{domain}/admin/grafana   (IngressRoute PathPrefix
 *              `/admin/grafana` + `admin-auth`, services/observability/k8s/
 *              ingressroute.yaml; Grafana serves the sub-path itself)
 *   - compose: https://grafana.{domain}          (router `Host(grafana.${DOMAIN})`
 *              + `super-admin-auth@file`, services/observability/compose/
 *              docker-compose.prod.yml)
 * Prometheus has no public route in either mode; it is reached only through
 * Grafana's datasource proxy (datasource uid `prometheus`, provisioned in
 * volumes/grafana/provisioning/datasources/datasources.yml and the k8s
 * grafana-provisioning ConfigMap).
 *
 * RCA 2026-10-19 (tests/results/e2e.db): the old checks never reached Grafana.
 * k8s probed `/grafana/api/health` (wrong prefix) and passed on the app's SPA
 * catch-all page (`200` + HTML, "HTML response (auth page)"); compose passed on
 * the ForwardAuth 401 ("behind auth middleware (expected)"). Every historical
 * pass was hollow. These checks act as the super admin instead: the admin
 * session from auth_admin_login mints the `vc-admin-token` ForwardAuth cookie
 * (POST /api/v1/admin/forwardauth-cookie, carbon/AGENTS.md "Session Cookies &
 * ForwardAuth"), and only Grafana's own JSON counts:
 *   - grafana_route_protected: no cookie gets 401/403 or a redirect to the
 *     app's /login. Never the app's 404, never 200 content.
 *   - grafana_health:     the cookie gets 200 `{"database":"ok"}`.
 *   - prometheus_targets: the cookie gets Prometheus' targets JSON with at
 *     least one active target `up`.
 *
 * All checks are fault-tolerant and never throw.
 */

import { performance } from 'node:perf_hooks';
import type { VerificationResult } from '../scenarios/types.js';
import { apiHeaders, CookieJar } from './app-functional.js';
import { dnsSafeFetch } from './health.js';

const FETCH_TIMEOUT_MS = 10_000;

/** The ForwardAuth cookie verify-role accepts (carbon/src/server/routes/v1/forwardauth-cookie.ts). */
export const FORWARDAUTH_COOKIE = 'vc-admin-token';

/** The provisioned Prometheus datasource uid. */
export const PROMETHEUS_DATASOURCE_UID = 'prometheus';

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ObservabilityCheckOptions {
  /** The app's apex domain (where the cookie is minted). */
  appDomain: string;
  isCompose: boolean;
  /**
   * The signed-in super-admin session from auth_admin_login. Absent when that
   * check skipped (no credentials) or failed; both are already reported there.
   */
  adminJar?: CookieJar;
  /** Why there is no admin session, for the skip reason. */
  adminUnavailableReason?: string;
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts for the authenticated reads (Grafana/Prometheus warming up). */
  attempts?: number;
  retryDelayMs?: number;
}

/** Grafana's public base URL for a deploy mode (see the module doc). */
export function grafanaBaseUrl(appDomain: string, isCompose: boolean): string {
  return isCompose ? `https://grafana.${appDomain}` : `https://${appDomain}/admin/grafana`;
}

/**
 * Run observability feature checks (Grafana, Prometheus).
 */
export async function runObservabilityChecks(
  opts: ObservabilityCheckOptions,
): Promise<VerificationResult[]> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const base = grafanaBaseUrl(opts.appDomain, opts.isCompose);
  const results: VerificationResult[] = [];

  results.push(await checkGrafanaRouteProtected(base, opts.appDomain, fetcher));

  if (!opts.adminJar) {
    const reason =
      opts.adminUnavailableReason ??
      'no signed-in super-admin session (auth_admin_login did not pass)';
    results.push(skip('grafana_health', reason), skip('prometheus_targets', reason));
    return results;
  }

  const minted = await mintForwardAuthCookie(opts.appDomain, opts.adminJar, fetcher);
  if (!minted.cookie) {
    results.push(
      fail('grafana_health', performance.now(), minted.error),
      fail('prometheus_targets', performance.now(), minted.error),
    );
    return results;
  }

  const retry = {
    attempts: opts.attempts ?? 4,
    delayMs: opts.retryDelayMs ?? 5_000,
    sleep: opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  results.push(await checkGrafanaHealth(base, minted.cookie, fetcher, retry));
  results.push(await checkPrometheusTargets(base, minted.cookie, fetcher, retry));
  return results;
}

// ---------------------------------------------------------------------------
// The ForwardAuth cookie
// ---------------------------------------------------------------------------

/**
 * Mint the `vc-admin-token` cookie from the super-admin session, as the SPA
 * does on load. 204 + Set-Cookie on success. 403 means not a super admin, or
 * MFA is globally on and the session is aal1 (requireAal2): the harness signs
 * in with a password only, so that case is reported, never worked around.
 */
export async function mintForwardAuthCookie(
  appDomain: string,
  adminJar: CookieJar,
  fetcher: Fetcher,
): Promise<{ cookie?: string; error: string }> {
  try {
    const res = await fetcher(`https://${appDomain}/api/v1/admin/forwardauth-cookie`, {
      method: 'POST',
      headers: apiHeaders(appDomain, adminJar),
    });
    const minted = new CookieJar();
    minted.absorb(res);
    const cookie = minted.get(FORWARDAUTH_COOKIE);
    if (res.status === 204 && cookie) return { cookie, error: '' };
    const body = await res.text().catch(() => '');
    const hint =
      res.status === 403
        ? ' (403: the session is not a super admin, or MFA is globally on and a password-only session is aal1)'
        : '';
    return {
      error:
        res.status === 204
          ? `POST /api/v1/admin/forwardauth-cookie answered 204 without a ${FORWARDAUTH_COOKIE} cookie`
          : `POST /api/v1/admin/forwardauth-cookie returned ${res.status}${hint}: ${body.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      error: `Could not mint the ForwardAuth cookie: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * Without the cookie the route must exist and refuse: ForwardAuth answers 401
 * (or 403), or redirects a browser to the app's /login. The app's 404 means
 * nothing routes the path to Grafana; a 200 means Grafana (or something
 * else) serves it unauthenticated.
 */
export async function checkGrafanaRouteProtected(
  base: string,
  appDomain: string,
  fetcher: Fetcher,
): Promise<VerificationResult> {
  const checkName = 'grafana_route_protected';
  const start = performance.now();
  try {
    const res = await fetcher(`${base}/api/health`, { signal: timeoutSignal() });
    const location = res.headers.get('location') ?? '';
    if (res.status === 401 || res.status === 403) {
      return pass(checkName, start, { statusCode: res.status });
    }
    if (res.status >= 300 && res.status < 400 && isAppLoginRedirect(location, appDomain)) {
      return pass(checkName, start, { statusCode: res.status, location });
    }
    const body = await res.text().catch(() => '');
    return fail(
      checkName,
      start,
      res.status === 404
        ? `${base}/api/health returned 404 without a cookie: nothing routes it to Grafana`
        : res.status === 200
          ? `${base}/api/health served 200 without a cookie: the route is not behind ForwardAuth`
          : `${base}/api/health returned ${res.status} without a cookie (expected 401/403 or a redirect to /login)`,
      { statusCode: res.status, location, body: body.slice(0, 200) },
    );
  } catch (err) {
    return fail(checkName, start, err instanceof Error ? err.message : String(err));
  }
}

/** A redirect to the app's sign-in page, as verify-role sends a browser. */
function isAppLoginRedirect(location: string, appDomain: string): boolean {
  try {
    const url = new URL(location, `https://${appDomain}`);
    return url.hostname === appDomain && url.pathname === '/login';
  } catch {
    return false;
  }
}

interface RetryPolicy {
  attempts: number;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * One authenticated read. Flat (not a discriminated union): the e2e tsconfig
 * does not narrow on a boolean discriminant.
 */
interface AuthedRead {
  ok: boolean;
  /** Why the content is not valid ('' when ok). */
  error: string;
  status?: number;
  body?: string;
  attempts?: number;
}

/**
 * GET with the ForwardAuth cookie, retried while the answer is not yet
 * valid; `validate` returns null for real content or the reason it is not.
 */
async function authedRead(
  url: string,
  cookie: string,
  fetcher: Fetcher,
  retry: RetryPolicy,
  validate: (status: number, contentType: string, body: string) => string | null,
): Promise<AuthedRead> {
  let last: AuthedRead = { ok: false, error: 'no attempt made' };
  for (let attempt = 1; attempt <= retry.attempts; attempt++) {
    try {
      const res = await fetcher(url, {
        headers: { Cookie: `${FORWARDAUTH_COOKIE}=${cookie}`, Accept: 'application/json' },
        signal: timeoutSignal(),
      });
      const body = await res.text().catch(() => '');
      const why = validate(res.status, res.headers.get('content-type') ?? '', body);
      if (why === null) return { ok: true, error: '', body, attempts: attempt };
      last = { ok: false, error: why, status: res.status, body: body.slice(0, 200) };
      // An auth refusal will not heal by waiting: the cookie is fresh.
      if (res.status === 401 || res.status === 403) break;
    } catch (err) {
      last = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (attempt < retry.attempts) await retry.sleep(retry.delayMs);
  }
  return last;
}

function parseJson(contentType: string, body: string): unknown {
  if (contentType.includes('text/html')) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Null when the response is Grafana's own healthy `/api/health`, else why not. */
export function grafanaHealthError(
  status: number,
  contentType: string,
  body: string,
): string | null {
  if (status !== 200) return `status=${status}`;
  const json = parseJson(contentType, body) as { database?: unknown } | undefined;
  if (json === undefined)
    return `200 but not JSON (${contentType || 'no content type'}): not Grafana`;
  if (json?.database !== 'ok') return `database=${String(json?.database ?? 'missing')}`;
  return null;
}

/**
 * Verify Grafana is running and its database connection is healthy:
 * GET {base}/api/health with the cookie -> 200 `{"database":"ok"}`.
 */
export async function checkGrafanaHealth(
  base: string,
  cookie: string,
  fetcher: Fetcher,
  retry: RetryPolicy,
): Promise<VerificationResult> {
  const start = performance.now();
  const url = `${base}/api/health`;
  const read = await authedRead(url, cookie, fetcher, retry, grafanaHealthError);
  if (read.ok) {
    return pass('grafana_health', start, { url, database: 'ok', attempts: read.attempts });
  }
  return fail('grafana_health', start, `${url} as super admin: ${read.error}`, {
    url,
    statusCode: read.status,
    body: read.body,
  });
}

interface PrometheusTarget {
  health?: unknown;
  labels?: { job?: unknown };
  scrapePool?: unknown;
}

/** Null when the body is Prometheus' targets JSON with an `up` target, else why not. */
export function prometheusTargetsError(
  status: number,
  contentType: string,
  body: string,
): string | null {
  if (status !== 200) return `status=${status}`;
  const json = parseJson(contentType, body) as
    | { status?: unknown; data?: { activeTargets?: unknown } }
    | undefined;
  if (json === undefined)
    return `200 but not JSON (${contentType || 'no content type'}): not Prometheus`;
  if (json?.status !== 'success' || !Array.isArray(json.data?.activeTargets)) {
    return 'not a Prometheus targets response (no status:"success" with data.activeTargets[])';
  }
  const targets = json.data.activeTargets as PrometheusTarget[];
  if (targets.length === 0) return 'Prometheus has no active targets';
  if (!targets.some((t) => t?.health === 'up')) {
    return `no active target is up (${targets.map((t) => `${String(t?.scrapePool ?? t?.labels?.job ?? '?')}=${String(t?.health)}`).join(', ')})`;
  }
  return null;
}

/**
 * Verify Prometheus is scraping, through Grafana's datasource proxy (the only
 * route to it): GET {base}/api/datasources/proxy/uid/prometheus/api/v1/targets
 * with the cookie -> Prometheus' targets JSON, at least one active target up.
 */
export async function checkPrometheusTargets(
  base: string,
  cookie: string,
  fetcher: Fetcher,
  retry: RetryPolicy,
): Promise<VerificationResult> {
  const start = performance.now();
  const url = `${base}/api/datasources/proxy/uid/${PROMETHEUS_DATASOURCE_UID}/api/v1/targets`;
  const read = await authedRead(url, cookie, fetcher, retry, prometheusTargetsError);
  if (read.ok) {
    const targets = (JSON.parse(read.body) as { data: { activeTargets: PrometheusTarget[] } }).data
      .activeTargets;
    return pass('prometheus_targets', start, {
      url,
      activeTargets: targets.length,
      up: targets.filter((t) => t.health === 'up').length,
      attempts: read.attempts,
    });
  }
  return fail('prometheus_targets', start, `${url} as super admin: ${read.error}`, {
    url,
    statusCode: read.status,
    body: read.body,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultFetcher(url: string, init?: RequestInit): Promise<Response> {
  return dnsSafeFetch(url, init);
}

function timeoutSignal(): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS).unref?.();
  return controller.signal;
}

function pass(
  checkName: string,
  start: number,
  details: Record<string, unknown>,
): VerificationResult {
  return {
    checkName,
    status: 'pass',
    responseTimeMs: Math.round(performance.now() - start),
    details,
  };
}

function fail(
  checkName: string,
  start: number,
  errorMessage: string,
  details?: Record<string, unknown>,
): VerificationResult {
  return {
    checkName,
    status: 'fail',
    responseTimeMs: Math.round(performance.now() - start),
    errorMessage,
    ...(details && { details }),
  };
}

function skip(checkName: string, reason: string): VerificationResult {
  return { checkName, status: 'skip', details: { skipped: true, reason } };
}
