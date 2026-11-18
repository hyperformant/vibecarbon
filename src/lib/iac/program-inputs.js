/**
 * The inputs every Pulumi program (iac/programs/*) reads from its config the
 * same way, and the one output they all shape the same way. No Pulumi import:
 * a program's own resources stay in the program.
 */

import { SERVER_OWNER_LABELS } from './create-timeout.js';

const OPERATOR_CIDRS_HINT =
  'no default; pass operatorCidrs from .vibecarbon.json or set ALLOWED_SSH_IPS=...';

/**
 * The stack's name, `<project>-<environment>` (a k8s program's cluster
 * name), and the labels its resources carry: the ownership labels
 * (SERVER_OWNER_LABELS) before the caller's, as every caller has always
 * passed them, so the keys come in the same order.
 * @param {{projectName: string, environment: string, labels?: Record<string, string>}} config
 * @returns {{name: string, labels: Record<string, string>}}
 */
export function stackIdentity(config) {
  return {
    name: `${config.projectName}-${config.environment}`,
    labels: {
      project: config.projectName,
      environment: config.environment,
      ...SERVER_OWNER_LABELS,
      ...(config.labels ?? {}),
    },
  };
}

/**
 * The operator-IP firewall lock (H-2). The deploy flow fills these from
 * projectConfig.operatorCidrs; an empty list means nothing can SSH in (or,
 * for k8s, reach the API), so a program refuses to build rather than
 * silently apply an open `0.0.0.0/0` default.
 * @param {{allowedSshIps?: string[], allowedK8sApiIps?: string[]}} config
 * @param {{k8sApi?: boolean}} [options] - k8sApi: the k8s API allowlist is required too
 */
export function requireOperatorCidrs(config, { k8sApi = false } = {}) {
  if (!config.allowedSshIps?.length) {
    throw new Error(`allowedSshIps required (${OPERATOR_CIDRS_HINT})`);
  }
  if (k8sApi && !config.allowedK8sApiIps?.length) {
    throw new Error(`allowedK8sApiIps required (${OPERATOR_CIDRS_HINT})`);
  }
}

/**
 * The frozen `sshKeyId` output: the caller's existing key id as given, or the
 * created key's id as a string Output.
 * @param {string|{apply: (fn: (id: unknown) => string) => unknown}} sshKeyId
 * @returns {unknown} string | Output<string>
 */
export function sshKeyIdOutput(sshKeyId) {
  return typeof sshKeyId === 'string' ? sshKeyId : sshKeyId.apply((id) => String(id));
}
