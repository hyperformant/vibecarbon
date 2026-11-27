/**
 * At the join deadline, a server that never registered is probed from the
 * k3s server it should have joined: ping and a TCP connect to port 22 on its
 * private and public addresses, and the k3s server's ARP entry for the
 * private one. What comes back is logged as `[node-join] from the k3s
 * server: ...` lines, and one sentence reading those facts ends that node's
 * line in the failure (awaitNodesJoined's `probeFromCluster`, node-join.js).
 *
 * WHY (Vultr run 45956890734, 2026-11-27 08:16Z): the k8s-ha standby's
 * database node at 137.220.58.74 timed out every ssh from 3 to 12 minutes
 * after it was created and never registered, while Vultr said `status ok
 * (power running, subscription active)` and the standby master beside it, in
 * the same firewall group and VPC, was fine. Hetzner lost a database node the
 * same way twice (2026-11-06, 2026-11-27). The provider's view cannot tell
 * which of these it was:
 *
 *   1. the server never booted, or has no network at all;
 *   2. the guest is up but its public network is broken;
 *   3. the command waited on the wrong address (node-join.js says so from
 *      the provider's own addresses).
 *
 * The k3s server is up by then (the deploy's join clock starts when it is,
 * and the failover's standby master is), and it sits on the server's private
 * network, so it can tell 1 from 2. The rig is destroyed at teardown, so this
 * is read on the failure path or never.
 *
 * What the sentences may claim rests on the cluster firewall, the same on
 * all five providers: ping and TCP 22 from the private network pass (DO,
 * Linode and Vultr admit ICMP and TCP from the VPC; Hetzner's firewall and
 * Scaleway's security group never filter the private network), and from
 * outside it no ping passes and port 22 only from the operator's CIDRs. So a
 * silent private address means the server is not up there, and a silent
 * public one means nothing. tests/unit/deploy/node-join-probe-firewall-census.test.ts
 * runs every k8s program and fails when its firewall stops saying so.
 *
 * Diagnosis only: one ssh to the k3s server, bounded at
 * CLUSTER_PROBE_BUDGET_MS, never retried, and it never throws into the
 * failure it describes. Nothing is rebooted or replaced (no retry ladder).
 */

import { isIPv4 } from 'node:net';
import { shEscape } from '../../shell.js';
import { nodeLabel } from './node-join.js';

/** The bound on the whole probe: one ssh to the k3s server and every check on it. */
export const CLUSTER_PROBE_BUDGET_MS = 20_000;

/** Pings sent to each address, each waited on for PING_WAIT_S. */
const PINGS = 2;
const PING_WAIT_S = 2;

/** The bound on each TCP connect to port 22, under `timeout`. */
const PORT_CHECK_S = 3;

/**
 * How long past its own bound the probe waits on a `run` that ignores it,
 * so the run's own timeout, which keeps what was printed, ends it first.
 */
const RUN_GRACE_MS = 5_000;

/** @typedef {'private' | 'public'} ProbeKind */
/** @typedef {'open' | 'refused' | 'timeout' | 'unreachable' | 'error'} Port22 */
/**
 * What the k3s server saw of one address.
 * @typedef {object} ProbeResult
 * @property {ProbeKind} kind
 * @property {string} address
 * @property {number|null} pings - replies to PINGS pings; null when ping could not run
 * @property {Port22} port22 - the connect's outcome: `timeout` is no answer
 *   in PORT_CHECK_S, `unreachable` no route (an ARP failure on the link reads so)
 * @property {string|null} neighbour - the ARP state of a private address
 *   (`REACHABLE`, `STALE`, `INCOMPLETE`, `FAILED`, ...); null for none, and
 *   for a public address, which is never on the link
 */

const KINDS = new Set(['private', 'public']);
const PORT22 = new Set(['open', 'refused', 'timeout', 'unreachable', 'error']);

/**
 * One address's checks, as a shell function. Each check's raw outcome is
 * printed on one line, so a run its bound stops still keeps the addresses
 * already done. The connect runs in its own bash (only bash has /dev/tcp),
 * with the address as its argument, never in its text.
 */
