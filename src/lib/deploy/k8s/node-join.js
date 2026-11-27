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
 * (describeServersForLog, BaseProvider.describeServerForDiagnosis). A deploy
 * fails on a server that never registered and on a NotReady k3s server or
 * database node; a registered worker that is NotReady is a warning line with
 * the same view (DEPLOY_NOT_READY_WARNS). It diagnoses and stops: nothing is
 * retried, rebooted or replaced.
 *
 * The provider's view cannot tell a server that never booted from one whose
 * public network is broken, or from one the command waited on at the wrong
 * address (Vultr run 45956890734, 2026-11-27: the k8s-ha standby's database
 * node timed out every ssh for 9 minutes while Vultr said it was running).
 * So the view carries the provider's own addresses for the server, the
 * failure says when its public one is not the address waited on, and each
 * server that never registered is probed from the k3s server it should have
 * joined (probeFromCluster, node-join-probe.js): ping and port 22 on its
 * private and public addresses, and the ARP entry for the private one.
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

/**
 * The roles whose node, registered but not Ready at a deploy's deadline, is a
 * warning and not a failure: workers only. What this check exists for is a
 * server that never booted, and that one never registers. A worker that
 * joined once and has gone NotReady on a long-lived cluster must not block
 * shipping an app change, and a deploy from scratch would not replace a
 * server that still exists. The k3s server and the database node are never
 * here: either one NotReady blocks the deploy's own waits, so it fails with
 * the clear message. The failover passes none: it scales onto the workers it
 * just made, so each one must be Ready.
 */
export const DEPLOY_NOT_READY_WARNS = Object.freeze(['worker']);

/** @typedef {'master' | 'db' | 'worker'} NodeRole */
/**
 * `privateIp` is the address the provisioning recorded for it on the
 * cluster's private network, where its outputs have one (the database node):
 * the probe's fallback when the provider's view lists none.
 * @typedef {{role: NodeRole, ip?: string, id?: string|number, privateIp?: string}} ExpectedNode
 */
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
 * outputs carry one (its address is a reserved IP on some providers). The
 * database node carries its private address when the outputs have one: the
 * probe's fallback on a provider whose server read lists none (Scaleway).
 *
 * @param {{masterIp?: string, masterId?: string|number, dbIp?: string, dbPrivateIp?: string, workerIps?: string[]}} outputs
 * @returns {ExpectedNode[]}
 */
