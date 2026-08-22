/**
 * Admin Performance Tests
 *
 * Requires PERF_BASE_URL + PERF_ADMIN_TOKEN.
 *
 * Usage:
 *   PERF_BASE_URL=http://localhost:8000 PERF_ADMIN_TOKEN=eyJ... pnpm test:loadtest
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { isReachable, runScenario, type ScenarioResult, saveResults } from './runner';

const BASE_URL = process.env.PERF_BASE_URL ?? '';
const ADMIN_TOKEN = process.env.PERF_ADMIN_TOKEN ?? '';
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
    label: `${LABEL}-admin`,
    baseUrl: BASE_URL,
    duration: DURATION,
    connections: CONNECTIONS,
    nodeVersion: process.version,
  });
  console.log(`\nResults saved to: ${filepath}`);
});

describe('Admin endpoints', () => {
  it('GET /api/v1/admin/stats — parallel listUsers calls', async () => {
    if (baseSkip || !ADMIN_TOKEN) return;

    const result = await runScenario(BASE_URL, {
      title: 'GET /api/v1/admin/stats',
      path: '/api/v1/admin/stats',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      duration: DURATION,
      connections: CONNECTIONS,
      thresholds: testConfig.perf.thresholds.admin,
    });

    results['GET /api/v1/admin/stats'] = result;

    if (result.thresholdViolations.length > 0) {
      console.warn('Threshold violations:', result.thresholdViolations);
    }

    expect(result.passed, result.thresholdViolations.join(', ')).toBe(true);
  });

  it('GET /api/v1/admin/performance — 6 internal service probes', async () => {
    if (baseSkip || !ADMIN_TOKEN) return;

    const result = await runScenario(BASE_URL, {
      title: 'GET /api/v1/admin/performance',
      path: '/api/v1/admin/performance',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      duration: DURATION,
      connections: CONNECTIONS,
      thresholds: testConfig.perf.thresholds.admin,
    });

    results['GET /api/v1/admin/performance'] = result;

    if (result.thresholdViolations.length > 0) {
      console.warn('Threshold violations:', result.thresholdViolations);
    }

    expect(result.passed, result.thresholdViolations.join(', ')).toBe(true);
  });
});
