/**
 * Authenticated Performance Tests
 *
 * Requires PERF_BASE_URL + PERF_AUTH_COOKIE.
 * Each test skips independently if its session cookie is absent.
 *
 * Usage:
 *   PERF_BASE_URL=http://localhost:3000 PERF_AUTH_COOKIE='better-auth.session_token=...' pnpm test:loadtest
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { isReachable, runScenario, type ScenarioResult, saveResults } from './runner';

const BASE_URL = process.env.PERF_BASE_URL ?? '';
const AUTH_COOKIE = process.env.PERF_AUTH_COOKIE ?? '';
const DURATION = Number(process.env.PERF_DURATION ?? testConfig.perf.defaults.duration);
const CONNECTIONS = Number(process.env.PERF_CONNECTIONS ?? testConfig.perf.defaults.connections);
const LABEL = process.env.PERF_LABEL ?? testConfig.perf.defaults.label;

const results: Record<string, ScenarioResult> = {};
let baseSkip = false;

beforeAll(async () => {
  if (!BASE_URL) {
    baseSkip = true;
    return;
  }
  const reachable = await isReachable(BASE_URL);
  if (!reachable) {
    baseSkip = true;
  }
}, testConfig.perf.reachabilityTimeoutMs);

afterAll(() => {
  if (baseSkip || Object.keys(results).length === 0) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filepath = saveResults(results, {
    timestamp,
    label: `${LABEL}-authenticated`,
    baseUrl: BASE_URL,
    duration: DURATION,
    connections: CONNECTIONS,
    nodeVersion: process.version,
  });
  console.log(`\nResults saved to: ${filepath}`);
});

describe('Authenticated endpoints', () => {
  it('GET /api/v1/me — session lookup + DB query', async () => {
    if (baseSkip || !AUTH_COOKIE) return;

    const result = await runScenario(BASE_URL, {
      title: 'GET /api/v1/me',
      path: '/api/v1/me',
      headers: { Cookie: AUTH_COOKIE },
      duration: DURATION,
      connections: CONNECTIONS,
      thresholds: testConfig.perf.thresholds.authenticated,
    });

    results['GET /api/v1/me'] = result;

    if (result.thresholdViolations.length > 0) {
      console.warn('Threshold violations:', result.thresholdViolations);
    }

    expect(result.passed, result.thresholdViolations.join(', ')).toBe(true);
  });

  it('GET /api/v1/organizations — RLS list query', async () => {
    if (baseSkip || !AUTH_COOKIE) return;

    const result = await runScenario(BASE_URL, {
      title: 'GET /api/v1/organizations',
      path: '/api/v1/organizations',
      headers: { Cookie: AUTH_COOKIE },
      duration: DURATION,
      connections: CONNECTIONS,
      thresholds: testConfig.perf.thresholds.authenticated,
    });

    results['GET /api/v1/organizations'] = result;

    if (result.thresholdViolations.length > 0) {
      console.warn('Threshold violations:', result.thresholdViolations);
    }

    expect(result.passed, result.thresholdViolations.join(', ')).toBe(true);
  });
});
