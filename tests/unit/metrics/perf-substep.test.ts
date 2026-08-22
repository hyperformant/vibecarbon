/**
 * Unit tests for E2EDb perf_substep persistence.
 *
 * The lifecycle records a batch of [perf] sub-stage timings per CLI
 * invocation; reports later pull the last N PASS-status durations for a
 * named substep to compute a regression baseline.
 *
 * In-memory SQLite (`:memory:`) keeps each test isolated from on-disk
 * e2e.db state and sibling unit tests.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { E2EDb } from '../../e2e/metrics/db.js';

function seedRunAndScenario(db: E2EDb, projectName: string, envPrefix: string) {
  const runId = randomUUID();
  db.createRun({
    id: runId,
    gitSha: 'sha',
    gitBranch: 'main',
    vibecarbonVersion: '0.0.0',
    machineInfo: {},
  });
  const scenarioId = randomUUID();
  db.createScenario({
    id: scenarioId,
    runId,
    mode: 'compose',
    dnsProvider: 'manual',
    domain: 'example.test',
    features: [],
    projectName,
    envPrefix,
  });
  return { runId, scenarioId };
}

function passStep(db: E2EDb, scenarioId: string, name = 'deploy'): string {
  const stepId = randomUUID();
  db.createStep({ id: stepId, scenarioId, name, command: name });
  db.startStep(stepId);
  db.completeStep(stepId, 'pass', 1000);
  return stepId;
}

describe('E2EDb perf substeps', () => {
  it('persists a batch of [perf] timings for a step', () => {
    const db = new E2EDb(':memory:');
    const { scenarioId } = seedRunAndScenario(db, 'proj-a', 'e1');
    const stepId = passStep(db, scenarioId);

    db.recordPerfSubsteps(stepId, [
      { name: 'setupServer', ms: 12_345 },
      { name: 'pullComposeImages', ms: 67_890, note: 'cold' },
      { name: 'composeUp', ms: 4_500 },
    ]);

    const rows = db.getPerfSubstepsByStep(stepId);
    // slowest first
    expect(rows.map((r) => r.name)).toEqual(['pullComposeImages', 'setupServer', 'composeUp']);
    expect(rows[0].duration_ms).toBe(67_890);
    expect(rows[0].note).toBe('cold');
    expect(rows[2].note).toBeNull();
  });

  it('is a no-op for an empty batch', () => {
    const db = new E2EDb(':memory:');
    const { scenarioId } = seedRunAndScenario(db, 'proj-b', 'e1');
    const stepId = passStep(db, scenarioId);

    db.recordPerfSubsteps(stepId, []);
    expect(db.getPerfSubstepsByStep(stepId)).toEqual([]);
  });

  it('returns baseline durations only from PASS-status steps', () => {
    const db = new E2EDb(':memory:');
    const { scenarioId } = seedRunAndScenario(db, 'proj-c', 'e1');

    // Two PASS steps with the same substep
    const passId1 = passStep(db, scenarioId);
    db.recordPerfSubsteps(passId1, [{ name: 'setupServer', ms: 10_000 }]);
    const passId2 = passStep(db, scenarioId);
    db.recordPerfSubsteps(passId2, [{ name: 'setupServer', ms: 12_000 }]);

    // A FAIL step with the same substep — must NOT enter the baseline
    const failId = randomUUID();
    db.createStep({ id: failId, scenarioId, name: 'deploy', command: 'deploy' });
    db.startStep(failId);
    db.completeStep(failId, 'fail', 99_999);
    db.recordPerfSubsteps(failId, [{ name: 'setupServer', ms: 99_000 }]);

    const baseline = db.getPerfSubstepBaseline('setupServer', 10);
    expect(baseline.sort()).toEqual([10_000, 12_000]);
  });

  it('respects the limit and returns most-recent first', () => {
    const db = new E2EDb(':memory:');
    const { scenarioId } = seedRunAndScenario(db, 'proj-d', 'e1');

    for (let i = 1; i <= 5; i++) {
      const stepId = passStep(db, scenarioId);
      db.recordPerfSubsteps(stepId, [{ name: 'composeUp', ms: i * 1000 }]);
    }

    const limited = db.getPerfSubstepBaseline('composeUp', 3);
    // Most recent 3 = ms values 5000, 4000, 3000 (id DESC)
    expect(limited).toEqual([5000, 4000, 3000]);
  });

  it('returns [] for a substep name with no green history', () => {
    const db = new E2EDb(':memory:');
    expect(db.getPerfSubstepBaseline('neverSeen', 10)).toEqual([]);
  });
});
