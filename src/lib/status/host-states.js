/**
 * Which servers need a restart to finish security updates, for `vibecarbon
 * status`.
 *
 * k8s: the reporter publishes each node's state as an annotation, so this
 * reads the run's cluster snapshot (cluster-snapshot.js) and makes no call of
 * its own. Compose: one bounded ssh call per server runs the reporter with
 * --print, which works before the reporter is installed. A server whose state
 * cannot be read is reported as not reporting, with the reason, and never as
 * "no restart due".
 */
import { existsSync as fsExistsSync } from 'node:fs';
import { hostReporterScript } from '../host-reporter.js';
import { hostStateFromNode, mainPackage, parseHostState } from '../host-state.js';
import { printable } from '../printable.js';
import { sshKeyPathFor as defaultGetKey, sshRun as defaultSsh } from '../ssh.js';
import { createClusterSnapshots, describeSshError, withTimeout } from './cluster-snapshot.js';
import { planContainerTargets } from './remote-containers.js';

const READ_TIMEOUT_MS = 10_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * @typedef {import('../host-state.js').HostState} HostState
 * @typedef {{ name: string, reporting: boolean, state: HostState | null, error?: string }} HostCheck
 */

// A short lowercase reason: the ssh helpers say "ssh timeout", the row says
// what happened.
const reasonOf = (message) =>
  message
    .replace(/^cluster snapshot failed: /, '')
    .replace(/^ssh timeout$/, 'ssh timed out')
    .toLowerCase();

const silent = (name, error) => ({ name, reporting: false, state: null, error });

async function readCompose(target, keyPath, deps) {
  try {
    const out = await withTimeout(
      deps.sshRun(target.ip, keyPath, ['sh', '-s', '--', '--print'], {
        input: hostReporterScript(),
        silent: true,
        timeout: READ_TIMEOUT_MS,
        transportRetry: false,
      }),
      READ_TIMEOUT_MS,
    );
    const state = parseHostState(String(out).trim());
    if (!state) return silent(target.serverName, 'unreadable host state');
    return { name: target.serverName, reporting: true, state };
  } catch (err) {
    return silent(target.serverName, reasonOf(describeSshError(err)));
  }
}

async function readCluster(target, label, deps) {
  try {
    const snapshot = await deps.snapshots.get(target.ip);
    return snapshot.nodes.map(hostStateFromNode);
  } catch (err) {
    const reason = label ? 'could not read nodes' : reasonOf(err.message);
    return [silent(label ?? target.serverName, reason)];
  }
}

/**
 * @param {string} envName
 * @param {object} envConfig
 * @param {{ sshRun?: typeof defaultSsh, sshKeyPathFor?: typeof defaultGetKey, existsSync?: typeof fsExistsSync, snapshots?: ReturnType<typeof createClusterSnapshots> }} [deps]
 * @returns {Promise<HostCheck[]>}
 */
export async function checkHostStates(envName, envConfig, deps = {}) {
  const d = {
    sshRun: deps.sshRun ?? defaultSsh,
    sshKeyPathFor: deps.sshKeyPathFor ?? defaultGetKey,
    existsSync: deps.existsSync ?? fsExistsSync,
  };
  const targets = planContainerTargets(envConfig, { env: envName });
  if (targets.length === 0) return [];
  d.snapshots = deps.snapshots ?? createClusterSnapshots(envName, { ...deps, ...d });

  const keyPath = d.sshKeyPathFor(envName);
  const haveKey = !!keyPath && d.existsSync(keyPath);
  const standbyIp =
    envConfig.ha?.standby?.masterIp ??
    (envConfig.servers ?? []).find((s) => s.role === 'standby')?.ip;
  const groups = await Promise.all(
    targets.map((target) => {
      if (target.kind === 'k8s')
        return readCluster(
          target,
          standbyIp && target.ip === standbyIp ? 'standby cluster' : null,
          d,
        );
      if (!haveKey) return [silent(target.serverName, 'no ssh key for this environment')];
      return readCompose(target, keyPath, d).then((h) => [h]);
    }),
  );
  return groups.flat();
}

const utcDay = (iso) => {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

/**
 * The status rows for a host check: servers due a restart, and servers that
 * could not say. Nothing when every server reports and none is due. Node
 * names, packages and ssh errors come from the servers, so each row's text
 * goes through printable().
 *
 * @param {string} envName
 * @param {HostCheck[]} hosts
 * @returns {Array<{ label: string, text: string }>}
 */
export function hostStateRows(envName, hosts) {
  const rows = [];
  const due = hosts.filter((h) => h.reporting && h.state?.rebootRequired);
  if (due.length > 0) {
    const pkg = mainPackage(due.flatMap((h) => h.state.packages)) ?? 'security updates';
    const since = due
      .map((h) => h.state.since)
      .filter(Boolean)
      .sort()[0];
    rows.push({
      label: 'Restart due',
      text: printable(
        `${due.map((h) => h.name).join(', ')} ${due.length === 1 ? 'needs' : 'need'} a restart for ${pkg}${since ? ` (since ${utcDay(since)})` : ''}, run vibecarbon update ${envName} to install it`,
      ),
    });
  }
  const notInstalled = hosts.filter((h) => !h.reporting && !h.error);
  if (notInstalled.length > 0) {
    rows.push({
      label: 'Restart check',
      text: printable(
        `${notInstalled.map((h) => h.name).join(', ')} not reporting yet, run vibecarbon update ${envName} once to set it up`,
      ),
    });
  }
  // A server that could not be read is not one update fixes: say why instead.
  const byReason = new Map();
  for (const h of hosts.filter((x) => !x.reporting && x.error)) {
    byReason.set(h.error, [...(byReason.get(h.error) ?? []), h.name]);
  }
  for (const [reason, names] of byReason) {
    rows.push({
      label: 'Restart check',
      text: printable(`${names.join(', ')} could not be checked (${reason})`),
    });
  }
  return rows;
}