const PROBE_FUNCTION = [
  'probe() {',
  '  kind=$1 addr=$2',
  `  pings=$(ping -c ${PINGS} -W ${PING_WAIT_S} -q "$addr" 2>&1 | sed -n ${shEscape(
    's/.*transmitted, \\([0-9][0-9]*\\) [a-z ]*received.*/\\1/p',
  )})`,
  '  [ -n "$pings" ] || pings=error',
  `  err=$(timeout ${PORT_CHECK_S} bash -c 'exec 3<>"/dev/tcp/$1/22"' probe "$addr" 2>&1 >/dev/null)`,
  '  rc=$?',
  '  case $rc in',
  '    0) port=open ;;',
  '    124) port=timeout ;;',
  '    *) case $err in',
  '         *refused*) port=refused ;;',
  "         *unreachable*|*'No route'*) port=unreachable ;;",
  '         *) port=error ;;',
  '       esac ;;',
  '  esac',
  '  neigh=-',
  '  if [ "$kind" = private ]; then',
  `    neigh=$(ip neigh show "$addr" 2>/dev/null | awk 'NR == 1 { print $NF }')`,
  '    [ -n "$neigh" ] || neigh=none',
  '  fi',
  '  echo "probe $kind $addr ping=$pings tcp22=$port neigh=$neigh"',
  '}',
];

/**
 * An address the k3s server can probe for another server: an IPv4 literal,
 * and not one that reaches the k3s server itself. Vultr lists `0.0.0.0` as
 * an instance's main IP until it assigns one, and a ping to it, or to a
 * loopback address, is answered by the sender.
 * @param {unknown} address
 * @returns {boolean}
 */
function isProbeable(address) {
  const a = String(address ?? '');
  if (!isIPv4(a)) return false;
  const first = Number(a.split('.')[0]);
  return first !== 0 && first !== 127;
}

/**
 * The script the k3s server runs (`sh -s`): every address at once, each its
 * own job, so the whole probe takes about PINGS + PING_WAIT_S + PORT_CHECK_S
 * seconds, not that for each. Only probeable IPv4 literals reach it.
 *
 * @param {Array<{kind: ProbeKind, address: string}>} targets
 * @returns {string}
 */
export function clusterProbeScript(targets) {
  const jobs = targets.map(({ kind, address }) => {
    if (!KINDS.has(kind)) throw new Error(`clusterProbeScript: unknown kind ${kind}`);
    if (!isIPv4(String(address))) {
      throw new Error(`clusterProbeScript: ${address} is not an IPv4 address`);
    }
    if (!isProbeable(address)) {
      throw new Error(`clusterProbeScript: ${address} is not an address the k3s server can probe`);
    }
    return `probe ${kind} ${shEscape(address)} &`;
  });
  return [...PROBE_FUNCTION, ...jobs, 'wait', ''].join('\n');
}

/**
 * The probe lines in what the script printed; anything else (an ssh warning,
 * a line cut off) is ignored.
 * @param {string} stdout
 * @returns {ProbeResult[]}
 */
export function parseProbeOutput(stdout) {
  const results = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const m = line
      .trim()
      .match(/^probe (private|public) (\S+) ping=(\d+|error) tcp22=(\S+) neigh=(\S+)$/);
    if (!m || !isIPv4(m[2]) || !PORT22.has(m[4])) continue;
    results.push({
      kind: /** @type {ProbeKind} */ (m[1]),
      address: m[2],
      pings: m[3] === 'error' ? null : Number(m[3]),
      port22: /** @type {Port22} */ (m[4]),
      neighbour: m[5] === '-' || m[5] === 'none' ? null : m[5],
    });
  }
  return results;
}

/** ARP states that say nothing on the link answered for the address. */
const ARP_UNANSWERED = new Set(['INCOMPLETE', 'FAILED']);

const PORT22_WORDS = {
  open: 'port 22 is open',
  refused: 'port 22 refused the connection',
  timeout: `port 22 gave no answer in ${PORT_CHECK_S}s`,
  unreachable: 'there is no route to it',
  error: 'the port 22 check could not run',
};

/** Something on the address answered: a ping reply, an open port, or a refusal from its kernel. */
const answered = (r) => (r.pings ?? 0) > 0 || r.port22 === 'open' || r.port22 === 'refused';

/** Neither check could run its tool, so the result says nothing. */
const couldNotRun = (r) => r.pings === null && r.port22 === 'error';

