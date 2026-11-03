/**
 * A settled cert-manager controller, as kubectl prints it, for harnesses
 * that drive applyK3sManifests through a mocked spawn: the Deployment rolled
 * out, its current ReplicaSet, and the leader lease held by a pod of it
 * (readiness.js awaitCertManagerLeader).
 */
const DEPLOYMENT = JSON.stringify({
  metadata: {
    name: 'cert-manager',
    uid: 'cm-uid',
    generation: 1,
    annotations: { 'deployment.kubernetes.io/revision': '1' },
  },
  spec: { replicas: 1 },
  status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1 },
});
const REPLICA_SETS = JSON.stringify({
  items: [
    {
      metadata: {
        name: 'cert-manager-5d4b8c7f9',
        annotations: { 'deployment.kubernetes.io/revision': '1' },
        ownerReferences: [{ uid: 'cm-uid' }],
      },
    },
  ],
});
const LEASE = JSON.stringify({
  spec: { holderIdentity: 'cert-manager-5d4b8c7f9-x7k2p-external-cert-manager-controller' },
});

/** The stdout for one of the leader wait's reads, or null for any other argv. */
export function certManagerLeaderStdout(cmd: string, args: readonly string[]): string | null {
  if (cmd !== 'kubectl' || !args.includes('get')) return null;
  if (args.includes('lease') && args.includes('cert-manager-controller')) return LEASE;
  if (!args.includes('cert-manager')) return null;
  if (args.includes('replicasets')) return REPLICA_SETS;
  if (args.includes('deployment')) return DEPLOYMENT;
  return null;
}
