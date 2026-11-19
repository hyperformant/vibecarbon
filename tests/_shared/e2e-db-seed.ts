/**
 * Rows for an e2e results database (tests/e2e/metrics/db.ts), for the tests
 * of what reads it: the perf data and table, the publisher, the cold/warm
 * classifier, the substeps. Each of those files wrote its own copy.
 */
import { randomUUID } from 'node:crypto';
import type { E2EDb } from '../e2e/metrics/db.js';

/** The six steps the published perf table shows, in its order. */
export const CURATED_STEPS = [
  'deploy',
  'warm-deploy',
  'backup',
  'restore',
  'scale',
  'destroy',
] as const;

/** A run on `main` at version 0.0.0; returns its id. */
export function createTestRun(db: E2EDb, gitSha = 'deadbee'): string {
  const runId = randomUUID();
  db.createRun({
    id: runId,
    gitSha,
    gitBranch: 'main',
    vibecarbonVersion: '0.0.0',
    machineInfo: {},
  });
  return runId;
}

/**
 * One provider/mode scenario under `runId`, project `<provider>-<mode>` at
 * `<mode>.example.test`, with the six curated steps. Each step passes in
 * 60 s unless `stepStatus` or `stepDurationMs` says otherwise, and a step in
 * `missingSteps` is not written at all. The scenario passes unless `status`
 * says otherwise.
 */
export function seedCuratedScenario(
  db: E2EDb,
  runId: string,
  provider: string,
  mode: string,
  opts: {
    status?: string;
    stepDurationMs?: Partial<Record<string, number>>;
    stepStatus?: Partial<Record<string, string>>;
    missingSteps?: Set<string>;
    /** The add-ons the scenario deployed; stock (none) by default. */
    features?: string[];
  } = {},
): void {
  const scenarioId = randomUUID();
  db.createScenario({
    id: scenarioId,
    runId,
    mode,
    dnsProvider: 'manual',
    domain: `${mode}.example.test`,
    features: opts.features ?? [],
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

/**
 * A run (git sha `sha`) holding one scenario of `projectName` and
 * `envPrefix`, with no steps and no provider of its own (the column's
 * default).
 */
export function seedRunAndScenario(
  db: E2EDb,
  projectName: string,
  envPrefix: string,
  mode = 'compose',
): { runId: string; scenarioId: string } {
  const runId = createTestRun(db, 'sha');
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
