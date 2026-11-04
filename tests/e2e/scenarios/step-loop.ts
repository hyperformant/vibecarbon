/**
 * The lifecycle's step loop, with one distinction in how a failure stops it.
 *
 * A functional failure aborts the run: the later steps assert state the failed
 * step should have produced, so they would only fail on their own
 * precondition. A cold-deploy `deploy_budget` miss is different. verify-deploy
 * reports it only after every one of its own functional checks passed, so the
 * deployed system is sound and scale, backup, restore and failover can still
 * be exercised. The step is still recorded as FAILED (so the scenario ends
 * FAIL and the summary and step matrix name `deploy_budget`); it just no
 * longer costs the run its downstream coverage.
 */
import type { StepName, StepResult } from './types.js';

/** The message prefix verify-deploy throws for a budget miss (pinned in _run-lifecycle.ts). */
export const DEPLOY_BUDGET_FAILURE_PREFIX = 'deploy: deploy_budget:';

/** A failed step whose only failure is the cold-deploy time/size budget. */
export function isDeployBudgetOnlyFailure(result: StepResult): boolean {
  return (
    result.name === 'verify-deploy' &&
    (result.status === 'fail' || result.status === 'error') &&
    (result.errorMessage ?? '').startsWith(DEPLOY_BUDGET_FAILURE_PREFIX)
  );
}

/** Whether this step's result stops the steps after it. */
export function abortsLifecycle(result: StepResult): boolean {
  if (result.status !== 'fail' && result.status !== 'error') return false;
  return !isDeployBudgetOnlyFailure(result);
}

export interface StepLoopDef {
  name: StepName;
  run: () => Promise<StepResult>;
}

export interface StepLoopOutcome {
  steps: StepResult[];
  /** First-failure-wins is NOT used: the latest failure message is kept, as before. */
  scenarioError: string | undefined;
  /** A step stopped the run (functional failure or operator abort/skip). */
  aborted: boolean;
  /** Any step failed, including a non-aborting budget miss. */
  anyFailed: boolean;
}

export async function runStepLoop(
  defs: readonly StepLoopDef[],
  hooks: {
    skipStep: (name: StepName) => StepResult;
    onStepComplete?: (result: StepResult) => Promise<'continue' | 'skip' | 'abort'>;
    log?: (line: string) => void;
  },
): Promise<StepLoopOutcome> {
  const steps: StepResult[] = [];
  let scenarioError: string | undefined;
  let aborted = false;
  for (const def of defs) {
    if (aborted) {
      steps.push(hooks.skipStep(def.name));
      continue;
    }
    const result = await def.run();
    steps.push(result);
    if (result.status === 'fail' || result.status === 'error') {
      scenarioError = result.errorMessage;
      if (abortsLifecycle(result)) {
        aborted = true;
      } else {
        hooks.log?.(
          `${def.name} missed its deploy budget (scenario will FAIL); continuing with the remaining steps`,
        );
      }
    }
    if (hooks.onStepComplete) {
      const action = await hooks.onStepComplete(result);
      if (action === 'skip' || action === 'abort') {
        hooks.log?.(`Operator requested ${action} — skipping remaining steps`);
        aborted = true;
        scenarioError = scenarioError ?? `Operator requested ${action}`;
      }
    }
  }
  return {
    steps,
    scenarioError,
    aborted,
    anyFailed: steps.some((s) => s.status === 'fail' || s.status === 'error'),
  };
}
