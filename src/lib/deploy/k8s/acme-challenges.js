/**
 * cert-manager ACME Challenges, read for two jobs.
 *
 * 1. Naming why an Order failed (the ACME watchdog, ./acme-order-recovery.js).
 *    Let's Encrypt's reason lands on the Challenge, never on an Order a failed
 *    Challenge turned invalid: the order controller copies only the ACME
 *    order's state onto the Order (pkg/controller/acmeorders/sync.go,
 *    updateOrderStatusFromACMEOrder, cert-manager v1.21.3), so
 *    `Order.status.reason` stays empty and the CertificateRequest's message
 *    ends in `order is in "invalid" state: ` with nothing after it (hetzner
 *    k8s-ha, CI run 42426102569, 2026-11-08). The Challenge holds the reason:
 *    `Error accepting authorization: <ACME problem>` after a failed
 *    validation (acmechallenges/sync.go, handleAuthorizationError), the
 *    authorization's own error detail when cert-manager reads it back
 *    (syncChallengeStatus), or the last self-check failure while it waits.
 *
 *    The Challenges are still there when the watchdog finds the Order
 *    failed, so nothing is recorded between polls. In v1.21.3 the order
 *    controller does nothing at all for an Order in a failure state; it
 *    deletes its Challenges only once the Order is valid and holds its
 *    certificate (deleteAllChallenges). The challenge controller never
 *    deletes its own object: a finished Challenge keeps its state and reason
 *    and only loses its finalizer. Challenges go with their owner chain
 *    (Challenge, Order, CertificateRequest), and the request goes only when
 *    the watchdog deletes it, after it has logged, or when cert-manager starts
 *    the next issuance cycle (requestmanager, deleteCurrentFailedRequests),
 *    which removes the failed Order with them, so the watchdog has nothing
 *    left to report.
 *
 * 2. Holding the deploy's Traefik restart while a Challenge is live (k3s.js,
 *    applyK3sManifests step 10). Traefik serves the HTTP-01 token Let's
 *    Encrypt fetches, and the Certificate is created earlier, by the base
 *    apply, so a challenge can be in flight when the restart comes. A
 *    force-deleted Traefik leaves port 80 closed until its replacement
 *    starts, and a validation that lands in that gap fails the order.
 *
 * Every function here is read-only and never throws.
 */

/** cert-manager's final Challenge states (pkg/acme/util.go, IsFinalState). */
export const CHALLENGE_FINAL_STATES = Object.freeze(['valid', 'invalid', 'expired', 'errored']);

/** The final states that mean the Challenge failed (IsFailureState). */
export const CHALLENGE_FAILURE_STATES = Object.freeze(['invalid', 'expired', 'errored']);

/** The cert-manager controller, as the upstream install manifest names it. */
export const CERT_MANAGER_CONTROLLER = Object.freeze({
  namespace: 'cert-manager',
  deployment: 'cert-manager',
});

/**
 * How long the deploy holds its Traefik restart for a live challenge. A
 * challenge that is progressing finishes in seconds: cert-manager retries its
 * self-check every 10 s and Let's Encrypt answers a validation within a few
 * seconds. One minute covers that with room. A challenge still live after it
 * is stuck on its self-check (the name does not reach this cluster yet, for
 * example), and Let's Encrypt is not asked to validate while the self-check
 * fails, so the restart goes ahead.
 */
export const TRAEFIK_RESTART_CHALLENGE_WAIT_MS = 60_000;

/** Between reads of the Challenges while the restart waits. */
export const CHALLENGE_POLL_MS = 2_000;

/** The one read the restart wait makes, each poll. */
export const CHALLENGES_ARGV = Object.freeze([
  'get',
  'challenges.acme.cert-manager.io',
  '--all-namespaces',
  '-o',
  'json',
]);

/**
 * argv (after `kubectl` and any `--kubeconfig`) of a bounded read of the
 * cert-manager controller log: the last `tailLines` lines of the last
 * `sinceMinutes`, under kubectl's own request timeout.
 *
 * @param {{ sinceMinutes: number, tailLines: number, requestTimeoutSec: number }} bounds
 * @returns {string[]}
 */
export function certManagerLogArgv({ sinceMinutes, tailLines, requestTimeoutSec }) {
  return [
    '-n',
    CERT_MANAGER_CONTROLLER.namespace,
    'logs',
    `deployment/${CERT_MANAGER_CONTROLLER.deployment}`,
    `--since=${sinceMinutes}m`,
    `--tail=${tailLines}`,
    `--request-timeout=${requestTimeoutSec}s`,
  ];
}

/** The longest cause the watchdog puts on one line. */
const MAX_CAUSE_CHARS = 600;

