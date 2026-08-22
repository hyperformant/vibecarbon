/**
 * Diff a just-finished scenario against the last green run for the same
 * mode + dnsProvider. Two outputs:
 *
 *   1. Regression detection — if a step that was 'pass' in the last green
 *      run is 'fail' in this run AND the failure isn't already classified
 *      as 'infra', upgrade the category to 'regression'. The catch: if it
 *      WAS infra (k3s timeout, LE rate limit), this isn't really a
 *      regression of our code, so leave the category alone.
 *
 *   2. Perf drift — duration deltas for steps that passed in both runs.
 *      Only surfaces when > 20% (and at least +30s absolute) so noise is
 *      filtered out — a 5s step that becomes 7s isn't actionable, a deploy
 *      that goes from 10 min to 13 min is.
 *
 * Both outputs are best-effort: if there's no green prior to compare
 * against (first run for a brand-new scenario), this returns an empty
 * diff and leaves the scenario unchanged.
 */

import type { ScenarioResult, StepResult } from '../scenarios/types.js';

export interface DiffEntry {
  kind: 'regression' | 'perf';
  stepName: string;
  /** Plain-language summary for the run summary footer. */
  message: string;
}

export interface DiffResult {
  /** Mutates the scenario in place: upgraded failureCategory + per-step. */
  scenario: ScenarioResult;
  /** What changed since the last green run (regressions + significant perf). */
  entries: DiffEntry[];
}

const PERF_DELTA_PCT = 0.2;
const PERF_DELTA_MS_MIN = 30_000;

export function applyDiffVsGreen(
  scenario: ScenarioResult,
  baselines: ReadonlyArray<{ name: string; status: string; durationMs: number }>,
): DiffResult {
  const entries: DiffEntry[] = [];

  if (baselines.length === 0) return { scenario, entries };

  const baselineByName = new Map(baselines.map((b) => [b.name, b]));

  let scenarioRegressed = false;
  const updatedSteps: StepResult[] = scenario.steps.map((step) => {
    const baseline = baselineByName.get(step.name);
    if (!baseline) return step;

    // Regression: was passing, now failing, and not already labeled infra.
    // Infra flakes can mask real regressions but the right answer there is
    // to retry the scenario (covered by the retry-on-flake path), not to
    // re-label this as 'regression' and confuse the operator.
    const isFail = step.status === 'fail' || step.status === 'error';
    if (isFail && baseline.status === 'pass' && step.failureCategory !== 'infra') {
      scenarioRegressed = true;
      entries.push({
        kind: 'regression',
        stepName: step.name,
        message: `${step.name}: passed last green, fails now${
          step.failureCategory ? ` [was ${step.failureCategory}]` : ''
        } — likely regression`,
      });
      return { ...step, failureCategory: 'regression' as const };
    }

    // Perf drift: both passed, but step is meaningfully slower.
    if (
      step.status === 'pass' &&
      baseline.status === 'pass' &&
      baseline.durationMs > 0 &&
      step.durationMs > baseline.durationMs * (1 + PERF_DELTA_PCT) &&
      step.durationMs - baseline.durationMs >= PERF_DELTA_MS_MIN
    ) {
      const deltaMs = step.durationMs - baseline.durationMs;
      const deltaPct = Math.round((deltaMs / baseline.durationMs) * 100);
      entries.push({
        kind: 'perf',
        stepName: step.name,
        message: `${step.name}: ${formatSec(step.durationMs)} (was ${formatSec(baseline.durationMs)}, ↑+${deltaPct}%)`,
      });
    }

    return step;
  });

  // If we upgraded any step to regression, the scenario rolls up to that.
  // (rollUpScenarioCategory in classify-failure.ts already does worst-wins,
  // but we may run after the runner already set scenario.failureCategory,
  // so re-derive here.)
  const failureCategory = scenarioRegressed ? 'regression' : scenario.failureCategory;

  return {
    scenario: { ...scenario, steps: updatedSteps, failureCategory },
    entries,
  };
}

function formatSec(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}
