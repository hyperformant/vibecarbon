/**
 * Unit tests for the perf anomaly guard (`detectPerfAnomalies`) — the
 * gatekeeper that decides whether a green-but-slow run may update the
 * checked-in performance data file.
 *
 * The renderers/patchers that used to live alongside it (per-provider
 * README blocks, inline markers) were replaced by the unified data layer —
 * see tests/e2e/metrics/perf-data.ts and its perf-data.test.ts.
 *
 * All run against in-memory SQLite (`:memory:`) — no fs mocks (repo
 * convention).
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { E2EDb } from '../../e2e/metrics/db.js';
import { detectPerfAnomalies } from '../../e2e/metrics/reporter.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const CURATED_STEPS = ['deploy', 'warm-deploy', 'backup', 'restore', 'scale', 'destroy'] as const;

function createTestRun(db: E2EDb): string {
  const runId = randomUUID();
  db.createRun({
    id: runId,
    gitSha: 'deadbee',
    gitBranch: 'main',
    vibecarbonVersion: '0.0.0',
    machineInfo: {},
  });
  return runId;
}

/**
 * Seed one scenario (provider/mode) with the six curated steps. Each step
 * defaults to 'pass' at 60s; pass overrides to flip individual steps to a
 * different status/duration or omit them entirely.
 */
function seedScenario(
  db: E2EDb,
  runId: string,
  provider: string,
  mode: string,
  opts: {
    status?: string;
    stepDurationMs?: Partial<Record<string, number>>;
    stepStatus?: Partial<Record<string, string>>;
    missingSteps?: Set<string>;
  } = {},
): void {
  const scenarioId = randomUUID();
  db.createScenario({
    id: scenarioId,
    runId,
    mode,
    dnsProvider: 'manual',
    domain: `${mode}.example.test`,
    features: [],
    projectName: `${provider}-${mode}`,
    envPrefix: 'e1',
    provider,
  });

  for (const step of CURATED_STEPS) {
    if (opts.missingSteps?.has(step)) continue;
    const stepId = randomUUID();
    db.createStep({ id: stepId, scenarioId, name: step, command: step });
    db.startStep(stepId);
    const status = opts.stepStatus?.[step] ?? 'pass';
    const duration = opts.stepDurationMs?.[step] ?? 60_000;
    db.completeStep(stepId, status, duration);
  }

  db.updateScenarioStatus(scenarioId, opts.status ?? 'pass');
}

// ---------------------------------------------------------------------------
// detectPerfAnomalies — scoped per provider
// ---------------------------------------------------------------------------

describe('detectPerfAnomalies (per-provider baseline)', () => {
  // Seed `n` historical green runs at a flat baseline for one (provider,
  // mode), then a current run with the given override, returning the
  // current run's id.
  function seedProviderHistoryThenCurrent(
    db: E2EDb,
    provider: string,
    mode: string,
    n: number,
    baselineMs: number,
    currentMs: number,
  ): string {
    for (let i = 0; i < n; i++) {
      const runId = createTestRun(db);
      seedScenario(db, runId, provider, mode, { stepDurationMs: { deploy: baselineMs } });
      db.completeRun(runId, 'pass');
    }
    const runId = createTestRun(db);
    seedScenario(db, runId, provider, mode, { stepDurationMs: { deploy: currentMs } });
    db.completeRun(runId, 'pass');
    return runId;
  }

  it("flags a cell that is much slower than its OWN provider's recent green median", () => {
    const db = new E2EDb(':memory:');
    const runId = seedProviderHistoryThenCurrent(db, 'hetzner', 'k8s', 3, 60_000, 90_000);
    const anomalies = detectPerfAnomalies(db, runId);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      provider: 'hetzner',
      mode: 'k8s',
      step: 'deploy',
      sampleCount: 3,
    });
    expect(anomalies[0].ratio).toBeCloseTo(1.5, 5);
    db.close();
  });

  it("does NOT use another provider's history as the baseline, even for the same mode", () => {
    const db = new E2EDb(':memory:');
    // Hetzner k8s history: 60s baseline.
    for (let i = 0; i < 3; i++) {
      const runId = createTestRun(db);
      seedScenario(db, runId, 'hetzner', 'k8s', { stepDurationMs: { deploy: 60_000 } });
      db.completeRun(runId, 'pass');
    }
    // DigitalOcean k8s history: legitimately much slower baseline (200s).
    for (let i = 0; i < 3; i++) {
      const runId = createTestRun(db);
      seedScenario(db, runId, 'digitalocean', 'k8s', { stepDurationMs: { deploy: 200_000 } });
      db.completeRun(runId, 'pass');
    }
    // Current run: DO k8s at 210s — within ITS OWN baseline (not an
    // anomaly); Hetzner k8s at 90s — 1.5x ITS OWN baseline (an anomaly).
    const runId = createTestRun(db);
    seedScenario(db, runId, 'hetzner', 'k8s', { stepDurationMs: { deploy: 90_000 } });
    seedScenario(db, runId, 'digitalocean', 'k8s', { stepDurationMs: { deploy: 210_000 } });
    db.completeRun(runId, 'pass');

    const anomalies = detectPerfAnomalies(db, runId);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ provider: 'hetzner', mode: 'k8s', step: 'deploy' });
    db.close();
  });

  it('does NOT flag a cell within the threshold (1.2× < 1.3×)', () => {
    const db = new E2EDb(':memory:');
    const runId = seedProviderHistoryThenCurrent(db, 'hetzner', 'k8s', 3, 60_000, 72_000);
    expect(detectPerfAnomalies(db, runId)).toEqual([]);
    db.close();
  });

  it('allows the update when there is no comparable history (< MIN_SAMPLES)', () => {
    const db = new E2EDb(':memory:');
    const runId = seedProviderHistoryThenCurrent(db, 'digitalocean', 'compose', 0, 60_000, 600_000);
    expect(detectPerfAnomalies(db, runId)).toEqual([]);
    db.close();
  });

  it('returns [] for an unknown run id', () => {
    const db = new E2EDb(':memory:');
    expect(detectPerfAnomalies(db, 'no-such-run')).toEqual([]);
    db.close();
  });
});
