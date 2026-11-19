/**
 * tests/_shared/e2e-db-seed.ts: the run and scenario rows the metrics tests
 * seed. What each seeder writes is pinned here by reading it back from a real
 * in-memory results database.
 */
import { describe, expect, it } from 'vitest';
import {
  CURATED_STEPS,
  createTestRun,
  seedCuratedScenario,
  seedRunAndScenario,
} from '../../_shared/e2e-db-seed.js';
import { E2EDb } from '../../e2e/metrics/db.js';

const details = (db: E2EDb, runId: string) => {
  const d = db.getRunDetails(runId);
  if (!d) throw new Error(`no run ${runId}`);
  return d;
};

describe('createTestRun', () => {
  it('writes a run on main at 0.0.0, with sha deadbee unless given one', () => {
    const db = new E2EDb(':memory:');
    const a = details(db, createTestRun(db)).run;
    expect(a).toMatchObject({
      git_sha: 'deadbee',
      git_branch: 'main',
      vibecarbon_version: '0.0.0',
    });
    expect(details(db, createTestRun(db, '403149a')).run.git_sha).toBe('403149a');
    expect(createTestRun(db)).not.toBe(createTestRun(db));
  });
});

describe('seedCuratedScenario', () => {
  it('writes the six curated steps, each passing in 60 s, under a passing scenario', () => {
    const db = new E2EDb(':memory:');
    const runId = createTestRun(db);
    seedCuratedScenario(db, runId, 'digitalocean', 'k8s');
    const { scenarios, steps } = details(db, runId);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]).toMatchObject({
      mode: 'k8s',
      provider: 'digitalocean',
      dns_provider: 'manual',
      domain: 'k8s.example.test',
      features: '[]',
      project_name: 'digitalocean-k8s',
      env_prefix: 'e1',
      status: 'pass',
    });
    expect(steps.map((s) => s.name)).toEqual([...CURATED_STEPS]);
    expect(steps.every((s) => s.status === 'pass' && s.duration_ms === 60_000)).toBe(true);
    expect(steps.every((s) => s.command === s.name)).toBe(true);
  });

  it('takes a status and duration per step, leaves out missing steps, and records features', () => {
    const db = new E2EDb(':memory:');
    const runId = createTestRun(db);
    seedCuratedScenario(db, runId, 'hetzner', 'compose', {
      status: 'fail',
      stepStatus: { backup: 'fail' },
      stepDurationMs: { deploy: 90_000 },
      missingSteps: new Set(['scale']),
      features: ['observability'],
    });
    const { scenarios, steps } = details(db, runId);
    expect(scenarios[0]).toMatchObject({ status: 'fail', features: '["observability"]' });
    const byName = new Map(steps.map((s) => [s.name, s]));
    expect(byName.has('scale')).toBe(false);
    expect(byName.get('backup')?.status).toBe('fail');
    expect(byName.get('deploy')?.duration_ms).toBe(90_000);
    expect(byName.get('restore')).toMatchObject({ status: 'pass', duration_ms: 60_000 });
  });
});

describe('seedRunAndScenario', () => {
  it('writes a run with sha `sha` and one stepless scenario of the project, env and mode', () => {
    const db = new E2EDb(':memory:');
    const { runId, scenarioId } = seedRunAndScenario(db, 'proj-a', 'e2', 'k8s-ha');
    const { run, scenarios, steps } = details(db, runId);
    expect(run.git_sha).toBe('sha');
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]).toMatchObject({
      id: scenarioId,
      mode: 'k8s-ha',
      project_name: 'proj-a',
      env_prefix: 'e2',
      dns_provider: 'manual',
      domain: 'example.test',
      features: '[]',
      provider: 'hetzner',
    });
    expect(steps).toEqual([]);
  });

  it('is compose unless told otherwise', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seedRunAndScenario(db, 'proj', 'e1');
    expect(details(db, runId).scenarios[0].mode).toBe('compose');
  });
});
