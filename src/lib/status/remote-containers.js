/**
 * Remote container/pod health for `vibecarbon status`.
 *
 * Every deployed server (compose) or cluster master (k8s) gets a table built
 * from the platform's own verdicts — `docker ps -a` status strings or pod
 * container statuses — mapped onto the same row shape the local Docker block
 * uses, so "exited", "CrashLoopBackOff" and "starting" read the same
 * everywhere. Collection is over SSH (the deployed app's internal services
 * endpoint needs a super_admin browser session the CLI does not have),
 * best-effort and hard-bounded per server: a dead server yields a row that
 * says so, never a thrown check.
 */

import { existsSync as fsExistsSync } from 'node:fs';
import {
  getSSHKeyPath as defaultGetKey,
  sshKubectl as defaultKubectl,
  sshRun as defaultSsh,
} from '../ssh.js';
import { classifyContainer, rowsFromDockerPs, SERVICE_DISPLAY_NAMES } from './container-rows.js';

export const APP_NAMESPACE = 'vibecarbon';

/**
 * Pick the primary and standby entries of an HA `servers[]`.
 *
 * The product writes three shapes and a failover mutates two of them
 * differently, so no single field is authoritative:
 *   - effects/compose-ha.js: `{ name: '<proj>-<env>-primary', role: 'primary' }`;
 *     failoverComposeHA flips `role` in place and never renames.
 *   - orchestrator.js (compose-ha and kubernetes-ha): `{ name: 'primary' }`,
 *     no role at all.
 *   - kubernetes-ha additionally persists `ha.primary.masterIp` /
 *     `ha.standby.masterIp`, and swapHaRoles swaps THOSE, not `servers[]`.
 * So: the `ha.<side>.masterIp` match wins (it is the only thing a k8s-ha
 * failover updates), then `role` (the only thing a compose-ha failover
 * updates), then the name, then array position — the same ladder
 * failover.js's identifyServers walks. The returned entry keeps its own
 * `name`, so the Servers block can still find its rollup by name.
 *
 * @param {object} envConfig
 * @returns {object[]} `[primary, standby]`, minus any side that could not be resolved
 */
function pickHaPair(envConfig) {
  const servers = envConfig.servers || [];
  const byIp = (ip) => (ip ? servers.find((s) => s.ip === ip) : undefined);
  const byRole = (role) => servers.find((s) => s.role === role);
  const byName = (role) =>
    servers.find((s) => s.name === role || (s.name || '').endsWith(`-${role}`));
  const pick = (side, index) =>
    byIp(envConfig.ha?.[side]?.masterIp) || byRole(side) || byName(side) || servers[index];
  const primary = pick('primary', 0);
  let standby = pick('standby', 1);
  if (standby === primary) standby = servers.find((s) => s !== primary);
  return [primary, standby].filter(Boolean);
}

/**
 * Which servers to query, and how, for one environment.
 *
 * compose → its single server; compose-ha → primary + standby; kubernetes →
 * the master (workers and a dedicated supabase VM are nodes, not stacks —
 * their pods show up in the cluster table); kubernetes-ha → the primary and
 * standby cluster masters.
 *
 * @param {{deployMode?: string, servers?: Array<{name?: string, ip?: string, role?: string}>, ha?: {primary?: {masterIp?: string}, standby?: {masterIp?: string}}}} envConfig
 * @returns {Array<{serverName: string, ip: string, kind: 'compose'|'k8s'}>}
 */
export function planContainerTargets(envConfig) {
  const servers = envConfig?.servers || [];
  if (servers.length === 0) return [];
  const mode = envConfig.deployMode || 'compose';
  const target = (s, kind) => ({ serverName: s.name || s.ip || '', ip: s.ip || '', kind });

  if (mode === 'compose') return [target(servers[0], 'compose')];
  if (mode === 'compose-ha') return pickHaPair(envConfig).map((s) => target(s, 'compose'));
  if (mode === 'kubernetes-ha') return pickHaPair(envConfig).map((s) => target(s, 'k8s'));
  // kubernetes: the control plane. Roles were not always recorded, so fall
  // back to the first server, which the orchestrator writes as the master.
  const master = servers.find((s) => s.role === 'master') || servers[0];
  return [target(master, 'k8s')];
}

// Waiting reasons a pod passes through on its way up (not a retry
// classifier: nothing here decides to retry anything). They are the pod
// still rolling, so they read `starting` (retried by the e2e verify-status
// poll) rather than a verdict. Back-offs (CrashLoopBackOff,
// ImagePullBackOff) and config errors are verdicts and stay unhealthy.
const STARTUP_WAITING_REASONS = new Set(['ContainerCreating', 'PodInitializing', 'ErrImagePull']);

