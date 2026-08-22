/**
 * Performance Test Runner
 *
 * Core wrapper for all performance test scenarios using autocannon.
 *
 * IMPORTANT: The app enforces 100 req/min per IP on `/api/v1/*` and `/api/health`.
 * At 10 connections × ~50ms avg latency ≈ 2000 req/10s, tests will trigger 429s.
 * Set `RATE_LIMIT_MAX=10000` on the target deployment to avoid 429s, or reduce
 * `PERF_CONNECTIONS` to 1–2 for rate-limited environments.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import autocannon from 'autocannon';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ScenarioOptions {
  title: string;
  path: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Duration in seconds */
  duration: number;
  /** Concurrent connections */
  connections: number;
  thresholds?: {
    p95LatencyMs?: number;
    maxErrorRate?: number;
  };
}

export interface ScenarioResult {
  latency: {
    p50: number;
    p75: number;
    p95: number;
    p99: number;
    mean: number;
    max: number;
  };
  rps: number;
  throughputMbps: number;
  totalRequests: number;
  errors: number;
  errorRate: number;
  duration: number;
  passed: boolean;
  thresholdViolations: string[];
}

export interface PerfRunMeta {
  timestamp: string;
  label: string;
  baseUrl: string;
  duration: number;
  connections: number;
  nodeVersion: string;
}

export interface PerfRunFile {
  meta: PerfRunMeta;
  results: Record<string, ScenarioResult>;
}

/**
 * Run a single autocannon scenario and return a normalised result.
 */
export async function runScenario(baseUrl: string, opts: ScenarioOptions): Promise<ScenarioResult> {
  const result = await autocannon({
    url: `${baseUrl}${opts.path}`,
    method: opts.method ?? 'GET',
    headers: opts.headers,
    duration: opts.duration,
    connections: opts.connections,
    pipelining: 1,
    timeout: 10,
    workers: 1,
  });

  const totalRequests = result.requests.total;
  const errors = result.errors + result.timeouts + (result.non2xx ?? 0);
  const errorRate = totalRequests > 0 ? errors / totalRequests : 0;

  // autocannon names the ~p95 bucket p97_5; fall back to p99
  const p95 = (result.latency as Record<string, number>).p97_5 ?? result.latency.p99 ?? 0;

  const throughputMbps = result.throughput.mean / 1024 / 1024;

  const thresholdViolations: string[] = [];
  if (opts.thresholds?.p95LatencyMs !== undefined && p95 > opts.thresholds.p95LatencyMs) {
    thresholdViolations.push(
      `p95 latency ${p95}ms exceeds threshold ${opts.thresholds.p95LatencyMs}ms`,
    );
  }
  if (opts.thresholds?.maxErrorRate !== undefined && errorRate > opts.thresholds.maxErrorRate) {
    thresholdViolations.push(
      `error rate ${(errorRate * 100).toFixed(2)}% exceeds threshold ${(opts.thresholds.maxErrorRate * 100).toFixed(2)}%`,
    );
  }

  return {
    latency: {
      p50: result.latency.p50 ?? 0,
      p75: result.latency.p75 ?? 0,
      p95,
      p99: result.latency.p99 ?? 0,
      mean: result.latency.mean ?? 0,
      max: result.latency.max ?? 0,
    },
    rps: result.requests.mean,
    throughputMbps,
    totalRequests,
    errors,
    errorRate,
    duration: opts.duration,
    passed: thresholdViolations.length === 0,
    thresholdViolations,
  };
}

/**
 * Write results to `tests/loadtest/results/{timestamp}-{label}.json`.
 * Creates the directory if it does not exist.
 * Returns the full path of the written file.
 */
export function saveResults(results: Record<string, ScenarioResult>, meta: PerfRunMeta): string {
  const dir = join(__dirname, 'results');
  mkdirSync(dir, { recursive: true });

  const filename = `${meta.timestamp}-${meta.label}.json`;
  const filepath = join(dir, filename);

  const payload: PerfRunFile = { meta, results };
  const stream = createWriteStream(filepath);
  stream.write(JSON.stringify(payload, null, 2));
  stream.end();

  return filepath;
}

/**
 * Fire one GET /api/health request with a 3 s timeout.
 * Returns false on any network error or 5xx response.
 */
export async function isReachable(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(id);
    return res.status < 500;
  } catch {
    return false;
  }
}
