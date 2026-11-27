/**
 * A cluster node that never joins stops the command at its join deadline,
 * naming the server and saying what the provider reports about it.
 *
 * WHY (perf run 45922250720, hetzner/k8s-ha restore-deploy, 2026-11-27): the
 * primary's database server (nbg1, 167.233.172.157) was created by Pulumi and
 * never answered ssh or joined k3s. Nothing waited for it to join, so db-0 sat
 * Pending on its `dedicated=db` node selector for awaitDbRollout's whole 900 s,
 * and the failure named the pod, never the node. The rig was destroyed before
 * anyone read Hetzner's view of the server, the second time that happened
 * (the first, 2026-11-06, was a database node that died after joining).
 *
 * So every wait that needs a node other than the k3s server checks first that
 * the nodes the provisioning made have registered and are Ready
 * (awaitNodesJoined), and at the deadline the failure carries the provider's
 * own status and recent actions for each one that has not
 * (describeServersForLog, BaseProvider.describeServerForDiagnosis). It
 * diagnoses and stops: nothing is retried, rebooted or replaced.
 * tests/unit/deploy/node-join-census.test.ts holds every node wait to it.
 */

import { progressLog } from '../../cli/progress.js';
import { isWorkerNode } from './node-roles.js';

/**
 * How long a node has to register and report Ready, counted from the moment
 * the k3s server it joins is serving. The budget the failover's worker wait
 * (waitForWorkersReady, src/failover.js) has given freshly made workers since
 * it was written, now one constant for both: a deploy's nodes boot the same
 * cloud-init and join the same way, and their clock starts at the same point
 * (the deploy: its k3s-ready wait returned; the failover: its converge
 * returned, with the standby's server already up). For scale, the 57 agent
 * boots in tests/results/e2e.db took at most 154 s from kernel start to k3s
 * running (`boot.systemd.total`, 2026-11).
 */
export const NODE_JOIN_BUDGET_MS = 600_000;

/** How often the node list is read: the failover worker wait's own interval. */
export const NODE_JOIN_POLL_MS = 10_000;

/**
 * Bound on recording the provider's view: one server listing (fetchWithRetry,
 * whose own retries stop near 15 s) and then each server's reads (one attempt
 * each, under the 5 s abort of BaseProvider._readForDiagnosis). A failure
 * report does not wait longer than that on the API it describes.
 */
const PROVIDER_VIEW_BUDGET_MS = 30_000;

/** @typedef {'master' | 'db' | 'worker'} NodeRole */
/** @typedef {{role: NodeRole, ip?: string, id?: string|number}} ExpectedNode */
/**
 * @typedef {ExpectedNode & {
 *   state: 'unregistered' | 'notReady',
 *   name?: string,
 * }} UnjoinedNode
 */

/** When a deploy's join clock starts, as the failure says it. */
const JOIN_CLOCK_START = 'the k3s server came up';

/** How a node of each role is named in what the operator reads. */
const ROLE_WORDS = { master: 'k3s server', db: 'database node', worker: 'worker' };

/** A registered node's role, from the labels k3s and our agents set (node-roles.js). */
const HAS_ROLE = {
  master: (labels) => 'node-role.kubernetes.io/control-plane' in labels,
  db: (labels) => labels.dedicated === 'db',
  worker: (labels) => isWorkerNode(labels),
};

/**
 * The nodes a provisioning made, from its outputs: the k3s server, the
 * database node and every worker. The master is known by its id when the
 * outputs carry one (its address is a reserved IP on some providers).
 *
 * @param {{masterIp?: string, masterId?: string|number, dbIp?: string, workerIps?: string[]}} outputs
 * @returns {ExpectedNode[]}
 */
export function clusterNodeExpectations({ masterIp, masterId, dbIp, workerIps }) {
  return [
    { role: 'master', ip: masterIp, ...(masterId != null && { id: masterId }) },
    { role: 'db', ip: dbIp },
    ...(workerIps ?? []).map((ip) => ({ role: /** @type {const} */ ('worker'), ip })),
  ];
}

/**
 * `kubectl get nodes -o json` reduced to what the join check reads. Throws on
 * output that is not a node list: an unreadable answer is no evidence.
 *
 * @param {string} json
 * @returns {Array<{name: string, labels: Record<string, string>, addresses: string[], ready: boolean}>}
 */
