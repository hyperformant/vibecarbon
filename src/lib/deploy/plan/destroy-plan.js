/**
 * Pure destroy planner. `planDestroy(tier, config) → Step[]` returns the ordered
 * list of step descriptors for a tier's teardown. It is PURE: no SSH/kubectl/fs,
 * no Hetzner/Cloudflare/S3 calls, no Date.now — every runtime decision and all
 * I/O is deferred to the effects (the destroy registry in src/destroy.js), which
 * runPlan executes against the live ctx.
 *
 * This is the destroy analogue of deploy-plan.js. It builds on the existing pure
 * `planDestroyTargets` (src/destroy.js), which derives the canonical tier plus
 * the ownership-aware teardown targets (stackEnvs, clusterNames, ownedIps,
 * hasPulumiStack) from persisted config. planDestroyTargets is called by the
 * runner to populate ctx.plan; planDestroy here only expresses the ORDERED
 * SEQUENCE of teardown operations for a tier. The `config` argument is accepted
 * for signature symmetry with planDeploy (destroy plans are fixed per tier).
 *
 * ── Safety properties encoded here (load-bearing; see the destroy safety
 *    notes) ──
 *   • Buckets-last: the app bucket, then the Pulumi state bucket, then the
 *     backup bucket are deleted AFTER the tier teardown step. The state bucket
 *     is the Pulumi backend, so it must never be yanked before `pulumi destroy`
 *     completes — it is fixed as the second bucket step, past the teardown.
 *   • HA both-cluster: k8s and k8s-ha share ONE teardown effect
 *     (`destroyK8sInfra`); the primary+standby fan-out is data-driven by
 *     ctx.plan.stackEnvs (from planDestroyTargets / pulumiStackEnvs), not a
 *     distinct step — mirroring the pre-refactor DESTROY_STRATEGIES table where
 *     both k8s tiers shared destroyK8sTier.
 *   • Pulumi-literal resource-name matching lives inside the wrapped teardown
 *     helpers (destroyComposeTier / destroyK8sTier), unchanged — the plan never
 *     re-derives resource names.
 *   • The orphan-stack gate (never auto-destroy orphan Pulumi stacks under
 *     `--yes` without `-orphans`) and the prod type-to-confirm gate are
 *     PRE-teardown interactive guards that run in destroy.js's main() before any
 *     plan executes — they are intentionally NOT plan steps.
 */
import { defineStep } from './step.js';

// The shared teardown tail (decomposed from the former `finishDestroy`), in the
// exact order finishDestroy ran its blocks. `delete-github-env` and
// `print-summary` were k8s-only in finishDestroy (the deleteGithubEnv/showSummary
// booleans), so they appear only in the k8s tail.
const composeTail = () => [
  // Stack-state reconciliation, FIRST in the tail: the compose teardown reaps
  // its Pulumi-provisioned resources via direct provider APIs (no `pulumi
  // destroy`), and the retained state bucket would otherwise carry a stack
  // file describing deleted infra into the next deploy of this environment —
  // which fails on providers whose refresh cannot prune deleted resources
  // (vultr firewall rules, e2e run 32309395314). The effect itself gates on a
  // clean leak ledger, so it sits immediately after the teardown whose
  // verdict it reads. The k8s tail needs no twin: destroyStack already runs
  // `pulumi destroy` + `removeStack` per stackEnv.
  defineStep({ name: 'remove-stack-state', effect: 'removePulumiStackState' }),
  defineStep({ name: 'delete-app-bucket', effect: 'deleteAppBucket' }),
  defineStep({ name: 'retain-state-bucket', effect: 'retainStateBucket' }),
  defineStep({ name: 'handle-backup-bucket', effect: 'handleBackupBucket' }),
  defineStep({ name: 'update-project-config', effect: 'updateProjectConfig' }),
  defineStep({ name: 'cleanup-local-files', effect: 'cleanupLocalFiles' }),
  defineStep({ name: 'finish-outro', effect: 'finishOutro' }),
];

const k8sTail = () => [
  defineStep({ name: 'delete-app-bucket', effect: 'deleteAppBucket' }),
  // Ungated, unlike the deletion it replaces. That step carried
  // `when: (ctx) => !ctx.results.pulumiDestroyFailed` (M3 Task 9f round 1),
  // because the state bucket holds the ONLY evidence a retry — or an operator,
  // by hand — can use to find what is still deployed, and deleting it in the
  // same run that failed to verify a teardown destroyed the evidence alongside
  // the failure. Keeping the bucket unconditionally is strictly safer than the
  // gate was, so the condition has nothing left to protect.
  defineStep({ name: 'retain-state-bucket', effect: 'retainStateBucket' }),
  defineStep({ name: 'handle-backup-bucket', effect: 'handleBackupBucket' }),
  defineStep({ name: 'delete-github-env', effect: 'deleteGithubEnv' }),
  defineStep({ name: 'update-project-config', effect: 'updateProjectConfig' }),
  defineStep({ name: 'cleanup-local-files', effect: 'cleanupLocalFiles' }),
  defineStep({ name: 'print-summary', effect: 'printSummary' }),
  defineStep({ name: 'finish-outro', effect: 'finishOutro' }),
];

/**
 * @param {'compose'|'compose-ha'|'k8s'|'k8s-ha'} tier
 * @param {object} _config
 * @returns {import('./step.js').Step[]}
 */
export function planDestroy(tier, _config) {
  if (tier === 'compose') {
    return [
      defineStep({ name: 'destroy-compose-services', effect: 'destroyComposeServices' }),
      ...composeTail(),
    ];
  }
  if (tier === 'compose-ha') {
    return [
      defineStep({ name: 'destroy-compose-ha', effect: 'destroyComposeHa' }),
      ...composeTail(),
    ];
  }
  if (tier === 'k8s' || tier === 'k8s-ha') {
    // One black-box teardown effect for both k8s tiers — the primary+standby
    // fan-out is carried by ctx.plan.stackEnvs, exactly as the removed
    // DESTROY_STRATEGIES table shared destroyK8sTier across k8s and k8s-ha.
    return [defineStep({ name: 'destroy-k8s-infra', effect: 'destroyK8sInfra' }), ...k8sTail()];
  }
  throw new Error(`planDestroy: unknown/unsupported tier ${tier}`);
}
