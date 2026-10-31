/**
 * Lifecycle steps that only make sense after an earlier one. `--skip-steps`
 * drops a step's dependents with it: each asserts the state its prerequisite
 * leaves (a failed-over env, a reconverged pair, a failed-back primary), so
 * without it they would fail on their own precondition, not on a product bug.
 */
import type { StepName } from './types.js';

/** Each step, and the steps that need it to have run first. */
export const STEP_DEPENDENTS: Readonly<Partial<Record<StepName, readonly StepName[]>>> = {
  // The backup writes the marker row restore-deploy looks for; the destroy
  // leaves the empty environment it deploys into.
  backup: ['restore-deploy'],
  destroy: ['restore-deploy'],
  failover: ['second-failover', 'reconverge-deploy'],
  'reconverge-deploy': ['failback'],
  failback: ['verify-failback'],
};

/** The requested skips plus, transitively, every step that depends on one. */
export function expandSkippedSteps(skip: ReadonlySet<string>): Set<string> {
  const out = new Set<string>(skip);
  const queue = [...skip];
  while (queue.length > 0) {
    const step = queue.shift() as StepName;
    for (const dependent of STEP_DEPENDENTS[step] ?? []) {
      if (!out.has(dependent)) {
        out.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return out;
}
