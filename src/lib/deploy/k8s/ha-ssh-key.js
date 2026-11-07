/**
 * The one SSH key a k8s-ha pair shares.
 *
 * Both clusters (primary and standby) boot from a single key, registered once
 * with the provider outside Pulumi (effects/k8s-ha.js) and handed to each
 * cluster's program as `existingSshKeyId`. Everything that has to find that
 * key by name derives it here: the upload, the destroy sweep, the converge
 * re-resolve, and the carbon-autoscaler config (whose node creates name the
 * key the new server must carry).
 */

/**
 * @param {string} projectName
 * @param {string} environment
 * @returns {string}
 */
export function haSshKeyName(projectName, environment) {
  return `${projectName}-${environment}-ha-key`;
}

/**
 * The SSH key name carbon-autoscaler must give the provider when it creates a
 * node, or undefined when the cluster owns its key (single-cluster k8s, where
 * the program creates `${clusterName}-${region}-key` and the renderer's own
 * default is right). A cluster handed a shared key id is an HA cluster.
 *
 * @param {{projectName: string, environment: string, sharedSshKeyId?: string|number|null}} args
 * @returns {string|undefined}
 */
export function autoscalerSshKeyName({ projectName, environment, sharedSshKeyId }) {
  return sharedSshKeyId ? haSshKeyName(projectName, environment) : undefined;
}