/**
 * Pod → row health, from phase + container statuses.
 *
 * @param {object} pod a `kubectl get pods -o json` item
 * @returns {{health: string, label: string, detail: string}}
 */
export function classifyPod(pod) {
  const phase = pod?.status?.phase || 'Unknown';
  const statuses = pod?.status?.containerStatuses || [];
  // Terminal phases first: a Succeeded one-shot can keep a stale waiting
  // status on a sidecar, and that must not turn a finished job red.
  if (phase === 'Succeeded') return { health: 'done', label: 'done', detail: '' };
  if (phase === 'Failed') {
    const terminated = statuses.find((cs) => cs.state?.terminated?.reason);
    return {
      health: 'unhealthy',
      label: 'failed',
      detail: terminated?.state.terminated.reason || '',
    };
  }
  const waiting = statuses.find((cs) => cs.state?.waiting?.reason);
  if (waiting) {
    const reason = waiting.state.waiting.reason;
    const restarts = statuses.reduce((n, cs) => n + (cs.restartCount || 0), 0);
    return {
      health: STARTUP_WAITING_REASONS.has(reason) ? 'starting' : 'unhealthy',
      label: reason,
      detail: restarts > 0 ? `restarts ${restarts}` : '',
    };
  }
  if (phase === 'Pending') {
    const sched = (pod.status?.conditions || []).find(
      (cd) => cd.type === 'PodScheduled' && cd.status === 'False',
    );
    return { health: 'starting', label: 'pending', detail: sched?.message || '' };
  }
  if (phase === 'Running') {
    const ready = statuses.filter((cs) => cs.ready).length;
    if (statuses.length > 0 && ready === statuses.length)
      return { health: 'healthy', label: 'healthy', detail: '' };
    return { health: 'starting', label: 'starting', detail: `ready ${ready}/${statuses.length}` };
  }
  return { health: 'unknown', label: 'unknown', detail: '' };
}

// Kubernetes encodes the pod-template hash with a vowel-free alphabet
// (rand.SafeEncodeString), not hex — so prefer the exact label and fall
// back to that alphabet when the label is missing.
const POD_TEMPLATE_HASH_RE = /-[bcdfghjklmnpqrstvwxz0-9]{5,10}$/;

/**
 * Name a pod by its controller: Deployment pods drop the ReplicaSet hash
 * (`app-7d9f8b5c6-abcde` → `app`), StatefulSet pods keep their ordinal
 * (`supabase-db-0`), everything else is the pod name.
 *
 * @param {object} pod
 * @returns {string}
 */
export function podDisplayName(pod) {
  const name = pod?.metadata?.name || '';
  const owner = pod?.metadata?.ownerReferences?.[0];
  if (owner?.kind !== 'ReplicaSet') return name;
  const hash = pod?.metadata?.labels?.['pod-template-hash'];
  if (hash && owner.name.endsWith(`-${hash}`)) return owner.name.slice(0, -(hash.length + 1));
  return owner.name.replace(POD_TEMPLATE_HASH_RE, '');
}

/**
 * Split a `kubectl get pods -A -o json` list into app rows (vibecarbon
 * namespace) and per-namespace rollups for everything else.
 *
 * @param {{items?: object[]}} podsJson
 * @returns {{app: Array<{name: string, container: string, health: string, label: string, detail: string, latencyMs: number}>, platform: Record<string, {healthy: number, total: number}>}}
 */
export function rowsFromPods(podsJson) {
  const app = [];
  const platform = {};
  for (const pod of podsJson?.items || []) {
    const ns = pod?.metadata?.namespace || '';
    const verdict = classifyPod(pod);
    if (ns === APP_NAMESPACE) {
      const name = podDisplayName(pod);
      app.push({ name, container: name, ...verdict, latencyMs: 0 });
      continue;
    }
    if (verdict.health === 'done') continue;
    if (!platform[ns]) {
      platform[ns] = { healthy: 0, total: 0 };
    }
    const bucket = platform[ns];
    bucket.total += 1;
    if (verdict.health === 'healthy') bucket.healthy += 1;
  }
  app.sort((a, b) => a.name.localeCompare(b.name));
  return { app, platform };
}

/**
 * @param {{items?: object[]}} nodesJson `kubectl get nodes -o json`
 * @returns {{ready: number, total: number}}
 */
export function nodeReadiness(nodesJson) {
  const items = nodesJson?.items || [];
  const ready = items.filter((n) =>
    (n?.status?.conditions || []).some((cd) => cd.type === 'Ready' && cd.status === 'True'),
  ).length;
  return { ready, total: items.length };
}

// re-exported so Task 3 can build compose rows without a second import site
export { classifyContainer, rowsFromDockerPs };

