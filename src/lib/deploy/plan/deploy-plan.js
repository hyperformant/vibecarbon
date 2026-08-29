/**
 * Pure deploy planner. `planDeploy(tier, config) → Step[]` returns the ordered
 * list of step descriptors for a tier's deploy. It is PURE: no SSH/kubectl/fs,
 * no Date.now, no I/O of any kind — every runtime decision is deferred to the
 * steps' `when(ctx)` predicates (evaluated by runPlan) and to the effects.
 *
 * The `config` argument is accepted for signature symmetry with the other
 * planners (and future tiers that shape their plan from config); the compose
 * plan is a fixed sequence whose conditionals live in the steps' when-gates.
 */
import {
  createAdminUserStep,
  dockerhubLoginStep,
  ghcrLoginStep,
  haConfigureReplicationStep,
  haCreateAdminUserStep,
  haFinalizeConfigStep,
  haK8sConfigureReplicationStep,
  haK8sFinalizeStep,
  haK8sGenerateSshKeyStep,
  haK8sOpenReplicationFirewallStep,
  haK8sProvisionClustersStep,
  haK8sUpdateDnsStep,
  haK8sUploadSshKeyStep,
  haK8sVerifyStreamingStep,
  haMergeWalgRoleStep,
  haPersistPendingConfigStep,
  haProvisionServersStep,
  haPullImagesStep,
  haRemoteBuildStep,
  haRunMigrationsStep,
  haSeedKnownHostsStep,
  haSetupBackupCronStep,
  haSetupServerFilesStep,
  haSetupServersStep,
  haStartComposeStackStep,
  haUpdateDnsStep,
  haVerifyStreamingStep,
  haWaitDockerReadyStep,
  haWaitForSshStep,
  haWaitPrimaryPostgresStep,
  haWriteReplicationOverlayStep,
  k8sDeployClusterStep,
  provisionServerStep,
  runMigrationsStep,
  setupBackupCronStep,
  setupServerFilesStep,
  setupServerStep,
  startComposeStackStep,
  transferImageStep,
  updateDnsStep,
  verifyHealthStep,
  verifyTlsReadyStep,
} from './steps.js';

/**
 * @param {'compose'|'compose-ha'|'k8s'|'k8s-ha'} tier
 * @param {object} _config
 * @returns {import('./step.js').Step[]}
 */
export function planDeploy(tier, _config) {
  if (tier === 'compose') {
    return [
      provisionServerStep(),
      setupServerStep(),
      transferImageStep(),
      dockerhubLoginStep(),
      ghcrLoginStep(),
      setupServerFilesStep(),
      updateDnsStep(),
      startComposeStackStep(),
      runMigrationsStep(),
      createAdminUserStep(),
      verifyHealthStep(),
      verifyTlsReadyStep(),
      setupBackupCronStep(),
    ];
  }
  if (tier === 'compose-ha') {
    // Faithful decomposition of the (now removed) inlined deployComposeHA:
    // every operation it ran over the primary+standby pair, in order. The
    // conditionals it ran inline (local-only remote build; managed vs manual
    // DNS; the replication warn/hard-gate) live in the steps' when-gates and
    // inside the effects, exactly as the single-compose plan defers them.
    return [
      haProvisionServersStep(),
      haPersistPendingConfigStep(),
      haWaitForSshStep(),
      haSeedKnownHostsStep(),
      haSetupServersStep(),
      haWaitDockerReadyStep(),
      haRemoteBuildStep(),
      haSetupServerFilesStep(),
      haMergeWalgRoleStep(),
      haPullImagesStep(),
      haUpdateDnsStep(),
      haStartComposeStackStep(),
      haRunMigrationsStep(),
      haCreateAdminUserStep(),
      haWaitPrimaryPostgresStep(),
      haWriteReplicationOverlayStep(),
      haConfigureReplicationStep(),
      haVerifyStreamingStep(),
      // Shared with single compose (same step name, same effect): the TLS
      // gate must precede finalize-config, which persists status:'deployed'.
      verifyTlsReadyStep(),
      haSetupBackupCronStep(),
      haFinalizeConfigStep(),
    ];
  }
  if (tier === 'k8s') {
    // Single-cluster k3s. deployK3s is a cohesive, internally state-gated
    // pipeline reused verbatim by k8s-ha's parallel fan-out, so it is wrapped
    // as ONE black-box step rather than cracked open (which would break the HA
    // per-cluster isolation and risk drift on a hardened path). The post-deploy
    // DNS-update + public health probe are shared across both k8s tiers and
    // intentionally remain in the orchestrator's post-dispatch block rather
    // than becoming plan steps — they read back deployResult shapes that
    // differ per tier (see orchestrator.js's tier dispatch).
    return [k8sDeployClusterStep()];
  }
  if (tier === 'k8s-ha') {
    // Faithful decomposition of the (now removed) inlined deployK8sHA: every
    // top-level phase it ran, in order. The per-cluster deploy (deployK3s ×2)
    // and the hardened WireGuard replication transport + scale-to-zero reseed
    // (setupReplication) are invoked by the effects as BLACK BOXES; the
    // conditionals deployK8sHA ran inline (firewall on apiToken, managed-DNS on
    // domain/provider, the degraded warn/hard-gate) live inside the effects,
    // exactly as the compose-ha plan defers them. Replication step names
    // (configure-replication, verify-streaming) mirror compose-ha's.
    return [
      haK8sGenerateSshKeyStep(),
      haK8sUploadSshKeyStep(),
      haK8sProvisionClustersStep(),
      haK8sOpenReplicationFirewallStep(),
      haK8sConfigureReplicationStep(),
      haK8sVerifyStreamingStep(),
      haK8sUpdateDnsStep(),
      haK8sFinalizeStep(),
    ];
  }
  throw new Error(`planDeploy: unknown/unsupported tier ${tier}`);
}