export function parseNodeList(json) {
  const items = JSON.parse(String(json ?? ''))?.items;
  if (!Array.isArray(items)) throw new Error('the node list had no items');
  return items.map((item) => ({
    name: String(item?.metadata?.name ?? ''),
    labels: item?.metadata?.labels ?? {},
    addresses: (item?.status?.addresses ?? []).map((a) => a?.address).filter(Boolean),
    ready: (item?.status?.conditions ?? []).find((c) => c?.type === 'Ready')?.status === 'True',
  }));
}

/**
 * The expected nodes that have not joined: not registered at all, or
 * registered and not Ready. Pure.
 *
 * A node is matched to its server by address first (every provider's agent
 * registers its public IP as the node's ExternalIP, and Hetzner's as its
 * InternalIP too), then, for any server no address matched, by role among the
 * nodes left: the master's address is a reserved IP on some providers, and a
 * lenient match can only pass a deploy that would otherwise fail, never the
 * other way round. Each node counts once, a Ready one first.
 *
 * @param {ReturnType<typeof parseNodeList>} nodes
 * @param {ExpectedNode[]} expected
 * @returns {UnjoinedNode[]}
 */
export function unjoinedNodes(nodes, expected) {
  const used = new Set();
  const take = (matches) => {
    const free = nodes.filter((n) => !used.has(n) && matches(n));
    const pick = free.find((n) => n.ready) ?? free[0];
    if (pick) used.add(pick);
    return pick;
  };
  const byAddress = expected.map((e) => (e.ip ? take((n) => n.addresses.includes(e.ip)) : null));
  return expected.flatMap((e, i) => {
    const node = byAddress[i] ?? take((n) => HAS_ROLE[e.role](n.labels));
    if (!node) return [{ ...e, state: /** @type {const} */ ('unregistered') }];
    if (!node.ready) return [{ ...e, name: node.name, state: /** @type {const} */ ('notReady') }];
    return [];
  });
}

/** One line of an error, for a log line or a clause. */
function firstLine(err) {
  return (
    String(err?.message ?? err)
      .split('\n')
      .find((l) => l.trim())
      ?.trim()
      .slice(0, 200) ?? 'unknown error'
  );
}

/**
 * `the database node p-db (1.2.3.4)`, `the database node at 1.2.3.4`, or
 * `a worker`: whatever is known of it.
 */
function nodeLabel(node, name) {
  const role = ROLE_WORDS[node.role];
  const who = name ?? node.name;
  if (who) return `the ${role} ${who}${node.ip ? ` (${node.ip})` : ''}`;
  if (node.ip) return `the ${role} at ${node.ip}`;
  return `a ${role}`;
}

/** What each role's absence stops, said once per failure. */
const ROLE_CONSEQUENCE = {
  master: 'nothing can be scheduled without it',
  db: 'the database runs only on that node',
  worker: 'the app needs its workers',
};

/**
 * A node a command waited on did not join by its deadline. Its message names
 * each server (name, address, role), says what the provider reports about it,
 * and ends with the caller's next step.
 */
export class NodesNeverJoinedError extends Error {
  /**
   * @param {UnjoinedNode[]} missing
   * @param {{budgetS: number, since?: string, views?: Map<UnjoinedNode, ProviderViewSummary>, nextStep?: string}} opts
   */
  constructor(missing, { budgetS, since = JOIN_CLOCK_START, views = new Map(), nextStep = '' }) {
    const lines = missing.map((node) => {
      const view = views.get(node);
      const label = nodeLabel(node, view?.name);
      const what =
        node.state === 'unregistered'
          ? `never joined the cluster: ${budgetS}s after ${since} it still had not registered`
          : `joined the cluster but was not Ready ${budgetS}s after ${since}, so its kubelet is not answering`;
      return `${label} ${what}, and ${ROLE_CONSEQUENCE[node.role]}.${view?.line ? ` ${view.line}` : ''}`;
    });
    super([...lines, ...(nextStep ? [nextStep] : [])].join('\n'));
    this.name = 'NodesNeverJoinedError';
    this.missing = missing;
  }
}

/**
 * The last lines of a deploy's NodesNeverJoinedError: what to do, by hand.
 * Nothing replaces the server on its own (no retry ladder): a server that
 * never came up is the provider's to show, and deleting it lets a deploy from
 * scratch (-full: its up refreshes, finds the server gone and makes a new
 * one) build another. A node that registered keeps its name and k3s node
 * password in the cluster, and a new server under that name is refused until
 * the node is deleted.
 *
 * @param {{providerName: string, env: string}} args
 * @returns {(missing: UnjoinedNode[]) => string}
 */
