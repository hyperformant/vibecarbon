/**
 * Recovery for terminally-failed cert-manager ACME issuance.
 *
 * THE FAILURE CLASS ("validation gate with no recovery"): cert-manager can
 * park an Order in a state it never leaves, while every gate we have
 * downstream (the public health probe, the e2e health check) just keeps
 * polling a URL that will never serve until a human intervenes. The probe
 * burns its entire budget and reports "fetch failed / self-signed
 * certificate", which says nothing about the actual cause.
 *
 * The concrete instance (e2e hetzner/k8s restore, 2026-08-11, e3):
 *
 *   order.acme.cert-manager.io/vibecarbon-tls-1-3540367894  errored
 *     Failed to finalize Order: 403 urn:ietf:params:acme:error:orderNotReady:
 *     Error finalizing order :: Order was already processing. This may
 *     indicate your client finalized the same order multiple times,
 *     possibly due to a client bug.
 *
 * Both DNS-01 challenges had already validated. Boulder reuses a pending or
 * ready ACME order when the same account submits a new-order with an
 * IDENTICAL identifier set
 * (https://github.com/letsencrypt/boulder/blob/main/docs/acme-implementation_details.md),
 * so two cert-manager Order CRs can end up pointing at ONE ACME order. Both
 * finalize; the loser gets 403 orderNotReady with the ACME order in
 * "processing". cert-manager's finalizeOrder only recovers from a 403 when
 * the re-fetched order is "valid" (pkg/controller/acmeorders/sync.go) — a
 * "processing" order falls through to the generic 4xx branch and the Order
 * is marked Errored, which is TERMINAL. Upstream tracks this as
 * cert-manager#8960 / PR#8968; neither is merged as of v1.20.2, the version
 * we pin.
 *
 * WHY WAITING DOESN'T HELP: cert-manager does eventually retry, but the
 * Certificate trigger controller backs off on
 * `certificateRequestMinimumBackoffDuration`, which defaults to ONE HOUR and
 * then doubles per failed attempt up to 32h
 * (internal/apis/config/controller/v1alpha1/defaults.go). Every deploy-time
 * budget we have is far shorter than the first retry, so from the deploy's
 * point of view a terminal Order is permanent.
 *
 * WHY DELETING THE REQUEST ISN'T ENOUGH: `shouldBackoffReissuingOnFailure`
 * keys off `Certificate.status.lastFailureTime`, which survives deletion of
 * the CertificateRequest. Deleting the request alone reproduces the upstream
 * workaround "delete the CertificateRequest, then wait an hour"
 * (cert-manager#4441). Recovery therefore has to clear the failure stamp on
 * the Certificate status as well.
 */

/**
 * `Order.status.state` values that cert-manager never transitions out of on
 * its own. Mirrors the State constants in pkg/apis/acme/v1/types_order.go
 * (valid / ready / pending / processing are all live states; these three are
 * the dead ends).
 */
export const TERMINAL_ORDER_STATES = Object.freeze(['errored', 'invalid', 'expired']);

/**
 * `CertificateRequest` Ready=False reasons that are terminal. Mirrors
 * CertificateRequestReasonFailed / CertificateRequestReasonDenied in
 * pkg/apis/certmanager/v1/types_certificaterequest.go — "Pending" is the
 * live one and must never appear here.
 */
export const TERMINAL_REQUEST_REASONS = Object.freeze(['Failed', 'Denied']);

/** Read a condition off a cert-manager status block. */
function condition(item, type) {
  return (item?.status?.conditions || []).find((c) => c?.type === type) || null;
}

/**
 * Everything a thrown kubectl failure might carry its diagnosis in.
 * runCommandAsync rejects with an Error whose `message` is the wrapper and
 * whose `stderr` holds what kubectl actually said, so both have to be read.
 */
function errorText(err) {
  if (!err) return '';
  const parts = [
    err instanceof Error ? err.message : String(err),
    err?.stderr?.toString?.() ?? '',
    err?.stdout?.toString?.() ?? '',
  ];
  return parts.filter(Boolean).join('\n');
}

/** Name of the owner of `item` with the given kind, or null. */
function ownerNamed(item, kind) {
  const ref = (item?.metadata?.ownerReferences || []).find((o) => o?.kind === kind);
  return ref?.name || null;
}

