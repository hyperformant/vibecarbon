/**
 * Hand one cluster to Flux from the operator's machine: install Flux, give it
 * this cluster's own read-only deploy key, put the app image's pull Secret in
 * place, check the app image Flux rolls to is built, apply the root objects,
 * then wait for the first sync. The cluster's half of `configure cicd <env>`,
 * run once per cluster (a k8s-ha primary and standby each get their own run,
 * and their own key). The steps are flux-bootstrap.js's, flux-deploy-key.js's
 * and ghcr-pull-secret.js's.
 */

import { applyFluxRoot, awaitFluxReconcile, installFluxIfAbsent } from './flux-bootstrap.js';
import { rotateFluxDeployKey } from './flux-deploy-key.js';
import { assertAppImageBuilt, ensureGhcrPullSecretOn } from './ghcr-pull-secret.js';

/**
 * The key comes after the install, which makes the flux-system namespace its
 * Secret goes in, and before the root, so the first fetch already has it. The
 * pull Secret also comes before the root, so the app pods the first sync
 * starts pull with it. The app image check comes after the pull Secret, so a
 * rerun once the image is built finds the stored token and asks nothing, and
 * before the root, so Flux never rolls the app to an image that is not there.
 * The sync then proves GitHub takes the new key: Flux is asked to fetch with
 * it.
 *
 * @param {{ projectDir: string, envName: string, kubeconfigPath: string,
 *   owner: string, repo: string,
 *   ghcrPull: import('./ghcr-pull-secret.js').GhcrPull,
 *   warn?: (line: string) => void }} args - envName names the cluster in what
 *   the operator reads (`prod`, `prod-standby`) and in its key's title;
 *   kubeconfigPath is that cluster's kubeconfig; owner/repo is the repo Flux
 *   clones; ghcrPull is the pull credential configure cicd resolved once for
 *   every cluster of the environment; warn takes what a step says and carries
 *   on past (an old deploy key it could not remove), for the caller to print
 *   once its spinner is done
 */
export async function handOverCluster({
  projectDir,
  envName,
  kubeconfigPath,
  owner,
  repo,
  ghcrPull,
  warn,
}) {
  const env = { ...process.env, KUBECONFIG: kubeconfigPath };
  await installFluxIfAbsent({ env });
  await rotateFluxDeployKey({ env, owner, repo, envName, ...(warn && { warn }) });
  await ensureGhcrPullSecretOn({ env, pull: ghcrPull });
  await assertAppImageBuilt({ owner, repo, pull: ghcrPull, envName });
  await applyFluxRoot({ env, projectDir });
  await awaitFluxReconcile({ env, envName, kubeconfigPath });
}
