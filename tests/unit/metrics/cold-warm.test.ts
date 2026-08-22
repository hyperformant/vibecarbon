/**
 * Unit tests for the cold/warm deploy classifier in E2EDb.
 *
 * Cold = no prior PASS `deploy` step for the same (project_name, env_prefix)
 *        within the lookup window (default 24h).
 * Warm = prior PASS deploy exists in window.
 *
 * The DB is created against an in-memory SQLite (`:memory:`) so each test is
 * isolated from on-disk e2e.db state and from sibling unit tests.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { E2EDb } from '../../e2e/metrics/db.js';

function seedRunAndScenario(
  db: E2EDb,
  projectName: string,
  envPrefix: string,
  mode = 'compose',
): { runId: string; scenarioId: string } {
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
    mode,
    dnsProvider: 'manual',
    domain: 'example.test',
    features: [],
    projectName,
    envPrefix,
  });
  return { runId, scenarioId };
}

describe('E2EDb cold/warm classification', () => {
  it('tags first deploy as cold', () => {
    const db = new E2EDb(':memory:');
    const { scenarioId } = seedRunAndScenario(db, 'proj-a', 'e1');
    const stepId = randomUUID();
    db.createStep({ id: stepId, scenarioId, name: 'deploy', command: 'deploy e1' });
    const details = db.getRunDetails(db.getRecentRuns(1)[0].id);
    const step = details?.steps.find((s) => s.id === stepId);
    expect(step?.cold_warm).toBe('cold');
    db.close();
  });

  it('tags second deploy of same project/env as warm when prior pass exists', () => {
    const db = new E2EDb(':memory:');
    const { scenarioId: s1 } = seedRunAndScenario(db, 'proj-a', 'e1');
    // Prior deploy passes — manually start + complete it to populate finished_at.
    const id1 = randomUUID();
    db.createStep({ id: id1, scenarioId: s1, name: 'deploy', command: 'deploy e1' });
    db.startStep(id1);
    db.completeStep(id1, 'pass', 1234);

    const { runId: run2, scenarioId: s2 } = seedRunAndScenario(db, 'proj-a', 'e1');
    const id2 = randomUUID();
    db.createStep({ id: id2, scenarioId: s2, name: 'deploy', command: 'deploy e1' });
    expect(db.classifyColdWarm('proj-a', 'e1')).toBe('warm');

    // Look up via the explicit run id — `getRecentRuns` orders by started_at,
    // and two runs created within the same ms can return in either order.
    const details = db.getRunDetails(run2);
    const step = details?.steps.find((s) => s.id === id2);
    expect(step?.cold_warm).toBe('warm');
    db.close();
  });

  it('does NOT promote to warm when only a failed prior deploy exists', () => {
    const db = new E2EDb(':memory:');
    const { scenarioId: s1 } = seedRunAndScenario(db, 'proj-b', 'e2');
    const id1 = randomUUID();
    db.createStep({ id: id1, scenarioId: s1, name: 'deploy' });
    db.startStep(id1);
    db.completeStep(id1, 'fail', 100, 'kaboom');

    expect(db.classifyColdWarm('proj-b', 'e2')).toBe('cold');
    db.close();
  });

  it('isolates project/env tuples — warm in one does not bleed into another', () => {
    const db = new E2EDb(':memory:');
    const { scenarioId: s1 } = seedRunAndScenario(db, 'proj-a', 'e1');
    const id1 = randomUUID();
    db.createStep({ id: id1, scenarioId: s1, name: 'deploy' });
    db.startStep(id1);
    db.completeStep(id1, 'pass', 200);

    expect(db.classifyColdWarm('proj-a', 'e1')).toBe('warm');
    expect(db.classifyColdWarm('proj-a', 'e2')).toBe('cold');
    expect(db.classifyColdWarm('proj-b', 'e1')).toBe('cold');
    db.close();
  });

  it('honors a custom window — a 1ms window classifies a 100ms-old pass as cold', async () => {
    const db = new E2EDb(':memory:');
    const { scenarioId: s1 } = seedRunAndScenario(db, 'proj-c', 'e3');
    const id1 = randomUUID();
    db.createStep({ id: id1, scenarioId: s1, name: 'deploy' });
    db.startStep(id1);
    db.completeStep(id1, 'pass', 200);
    // Wait long enough that the recorded finished_at is outside a tiny window.
    await new Promise((r) => setTimeout(r, 50));
    expect(db.classifyColdWarm('proj-c', 'e3', 1)).toBe('cold');
    expect(db.classifyColdWarm('proj-c', 'e3', 24 * 60 * 60 * 1000)).toBe('warm');
    db.close();
  });

  it('respects an explicit coldWarm override on createStep', () => {
    const db = new E2EDb(':memory:');
    const { scenarioId } = seedRunAndScenario(db, 'proj-d', 'e4');
    const id = randomUUID();
    db.createStep({ id, scenarioId, name: 'deploy', coldWarm: 'warm' });
    const details = db.getRunDetails(db.getRecentRuns(1)[0].id);
    const step = details?.steps.find((s) => s.id === id);
    expect(step?.cold_warm).toBe('warm');
    db.close();
  });
});
