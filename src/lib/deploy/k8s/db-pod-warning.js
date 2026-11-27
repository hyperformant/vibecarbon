/**
 * Why the db pod is stuck, in the cluster's own words: its newest Warning
 * event, for the two db waits that give up on it.
 *
 * WHY (perf run 45940611622, vultr/k8s, step restore-deploy): the db rollout
 * wait expired after 900 s saying only "db-0 (Pending)". The cause was in the
 * pod's events, which only the e2e failure bundle had read: Vultr's CSI
 * answered every attach with "Block storage is not compatible with this
 * server" (Warning FailedAttachVolume, x15 over 15m).
 *
 * Both db waits add the same clause, `; last warning <Reason>: <message>`,
 * to the pod's own parenthesis: awaitDbRollout's "The db pod never became
 * Ready: db-0 (Pending; last warning ...)." (k3s.js summarizeDbPods) and
 * awaitDbPodReady's "db-0 is not Ready (ContainersNotReady; last warning
 * ...)" (readiness.js, a deploy whose apply was skipped). podWarningClause is
 * the one writer of it: tests/e2e/utils/classify-failure.ts masks the clause
 * by this exact shape, so the cluster's words never decide how an e2e
 * failure is classified (tests/unit/deploy/db-pod-warning.test.ts holds both
 * waits to this module).
 *
 * The read happens only on a wait's failure path, only for a pod that is not
 * Ready, once, bounded, never retried, and never throws: a failed, hung or
 * empty read leaves the wait's message exactly as it was without it.
 */
import { runCommandAsync } from '../../command.js';
import { printable } from '../../printable.js';

/**
 * The one read behind the clause: every Warning event on a pod in the
 * namespace, as JSON. Field selectors cannot OR, so naming each not-Ready
 * pod would take one read per pod; this is one read under one bound however
 * many there are, and latestPodWarnings picks the db pods out of it by name
 * and uid. Warnings only, because a Normal event (Scheduled, Pulled, Started)
 * explains nothing about a pod that is stuck. `--request-timeout` bounds
 * kubectl's own call; readDbPodWarnings kills the process a little later,
 * should kubectl hang anywhere else.
 *
 * @param {string} [namespace]
 * @returns {string[]}
 */
export function dbPodWarningEventsArgs(namespace = 'vibecarbon') {
  return [
    'kubectl',
    '-n',
    namespace,
    'get',
    'events',
    '--field-selector',
    'involvedObject.kind=Pod,type=Warning',
    '-o',
    'json',
    '--request-timeout=10s',
  ];
}

/** readDbPodWarnings' process bound: past kubectl's own 10 s request timeout. */
export const DB_POD_WARNING_READ_MS = 15_000;

/**
 * The newest Warning event of each of `pods`, from dbPodWarningEventsArgs'
 * JSON, keyed by pod name. Pure. An event is a pod's when it names the pod
 * and, when the pod's uid is known, carries that uid, so the events a replaced
 * db-0 left behind never speak for the current one. Newest by the cluster's
 * own clock, never this machine's: the events.k8s.io series' last sighting,
 * then lastTimestamp (core/v1 bumps it on every repeat, so a warning that has
 * fired for 15 minutes reads as fresh), then eventTime, then creation. An
 * event with no message says nothing and is skipped; unreadable JSON is no
 * warning at all. The text is returned as the cluster sent it:
 * podWarningClause makes it safe to print.
 *
 * @param {string} eventsJson
 * @param {{name: string, uid?: string}[]} pods
 * @returns {Map<string, {reason: string, message: string}>}
 */
export function latestPodWarnings(eventsJson, pods) {
  const latest = new Map();
  const latestAt = new Map();
  let items;
  try {
    items = JSON.parse(String(eventsJson ?? ''))?.items;
  } catch {
    return latest;
  }
  if (!Array.isArray(items)) return latest;
  for (const ev of items) {
    if (ev?.type !== 'Warning' || !String(ev.message ?? '').trim()) continue;
    const obj = ev.involvedObject ?? {};
    const pod = pods.find((p) => p.name === obj.name && (!p.uid || p.uid === obj.uid));
    if (!pod) continue;
    const t = Date.parse(
      ev.series?.lastObservedTime ??
        ev.lastTimestamp ??
        ev.eventTime ??
        ev.metadata?.creationTimestamp ??
        '',
    );
    const at = Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
    if (latestAt.get(pod.name) > at) continue;
    latestAt.set(pod.name, at);
    latest.set(pod.name, { reason: String(ev.reason ?? ''), message: String(ev.message) });
  }
  return latest;
}

/**
 * The newest Warning event of each of `pods` (the caller passes only pods
 * that are not Ready). One read, bounded, never retried. Never throws: a
 * failed, hung or empty read is no warning, and the caller's message stays
 * exactly what it was without this read. No pods, no read.
 *
 * @param {NodeJS.ProcessEnv} env - carries KUBECONFIG
 * @param {{name: string, uid?: string}[]} pods
 * @param {object} [opts]
 * @param {string} [opts.namespace]
 * @param {(argv: string[], opts: object) => Promise<unknown>} [opts.exec] - test seam
 * @returns {Promise<Map<string, {reason: string, message: string}>>}
 */
export async function readDbPodWarnings(
  env,
  pods,
  { namespace = 'vibecarbon', exec = runCommandAsync } = {},
) {
  if (pods.length === 0) return new Map();
  try {
    const out = await exec(dbPodWarningEventsArgs(namespace), {
      env,
      silent: true,
      timeout: DB_POD_WARNING_READ_MS,
    });
    return latestPodWarnings(String(out ?? ''), pods);
  } catch {
    return new Map();
  }
}

/** The longest event message a db wait's failure quotes, in characters. */
const POD_WARNING_MESSAGE_MAX = 300;
/** Event reasons are one CamelCase word; anything longer is cut. */
const POD_WARNING_REASON_MAX = 64;

/**
 * Event text from the cluster, made safe for one line of an error message.
 *
 * The cluster is a server the CLI logs in to, and this text reaches the
 * operator's terminal through cli.js's `Error:` line as it is. Whitespace
 * runs, newlines included, become one space; then printable() replaces the
 * other C0/C1 controls (the escape sequences' way in), and the format
 * characters printable() leaves (bidi overrides, zero-width marks, which can
 * make a line read as something else) are replaced the same way.
 * Parentheses become brackets: the clause sits inside the pod's own
 * parentheses, and tests/e2e/utils/classify-failure.ts relies on that clause
 * holding none to find where it ends. Cut to `max` characters, counted as
 * code points so a cut never splits one.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function podWarningText(value, max) {
  const flat = printable(String(value ?? '').replace(/\s+/g, ' '))
    .replace(/\p{Cf}/gu, '\uFFFD')
    .replace(/\(/g, '[')
    .replace(/\)/g, ']')
    .trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 3).join('')}...`;
}

/**
 * The clause a db wait appends inside the pod's parenthesis, after its state:
 * `; last warning FailedAttachVolume: <message>`, or '' without a warning.
 * The one writer of it (see the module comment). Reason and message together
 * stay under 400 characters, which the classifier's mask relies on.
 *
 * @param {{reason: string, message: string}|undefined} warning
 * @returns {string}
 */
export function podWarningClause(warning) {
  if (!warning) return '';
  const reason = podWarningText(warning.reason, POD_WARNING_REASON_MAX);
  const message = podWarningText(warning.message, POD_WARNING_MESSAGE_MAX);
  return `; last warning${reason ? ` ${reason}` : ''}: ${message}`;
}
