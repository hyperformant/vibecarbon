/**
 * Which servers `vibecarbon update <env>` touches. Compose tiers list their
 * servers from the saved config; k8s tiers ask each cluster's master for its
 * nodes, because workers come and go with the autoscaler and are not all
 * recorded.
 */

import { isIP } from 'node:net';
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
 * @typedef {{ name: string, masterIp: string, cordoned: boolean }} Leftover a Ready node an interrupted run left marked;
 *   cordoned: still unschedulable. One that is not was uncordoned since, and only its mark is left.
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
      leftovers.push({ name: nodeName, masterIp, cordoned: node.spec?.unschedulable === true });
    const ip = node.status?.addresses?.find((a) => a.type === 'ExternalIP')?.address;
    if (!ip) {
      skipped.push({ name: nodeName, ip: null, reason: 'no public address' });
      continue;
    }
    if (typeof ip !== 'string' || !isIP(ip)) {
      skipped.push({ name: nodeName, ip: null, reason: 'reports no valid public address' });
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
 * Drops the k8s nodes whose address cannot be theirs. A node writes its own
 * ExternalIP, so a compromised one could claim another server's address and
 * have the update's root commands run there: two nodes with one address are
 * both skipped, and a node that is not a master may not claim a master's
 * recorded address.
 *
 * @param {UpdateTarget[]} targets
 * @param {string[]} masterIps the recorded master address of each cluster
 * @returns {{ kept: UpdateTarget[], dropped: Skipped[] }}
 */
function dropBorrowedAddresses(targets, masterIps) {
  const count = new Map();
  for (const t of targets) count.set(t.ip, (count.get(t.ip) ?? 0) + 1);
  const kept = [];
  const dropped = [];
  for (const t of targets) {
    if (t.role !== 'master' && masterIps.includes(t.ip))
      dropped.push({ name: t.name, ip: t.ip, reason: `reports the master's address ${t.ip}` });
    else if (count.get(t.ip) > 1)
      dropped.push({ name: t.name, ip: t.ip, reason: `two nodes report the address ${t.ip}` });
    else kept.push(t);
  }
  return { kept, dropped };
}

/**
 * @param {string} envName
 * @param {object} envConfig
 * @param {{ sshKubectl?: Function }} [deps]
 * An `AmbiguousPrimaryError` from `resolvePrimary` propagates on purpose: with
 * unclear roles, guessing which server is primary could update the wrong one.
 *
 * Nothing recorded at all lists nothing, for the caller to say so. A side
 * the tier expects but has no address for (a k8s cluster, or a compose-ha
 * server) is skipped, so the run is never read as done.
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
    const sideOf = (sv) => (sv.role === 'standby' ? 'standby' : 'primary');
    for (const sv of servers) {
      if (!sv.ip) {
        skipped.push({ name: sv.name, ip: null, reason: 'no public address' });
        continue;
      }
      targets.push({ name: sv.name, ip: sv.ip, side: sideOf(sv), role: 'server', kind: 'compose' });
    }
    // A side the tier expects but has no server on record is named, as on k8s.
    if (servers.length > 0) {
      for (const side of ['primary', 'standby']) {
        if (servers.some((sv) => sideOf(sv) === side)) continue;
        skipped.push({
          name: `${side} server`,
          ip: null,
          reason: `no recorded address for the ${side} server`,
        });
      }
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
      const masterIps = clusters.map((c) => c.masterIp).filter(Boolean);
      const { kept, dropped } = dropBorrowedAddresses(targets, masterIps);
      targets.splice(0, targets.length, ...kept);
      skipped.push(...dropped);
    }
  }
  return { tier, targets, skipped, leftovers };
}
