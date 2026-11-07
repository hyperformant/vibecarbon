/**
 * The one SSH key a k8s-ha pair shares.
 *
 * Both clusters (primary and standby) boot from a single key, registered once
 * with the provider outside Pulumi (effects/k8s-ha.js) and handed to each
 * cluster's program as `existingSshKeyId`. The sites that look the key up by
 * its operator-environment name share this helper: the upload, the destroy
 * sweep and the converge re-resolve. Cluster stacks run as <env>-primary and
 * <env>-standby, so deploy carries the uploaded name (`sharedSshKeyName`)
 * instead of deriving it again.
 */

/**
 * @param {string} projectName
 * @param {string} environment
 * @returns {string}
 */
export function haSshKeyName(projectName, environment) {
  return `${projectName}-${environment}-ha-key`;
}