/** Collapse whitespace and cap the length, so a cause stays on one line. */
export function compact(text, max = MAX_CAUSE_CHARS) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** First line of whatever a failed kubectl call carried. */
function firstLine(err) {
  const text = [
    err instanceof Error ? err.message : String(err ?? ''),
    err?.stderr?.toString?.() ?? '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? 'unknown error'
  );
}

/** Name of the owner of `item` with the given kind, or null. */
function ownerNamed(item, kind) {
  const ref = (item?.metadata?.ownerReferences || []).find((o) => o?.kind === kind);
  return ref?.name || null;
}

/**
 * @typedef {{ namespace: string, name: string, dnsName: string, type: string,
 *   state: string, reason: string }} ChallengeSummary
 */

/** @returns {ChallengeSummary} */
function summarize(ch) {
  return {
    namespace: ch?.metadata?.namespace ?? '',
    name: ch?.metadata?.name ?? '',
    dnsName: ch?.spec?.dnsName ?? '(unknown name)',
    type: ch?.spec?.type ?? 'ACME',
    state: ch?.status?.state || 'unset',
    reason: compact(ch?.status?.reason ?? ''),
  };
}

/** `HTTP-01 challenge for app.example.com is invalid: <reason>` */
export function describeChallenge(c) {
  return `${c.type} challenge for ${c.dnsName} is ${c.state}${c.reason ? `: ${c.reason}` : ''}`;
}

/**
 * The Challenges an Order owns (cert-manager sets the Order as their
 * controller owner), from a `kubectl get ... -o json` items array that may
 * hold other kinds too.
 *
 * @param {Array<Record<string, any>>} items
 * @param {{ namespace: string, order: string }} order
 * @returns {ChallengeSummary[]}
 */
export function challengesOfOrder(items, { namespace, order }) {
  return (Array.isArray(items) ? items : [])
    .filter(
      (i) =>
        i?.kind === 'Challenge' &&
        i?.metadata?.namespace === namespace &&
        ownerNamed(i, 'Order') === order,
    )
    .map(summarize);
}

/**
 * Why an Order failed, from what the cluster holds, or null when nothing
 * there says. In order of preference: a failed Challenge's reason (Let's
 * Encrypt's own words), an unfinished Challenge's reason (its last
 * self-check), the Order's own reason (cert-manager sets it for an error at
 * the order or finalize step). A Challenge that validated says nothing about
 * the failure and is skipped.
 *
 * @param {Array<Record<string, any>>} items
 * @param {{ namespace: string, order: string }} order
 * @returns {string|null}
 */
export function orderFailureCause(items, { namespace, order }) {
  const challenges = challengesOfOrder(items, { namespace, order });
  const failed = challenges.filter((c) => CHALLENGE_FAILURE_STATES.includes(c.state) && c.reason);
  const unfinished = challenges.filter(
    (c) => !CHALLENGE_FINAL_STATES.includes(c.state) && c.reason,
  );
  const telling = failed.length > 0 ? failed : unfinished;
  if (telling.length > 0) return compact(telling.map(describeChallenge).join('; '));
  const own = (Array.isArray(items) ? items : []).find(
    (i) =>
      i?.kind === 'Order' && i?.metadata?.namespace === namespace && i?.metadata?.name === order,
  )?.status?.reason;
  return own ? compact(own) : null;
}

/** Strip klog's `E1108 00:00:38.123456       1 sync.go:123] ` header. */
function stripKlogHeader(line) {
  return line.replace(/^[IWEF]\d{4} [\d:.]+\s+\d+ [^\]]+\] /, '');
}

/**
 * The last `max` lines of a cert-manager controller log that name one of
 * `names`, compacted, error lines first when there are any. Pure.
 *
 * @param {string} logText
 * @param {string[]} names
 * @param {number} [max]
 * @returns {string[]}
 */
export function logLinesNaming(logText, names, max = 3) {
  const wanted = names.filter(Boolean);
  if (wanted.length === 0) return [];
  const naming = String(logText ?? '')
    .split('\n')
    .filter((l) => wanted.some((n) => l.includes(n)));
  const errors = naming.filter((l) => /^[EW]\d{4} /.test(l));
  return (errors.length > 0 ? errors : naming)
    .slice(-max)
    .map((l) => compact(stripKlogHeader(l), 300));
}

/** The window and caps of the watchdog's log fallback. */
export const WATCHDOG_LOG_BOUNDS = Object.freeze({
  sinceMinutes: 30,
  tailLines: 2000,
  requestTimeoutSec: 5,
});

/**
 * Why an Order failed, in one line, never throwing. The cluster's objects
 * first (orderFailureCause), then the last few cert-manager controller log
 * lines naming the order or its challenges, read once under
 * WATCHDOG_LOG_BOUNDS. When nothing says, the line says the reason was
 * unavailable and why.
 *
 * @param {{ items: Array<Record<string, any>>, namespace: string, order: string,
 *   runKubectl: (argv: string[]) => Promise<string> }} args
 * @returns {Promise<{ found: boolean, cause: string }>}
 */