export function nodesNeverJoinedNextStep({ providerName, env }) {
  return (missing) => {
    const registered = missing.filter((n) => n.state === 'notReady' && n.name).map((n) => n.name);
    return [
      `nothing was retried or replaced. Look at the server in the ${providerName} console. ` +
        'If it never came up, delete it there and deploy again from scratch, which builds a new one in its place.',
      ...(registered.length > 0
        ? [
            'a node that registered keeps its name in the cluster, so remove it first (from `vibecarbon shell`):',
            `  kubectl delete node ${registered.join(' ')}`,
          ]
        : []),
      'then run:',
      `  vibecarbon deploy ${env} -full`,
    ].join('\n');
  };
}

/**
 * Wait until every expected node has registered and is Ready, or throw
 * NodesNeverJoinedError once the deadline has passed. One read when they have
 * (the happy path costs a single `kubectl get nodes`), then one every
 * `pollMs`. At the deadline it records the provider's view of each node still
 * missing (`describeServers`) before it throws, and a failure there never
 * replaces this one.
 *
 * Reads that fail are no evidence: the last good read decides, and when no
 * read ever succeeded the wait says so instead of guessing.
 *
 * @param {object} args
 * @param {ExpectedNode[]} args.expected
 * @param {() => Promise<string>} args.readNodes - `kubectl get nodes -o json` stdout
 * @param {number} args.deadline - epoch ms
 * @param {number} [args.budgetS] - the budget the deadline came from, for the message
 * @param {string} [args.since] - what the deadline counts from, for the message
 * @param {(missing: UnjoinedNode[]) => Promise<Map<UnjoinedNode, ProviderViewSummary>>} [args.describeServers]
 * @param {string | ((missing: UnjoinedNode[]) => string)} [args.nextStep] - the
 *   failure's last lines: what to do
 * @param {number} [args.pollMs]
 * @param {() => number} [args.now]
 * @param {(ms: number) => Promise<unknown>} [args.sleep]
 * @returns {Promise<void>}
 */
