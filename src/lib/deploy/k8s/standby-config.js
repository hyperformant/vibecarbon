import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enabledK8sAddonNames, k8sFailoverAddonWorkloads } from '../../services/standby-policy.js';

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
 * Add-on entries carry `addon: true`: failover scales and quiesces them with
 * the app, but its readiness gate (before the DNS flip) awaits only the app
 * tier, so a slow add-on start never lengthens the outage.
 *
 * An older project config may still carry entries for workloads that no
 * longer exist (the retired chart's Deployments); failover's scale step logs
 * "not found; skipped" for those and carries on.
 *
 * @param {{appManifestText: string, addons?: Array<{name: string, namespace: string, manifestText: string}>}} args
 *   appManifestText: k8s/base/app/deployment.yaml; addons: one per add-on
 *   Deployment, its manifest from k8s/base/<addon>/deployment.yaml
 * @returns {Array<{name: string, namespace: string, replicas: number, addon?: true}>}
 */
export function deriveScaleUpList({ appManifestText, addons = [] }) {
  return [
    { name: 'app', namespace: 'vibecarbon', replicas: manifestReplicas(appManifestText, 2) },
    ...addons.map((a) => ({
      name: a.name,
      namespace: a.namespace,
      replicas: manifestReplicas(a.manifestText, 1),
      // Scaled up with the app, not awaited by the pre-DNS-flip rollout gate.
      addon: true,
    })),
    { name: 'cluster-autoscaler', namespace: 'kube-system', replicas: 1 },
  ];
}

/**
 * The add-on entries deriveScaleUpList takes: one per app-namespace Deployment
 * of each add-on deployed into the project's k8s tree, with the manifest the
 * deploy renders from (`k8s/base/<addon>/deployment.yaml`). Throws a one-line
 * cause naming the add-on when that manifest is missing.
 *
 * @param {string} projectDir
 * @returns {Array<{name: string, namespace: string, manifestText: string}>}
 */
export function failoverAddonManifests(projectDir) {
  return enabledK8sAddonNames(projectDir).flatMap((addon) => {
    const workloads = k8sFailoverAddonWorkloads([addon]);
    if (workloads.length === 0) return [];
    const path = join(projectDir, 'k8s', 'base', addon, 'deployment.yaml');
    if (!existsSync(path)) {
      throw new Error(
        `the ${addon} add-on has no k8s/base/${addon}/deployment.yaml, so failover cannot read its replica count (restore the file, or remove k8s/base/${addon} to drop the add-on)`,
      );
    }
    const manifestText = readFileSync(path, 'utf-8');
    return workloads.map((w) => ({ name: w.name, namespace: w.namespace, manifestText }));
  });
}
