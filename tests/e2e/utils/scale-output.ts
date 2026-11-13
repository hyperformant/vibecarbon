/**
 * What verify-scale reads from a k8s scale's own output about the cluster
 * autoscaler. A worker type change must reach each cluster's
 * kube-system/carbon-autoscaler-config, or the autoscaler keeps making workers
 * of the old type. Scale only warns when that re-patch fails (the servers are
 * already resized), so the matrix passed it: 2026-11-13, 3 of 8 k8s scales
 * lost the re-patch to the master's reboot and verify-scale stayed green.
 */

/** The lines scale.js prints (src/scale.js repatchClusterAutoscaler). */
export const CA_REPATCHED = /cluster-autoscaler re-patched \(([^)]*)\)/g;
export const CA_REPATCH_FAILED = /CA re-patch failed \(([^)]*)\)/g;

/**
 * Why the scale output shows the autoscaler kept its old worker settings, or
 * null when every cluster took the new ones. Compose modes have no autoscaler.
 */
export function autoscalerRepatchProblem(output: string, mode: string): string | null {
  if (mode !== 'k8s' && mode !== 'k8s-ha') return null;
  const failed = [...output.matchAll(CA_REPATCH_FAILED)].map((m) => m[1]);
  if (failed.length > 0) {
    return `verify-scale: the cluster autoscaler kept its old worker settings (${failed.join(', ')}): its re-patch failed`;
  }
  const done = [...output.matchAll(CA_REPATCHED)].length;
  const want = mode === 'k8s-ha' ? 2 : 1;
  if (done < want) {
    return `verify-scale: expected ${want} cluster-autoscaler re-patch line(s) for ${mode}, saw ${done}`;
  }
  return null;
}
