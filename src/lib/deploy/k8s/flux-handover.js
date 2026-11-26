/**
 * Hand one cluster to Flux from the operator's machine: install Flux, apply
 * the root objects, then wait for the first sync. The cluster's half of
 * `configure cicd <env>`, run once per cluster (a k8s-ha primary and standby
 * each get their own run). The steps are flux-bootstrap.js's.
 */

import { applyFluxRoot, awaitFluxReconcile, installFluxIfAbsent } from './flux-bootstrap.js';

/**
 * @param {{ projectDir: string, envName: string, kubeconfigPath: string }} args -
 *   envName names the cluster in what the operator reads (`prod`,
 *   `prod-standby`); kubeconfigPath is that cluster's kubeconfig
 */
export async function handOverCluster({ projectDir, envName, kubeconfigPath }) {
  const env = { ...process.env, KUBECONFIG: kubeconfigPath };
  await installFluxIfAbsent({ env });
  await applyFluxRoot({ env, projectDir });
  await awaitFluxReconcile({ env, envName });
}