/**
 * Find Certificates whose issuance is parked in a state cert-manager will
 * not leave without help.
 *
 * Takes the `items` array of a
 * `kubectl get certificate,certificaterequest,order -A -o json` and walks
 * ownership downward (Certificate → CertificateRequest → Order) so a finding
 * always carries the exact resource names a recovery has to act on.
 *
 * A Certificate that is already Ready=True is never reported, even if a
 * stale errored Order from a previous revision is still lying around — that
 * one is harmless history, not a live outage.
 *
 * @param {Array<Record<string, any>>} items
 * @returns {Array<{namespace: string, certificate: string, request: string|null,
 *   order: string|null, state: string|null, reason: string}>}
 */
export function findTerminalAcmeFailures(items) {
  const byKind = (kind) =>
    (items || []).filter((i) => i?.kind === kind && i?.metadata?.name && i?.metadata?.namespace);

  const certificates = byKind('Certificate');
  const requests = byKind('CertificateRequest');
  const orders = byKind('Order');

  const findings = [];
  for (const cert of certificates) {
    const ready = condition(cert, 'Ready');
    if (ready?.status === 'True') continue;

    const ns = cert.metadata.namespace;
    const certName = cert.metadata.name;
    // Requests this Certificate owns, newest revision last. The revision
    // annotation is authoritative; fall back to name order so a request
    // missing the annotation still sorts deterministically.
    const owned = requests
      .filter((r) => r.metadata.namespace === ns && ownerNamed(r, 'Certificate') === certName)
      .sort((a, b) => {
        const rev = (r) =>
          Number(r?.metadata?.annotations?.['cert-manager.io/certificate-revision'] ?? 0);
        return rev(a) - rev(b) || String(a.metadata.name).localeCompare(String(b.metadata.name));
      });

    for (const req of owned) {
      const reqReady = condition(req, 'Ready');
      const order = orders.find(
        (o) =>
          o.metadata.namespace === ns && ownerNamed(o, 'CertificateRequest') === req.metadata.name,
      );
      const orderState = order?.status?.state ?? null;
      const orderTerminal = orderState != null && TERMINAL_ORDER_STATES.includes(orderState);
      const requestTerminal =
        reqReady?.status === 'False' && TERMINAL_REQUEST_REASONS.includes(reqReady?.reason);
      if (!orderTerminal && !requestTerminal) continue;

      // Prefer the Order's own reason — it carries the ACME problem
      // document (the "orderNotReady ... already processing" text), which is
      // the line an operator actually needs. The request message is a
      // wrapper around it.
      const reason = order?.status?.reason || reqReady?.message || `order in "${orderState}" state`;
      findings.push({
        namespace: ns,
        certificate: certName,
        request: req.metadata.name,
        order: order?.metadata?.name ?? null,
        state: orderState,
        reason,
      });
    }
  }
  return findings;
}

/**
 * Un-stick one finding.
 *
 * Two steps, both idempotent, in this order:
 *
 *   1. Delete the failed CertificateRequest. Its Order is an owned child, so
 *      the Order goes with it — deleting the Order alone would achieve
 *      nothing because the terminal CertificateRequest would not rebuild it.
 *   2. Clear `lastFailureTime` + `failedIssuanceAttempts` from the
 *      Certificate's status. Without this the trigger controller sits on its
 *      one-hour (then exponential) backoff before creating a replacement
 *      request, which is longer than any budget we hold open.
 *
 * A JSON merge patch with an explicit null removes the field, and both
 * fields are `omitempty` pointers, so this restores exactly the state of a
 * Certificate that has never failed.
 *
 * @param {object} args
 * @param {{namespace: string, certificate: string, request: string|null}} args.finding
 * @param {(argv: string[]) => Promise<string>} args.runKubectl
 * @returns {Promise<string[][]>} the argv of each command actually run
 */