/** `2 of 2 pings came back, port 22 is open and ARP for it is REACHABLE`. */
function facts(r) {
  const parts = [
    r.pings === null
      ? 'ping could not run'
      : r.pings === 0
        ? 'no ping came back'
        : `${r.pings} of ${PINGS} pings came back`,
    PORT22_WORDS[r.port22],
  ];
  if (r.neighbour) parts.push(`ARP for it is ${r.neighbour}`);
  return parts.length > 2
    ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
    : parts.join(' and ');
}

/** What the public address's silence is worth: the firewall drops both checks there. */
const PUBLIC_SILENCE =
  'which the cluster firewall would cause anyway (it drops ping there and admits port 22 only ' +
  'from the addresses `vibecarbon access` lists)';

/**
 * The one sentence a node's failure line ends with, read from what the k3s
 * server saw: the private address decides when it was checked, and the
 * public one only adds what it can (see the module doc for why silence there
 * means nothing). Null when there is nothing to say.
 *
 * @param {object} args
 * @param {ProbeResult} [args.priv]
 * @param {ProbeResult} [args.pub]
 * @param {string} args.providerName
 * @param {string} [args.privateAddress] - the private address probed, when
 *   one was: with no `priv`, its check reported nothing (a run stopped early)
 * @returns {string|null}
 */
export function probeSentence({ priv, pub, providerName, privateAddress }) {
  if (priv && !couldNotRun(priv)) {
    const at = `From the k3s server, its private address ${priv.address}`;
    if (answered(priv)) {
      return `${at} answers (${facts(priv)}), so the server is up: its public network or its boot is the problem.`;
    }
    if (pub && answered(pub)) {
      return (
        `From the k3s server, its public address ${pub.address} answers (${facts(pub)}) but its ` +
        `private address ${priv.address} does not (${facts(priv)}), so the server is up and its ` +
        'private network is the problem.'
      );
    }
    if (ARP_UNANSWERED.has(priv.neighbour ?? '')) {
      return (
        `${at} does not answer (${facts(priv)}): nothing on the private network holds that ` +
        'address, so the server never brought up its network or never booted.'
      );
    }
    const admitted = 'though the cluster firewall lets ping and port 22 through there';
    if (priv.neighbour) {
      return `${at} does not answer (${facts(priv)}), ${admitted}: a machine holds the address, but nothing on it answers.`;
    }
    return `${at} does not answer (${facts(priv)}), ${admitted}, so the server never booted or never brought up its private network.`;
  }
  const lead = priv
    ? `From the k3s server, the check of its private address ${priv.address} could not run (${facts(priv)})`
    : privateAddress
      ? `From the k3s server, the check of its private address ${privateAddress} reported nothing`
      : `${providerName} lists no private address for it`;
  if (!pub || couldNotRun(pub))
    return priv || privateAddress ? `${lead}, so it shows nothing.` : null;
  if (answered(pub)) {
    return `${lead}, and its public address ${pub.address} answers the k3s server (${facts(pub)}), so the server is up.`;
  }
  return (
    `${lead}, and its public address ${pub.address} does not answer the k3s server ` +
    `(${facts(pub)}), ${PUBLIC_SILENCE}, so this cannot tell whether the server is up.`
  );
}

/**
 * Why a run failed, in one line: its bound, or ssh's own words (the first
 * stderr line that is not a warning), never its argv.
 */
function whyNot(err, budgetS) {
  if (err?.timedOut) return `it did not finish within ${budgetS}s`;
  const said = String(err?.stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('Warning:'));
  return (said || String(err?.message ?? err).split('\n')[0] || 'unknown error').slice(0, 200);
}

/**
 * The probe awaitNodesJoined runs at its deadline (`probeFromCluster`): for
 * each node that never registered, other than the k3s server itself, its
 * private address (the provider's view, else the one the provisioning
 * recorded) and its public address (the provider's, else the one the command
 * waited on), all checked by one `run` of clusterProbeScript on the k3s
 * server. One `[node-join] from the k3s server: ...` log line per address,
 * and one sentence per node (probeSentence).
 *
 * Never throws and never waits past its bound: a run that fails is one log
 * line, and a run its bound stopped keeps what it printed.
 *
 * @param {object} args
 * @param {(script: string, opts: {timeoutMs: number}) => Promise<string>} args.run -
 *   runs the script with `sh -s` on the k3s server over the command's own
 *   ssh (key, known_hosts, BatchMode), killed at `timeoutMs`
 * @param {string} args.providerName
 * @param {number} [args.budgetMs]
 * @param {(line: string) => void} [args.log]
 * @returns {(
 *   nodes: import('./node-join.js').UnjoinedNode[],
 *   views: Map<import('./node-join.js').UnjoinedNode, import('./node-join.js').ProviderViewSummary>,
 * ) => Promise<Map<import('./node-join.js').UnjoinedNode, string>>}
 */
