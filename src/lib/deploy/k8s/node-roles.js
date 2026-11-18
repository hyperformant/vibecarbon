/**
 * Which cluster nodes are workers: by label, never by name.
 *
 * A node's name is its server's name, and a server's name is not ours to
 * keep. Linode caps an instance label at 50 characters, and a longer one is
 * cut and given a hash suffix (squeezeLinodeInstanceLabel), so
 * `<project>-l4-standby-worker-1` registers as `<project>-l4-st-d644a9d7`.
 * A failover that counted `-worker-` names waited its full 600 s for a worker
 * that had joined, then tore it down (linode/k8s-ha, 2026-11-15). Workers the
 * cluster autoscaler adds (`<cluster>-ca-<random>`) never had the segment.
 *
 * A cluster has three kinds of node. The k3s server carries
 * node-role.kubernetes.io/control-plane, which k3s sets itself. The database
 * node carries dedicated=db, which its k3s agent sets at join (the worker
 * template loaded as the db role, AGENT_ROLES in src/lib/iac/cloud-init.js),
 * and the db StatefulSet's nodeSelector requires it, so the node running the
 * database always has it. Every other node is a worker.
 *
 * tests/unit/deploy/node-roles-census.test.ts keeps every worker lookup on
 * this selector.
 */
export const WORKER_NODE_SELECTOR = '!node-role.kubernetes.io/control-plane,dedicated!=db';

/**
 * WORKER_NODE_SELECTOR for a node already read (`kubectl get nodes -o json`).
 *
 * @param {Record<string, string> | undefined} labels the node's metadata.labels
 * @returns {boolean}
 */
export function isWorkerNode(labels) {
  const l = labels ?? {};
  return !('node-role.kubernetes.io/control-plane' in l) && l.dedicated !== 'db';
}

/**
 * How many rows of `kubectl get nodes --no-headers` are Ready. The STATUS
 * column is `Ready`, `NotReady`, or either with `,SchedulingDisabled`.
 *
 * @param {string} out
 * @returns {number}
 */
export function countReadyNodes(out) {
  return String(out ?? '')
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1] ?? '')
    .filter((status) => status.split(',').includes('Ready')).length;
}
