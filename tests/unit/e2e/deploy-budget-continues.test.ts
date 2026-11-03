/**
 * A cold-deploy budget miss fails the scenario but must not cost it the steps
 * after verify-deploy (two DO k8s-ha runs lost their failover coverage to a
 * 21s overrun). A functional failure still aborts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  abortsLifecycle,
  DEPLOY_BUDGET_FAILURE_PREFIX,
  runStepLoop,
} from '../../e2e/scenarios/step-loop.js';
import type { StepName, StepResult } from '../../e2e/scenarios/types.js';

const result = (name: string, status: StepResult['status'], errorMessage?: string): StepResult => ({
  name: name as StepName,
  status,
  startedAt: '',
  finishedAt: '',
  durationMs: 0,
  errorMessage,
});

const BUDGET_MSG = `${DEPLOY_BUDGET_FAILURE_PREFIX} cold deploy took 21s over budget`;

function harness(plan: Record<string, StepResult>) {
  const ran: string[] = [];
  const defs = Object.keys(plan).map((name) => ({
    name: name as StepName,
    run: async () => {
      ran.push(name);
      return plan[name];
    },
  }));
  const run = () =>
    runStepLoop(defs, { skipStep: (n) => result(n, 'skip', 'Skipped due to prior failure') });
  return { ran, run };
}

describe('deploy_budget miss vs functional failure', () => {
  it('a budget-only miss continues through every later step and the scenario still FAILS', async () => {
    const h = harness({
      deploy: result('deploy', 'pass'),
      'verify-deploy': result('verify-deploy', 'fail', BUDGET_MSG),
      scale: result('scale', 'pass'),
      failover: result('failover', 'pass'),
    });
    const out = await h.run();
    expect(h.ran).toEqual(['deploy', 'verify-deploy', 'scale', 'failover']);
    expect(out.steps.map((s) => s.status)).toEqual(['pass', 'fail', 'pass', 'pass']);
    expect(out.aborted).toBe(false);
    // The verdict input: a failed step is present, and the summary carries the name.
    expect(out.anyFailed).toBe(true);
    expect(out.scenarioError).toContain('deploy_budget');
  });

  it('a functional verification failure still aborts and skips the rest', async () => {
    const h = harness({
      deploy: result('deploy', 'pass'),
      'verify-deploy': result('verify-deploy', 'fail', '2 verification(s) failed: auth_signup'),
      scale: result('scale', 'pass'),
    });
    const out = await h.run();
    expect(h.ran).toEqual(['deploy', 'verify-deploy']);
    expect(out.steps.map((s) => s.status)).toEqual(['pass', 'fail', 'skip']);
    expect(out.aborted).toBe(true);
    expect(out.anyFailed).toBe(true);
  });

  it('only verify-deploy gets the budget exemption', () => {
    expect(abortsLifecycle(result('scale', 'fail', BUDGET_MSG))).toBe(true);
    expect(abortsLifecycle(result('verify-deploy', 'fail', BUDGET_MSG))).toBe(false);
    expect(abortsLifecycle(result('deploy', 'fail', 'boom'))).toBe(true);
  });

  it('the lifecycle throws exactly the prefix the loop exempts, and the verdict counts the failed step', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../e2e/scenarios/_run-lifecycle.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain(
      `throw new Error(\`${DEPLOY_BUDGET_FAILURE_PREFIX} \${deployBudgetMiss.message}\`)`,
    );
    expect(src).toContain("const hasStepFailure = steps.some((s) => s.status === 'fail'");
  });
});
