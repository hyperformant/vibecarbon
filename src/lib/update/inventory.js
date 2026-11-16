/**
 * Which servers `vibecarbon update <env>` touches. Compose tiers list their
 * servers from the saved config; k8s tiers ask each cluster's master for its
 * nodes, because workers come and go with the autoscaler and are not all
 * recorded.
 */

import { resolvePrimary } from '../cli/resolve-primary.js';
import { isWorkerNode } from '../deploy/k8s/node-roles.js';
import { resolveTier } from '../deploy/tier-registry.js';
import { hostStateFromNode } from '../host-state.js';
import { sshKeyPathFor, sshKubectl } from '../ssh.js';
import { describeSshError } from '../status/cluster-snapshot.js';

const CONTROL_PLANE = 'node-role.kubernetes.io/control-plane';

/** The annotation `update` puts on a node it cordons, so a later run can release it. */
export const CORDON_MARK = 'vibecarbon.dev/cordoned-by-update';

/**
 * @typedef {{ name: string, ip: string, side: 'primary' | 'standby', role: 'server' | 'master' | 'worker' | 'db', kind: 'compose' | 'k8s', masterIp?: string, nodeName?: string, reporting?: boolean }} UpdateTarget
 *   reporting (k8s): whether the node carries readable host state from the reporter.
 * @typedef {{ name: string, ip: string | null, reason: string }} Skipped
 * @typedef {{ name: string, masterIp: string }} Leftover a Ready node an interrupted run left cordoned
 */

function nodeRole(labels) {
  if (CONTROL_PLANE in (labels ?? {})) return 'master';
  if (isWorkerNode(labels)) return 'worker';
  return 'db';
}

const isReady = (node) =>
  node?.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false;

async function listClusterNodes({ masterIp, side, key, kubectl, targets, skipped, leftovers }) {
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
    // Read only: the plan shows it, and only a confirmed run releases it.
    if (CORDON_MARK in (node.metadata?.annotations ?? {}) && isReady(node))
      leftovers.push({ name: nodeName, masterIp });
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
      reporting: hostStateFromNode(node).reporting,
    });
  }
}

/**
 * @param {string} envName
 * @param {object} envConfig
 * @param {{ sshKubectl?: Function }} [deps]
 * An `AmbiguousPrimaryError` from `resolvePrimary` propagates on purpose: with
 * unclear roles, guessing which server is primary could update the wrong one.
 *
 * Nothing recorded at all lists nothing, for the caller to say so. A k8s
 * side the tier expects but has no address for is skipped, so the run is
 * never read as done.
 *
 * @returns {Promise<{ tier: string, targets: UpdateTarget[], skipped: Skipped[], leftovers: Leftover[] }>}
 */
export async function listUpdateTargets(envName, envConfig, deps = { sshKubectl }) {
  const kubectl = deps.sshKubectl ?? sshKubectl;
  const tier = resolveTier(envConfig);
  const servers = envConfig.servers ?? [];
  /** @type {UpdateTarget[]} */
  const targets = [];
  /** @type {Skipped[]} */
  const skipped = [];
  /** @type {Leftover[]} */
  const leftovers = [];

  if (tier === 'compose') {
    const sv = resolvePrimary(envConfig, { env: envName })?.entry;
    if (sv && !sv.ip) {
      skipped.push({ name: sv.name ?? 'master', ip: null, reason: 'no public address' });
    } else if (sv) {
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
      if (!sv.ip) {
        skipped.push({ name: sv.name, ip: null, reason: 'no public address' });
        continue;
      }
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
    if (clusters.some((c) => c.masterIp)) {
      for (const c of clusters) {
        if (!c.masterIp) {
          skipped.push({
            name: `${c.side} cluster`,
            ip: null,
            reason: `no recorded address for the ${c.side} cluster`,
          });
          continue;
        }
        await listClusterNodes({ ...c, key, kubectl, targets, skipped, leftovers });
      }
    }
  }
  return { tier, targets, skipped, leftovers };
}