export async function recoverTerminalAcmeFailure({ finding, runKubectl }) {
  const ran = [];
  const run = async (argv) => {
    ran.push(argv);
    await runKubectl(argv);
  };
  if (finding.request) {
    await run([
      '-n',
      finding.namespace,
      'delete',
      'certificaterequest',
      finding.request,
      '--ignore-not-found',
    ]);
  }
  try {
    await run([
      '-n',
      finding.namespace,
      'patch',
      'certificate',
      finding.certificate,
      '--type=merge',
      '--subresource=status',
      '-p',
      JSON.stringify({ status: { lastFailureTime: null, failedIssuanceAttempts: null } }),
    ]);
  } catch (err) {
    // `kubectl patch --subresource` landed in 1.24. On an older client the
    // request delete above still happened, so issuance WILL retry — just not
    // until cert-manager's one-hour backoff elapses, long after any budget we
    // hold. That is a materially different outcome from "the patch failed",
    // so name it rather than letting it read as a generic kubectl error.
    if (/unknown flag:\s*--subresource/i.test(errorText(err))) {
      throw new Error(
        `clearing the issuance-failure backoff on ${finding.namespace}/${finding.certificate} ` +
          `requires kubectl >= 1.24 (this client has no \`patch --subresource\`). The failed ` +
          `CertificateRequest was deleted, so cert-manager will reissue; but only after its ` +
          `~1h backoff, not within this deploy. Upgrade kubectl to recover in-deploy.`,
        { cause: err },
      );
    }
    throw err;
  }
  return ran;
}

/**
 * `<namespace>/<name>` of every Certificate this deploy creates and therefore
 * owns. The watchdog READS the whole cluster — a foreign Certificate racing
 * ours for the same ACME order is exactly the kind of thing we want in the
 * log — but it only ever WRITES to these two.
 *
 * The write is destructive (it deletes a CertificateRequest), so the blast
 * radius has to be a list we can point at, not "whatever the finder returned".
 * A user's own cert-manager Certificates, or an operator's, live in the same
 * cluster and are none of our business: repairing one would delete a resource
 * we did not create, on a schedule the user never asked for.
 */
export const DEPLOY_OWNED_CERTIFICATES = Object.freeze([
  'vibecarbon/vibecarbon-tls',
  'vibecarbon-observability/grafana-tls',
]);

/**
 * The one Certificate whose Secret terminates TLS for the apex the health
 * probe fetches (`carbon/k8s/base/traefik/`). Only this one may stop the
 * probe: it is the only Certificate whose failure PROVES the probed URL can
 * never serve. `grafana-tls` failing is a real problem and gets repaired and
 * logged, but /admin/grafana is not what the probe is asking about, and
 * aborting the deploy over it would turn an add-on's cert into a deploy-wide
 * outage.
 */
export const PROBED_APEX_CERTIFICATE = 'vibecarbon/vibecarbon-tls';

/**
 * Build the watchdog the public health probe polls with.
 *
 * Contract, deliberately narrow so the probe stays the thing in charge:
 *
 *   - returns `{ action: 'none' }` when nothing WE own is terminally failed,
 *     when kubectl is unavailable, or when anything at all goes wrong. The
 *     watchdog must never be the reason a deploy fails, so it fails OPEN —
 *     structurally, via a catch-all around the whole poll.
 *   - returns `{ action: 'recovered', findings }` after clearing failures,
 *     so the probe keeps polling and issuance gets a real second chance.
 *   - returns `{ action: 'abort', reason }` only once `PROBED_APEX_CERTIFICATE`
 *     has consumed its recovery budget and is STILL terminal. That is the
 *     fail-fast path: the caller stops waiting and reports the ACME reason
 *     instead of burning the rest of its budget on a URL that cannot serve.
 *
 * The recovery budget is per-Certificate and carried in the closure, so a
 * probe that polls fifty times still only ever attempts `maxRecoveries`
 * repairs per Certificate.
 *
 * @param {object} args
 * @param {(argv: string[]) => Promise<string>} args.runKubectl
 * @param {number} [args.maxRecoveries] repairs attempted per Certificate
 * @param {(msg: string) => void} [args.log]
 * @param {readonly string[]} [args.repairable] `ns/name` keys we may write to
 * @param {string} [args.abortOn] the `ns/name` key allowed to stop the probe
 * @returns {() => Promise<{action: 'none'|'recovered'|'abort', findings?: any[], reason?: string}>}
 */