export async function awaitNodesJoined({
  expected,
  readNodes,
  deadline,
  budgetS = NODE_JOIN_BUDGET_MS / 1000,
  since = JOIN_CLOCK_START,
  describeServers,
  nextStep = '',
  pollMs = NODE_JOIN_POLL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  /** @type {UnjoinedNode[] | null} */
  let missing = null;
  let lastReadError;
  let announced = false;
  for (;;) {
    try {
      missing = unjoinedNodes(parseNodeList(await readNodes()), expected);
      lastReadError = undefined;
      if (missing.length === 0) return;
    } catch (err) {
      lastReadError = err;
    }
    if (now() >= deadline) break;
    if (missing && !announced) {
      announced = true;
      progressLog(
        `[node-join] waiting for ${missing.map((n) => nodeLabel(n)).join(', ')} to join the cluster`,
      );
    }
    await sleep(Math.max(0, Math.min(pollMs, deadline - now())));
  }
  if (!missing) {
    throw new Error(
      `could not read the cluster's nodes for ${budgetS}s to see whether they joined ` +
        `(last error: ${firstLine(lastReadError)}).`,
    );
  }
  let views = new Map();
  if (describeServers) {
    try {
      views = await describeServers(missing);
    } catch (err) {
      console.error(`[node-join] could not record the provider's view: ${firstLine(err)}`);
    }
  }
  const step = typeof nextStep === 'function' ? nextStep(missing) : nextStep;
  throw new NodesNeverJoinedError(missing, { budgetS, since, views, nextStep: step });
}

/**
 * @typedef {{name?: string, line: string}} ProviderViewSummary
 *   `line` is one sentence for the failure message; the full view is logged.
 */

/** `2026-11-27T02:32:10+00:00` as `2026-11-27 02:32:10 UTC`; anything else as given. */
function when(ts) {
  const ms = Date.parse(String(ts ?? ''));
  if (!Number.isFinite(ms)) return ts ? String(ts) : 'an unknown time';
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/**
 * One sentence of the provider's view, for the failure message.
 * @param {string} providerName
 * @param {import('../../providers/base.js').ServerProviderView} view
 */
export function providerViewLine(providerName, view) {
  const state = [view.status, view.detail].filter(Boolean).join(', ') || 'no status';
  const made = view.created ? `, created ${when(view.created)}` : '';
  const place = view.location ? ` in ${view.location}` : '';
  const last = view.events?.[0];
  const action = last
    ? `; its last action, ${last.action}, is ${last.status ?? 'of unknown status'}` +
      (last.error ? ` (${last.error})` : '')
    : '';
  return `${providerName} says it is ${state}${made}${place}${action}.`;
}

/**
 * The provider view as log lines: the server, then each recent action.
 * @param {string} providerName
 * @param {UnjoinedNode} node
 * @param {import('../../providers/base.js').ServerProviderView} view
 * @returns {string[]}
 */
function providerViewLogLines(providerName, node, view) {
  const head =
    `[node-join] ${providerName}'s view of ${view.name ?? node.ip} (${node.ip ?? '?'}, ${ROLE_WORDS[node.role]}): ` +
    `status ${view.status ?? '?'}${view.detail ? ` (${view.detail})` : ''}, ` +
    `created ${view.created ?? '?'}, at ${view.location ?? '?'}, id ${view.id}`;
  const events = (view.events ?? []).map(
    (e) =>
      `[node-join]   ${e.action}: ${e.status ?? '?'}, started ${e.started ?? '?'}` +
      `${e.finished ? `, finished ${e.finished}` : ''}${e.error ? `, error ${e.error}` : ''}`,
  );
  const none = view.eventsError
    ? [`[node-join]   recent actions not read: ${view.eventsError}`]
    : view.eventsNote && events.length === 0
      ? [`[node-join]   no recent actions: ${view.eventsNote}`]
      : events.length === 0
        ? ['[node-join]   no recent actions listed']
        : [];
  return [head, ...events, ...none];
}

/**
 * Record what the provider says about each server in `nodes`, for the failure
 * log: its status, when and where it was made, and its recent actions, all
 * printed as `[node-join]` lines (stderr, which the deploy log keeps), and
 * one sentence per server for the failure message.
 *
 * A server is found by its id when known, otherwise by its public address in
 * one listing of the account's servers. Read-only, bounded by `budgetMs`, and
 * it never throws: a read that fails is a log line, and the failure it
 * describes is reported as it was.
 *
 * @param {object} args
 * @param {import('../../providers/base.js').BaseProvider} args.provider
 * @param {typeof import('../../providers/base.js').BaseProvider} args.Provider
 * @param {UnjoinedNode[]} args.nodes
 * @param {number} [args.budgetMs]
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<Map<UnjoinedNode, ProviderViewSummary>>}
 */
export async function describeServersForLog({
  provider,
  Provider,
  nodes,
  budgetMs = PROVIDER_VIEW_BUDGET_MS,
  log = (line) => console.error(line),
}) {
  /** @type {Map<UnjoinedNode, ProviderViewSummary>} */
  const views = new Map();
  const providerName = Provider?.NAME || 'the provider';
  const work = (async () => {
    let listing;
    const idOf = async (node) => {
      if (node.id != null) return node.id;
      listing ??= provider.listServersDetailed().then(({ items }) => items ?? []);
      const server = (await listing).find((s) => Provider.getPublicIP(s) === node.ip);
      if (!server) throw new Error(`no ${providerName} server has the address ${node.ip}`);
      return server.id;
    };
    await Promise.all(
      nodes.map(async (node) => {
        try {
          const view = await provider.describeServerForDiagnosis(await idOf(node));
          for (const line of providerViewLogLines(providerName, node, view)) log(line);
          views.set(node, {
            ...(view.name && { name: view.name }),
            line: providerViewLine(providerName, view),
          });
        } catch (err) {
          log(
            `[node-join] could not read ${providerName}'s view of ${node.ip ?? ROLE_WORDS[node.role]}: ${firstLine(err)}`,
          );
        }
      }),
    );
  })();
  work.catch(() => {});
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve('expired'), budgetMs);
    timer.unref?.();
  });
  const outcome = await Promise.race([work.then(() => 'done'), expired]);
  clearTimeout(timer);
  if (outcome === 'expired') {
    log(
      `[node-join] stopped reading ${providerName}'s view after ${Math.round(budgetMs / 1000)}s; what it had answered is above`,
    );
  }
  return views;
}
