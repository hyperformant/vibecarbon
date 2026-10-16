/**
 * Derive the failover scale-up list from what deploy ACTUALLY renders —
 * replaces the former hardcoded failover deployment list (a drift hazard).
 *
 * A pilot-light standby runs its db StatefulSet (streaming from the primary)
 * and nothing app-tier: the deploy zeroes the app Deployment, and the
 * cluster-autoscaler sits at 0 until promotion. So the app tier failover must
 * bring up is exactly those two, with the app at the replica count its own
 * manifest declares. The db is never in this list: it is already running.
 *
 * An older project config may still carry entries for workloads that no
 * longer exist (the retired chart's Deployments); failover's scale step logs
 * "not found; skipped" for those and carries on.
 *
 * @param {{appManifestText: string}} args - k8s/base/app/deployment.yaml
 * @returns {Array<{name: string, namespace: string, replicas: number}>}
 */
export function deriveScaleUpList({ appManifestText }) {
  const appReplicas = Number(appManifestText.match(/^\s*replicas:\s*(\d+)/m)?.[1] ?? 2);
  return [
    { name: 'app', namespace: 'vibecarbon', replicas: appReplicas },
    { name: 'cluster-autoscaler', namespace: 'kube-system', replicas: 1 },
  ];
}