export function clusterNodeExpectations({ masterIp, masterId, dbIp, dbPrivateIp, workerIps }) {
  return [
    { role: 'master', ip: masterIp, ...(masterId != null && { id: masterId }) },
    { role: 'db', ip: dbIp, ...(dbPrivateIp && { privateIp: dbPrivateIp }) },
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
 * @param {ExpectedNode & {name?: string}} node
 * @param {string} [name]
 */
export function nodeLabel(node, name) {
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
   * @param {{
   *   budgetS: number,
   *   since?: string,
   *   views?: Map<UnjoinedNode, ProviderViewSummary>,
   *   probes?: Map<UnjoinedNode, string>,
   *   nextStep?: string,
   * }} opts - `probes`: the sentence the probe from the k3s server gives each
   *   node it reached a reading for (probeFromCluster)
   */
  constructor(
    missing,
    { budgetS, since = JOIN_CLOCK_START, views = new Map(), probes = new Map(), nextStep = '' },
  ) {
    const lines = missing.map((node) => {
      const view = views.get(node);
      const label = nodeLabel(node, view?.name);
      const what =
        node.state === 'unregistered'
          ? `never joined the cluster: ${budgetS}s after ${since} it still had not registered`
          : `joined the cluster but was not Ready ${budgetS}s after ${since}, so its kubelet is not answering`;
      const probe = probes.get(node);
      return (
        `${label} ${what}, and ${ROLE_CONSEQUENCE[node.role]}.` +
        `${view?.line ? ` ${view.line}` : ''}${probe ? ` ${probe}` : ''}`
      );
    });
    super([...lines, ...(nextStep ? [nextStep] : [])].join('\n'));
    this.name = 'NodesNeverJoinedError';
    this.missing = missing;
  }
}

/**
 * The last lines of a deploy's NodesNeverJoinedError: what to do, by hand.
 * Nothing replaces a server on its own (no retry ladder).
 *
 * A server that never registered is the provider's to show: deleting it lets
 * a deploy from scratch (-full: its up refreshes, finds the server gone and
 * makes a new one) build another. A node that registered and stopped
 * answering is a server that still exists, which no deploy replaces: it is
 * restarted, or deleted together with its Node (k3s keeps the node's name and
 * password, and refuses a new server under that name until the Node is gone).
 *
 * @param {{providerName: string, env: string}} args
 * @returns {(missing: UnjoinedNode[]) => string}
 */
export function nodesNeverJoinedNextStep({ providerName, env }) {
  return (missing) => {
    const registered = missing.filter((n) => n.state === 'notReady' && n.name).map((n) => n.name);
    const lines = ['nothing was retried or replaced.'];
    if (missing.some((n) => n.state === 'unregistered')) {
      lines.push(
        `look at the server that never registered in the ${providerName} console. If it never came up, ` +
          'delete it there and deploy from scratch, which builds a new one in its place:',
        `  vibecarbon deploy ${env} -full`,
      );
    }
    if (registered.length > 0) {
      lines.push(
        'a node that registered and stopped answering is a server that still exists, and no deploy replaces it. ' +
          `Restart it in the ${providerName} console if it is stopped or hung, then deploy again:`,
        `  vibecarbon deploy ${env}`,
        'to replace it instead, delete the server in the console and its node from the cluster ' +
          '(from `vibecarbon shell`), then deploy from scratch:',
        `  kubectl delete node ${registered.join(' ')}`,
        `  vibecarbon deploy ${env} -full`,
      );
    }
    return lines.join('\n');
  };
}

/**
 * The one line a tolerated node gets (DEPLOY_NOT_READY_WARNS): registered,
 * not Ready at the deadline, and the command goes on without it.
 *
 * @param {UnjoinedNode} node
 * @param {{budgetS: number, since: string, view?: ProviderViewSummary}} args
 */
function notReadyWarningLine(node, { budgetS, since, view }) {
  return (
    `[node-join] ${nodeLabel(node, view?.name)} is registered but was not Ready ${budgetS}s after ${since}, ` +
    'so its kubelet is not answering. The deploy goes on without it: it joined once, and ' +
    `deploying again would not replace a server that still exists.${view?.line ? ` ${view.line}` : ''}`
  );
}

/**
 * Wait until every expected node has registered and is Ready, or throw
 * NodesNeverJoinedError once the deadline has passed. A node of a role in
 * `warnNotReady` that registered but is not Ready by then is one warning line
 * (`onWarn`) instead, and does not fail the wait; one that never registered
 * always does. One read when they have
 * (the happy path costs a single `kubectl get nodes`), then one every
 * `pollMs`. At the deadline it records the provider's view of each node still
 * missing (`describeServers`) before it throws, and a failure there never
 * replaces this one. Then each node that never registered is probed from the
 * k3s server (`probeFromCluster`, given those nodes and the views just read),
 * and each sentence it returns ends that node's line; a probe that fails is
 * one log line, and the failure is thrown as it would be without it.
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
 * @param {(
 *   unregistered: UnjoinedNode[],
 *   views: Map<UnjoinedNode, ProviderViewSummary>,
 * ) => Promise<Map<UnjoinedNode, string>>} [args.probeFromCluster] - the probe
 *   from the k3s server (clusterProbe, node-join-probe.js)
 * @param {string | ((missing: UnjoinedNode[]) => string)} [args.nextStep] - the
 *   failure's last lines: what to do
 * @param {readonly NodeRole[]} [args.warnNotReady] - roles whose registered
 *   but NotReady node warns at the deadline (DEPLOY_NOT_READY_WARNS); none by default
 * @param {(line: string) => void} [args.onWarn]
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
  probeFromCluster,
  nextStep = '',
  warnNotReady = [],
  onWarn = (line) => progressLog(line),
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
  // A node that registered has a kubelet that answered; only one that never
  // did needs reading from inside the cluster's network.
  let probes = new Map();
  const unregistered = missing.filter((n) => n.state === 'unregistered');
  if (probeFromCluster && unregistered.length > 0) {
    try {
      probes = await probeFromCluster(unregistered, views);
    } catch (err) {
      console.error(`[node-join] could not probe from the k3s server: ${firstLine(err)}`);
    }
  }
  // A registered node of a tolerated role is a warning; anything that never
  // registered, and a NotReady k3s server or database node, fails.
  const tolerated = (n) => n.state === 'notReady' && warnNotReady.includes(n.role);
  for (const node of missing.filter(tolerated)) {
    onWarn(notReadyWarningLine(node, { budgetS, since, view: views.get(node) }));
  }
  const failing = missing.filter((n) => !tolerated(n));
  if (failing.length === 0) return;
  const step = typeof nextStep === 'function' ? nextStep(failing) : nextStep;
  throw new NodesNeverJoinedError(failing, { budgetS, since, views, probes, nextStep: step });
}

/**
 * @typedef {{name?: string, line: string, publicIp?: string|null, privateIp?: string|null}} ProviderViewSummary
 *   `line` is one sentence for the failure message; the full view is logged.
 *   The addresses are the provider's own, for the probe from the k3s server.
 */

/** `2026-11-27T02:32:10+00:00` as `2026-11-27 02:32:10 UTC`; anything else as given. */
function when(ts) {
  const ms = Date.parse(String(ts ?? ''));
  if (!Number.isFinite(ms)) return ts ? String(ts) : 'an unknown time';
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/**
 * One sentence of the provider's view, for the failure message, and one more
 * when the public address the provider lists is not the one the command
 * waited on (`node.ip`): case 3 of a server that never answers, the wrong
 * address. Not for the k3s server, whose recorded address is the cluster's
 * reserved IP on some providers (Linode, Scaleway), which need not be the
 * one the provider lists first.
 * @param {string} providerName
 * @param {import('../../providers/base.js').ServerProviderView} view
 * @param {ExpectedNode} [node]
 */
export function providerViewLine(providerName, view, node) {
  const state = [view.status, view.detail].filter(Boolean).join(', ') || 'no status';
  const made = view.created ? `, created ${when(view.created)}` : '';
  const place = view.location ? ` in ${view.location}` : '';
  const last = view.events?.[0];
  const action = last
    ? `; its last action, ${last.action}, is ${last.status ?? 'of unknown status'}` +
      (last.error ? ` (${last.error})` : '')
    : '';
  return `${providerName} says it is ${state}${made}${place}${action}.${addressMismatch(providerName, view, node)}`;
}

/** The sentence providerViewLine adds when the provider's public address is not `node.ip`. */
function addressMismatch(providerName, view, node) {
  if (!node?.ip || node.role === 'master' || view.publicIp === undefined) return '';
  if (view.publicIp === node.ip) return '';
  if (!view.publicIp) {
    return ` ${providerName} lists no public address for it, though this command waited on ${node.ip}.`;
  }
  return (
    ` ${providerName} lists its public address as ${view.publicIp}, not ${node.ip}, ` +
    'the address this command waited on.'
  );
}

/**
 * The provider view as log lines: the server, then each recent action. The
 * plan rides on the server line when the provider's read carries one.
 * @param {string} providerName
 * @param {ExpectedNode} node
 * @param {import('../../providers/base.js').ServerProviderView} view
 * @param {string} [tag] - the log tag (`node-join`; `db` for a refused volume attach)
 * @returns {string[]}
 */
function providerViewLogLines(providerName, node, view, tag = 'node-join') {
  const head =
    `[${tag}] ${providerName}'s view of ${view.name ?? node.ip} (${node.ip ?? '?'}, ${ROLE_WORDS[node.role]}): ` +
    `status ${view.status ?? '?'}${view.detail ? ` (${view.detail})` : ''}, ` +
    `created ${view.created ?? '?'}, at ${view.location ?? '?'}, id ${view.id}, ` +
    `public ${view.publicIp ?? 'none'}, ` +
    `private ${view.privateIp ?? (view.privateIpNote ? `unknown (${view.privateIpNote})` : 'none')}` +
    (view.plan ? `, plan ${view.plan}` : '');
  const events = (view.events ?? []).map(
    (e) =>
      `[${tag}]   ${e.action}: ${e.status ?? '?'}, started ${e.started ?? '?'}` +
      `${e.finished ? `, finished ${e.finished}` : ''}${e.error ? `, error ${e.error}` : ''}`,
  );
  const none = view.eventsError
    ? [`[${tag}]   recent actions not read: ${view.eventsError}`]
    : view.eventsNote && events.length === 0
      ? [`[${tag}]   no recent actions: ${view.eventsNote}`]
      : events.length === 0
        ? [`[${tag}]   no recent actions listed`]
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
 * @template {ExpectedNode} N
 * @param {object} args
 * @param {import('../../providers/base.js').BaseProvider} args.provider
 * @param {typeof import('../../providers/base.js').BaseProvider} args.Provider
 * @param {N[]} args.nodes
 * @param {number} [args.budgetMs]
 * @param {(line: string) => void} [args.log]
 * @param {string} [args.tag] - the log tag: `node-join` for a node that never
 *   joined, `db` for the database server of a refused volume attach
 *   (attach-refusal-view.js)
 * @returns {Promise<Map<N, ProviderViewSummary>>}
 */
export async function describeServersForLog({
  provider,
  Provider,
  nodes,
  budgetMs = PROVIDER_VIEW_BUDGET_MS,
  log = (line) => console.error(line),
  tag = 'node-join',
}) {
  /** @type {Map<N, ProviderViewSummary>} */
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
          for (const line of providerViewLogLines(providerName, node, view, tag)) log(line);
          views.set(node, {
            ...(view.name && { name: view.name }),
            line: providerViewLine(providerName, view, node),
            publicIp: view.publicIp ?? null,
            privateIp: view.privateIp ?? null,
          });
        } catch (err) {
          log(
            `[${tag}] could not read ${providerName}'s view of ${node.ip ?? ROLE_WORDS[node.role]}: ${firstLine(err)}`,
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
      `[${tag}] stopped reading ${providerName}'s view after ${Math.round(budgetMs / 1000)}s; what it had answered is above`,
    );
  }
  return views;
}