export function createAcmeIssuanceWatchdog({
  runKubectl,
  maxRecoveries = 2,
  log = () => {},
  repairable = DEPLOY_OWNED_CERTIFICATES,
  abortOn = PROBED_APEX_CERTIFICATE,
}) {
  /** @type {Map<string, number>} */
  const attempts = new Map();
  /** Foreign Certificates already reported — log each once, not every poll. */
  const reportedForeign = new Set();
  const owned = new Set(repairable);
  // A logger that throws must not take the deploy with it (LOW-2).
  const safeLog = (msg) => {
    try {
      log(msg);
    } catch {
      /* a broken logger is not a deploy failure */
    }
  };
  const keyOf = (f) => `${f.namespace}/${f.certificate}`;

  async function pollOnce() {
    let findings;
    try {
      const raw = await runKubectl([
        'get',
        'certificate,certificaterequest,order',
        '--all-namespaces',
        '-o',
        'json',
      ]);
      findings = findTerminalAcmeFailures(JSON.parse(raw)?.items ?? []);
    } catch (err) {
      // No kubeconfig, API server not reachable, malformed JSON — none of
      // these are a reason to fail a deploy that might still converge.
      safeLog(`[acme-watchdog] state check skipped: ${errorText(err).split('\n')[0]}`);
      return { action: 'none' };
    }
    if (findings.length === 0) return { action: 'none' };

    // Foreign Certificates: report once, never touch. If one of these is
    // racing us for a shared ACME order, this line is the evidence.
    for (const f of findings.filter((x) => !owned.has(keyOf(x)))) {
      if (reportedForeign.has(keyOf(f))) continue;
      reportedForeign.add(keyOf(f));
      safeLog(
        `[acme-watchdog] ${keyOf(f)} is terminally failed (state="${f.state}") but is NOT ` +
          `deploy-owned, reporting only, not repairing: ${f.reason}`,
      );
    }

    const ours = findings.filter((f) => owned.has(keyOf(f)));
    if (ours.length === 0) return { action: 'none' };

    // Abort only for the Certificate that actually terminates the probed
    // apex, and only once it has spent its whole repair budget.
    const stuckApex = ours.find(
      (f) => keyOf(f) === abortOn && (attempts.get(keyOf(f)) ?? 0) >= maxRecoveries,
    );
    if (stuckApex) {
      return {
        action: 'abort',
        findings: [stuckApex],
        reason:
          `cert-manager issuance for ${keyOf(stuckApex)} is terminally failed ` +
          `after ${maxRecoveries} recovery attempts` +
          (stuckApex.order ? ` (order ${stuckApex.order}, state "${stuckApex.state}")` : '') +
          `: ${stuckApex.reason}`,
      };
    }

    let attempted = 0;
    for (const f of ours) {
      const key = keyOf(f);
      const used = attempts.get(key) ?? 0;
      if (used >= maxRecoveries) {
        // Budget spent on a non-apex cert (grafana-tls). Nothing more to do
        // for it, and it must not stop the probe — the apex may still land.
        continue;
      }
      attempts.set(key, used + 1);
      attempted++;
      safeLog(
        `[acme-watchdog] ${key} is terminally failed (${f.order ? `order ${f.order} ` : ''}state="${f.state}"): ${f.reason}`,
      );
      safeLog(
        `[acme-watchdog] recovering ${key}, deleting failed request ${f.request} and clearing the issuance-failure backoff (attempt ${used + 1}/${maxRecoveries})`,
      );
      try {
        await recoverTerminalAcmeFailure({ finding: f, runKubectl });
      } catch (err) {
        // A failed repair still consumed an attempt — that is what bounds
        // the loop. The next poll retries; the one after that escalates.
        safeLog(`[acme-watchdog] recovery of ${key} failed: ${errorText(err).split('\n')[0]}`);
      }
    }
    // Nothing left to try: everything we own has spent its budget and none of
    // it is the apex. Stay quiet and let the probe run its own course.
    if (attempted === 0) return { action: 'none' };
    return { action: 'recovered', findings: ours };
  }

  return async function pollAcmeIssuance() {
    // Structural fail-open (LOW-2): whatever goes wrong in there — a thrown
    // logger, an unexpected resource shape, a bug of ours — the probe keeps
    // its own schedule and the deploy keeps its own verdict.
    try {
      return await pollOnce();
    } catch (err) {
      safeLog(`[acme-watchdog] poll failed, continuing: ${errorText(err).split('\n')[0]}`);
      return { action: 'none' };
    }
  };
}
