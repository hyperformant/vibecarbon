/** The first `replicas:` a manifest declares, or `fallback` when it has none. */
const manifestReplicas = (text, fallback) =>
  Number(text.match(/^\s*replicas:\s*(\d+)/m)?.[1] ?? fallback);

/**
 * Derive the failover scale-up list from what deploy ACTUALLY renders —
 * replaces the former hardcoded failover deployment list (a drift hazard).
 *
 * A pilot-light standby runs its db StatefulSet (streaming from the primary)
 * and nothing app-tier: the deploy zeroes the app Deployment and every
 * declared add-on, and the cluster-autoscaler sits at 0 until promotion. So
 * failover brings up the app at the replica count its own manifest declares,
 * then the add-ons in the app namespace (`k8sFailoverAddonWorkloads`; the
 * observability stack is reinstalled by the reconverge deploy instead), then
 * the autoscaler. The db is never in this list: it is already running.
 *
 * An older project config may still carry entries for workloads that no
 * longer exist (the retired chart's Deployments); failover's scale step logs
 * "not found; skipped" for those and carries on.
 *
 * @param {{appManifestText: string, addons?: Array<{name: string, namespace: string, manifestText: string}>}} args
 *   appManifestText: k8s/base/app/deployment.yaml; addons: one per add-on
 *   Deployment, its manifest from k8s/base/<addon>/deployment.yaml
 * @returns {Array<{name: string, namespace: string, replicas: number}>}
 */
export function deriveScaleUpList({ appManifestText, addons = [] }) {
  return [
    { name: 'app', namespace: 'vibecarbon', replicas: manifestReplicas(appManifestText, 2) },
    ...addons.map((a) => ({
      name: a.name,
      namespace: a.namespace,
      replicas: manifestReplicas(a.manifestText, 1),
    })),
    { name: 'cluster-autoscaler', namespace: 'kube-system', replicas: 1 },
  ];
}
