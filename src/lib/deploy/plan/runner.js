import { assertValidPlan } from './step.js';

/** Execute a pure plan against an effect registry. Owns the cross-cutting
 *  concerns once: when-gating, error-wrapping with the step name. */
export async function runPlan(steps, ctx, effects) {
  assertValidPlan(steps);
  for (const step of steps) {
    if (step.when && !step.when(ctx)) {
      // A when-skip of a REQUIRED step (a DR gate / replication / config-persist)
      // must abort the plan, never continue silently. Tonight's k8s-ha RCA: a
      // load-bearing step that never ran let the deploy report success without
      // its replication hard-gate. A mis-gated required step now fails loudly
      // with the step name and the ctx keys that decided the gate.
      if (step.required) {
        throw new Error(
          `[step:${step.name}] required step SKIPPED: its when-predicate returned false under the ` +
            `deploy ctx. A required (gate/persist/replication) step must never be gated out, ` +
            `skipping it would let the deploy report success without running it.`,
        );
      }
      // Optional skips are legitimate (warm redeploy, creds absent, manual DNS)
      // but must not be invisible: name every skip on stderr so a future
      // when-gate bug can't hide behind a green run.
      process.stderr.write(`[plan] skip optional step '${step.name}' (when=false)\n`);
      continue;
    }
    const impl = effects[step.effect];
    if (typeof impl !== 'function') {
      throw new Error(`runPlan: no effect '${step.effect}' for step '${step.name}'`);
    }
    try {
      await impl(ctx, step.args || {});
    } catch (err) {
      err.message = `[step:${step.name}] ${err.message}`;
      throw err;
    }
  }
  return ctx;
}
