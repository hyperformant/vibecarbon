/**
 * Public Performance Tests
 *
 * No authentication required.
 * Skips automatically if PERF_BASE_URL is unset or the target is unreachable.
 *
 * Usage:
 *   PERF_BASE_URL=http://localhost:8000 pnpm test:loadtest
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { isReachable, runScenario, type ScenarioResult, saveResults } from './runner';

const BASE_URL = process.env.PERF_BASE_URL ?? '';
const DURATION = Number(process.env.PERF_DURATION ?? testConfig.perf.defaults.duration);
const CONNECTIONS = Number(process.env.PERF_CONNECTIONS ?? testConfig.perf.defaults.connections);
const LABEL = process.env.PERF_LABEL ?? testConfig.perf.defaults.label;

const results: Record<string, ScenarioResult> = {};
let skip = false;

beforeAll(async () => {
  if (!BASE_URL) {
    skip = true;
    return;
  }
  const reachable = await isReachable(BASE_URL);
  if (!reachable) {
    skip = true;
  }
}, testConfig.perf.reachabilityTimeoutMs);

afterAll(() => {
  if (skip || Object.keys(results).length === 0) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filepath = saveResults(results, {
    timestamp,
    label: `${LABEL}-public`,
    baseUrl: BASE_URL,
    duration: DURATION,
    connections: CONNECTIONS,
    nodeVersion: process.version,
  });
  console.log(`\nResults saved to: ${filepath}`);
});

describe('Public endpoints', () => {
  it('GET /api/health — liveness probe', async () => {
    if (skip) return;

    const result = await runScenario(BASE_URL, {
      title: 'GET /api/health',
      path: '/api/health',
      duration: DURATION,
      connections: CONNECTIONS,
      thresholds: testConfig.perf.thresholds.healthLiveness,
    });

    results['GET /api/health'] = result;

    if (result.thresholdViolations.length > 0) {
      console.warn('Threshold violations:', result.thresholdViolations);
    }

    expect(result.passed, result.thresholdViolations.join(', ')).toBe(true);
  });

  it('GET /api/health/ready — readiness probe (DB query)', async () => {
    if (skip) return;

    const result = await runScenario(BASE_URL, {
      title: 'GET /api/health/ready',
      path: '/api/health/ready',
      duration: DURATION,
      connections: CONNECTIONS,
      thresholds: testConfig.perf.thresholds.healthReady,
    });

    results['GET /api/health/ready'] = result;

    if (result.thresholdViolations.length > 0) {
      console.warn('Threshold violations:', result.thresholdViolations);
    }

    expect(result.passed, result.thresholdViolations.join(', ')).toBe(true);
  });
});
