/**
 * Which servers `vibecarbon update <env>` touches. Compose tiers list their
 * servers from the saved config; k8s tiers ask each cluster's master for its
 * nodes, because workers come and go with the autoscaler and are not all
 * recorded.
 */

import { resolvePrimary } from '../cli/resolve-primary.js';
import { isWorkerNode } from '../deploy/k8s/node-roles.js';
import { resolveTier } from '../deploy/tier-registry.js';
import { sshKeyPathFor, sshKubectl } from '../ssh.js';
import { describeSshError } from '../status/cluster-snapshot.js';

const CONTROL_PLANE = 'node-role.kubernetes.io/control-plane';

/**
 * @typedef {{ name: string, ip: string, side: 'primary' | 'standby', role: 'server' | 'master' | 'worker' | 'db', kind: 'compose' | 'k8s', masterIp?: string, nodeName?: string }} UpdateTarget
 * @typedef {{ name: string, ip: string | null, reason: string }} Skipped
 */

function nodeRole(labels) {
  if (CONTROL_PLANE in (labels ?? {})) return 'master';
  if (isWorkerNode(labels)) return 'worker';
  return 'db';
}

async function listClusterNodes({ masterIp, side, key, kubectl, targets, skipped }) {
  let nodes;
  try {
    const out = await kubectl(masterIp, key, ['get', 'nodes', '-o', 'json'], { timeout: 20_000 });
    nodes = JSON.parse(out).items ?? [];
  } catch (err) {
    skipped.push({
      name: masterIp,
      ip: masterIp,
      reason: `could not list nodes through ${masterIp}: ${describeSshError(err)}`,
    });
    return;
  }
  for (const node of nodes) {
    const nodeName = node.metadata?.name ?? '';
    const ip = node.status?.addresses?.find((a) => a.type === 'ExternalIP')?.address;
    if (!ip) {
      skipped.push({ name: nodeName, ip: null, reason: 'no public address' });
      continue;
    }
    targets.push({
      name: nodeName,
      ip,
      side,
      role: nodeRole(node.metadata?.labels),
      kind: 'k8s',
      masterIp,
      nodeName,
    });
  }
}

/**
 * @param {string} envName
 * @param {object} envConfig
 * @param {{ sshKubectl?: Function }} [deps]
 * @returns {Promise<{ tier: string, targets: UpdateTarget[], skipped: Skipped[] }>}
 */
export async function listUpdateTargets(envName, envConfig, deps = { sshKubectl }) {
  const kubectl = deps.sshKubectl ?? sshKubectl;
  const tier = resolveTier(envConfig);
  const servers = envConfig.servers ?? [];
  /** @type {UpdateTarget[]} */
  const targets = [];
  /** @type {Skipped[]} */
  const skipped = [];

  if (tier === 'compose') {
    const sv = resolvePrimary(envConfig, { env: envName })?.entry;
    if (sv?.ip) {
      targets.push({
        name: sv.name ?? 'master',
        ip: sv.ip,
        side: 'primary',
        role: 'server',
        kind: 'compose',
      });
    }
  } else if (tier === 'compose-ha') {
    for (const sv of servers) {
      if (!sv.ip) continue;
      targets.push({
        name: sv.name,
        ip: sv.ip,
        side: sv.role === 'standby' ? 'standby' : 'primary',
        role: 'server',
        kind: 'compose',
      });
    }
  } else {
    const key = sshKeyPathFor(envName);
    const clusters = [
      { masterIp: resolvePrimary(envConfig, { env: envName })?.ip, side: 'primary' },
    ];
    if (tier === 'k8s-ha')
      clusters.push({ masterIp: envConfig.ha?.standby?.masterIp, side: 'standby' });
    for (const c of clusters) {
      if (!c.masterIp) continue;
      await listClusterNodes({ ...c, key, kubectl, targets, skipped });
    }
  }
  return { tier, targets, skipped };
}
