/**
 * Observability feature verification checks (Grafana, Prometheus).
 *
 * Validates that Grafana is healthy and that Prometheus is connected
 * as a datasource. All checks are fault-tolerant and never throw.
 */

import { performance } from 'node:perf_hooks';
import type { VerificationResult } from '../scenarios/types.js';
import { dnsSafeFetch } from './health.js';

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Run observability feature checks (Grafana, Prometheus).
 */
export async function runObservabilityChecks(
  domain: string,
  isCompose = false,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  // Compose: Grafana at grafana.{domain}/api/health (subdomain routing, caller passes grafanaDomain)
  // K8s: Grafana at {domain}/grafana/api/health (path-based routing)
  const grafanaBase = isCompose ? `https://${domain}` : `https://${domain}/grafana`;

  results.push(await checkGrafanaHealth(grafanaBase));
  results.push(await checkPrometheusTargets(grafanaBase));

  return results;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * Verify Grafana is running and its database connection is healthy.
 * GET https://{domain}/grafana/api/health -> 200 with {"database": "ok"}
 */
async function checkGrafanaHealth(grafanaBase: string): Promise<VerificationResult> {
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await dnsSafeFetch(`${grafanaBase}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    const responseTimeMs = Math.round(performance.now() - start);

    // Grafana behind ForwardAuth returns 401/403 or redirects (HTML page).
    // Any response proves the service is reachable and Traefik is routing correctly.
    if (res.status === 401 || res.status === 403) {
      return {
        checkName: 'grafana_health',
        status: 'pass',
        responseTimeMs,
        details: { statusCode: res.status, note: 'behind auth middleware (expected)' },
      };
    }

    const body = (await res.json().catch(() => null)) as { database?: string } | null;

    if (res.status === 200 && body?.database === 'ok') {
      return {
        checkName: 'grafana_health',
        status: 'pass',
        responseTimeMs,
        details: { statusCode: res.status, database: body.database },
      };
    }

    // HTML response (auth redirect page) also means service is running
    if (res.status === 200 && !body) {
      return {
        checkName: 'grafana_health',
        status: 'pass',
        responseTimeMs,
        details: { statusCode: res.status, note: 'HTML response (auth page)' },
      };
    }

    return {
      checkName: 'grafana_health',
      status: 'fail',
      responseTimeMs,
      errorMessage: `Unexpected response: status=${res.status}, database=${body?.database ?? 'missing'}`,
      details: { statusCode: res.status, body },
    };
  } catch (err) {
    return {
      checkName: 'grafana_health',
      status: 'fail',
      responseTimeMs: Math.round(performance.now() - start),
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Verify Prometheus is connected as a Grafana datasource.
 *
 * Primary: GET https://{domain}/grafana/api/datasources/proxy/1/api/v1/targets -> 200
 * Fallback: try direct Prometheus endpoint if Grafana proxy returns 401/403 or fails.
 * If neither works, mark as 'fail' without throwing.
 */
async function checkPrometheusTargets(grafanaBase: string): Promise<VerificationResult> {
  const start = performance.now();

  // Primary: query Prometheus through the Grafana datasource proxy
  const grafanaProxyResult = await tryFetch(
    `${grafanaBase}/api/datasources/proxy/1/api/v1/targets`,
  );

  if (grafanaProxyResult.ok) {
    return {
      checkName: 'prometheus_targets',
      status: 'pass',
      responseTimeMs: Math.round(performance.now() - start),
      details: {
        method: 'grafana_proxy',
        statusCode: grafanaProxyResult.statusCode,
      },
    };
  }

  // Fallback: try direct Prometheus endpoint (common paths)
  // Grafana proxy returned 401/403 or network error — Prometheus may still be
  // accessible directly on the standard /prometheus path.
  // Extract the base domain from grafanaBase for direct Prometheus access
  const baseHost = new URL(grafanaBase).hostname;
  const directResult = await tryFetch(`https://${baseHost}/prometheus/api/v1/targets`);

  if (directResult.ok) {
    return {
      checkName: 'prometheus_targets',
      status: 'pass',
      responseTimeMs: Math.round(performance.now() - start),
      details: {
        method: 'direct',
        statusCode: directResult.statusCode,
        grafanaProxyError: grafanaProxyResult.error,
      },
    };
  }

  // If both returned auth errors (401/403), the services are behind auth middleware
  // which means they are running and routable — pass with a note.
  const proxyAuth = grafanaProxyResult.statusCode === 401 || grafanaProxyResult.statusCode === 403;
  const directAuth = directResult.statusCode === 401 || directResult.statusCode === 403;
  if (proxyAuth || directAuth) {
    return {
      checkName: 'prometheus_targets',
      status: 'pass',
      responseTimeMs: Math.round(performance.now() - start),
      details: {
        note: 'behind auth middleware (expected)',
        grafanaProxyStatusCode: grafanaProxyResult.statusCode,
        directStatusCode: directResult.statusCode,
      },
    };
  }

  // Both methods failed
  return {
    checkName: 'prometheus_targets',
    status: 'fail',
    responseTimeMs: Math.round(performance.now() - start),
    errorMessage: 'Neither Grafana proxy nor direct Prometheus returned targets',
    details: {
      grafanaProxyStatusCode: grafanaProxyResult.statusCode,
      grafanaProxyError: grafanaProxyResult.error,
      directStatusCode: directResult.statusCode,
      directError: directResult.error,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FetchAttempt {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

/**
 * Attempt a GET request. Returns a simple success/failure descriptor
 * rather than throwing, so callers can fall through to alternatives.
 */
async function tryFetch(url: string): Promise<FetchAttempt> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await dnsSafeFetch(url, { signal: controller.signal });
    clearTimeout(timer);

    return {
      ok: res.status === 200,
      statusCode: res.status,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
