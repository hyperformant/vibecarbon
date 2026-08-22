/**
 * Unit tests for E2EDb.recordOrphansSwept.
 *
 * The post-destroy sweep persists per-category orphan counts to the
 * scenarios row so trend queries can spot destroy regressions across runs.
 * These tests lock the contract:
 *   - Total = sum of all categories.
 *   - Breakdown serializes to JSON exactly as input.
 *   - Subagent query `WHERE orphans_swept > 0` finds regression scenarios.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { E2EDb, type SweepBreakdown } from '../../e2e/metrics/db.js';

function seedScenario(db: E2EDb, mode = 'compose-ha'): string {
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
    projectName: 'proj',
    envPrefix: 'e1',
  });
  return scenarioId;
}

const ZERO: SweepBreakdown = {
  servers: 0,
  volumes: 0,
  placementGroups: 0,
  firewalls: 0,
  floatingIps: 0,
  networks: 0,
  s3Buckets: 0,
  sshKeys: 0,
};

describe('E2EDb.recordOrphansSwept', () => {
  it('persists zero counts when destroy worked cleanly', () => {
    const db = new E2EDb(':memory:');
    const scenarioId = seedScenario(db);
    db.recordOrphansSwept(scenarioId, ZERO);
    const row = (
      db as unknown as { db: { prepare: (s: string) => { get: (id: string) => unknown } } }
    ).db
      .prepare('SELECT orphans_swept, orphans_swept_breakdown FROM scenarios WHERE id = ?')
      .get(scenarioId) as { orphans_swept: number; orphans_swept_breakdown: string };
    expect(row.orphans_swept).toBe(0);
    expect(JSON.parse(row.orphans_swept_breakdown)).toEqual(ZERO);
    db.close();
  });

  it('sums all categories into the total', () => {
    const db = new E2EDb(':memory:');
    const scenarioId = seedScenario(db);
    const counts: SweepBreakdown = {
      servers: 1,
      volumes: 2,
      placementGroups: 3,
      firewalls: 27,
      floatingIps: 4,
      networks: 5,
      s3Buckets: 6,
      sshKeys: 7,
    };
    db.recordOrphansSwept(scenarioId, counts);
    const row = (
      db as unknown as { db: { prepare: (s: string) => { get: (id: string) => unknown } } }
    ).db
      .prepare('SELECT orphans_swept, orphans_swept_breakdown FROM scenarios WHERE id = ?')
      .get(scenarioId) as { orphans_swept: number; orphans_swept_breakdown: string };
    expect(row.orphans_swept).toBe(55);
    expect(JSON.parse(row.orphans_swept_breakdown)).toEqual(counts);
    db.close();
  });

  it('subagent query finds regression scenarios via WHERE orphans_swept > 0', () => {
    const db = new E2EDb(':memory:');
    const cleanId = seedScenario(db, 'compose');
    const dirtyId = seedScenario(db, 'compose-ha');
    db.recordOrphansSwept(cleanId, ZERO);
    db.recordOrphansSwept(dirtyId, { ...ZERO, firewalls: 27 });
    const rows = (db as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }).db
      .prepare('SELECT id, mode FROM scenarios WHERE orphans_swept > 0')
      .all() as { id: string; mode: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(dirtyId);
    expect(rows[0].mode).toBe('compose-ha');
    db.close();
  });

  it('idempotent — last write wins', () => {
    const db = new E2EDb(':memory:');
    const scenarioId = seedScenario(db);
    db.recordOrphansSwept(scenarioId, { ...ZERO, firewalls: 5 });
    db.recordOrphansSwept(scenarioId, { ...ZERO, firewalls: 10 });
    const row = (
      db as unknown as { db: { prepare: (s: string) => { get: (id: string) => unknown } } }
    ).db
      .prepare('SELECT orphans_swept FROM scenarios WHERE id = ?')
      .get(scenarioId) as { orphans_swept: number };
    expect(row.orphans_swept).toBe(10);
    db.close();
  });
});
