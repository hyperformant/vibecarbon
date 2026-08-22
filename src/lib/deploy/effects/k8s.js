/**
 * k8s (single-cluster) deploy effect registry.
 *
 * The single-cluster k3s deploy is orchestrated by `deployK3s` in ../k8s/k3s.js
 * — a cohesive, internally state-gated pipeline (preflight → Pulumi up →
 * wait-ready → kubeconfig → build → sideload → applyK3sManifests) that k8s-ha
 * REUSES VERBATIM, running two copies in parallel with per-cluster
 * state/tracker/perfPrefix isolation. Cracking deployK3s into separate effects
 * would break that parallel isolation (two clusters would collide on one shared
 * ctx) and risk behaviour drift on a heavily-hardened path, so — per the Task 5
 * brief's "wrap the existing function rather than inlining it" — the
 * single-cluster deploy is expressed as ONE effect that wraps deployK3s as a
 * black box, preserving its `deploy.k3s.full` perf span (relocated verbatim
 * from the orchestrator's former TIER_DEPLOYERS.k8s entry). The shared
 * per-cluster block that k8s-ha reuses ×2 IS this deployK3s call.
 *
 * ── ctx contract ──
 *   Inputs (set by the orchestrator before runPlan):
 *     options = the deploymentConfig object deployK3s consumes (projectName,
 *               environment, region, master/supabase/worker server types,
 *               min/maxWorkers, apiToken, s3Config, state, tracker, domain,
 *               restore, dnsProvider, dnsToken, backupBucketName, …)
 *               — passed through UNCHANGED so deployK3s receives byte-for-byte
 *               the same options object it got from the former dispatch table.
 *   Filled in by the effect:
 *     clusterResult = deployK3s's return { masterIp, floatingIp, supabaseIp,
 *                     supabasePrivateIp, workerIps, networkId, kubeconfig,
 *                     sshKeyPath, imageTag } — read back into deployResult.
 */
import { perfAsync } from '../../perf.js';

/** Provision + deploy a single k3s cluster (wraps deployK3s as a black box). */
async function k8sDeployCluster(ctx) {
  const { deployK3s } = await import('../k8s/k3s.js');
  ctx.clusterResult = await perfAsync('deploy.k3s.full', () => deployK3s(ctx.options));
}

export const K8S_EFFECTS = { k8sDeployCluster };
