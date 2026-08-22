/**
 * `getLastGreenStepBaselines` must be scoped to the PROVIDER, not just
 * (mode, dnsProvider).
 *
 * hetzner/compose-ha and digitalocean/compose-ha both resolve to
 * (compose-ha, cloudflare). Keyed on that pair alone, whichever cloud went
 * green most recently becomes the other's baseline — and the runner's
 * diff-vs-green pass then reads a cross-cloud timing delta as this run's
 * perf drift, upgrades failureCategory to 'regression', re-persists it, and
 * (because the E2E_RETRY_FLAKES retry fires on 'infra' only) suppresses the
 * retry. The sibling anomaly-guard query was provider-scoped when the
 * multi-provider registry landed; this one was missed.
 *
 * In-memory SQLite per test, same idiom as cold-warm.test.ts.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { E2EDb } from '../../e2e/metrics/db.js';

/** Seed one finished scenario with a single green `deploy` step of `durationMs`. */
function seedGreenScenario(
  db: E2EDb,
  opts: { provider: string; mode: string; dnsProvider: string; durationMs: number },
): { runId: string } {
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
    mode: opts.mode,
    dnsProvider: opts.dnsProvider,
    domain: 'example.test',
    features: [],
    projectName: `proj-${opts.provider}-${opts.mode}`,
    envPrefix: 'e1',
    provider: opts.provider,
  });
  const stepId = randomUUID();
  db.createStep({ id: stepId, scenarioId, name: 'deploy', command: 'deploy e1', coldWarm: 'cold' });
  db.startStep(stepId);
  db.completeStep(stepId, 'pass', opts.durationMs);
  db.updateScenarioStatus(scenarioId, 'pass');
  return { runId };
}

const CURRENT_RUN = 'current-run-id';

describe('E2EDb.getLastGreenStepBaselines is provider-scoped', () => {
  it('does NOT return a DigitalOcean green as the Hetzner baseline for the same mode', () => {
    const db = new E2EDb(':memory:');
    seedGreenScenario(db, {
      provider: 'digitalocean',
      mode: 'compose-ha',
      dnsProvider: 'cloudflare',
      durationMs: 999_000,
    });

    const baselines = db.getLastGreenStepBaselines(
      'hetzner',
      'compose-ha',
      'cloudflare',
      CURRENT_RUN,
    );

    expect(baselines).toEqual([]);
    db.close();
  });

  it('returns the provider’s OWN green even when another provider went green more recently', () => {
    const db = new E2EDb(':memory:');
    seedGreenScenario(db, {
      provider: 'hetzner',
      mode: 'compose-ha',
      dnsProvider: 'cloudflare',
      durationMs: 120_000,
    });
    // Most-recent-green overall, but a different cloud: must not win.
    seedGreenScenario(db, {
      provider: 'digitalocean',
      mode: 'compose-ha',
      dnsProvider: 'cloudflare',
      durationMs: 999_000,
    });

    const baselines = db.getLastGreenStepBaselines(
      'hetzner',
      'compose-ha',
      'cloudflare',
      CURRENT_RUN,
    );

    expect(baselines).toEqual([{ name: 'deploy', status: 'pass', durationMs: 120_000 }]);
    db.close();
  });

  it('still excludes the current run (diff against history, not ourselves)', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seedGreenScenario(db, {
      provider: 'hetzner',
      mode: 'compose',
      dnsProvider: 'hetzner',
      durationMs: 60_000,
    });

    expect(db.getLastGreenStepBaselines('hetzner', 'compose', 'hetzner', runId)).toEqual([]);
    db.close();
  });
});
