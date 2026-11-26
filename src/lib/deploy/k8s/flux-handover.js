/**
 * Hand one cluster to Flux from the operator's machine: install Flux, give it
 * this cluster's own read-only deploy key, apply the root objects, then wait
 * for the first sync. The cluster's half of `configure cicd <env>`, run once
 * per cluster (a k8s-ha primary and standby each get their own run, and their
 * own key). The steps are flux-bootstrap.js's and flux-deploy-key.js's.
 */

import { applyFluxRoot, awaitFluxReconcile, installFluxIfAbsent } from './flux-bootstrap.js';
import { rotateFluxDeployKey } from './flux-deploy-key.js';

/**
 * The key comes after the install, which makes the flux-system namespace its
 * Secret goes in, and before the root, so the first fetch already has it. The
 * sync then proves GitHub takes the new key: Flux is asked to fetch with it.
 *
 * @param {{ projectDir: string, envName: string, kubeconfigPath: string,
 *   owner: string, repo: string }} args - envName names the cluster in what
 *   the operator reads (`prod`, `prod-standby`) and in its key's title;
 *   kubeconfigPath is that cluster's kubeconfig; owner/repo is the repo Flux
 *   clones
 */
export async function handOverCluster({ projectDir, envName, kubeconfigPath, owner, repo }) {
  const env = { ...process.env, KUBECONFIG: kubeconfigPath };
  await installFluxIfAbsent({ env });
  await rotateFluxDeployKey({ env, owner, repo, envName });
  await applyFluxRoot({ env, projectDir });
  await awaitFluxReconcile({ env, envName, kubeconfigPath });
}