export async function explainOrderFailure({ items, namespace, order, runKubectl }) {
  try {
    const fromCluster = orderFailureCause(items, { namespace, order });
    if (fromCluster) return { found: true, cause: fromCluster };
    const names = [order, ...challengesOfOrder(items, { namespace, order }).map((c) => c.name)];
    let logText;
    try {
      logText = await runKubectl(certManagerLogArgv(WATCHDOG_LOG_BOUNDS));
    } catch (err) {
      return {
        found: false,
        cause:
          'reason unavailable: its Challenges and the Order carry none, and the cert-manager ' +
          `log could not be read (${compact(firstLine(err), 200)})`,
      };
    }
    const lines = logLinesNaming(logText, names);
    if (lines.length > 0) return { found: true, cause: `cert-manager log: ${lines.join(' | ')}` };
    return {
      found: false,
      cause:
        'reason unavailable: its Challenges and the Order carry none, and no cert-manager log ' +
        `line in the last ${WATCHDOG_LOG_BOUNDS.sinceMinutes} minutes names it`,
    };
  } catch (err) {
    return { found: false, cause: `reason unavailable: ${compact(firstLine(err), 200)}` };
  }
}

/**
 * The Challenges in `namespaces` cert-manager has not finished with: not
 * being deleted and not in a final state. A Challenge only exists while its
 * Order is live (a valid Order deletes its Challenges), so this is every
 * HTTP-01 token Let's Encrypt may still fetch.
 *
 * @param {Array<Record<string, any>>} items
 * @param {readonly string[]} namespaces
 * @returns {ChallengeSummary[]}
 */
export function liveChallenges(items, namespaces) {
  return (Array.isArray(items) ? items : [])
    .filter(
      (i) =>
        i?.kind === 'Challenge' &&
        namespaces.includes(i?.metadata?.namespace) &&
        !i?.metadata?.deletionTimestamp &&
        !CHALLENGE_FINAL_STATES.includes(i?.status?.state ?? ''),
    )
    .map(summarize);
}

/**
 * Wait, at most `budgetMs`, until no Challenge in `namespaces` is live
 * (liveChallenges). One read per poll; never throws. A read that fails ends
 * the wait: the wait guards a rare race and must never become a way for the
 * deploy to stall, and a cluster kubectl cannot read reports itself at the
 * next call.
 *
 * @param {{ runKubectl: (argv: string[]) => Promise<string>,
 *   namespaces: readonly string[], budgetMs?: number, intervalMs?: number,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number }} args
 * @returns {Promise<{ settled: boolean, waitedMs: number, reads: number,
 *   live: ChallengeSummary[], error?: string }>}
 */
export async function awaitAcmeChallengesSettled({
  runKubectl,
  namespaces,
  budgetMs = TRAEFIK_RESTART_CHALLENGE_WAIT_MS,
  intervalMs = CHALLENGE_POLL_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  const start = now();
  const deadline = start + budgetMs;
  let reads = 0;
  try {
    for (;;) {
      let live;
      try {
        reads += 1;
        const raw = await runKubectl([...CHALLENGES_ARGV]);
        live = liveChallenges(JSON.parse(String(raw ?? ''))?.items ?? [], namespaces);
      } catch (err) {
        return {
          settled: false,
          waitedMs: now() - start,
          reads,
          live: [],
          error: compact(firstLine(err), 200),
        };
      }
      if (live.length === 0) return { settled: true, waitedMs: now() - start, reads, live };
      if (now() >= deadline) return { settled: false, waitedMs: now() - start, reads, live };
      await sleep(Math.max(0, Math.min(intervalMs, deadline - now())));
    }
  } catch (err) {
    return {
      settled: false,
      waitedMs: now() - start,
      reads,
      live: [],
      error: compact(firstLine(err), 200),
    };
  }
}

/**
 * The one line the Traefik restart prints about its wait, or null when there
 * was nothing to wait for.
 *
 * @param {Awaited<ReturnType<typeof awaitAcmeChallengesSettled>>} result
 * @returns {string|null}
 */
export function challengeWaitLine(result) {
  const seconds = Math.round((result?.waitedMs ?? 0) / 1000);
  if (result?.error) {
    return `traefik restart: could not read the ACME challenges (${result.error}), restarting without waiting`;
  }
  if (result?.settled) {
    return (result.reads ?? 1) > 1
      ? `traefik restart held ${seconds}s until the ACME challenge finished`
      : null;
  }
  const live = (result?.live ?? []).map(describeChallenge).join('; ');
  return (
    `traefik restart: ${live || 'an ACME challenge'} is still live after ${seconds}s, ` +
    'restarting anyway. If its order fails, the ACME watchdog repairs it during the TLS check.'
  );
}