export function clusterProbe({
  run,
  providerName,
  budgetMs = CLUSTER_PROBE_BUDGET_MS,
  log = (line) => console.error(line),
}) {
  const budgetS = Math.round(budgetMs / 1000);
  return async (nodes, views) => {
    /** @type {Map<import('./node-join.js').UnjoinedNode, string>} */
    const sentences = new Map();
    const targets = [];
    const unknown = [];
    for (const node of nodes) {
      if (node.role === 'master') continue;
      const view = views?.get(node);
      const privateIp = view?.privateIp || node.privateIp;
      const publicIp = view?.publicIp || node.ip;
      const label = nodeLabel(node, view?.name);
      const mine = [
        ...(isProbeable(privateIp)
          ? [
              {
                node,
                label,
                kind: /** @type {const} */ ('private'),
                address: String(privateIp),
                recorded: !view?.privateIp,
              },
            ]
          : []),
        ...(isProbeable(publicIp)
          ? [{ node, label, kind: /** @type {const} */ ('public'), address: String(publicIp) }]
          : []),
      ];
      if (mine.length === 0) unknown.push(label);
      targets.push(...mine);
    }
    if (unknown.length > 0) {
      log(
        `[node-join] nothing to probe from the k3s server: no address is known for ${unknown.join(', ')}`,
      );
    }
    if (targets.length === 0) return sentences;

    let stdout = '';
    /** @type {string|null} why a run that printed some lines did not finish */
    let stopped = null;
    try {
      let timer;
      const expired = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs + RUN_GRACE_MS);
        timer.unref?.();
      });
      const ran = Promise.resolve()
        .then(() => run(clusterProbeScript(targets), { timeoutMs: budgetMs }))
        .then(
          (out) => ({ out: String(out ?? '') }),
          (err) => ({ err }),
        );
      const outcome = await Promise.race([ran, expired]);
      clearTimeout(timer);
      if (!outcome) {
        log(
          `[node-join] could not probe from the k3s server: it did not finish within ${budgetS}s`,
        );
        return sentences;
      }
      if ('err' in outcome) {
        stdout = String(outcome.err?.stdout ?? '');
        if (parseProbeOutput(stdout).length === 0) {
          log(`[node-join] could not probe from the k3s server: ${whyNot(outcome.err, budgetS)}`);
          return sentences;
        }
        stopped = outcome.err?.timedOut
          ? `stopped after ${budgetS}s`
          : `failed partway (${whyNot(outcome.err, budgetS)})`;
      } else {
        stdout = outcome.out;
      }
    } catch (err) {
      log(`[node-join] could not probe from the k3s server: ${whyNot(err, budgetS)}`);
      return sentences;
    }

    const results = parseProbeOutput(stdout);
    const resultOf = (t) => results.find((r) => r.kind === t.kind && r.address === t.address);
    for (const t of targets) {
      const r = resultOf(t);
      const where = `${t.label}, ${t.kind} address ${t.address}${t.recorded ? ' (recorded by the deploy)' : ''}`;
      log(
        r
          ? `[node-join] from the k3s server: ${where}: ping ${r.pings ?? 'error'}/${PINGS}, ` +
              `port 22 ${r.port22}${t.kind === 'private' ? `, neighbour ${r.neighbour ?? 'none'}` : ''}`
          : `[node-join] from the k3s server: ${where}: the probe reported nothing`,
      );
    }
    if (stopped) {
      log(`[node-join] the probe from the k3s server ${stopped}; what it had answered is above`);
    }
    for (const node of new Set(targets.map((t) => t.node))) {
      const target = (kind) => targets.find((x) => x.node === node && x.kind === kind);
      const privateTarget = target('private');
      const publicTarget = target('public');
      const sentence = probeSentence({
        priv: privateTarget && resultOf(privateTarget),
        pub: publicTarget && resultOf(publicTarget),
        providerName,
        privateAddress: privateTarget?.address,
      });
      if (sentence) sentences.set(node, sentence);
    }
    return sentences;
  };
}
