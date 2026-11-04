/**
 * One read of a k8s cluster per `vibecarbon status` run.
 *
 * Status used to send each cluster master about 16 kubectl calls per run, up
 * to 7 at once, each capped at 10 s with no retry: `get pods -A` and `get
 * nodes` for the containers rows, `get jobs` for the backup row, and the same
 * db pod looked up four times (replication, the WAL archiver, the dropped-WAL
 * log read, the gap record) plus once more for its start time. On a 2-vCPU
 * master any slow moment then read as a false "ssh timeout" for a live
 * server.
 *
 * Now every row reads one snapshot: a single `kubectl get nodes,pods,jobs -A
 * -o json` over one ssh call, parsed once, memoized per cluster for the run.
 * The containers rows, node readiness, the backup job and the db pod name all
 * come from it. Execs that must run inside the db pod (psql, log reads) keep
 * their own call and take the pod name from here.
 *
 * A failed snapshot is one reason (`cluster snapshot failed: <why>`) for every
 * row that depends on it, and those rows read as unreadable, never unhealthy.
 * It is not retried within the run. The census
 * (tests/unit/status/cluster-listing-census.test.ts) keeps every other status
 * module from listing pods, nodes or jobs itself.
 */
import { existsSync as fsExistsSync } from 'node:fs';
import { DB_CONTAINER, DB_POD_SELECTOR } from '../deploy/db-workload.js';
import { sshKeyPathFor as defaultGetKey, sshKubectl as defaultKubectl } from '../ssh.js';

const NAMESPACE = 'vibecarbon';

/** The one listing: every node, and every pod and job in every namespace. */
export const SNAPSHOT_ARGV = ['get', 'nodes,pods,jobs', '-A', '-o', 'json'];

/**
 * The snapshot's bound, 20 s. The calls it replaces were bounded at 10 s each,
 * one list apiece. This one kubectl process lists three kinds back to back and
 * returns them together, so it gets the budget of the two lists the
 * containers row used to run side by side. Still bounded: a cluster that
 * cannot answer in 20 s is reported unreadable.
 */
export const SNAPSHOT_TIMEOUT_MS = 20_000;

/** Reject with `ssh timeout` when `promise` has not settled within `ms`. */
export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('ssh timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// runCommandAsync builds a failure's `message` as `Command failed: <full
// argv>\n<stderr>`: reading message's first line would echo the ssh
// invocation (including the local key path) instead of the actual reason.
// Prefer err.stderr (what the remote/ssh actually said); err.timedOut is the
// wrapper-timeout sentinel (see isTransientSshCommandError's docs in ssh.js)
// and has no stderr of its own.
//
// ssh's own chatter comes first on stderr (the "Warning: Permanently added"
// known-hosts line and the `@@@...@@@` host-key banner), so skip those before
// taking the first line, or "Connection refused" reads as a warning.
const SSH_NOISE_LINE = /^(Warning:|@+$)/;

/** One line saying why an ssh read failed, never the ssh argv. */
export function describeSshError(err) {
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

/**
 * The snapshot's List split by kind.
 *
 * @param {string} text `kubectl get nodes,pods,jobs -A -o json`
 * @returns {{ nodes: object[], pods: object[], jobs: object[] }}
 */
export function parseClusterSnapshot(text) {
  let listed;
  try {
    listed = JSON.parse(text);
  } catch {
    listed = null;
  }
  if (listed?.kind !== 'List' || !Array.isArray(listed.items)) {
    throw new Error('kubectl output unparseable');
  }
  const of = (kind) => listed.items.filter((i) => i?.kind === kind);
  return { nodes: of('Node'), pods: of('Pod'), jobs: of('Job') };
}

/**
 * The cluster snapshots of one environment, read at most once per cluster
 * (by master ip) and shared by every row that asks. A failed read rejects
 * every asker with the same `cluster snapshot failed: <why>`.
 *
 * @param {string} envName
 * @param {{ sshKubectl?: typeof defaultKubectl, sshKeyPathFor?: typeof defaultGetKey, existsSync?: typeof fsExistsSync, snapshotTimeoutMs?: number }} [deps]
 * @returns {{ get: (ip: string) => Promise<{ nodes: object[], pods: object[], jobs: object[] }> }}
 */
export function createClusterSnapshots(envName, deps = {}) {
  const sshKubectl = deps.sshKubectl ?? defaultKubectl;
  const getKey = deps.sshKeyPathFor ?? defaultGetKey;
  const exists = deps.existsSync ?? fsExistsSync;
  const timeoutMs = deps.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS;
  const byIp = new Map();

  const read = async (ip) => {
    try {
      const key = getKey(envName);
      if (!key || !exists(key)) throw new Error('no ssh key for this environment');
      const out = await withTimeout(
        sshKubectl(ip, key, SNAPSHOT_ARGV, {
          silent: true,
          timeout: timeoutMs,
          transportRetry: false,
        }),
        timeoutMs,
      );
      return parseClusterSnapshot(out);
    } catch (err) {
      throw new Error(`cluster snapshot failed: ${describeSshError(err)}`);
    }
  };

  return {
    get(ip) {
      if (!byIp.has(ip)) {
        const snapshot = read(ip);
        // Every asker awaits it; this only keeps a rejection nobody has
        // awaited yet from counting as unhandled.
        snapshot.catch(() => {});
        byIp.set(ip, snapshot);
      }
      return byIp.get(ip);
    },
  };
}

const [DB_LABEL_KEY, DB_LABEL_VALUE] = DB_POD_SELECTOR.split('=');

/**
 * The db pod: the first `app=vibecarbon-db` pod in the vibecarbon namespace,
 * as `kubectl get pods -l` would list it.
 *
 * @param {{ pods: object[] }} snapshot
 * @returns {object}
 */
export function dbPod(snapshot) {
  const pod = snapshot.pods.find(
    (p) =>
      p?.metadata?.namespace === NAMESPACE &&
      p?.metadata?.labels?.[DB_LABEL_KEY] === DB_LABEL_VALUE,
  );
  if (!pod) throw new Error(`no ${DB_POD_SELECTOR} pod in namespace ${NAMESPACE}`);
  return pod;
}

/**
 * When the db container last started (its running state), or '' when it is
 * not running.
 *
 * @param {object} pod
 * @returns {string}
 */
export function dbContainerStartedAt(pod) {
  const statuses = pod?.status?.containerStatuses ?? [];
  const db = statuses.find((cs) => cs?.name === DB_CONTAINER) ?? statuses[0];
  return db?.state?.running?.startedAt ?? '';
}
