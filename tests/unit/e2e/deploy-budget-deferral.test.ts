import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source pin for where a cold-deploy budget miss fails the scenario
 * (_run-lifecycle.ts has no unit harness, so wiring is pinned by reading the
 * source, as in warm-redeploy-step-gating.test.ts).
 *
 * The deploy step records `deploy_budget` and logs it, but must not throw on a
 * miss: the first real runs are uncalibrated, and a throw there would skip
 * every downstream correctness step. verify-deploy throws on the stored miss
 * after its own checks have run.
 */
describe('_run-lifecycle.ts: a deploy budget miss fails verify-deploy, not deploy', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../tests/e2e/scenarios/_run-lifecycle.ts', import.meta.url)),
    'utf8',
  );
  const budgetIdx = src.indexOf('checkDeployBudget(');
  const verifyDeployIdx = src.indexOf("name: 'verify-deploy',");

  it('records the result at the deploy step and stores a miss instead of throwing', () => {
    expect(budgetIdx).toBeGreaterThan(-1);
    const deployBody = src.slice(budgetIdx, verifyDeployIdx);
    expect(deployBody).toContain('collector.recordVerifications(stepId, [budget]);');
    expect(deployBody).toContain('deployBudgetMiss = budget;');
    expect(deployBody).not.toMatch(/throw new Error\(`deploy: \$\{budget\.checkName\}/);
  });

  it('throws the stored miss at the end of verify-deploy, after its own failures', () => {
    const throwIdx = src.indexOf(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a template literal
      'throw new Error(`deploy: deploy_budget: ${deployBudgetMiss.message}`)',
    );
    expect(throwIdx).toBeGreaterThan(-1);
    const gateIdx = src.lastIndexOf("stepName === 'verify-deploy' && deployBudgetMiss", throwIdx);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(throwIdx - gateIdx).toBeLessThan(200);
    // After the step's own verification failures are evaluated and thrown.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a template literal
    const ownFailuresIdx = src.lastIndexOf('verification(s) failed: ${failNames}', throwIdx);
    expect(ownFailuresIdx).toBeGreaterThan(-1);
    expect(src.slice(ownFailuresIdx, throwIdx)).not.toContain('async function ');
  });
});
