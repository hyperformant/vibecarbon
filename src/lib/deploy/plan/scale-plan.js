/**
 * Pure scale planner. `planScale(tier, config) → Step[]` returns the ordered
 * list of step descriptors for a tier's post-deploy scale. It is PURE: no
 * SSH/Pulumi/kubectl calls, no Date.now, no I/O of any kind — every runtime
 * decision (which servers to touch, HA fan-out parallel-vs-sequential,
 * whether infra actually changed) is deferred to the effects (the
 * `SCALE_EFFECTS` registry in src/scale.js), which runPlan executes against
 * the live ctx. The `config` argument is accepted for signature symmetry
 * with the other planners; scale's plan shape is fixed per tier-family.
 *
 * This is the scale analogue of deploy-plan.js / destroy-plan.js. The
 * interactive prep that used to open `scaleCompose` / `scaleK8s` (env/target/
 * type prompts, confirmation, operator-IP-access gate, credential loading) is
 * NOT part of the plan — exactly as planDeploy defers the config-gathering
 * step to the caller (deploy.js) and only expresses the ordered EXECUTION
 * sequence. scale.js's run() still gathers the operator's choices and builds
 * ctx before calling `runPlan(planScale(tier, config), ctx, SCALE_EFFECTS)`.
 *
 * ── compose / compose-ha share ONE step list ──
 * scaleCompose already ran ONE code path for both tiers, branching on
 * `isHATier(tier)` purely as CTX DATA (how many target servers were selected,
 * parallel-vs-sequential fan-out) — never as a different SEQUENCE of
 * operations. The per-server blue-green replace-and-restore pipeline (backup
 * old → create new → wait for SSH → provision → copy files → registry logins
 * → optional remote build → pull images → compose up → restore from S3 →
 * update DNS → reset ACME state → recreate services → backup cron → destroy
 * old server) is COHESIVE: every step after server-creation is wrapped in ONE
 * try/catch that deletes the new server on ANY failure, so cracking it into
 * barrier-synchronized steps across servers would change failure/cleanup
 * semantics (and, for HA, the fan-out is per-server-independent parallelism,
 * not phase-barrier parallelism). Mirroring the deployK3s / destroy-tier
 * black-box precedent, it stays ONE step ('scale-servers') whose effect owns
 * the whole fan-out — exactly as compose-ha's DEPLOY plan wraps its own
 * multi-node phases, except here the "phase" IS the whole per-server
 * pipeline.
 *
 * ── k8s / k8s-ha share ONE step list ──
 * scaleK8s likewise ran ONE code path for both tiers; the standby cluster is
 * only touched when `isHATier(tier) && envConfig.secondaryRegion` — CTX DATA,
 * not a distinct plan shape (mirrors planDestroy's k8s/k8s-ha sharing
 * `destroy-k8s-infra`, fanned by ctx.plan.stackEnvs). The Pulumi preview +
 * master-replace defense + upStack + cluster-autoscaler re-patch is a single
 * cohesive, per-cluster routine (`applyScaleChanges`) called once for the
 * primary (or single) cluster and again for the standby when HA — wrapped as
 * ONE step for the same reason deployK3s is wrapped as one step. The post-
 * resize readiness wait (API healthz → CSI DaemonSet rollout → pod-Ready,
 * with the standby's skip-pod-ready exception) is a distinct concern run
 * AFTER every cluster has been resized, so it is its own step.
 */
import { defineStep } from './step.js';

const composeScaleSteps = () => [
  defineStep({ name: 'register-ssh-key', effect: 'scaleRegisterSshKey' }),
  defineStep({ name: 'scale-servers', effect: 'scaleServers' }),
  defineStep({ name: 'update-project-config', effect: 'scaleUpdateComposeConfig' }),
  defineStep({ name: 'finish-outro', effect: 'scaleFinishComposeOutro' }),
];

const k8sScaleSteps = () => [
  defineStep({ name: 'apply-scale-changes', effect: 'scaleApplyK8sChanges' }),
  // HA-only belt (item I-1): after the resize rebooted the supabase node(s),
  // recreate wg0 + bounce the crash-looped repl-gateway BEFORE the pods-Ready
  // wait — a crash-looping gateway (couldn't bind its tunnel IP without wg0)
  // otherwise wedges the primary's `kubectl wait --for=Ready pods --all` for
  // 10 min and fails scale. Shared step (k8s + k8s-ha keep one plan shape, per
  // the scale-plan design); `when: ctx.isHA` gates it to HA at run time, and
  // the effect further no-ops unless the supabase node was actually resized.
  defineStep({
    name: 're-establish-ha-tunnel',
    effect: 'scaleReestablishHaTunnel',
    when: (ctx) => !!ctx.isHA,
  }),
  defineStep({ name: 'verify-ready', effect: 'scaleVerifyK8sReady' }),
  defineStep({ name: 'update-project-config', effect: 'scaleUpdateK8sConfig' }),
  defineStep({ name: 'finish-outro', effect: 'scaleFinishK8sOutro' }),
];

/**
 * @param {'compose'|'compose-ha'|'k8s'|'k8s-ha'} tier
 * @param {object} _config
 * @returns {import('./step.js').Step[]}
 */
export function planScale(tier, _config) {
  if (tier === 'compose' || tier === 'compose-ha') {
    return composeScaleSteps();
  }
  if (tier === 'k8s' || tier === 'k8s-ha') {
    return k8sScaleSteps();
  }
  throw new Error(`planScale: unknown/unsupported tier ${tier}`);
}