const DOCKER_PS_ARGV = [
  'docker',
  'ps',
  '-a',
  '--filter',
  null,
  '--format',
  '{{.Names}}\t{{.State}}\t{{.Status}}',
];

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('ssh timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// runCommandAsync builds a failure's `message` as `Command failed: <full
// argv>\n<stderr>` — reading message's first line would echo the ssh
// invocation (including the local key path) instead of the actual reason.
// Prefer err.stderr (what the remote/ssh actually said); err.timedOut is the
// wrapper-timeout sentinel (see isTransientSshCommandError's docs in
// ssh.js) and has no stderr of its own.
//
// ssh's own chatter comes first on stderr — the "Warning: Permanently added"
// known-hosts line and the `@@@…@@@` host-key banner — so skip those before
// taking the first line, or "Connection refused" reads as a warning.
const SSH_NOISE_LINE = /^(Warning:|@+$)/;

function describeSshError(err) {
  if (err?.timedOut) return 'ssh timeout';
  const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
  const reason = stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !SSH_NOISE_LINE.test(line));
  if (reason) return reason;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].trim();
}

async function collectCompose(target, projectName, keyPath, deps) {
  const argv = DOCKER_PS_ARGV.map((a) => (a === null ? `name=^${projectName}-` : a));
  const listing = await withTimeout(
    deps.sshRun(target.ip, keyPath, argv, {
      silent: true,
      timeout: deps.timeoutMs,
      transportRetry: false,
    }),
    deps.timeoutMs,
  );
  const rows = rowsFromDockerPs(listing, projectName).map(({ container, state, status }) => ({
    name: SERVICE_DISPLAY_NAMES[container] || container,
    container,
    ...classifyContainer(container, state, status),
    latencyMs: 0,
  }));
  return { kind: 'compose', ip: target.ip, rows };
}

async function collectK8s(target, keyPath, deps) {
  const run = (argv) =>
    withTimeout(
      deps.sshKubectl(target.ip, keyPath, argv, {
        silent: true,
        timeout: deps.timeoutMs,
        transportRetry: false,
      }),
      deps.timeoutMs,
    );
  const [podsRaw, nodesRaw] = await Promise.all([
    run(['get', 'pods', '-A', '-o', 'json']),
    run(['get', 'nodes', '-o', 'json']),
  ]);
  let pods;
  let nodes;
  try {
    pods = JSON.parse(podsRaw);
    nodes = JSON.parse(nodesRaw);
  } catch {
    throw new Error('kubectl output unparseable');
  }
  const { app, platform } = rowsFromPods(pods);
  return { kind: 'k8s', ip: target.ip, rows: app, platform, nodes: nodeReadiness(nodes) };
}

/**
 * Per-server container/pod tables for one environment. Best-effort and
 * bounded: every server resolves to a `ServerContainers`, with `error` set
 * instead of rows when it could not be read. Null when there is nothing to
 * query (no servers, no project name).
 *
 * @param {string} envName
 * @param {object} envConfig
 * @param {string|undefined} projectName
 * @param {{sshRun?: typeof defaultSsh, sshKubectl?: typeof defaultKubectl, getSSHKeyPath?: typeof defaultGetKey, existsSync?: typeof fsExistsSync, timeoutMs?: number}} [deps]
 * @returns {Promise<Record<string, {kind: 'compose'|'k8s', ip: string, rows: object[], platform?: object, nodes?: object, error?: string}>|null>}
 */
export async function checkRemoteContainers(envName, envConfig, projectName, deps = {}) {
  const d = {
    sshRun: deps.sshRun || defaultSsh,
    sshKubectl: deps.sshKubectl || defaultKubectl,
    getSSHKeyPath: deps.getSSHKeyPath || defaultGetKey,
    existsSync: deps.existsSync || fsExistsSync,
    timeoutMs: deps.timeoutMs ?? 10_000,
  };
  if (!projectName) return null;
  const targets = planContainerTargets(envConfig);
  if (targets.length === 0) return null;

  const keyPath = d.getSSHKeyPath(envName);
  const haveKey = !!keyPath && d.existsSync(keyPath);

  const results = await Promise.all(
    targets.map(async (t) => {
      const empty = (error) => [t.serverName, { kind: t.kind, ip: t.ip, rows: [], error }];
      if (!t.ip) return empty('no ip recorded');
      if (!haveKey) return empty('no ssh key');
      try {
        const value =
          t.kind === 'k8s'
            ? await collectK8s(t, keyPath, d)
            : await collectCompose(t, projectName, keyPath, d);
        return [t.serverName, value];
      } catch (err) {
        return empty(describeSshError(err));
      }
    }),
  );
  return Object.fromEntries(results);
}
