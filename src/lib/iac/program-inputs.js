/**
 * The inputs every Pulumi program (iac/programs/*) reads from its config the
 * same way, and the one output they all shape the same way. No Pulumi import:
 * a program's own resources stay in the program.
 */

import { isIPv4 } from 'node:net';
import { haStacksFrom } from '../deploy/standby-types.js';
import { environmentForStack } from '../environment-name.js';
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

/** Kubernetes node names are DNS labels: 63 characters at most. */
const K8S_NODE_NAME_MAX = 63;

/**
 * Refuse, before any resource exists, a cluster whose nodes Kubernetes could
 * not name, on a provider whose server name becomes each node's hostname and
 * so its k8s node name (see the boot scripts). The longest is an autoscaler
 * worker: `<cluster>-ca-` plus 8 random characters.
 * @param {string} clusterName stackIdentity's name
 * @param {string} providerName the provider's display name (Provider.NAME)
 */
export function requireK8sNodeNamesFit(clusterName, providerName) {
  const longestNodeName = `${clusterName}-ca-xxxxxxxx`;
  if (longestNodeName.length > K8S_NODE_NAME_MAX) {
    throw new Error(
      `Kubernetes on ${providerName} cannot give this cluster's nodes a node name: the longest, ` +
        `"${clusterName}-ca-<8 characters>", is ${longestNodeName.length} characters and ` +
        `Kubernetes allows ${K8S_NODE_NAME_MAX}. Use a shorter project or environment name.`,
    );
  }
}

/**
 * The k8s-ha replication peer of one cluster stack: the OTHER side's recorded
 * database node public IPv4, which the stack's program declares as its UDP
 * 51821 allow rule (`config.replicationPeerIp`). The deploy writes that rule
 * over REST (openReplicationFirewallForPeers), and every up resets an inline
 * firewall to what its program declares, so a program that left it out
 * dropped it on every scale and failover. Declared from the record, it is
 * what REST wrote, and an up plans no firewall change.
 *
 * Keyed by stack, never by role: a failover swaps `ha.primary` and
 * `ha.standby`, and the stacks keep their names (haStacksFrom). A record
 * without stacks (one written before failover recorded them) maps the way the
 * deploy and scale resolve it: `<env>-primary` plays primary, `<env>-standby`
 * standby, the environment being `stackName` without its suffix. Undefined,
 * so the program declares no rule and the deploy's REST step opens it, when
 * the environment is not HA, `stackName` is neither side, or the peer has no
 * address on record yet (the first deploy).
 *
 * @param {object|undefined} envConfig the environment's record in .vibecarbon.json
 * @param {string} stackName the Pulumi stack the program is for
 * @returns {string|undefined}
 * @throws {Error} the recorded address is not an IPv4 address (a hand edit)
 */
export function replicationPeerIpFor(envConfig, stackName) {
  const sides = haStacksFrom(envConfig);
  if (!sides) return undefined;
  const environment = environmentForStack(stackName);
  const primaryStack = sides.primary.stack ?? `${environment}-primary`;
  const standbyStack = sides.standby.stack ?? `${environment}-standby`;
  const peerRole =
    stackName === primaryStack ? 'standby' : stackName === standbyStack ? 'primary' : null;
  if (!peerRole) return undefined;
  const peerIp = envConfig.ha[peerRole]?.dbIp;
  if (peerIp == null || peerIp === '') return undefined;
  if (typeof peerIp !== 'string' || !isIPv4(peerIp)) {
    throw new Error(
      `ha.${peerRole}.dbIp ${JSON.stringify(peerIp)} in environment ${environment} ` +
        `is not an IPv4 address (the replication peer of stack ${stackName}; set it to that ` +
        "database node's public IPv4 in .vibecarbon.json, or delete it and vibecarbon deploy " +
        'records it again)',
    );
  }
  return peerIp;
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
