/**
 * A cluster-snapshot seam (src/lib/status/cluster-snapshot.js) for status
 * tests: each cluster, by master ip, holds one db pod with the given name.
 */
export function dbPodSnapshots(podFor: (ip: string) => string) {
  return {
    get: async (ip: string) => ({
      nodes: [],
      jobs: [],
      pods: [
        {
          kind: 'Pod',
          metadata: { name: podFor(ip), namespace: 'vibecarbon', labels: { app: 'vibecarbon-db' } },
          status: { phase: 'Running' },
        },
      ],
    }),
  };
}
