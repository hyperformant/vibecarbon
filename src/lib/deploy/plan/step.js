/** @typedef {{name:string, effect:string, args?:object, when?:(ctx:any)=>boolean, retry?:{attempts:number,backoffMs?:number,isTransient?:(e:Error)=>boolean}, required?:boolean}} Step */
/**
 * `required: true` marks a load-bearing step (a DR gate, a replication setup, a
 * config-persist) whose skip must NEVER be silent. runPlan refuses to skip a
 * required step via a falsy `when` — it throws instead. Optional steps that get
 * when-skipped are logged by name to stderr. Rationale (2026-07-07 k8s-ha RCA):
 * a deploy that quietly bypasses its replication hard-gate yet reports success
 * is the worst failure mode this codebase has, and a "behavior-identity" review
 * can miss a mis-gated step — so the runner must make this class loud.
 */
export function defineStep({ name, effect, args, when, retry, required }) {
  if (!name || typeof name !== 'string') throw new Error('step: name required');
  if (!effect || typeof effect !== 'string') throw new Error(`step '${name}': effect required`);
  const s = { name, effect };
  if (args !== undefined) s.args = args;
  if (when !== undefined) s.when = when;
  if (retry !== undefined) s.retry = retry;
  if (required !== undefined) s.required = required;
  return s;
}
export function assertValidPlan(steps) {
  if (!Array.isArray(steps)) throw new Error('plan: expected an array of steps');
  for (const s of steps) {
    if (!s || typeof s.name !== 'string' || typeof s.effect !== 'string') {
      throw new Error(`plan: invalid step (needs name + effect): ${JSON.stringify(s)}`);
    }
  }
  return steps;
}
export const planStepNames = (steps) => steps.map((s) => s.name);
