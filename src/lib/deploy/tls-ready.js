/**
 * TLS-ready deploy gate for the compose tiers.
 *
 * THE RULE: a deploy is not done until the apex domain serves a certificate
 * the platform trust store accepts. Compose fires Traefik/lego ACME
 * issuance asynchronously; before this gate the deploy reported success
 * while issuance was still in flight, and on slow DNS-01 propagation
 * (DigitalOcean's anycast POPs, run 33252884427) the domain sat on the
 * Traefik self-signed default (compose) or an apex-less wildcard
 * (compose-ha) for minutes after "success" — a browser cert warning for the
 * customer, a red ssl_valid for e2e, and the actual ACME error nowhere in
 * sight. The k8s tier was green on the same provider for exactly one
 * reason: it AWAITS cert-manager (CERT_MANAGER_READY_BUDGET_MS). This
 * module is the compose mirror of that contract.
 *
 * Shape: pure decision function (assertTlsReadyOrDegraded — the
 * assertReplicationStreamingOrDegraded pattern) + a budgeted poll with
 * injectable probe/sleep/clock (the waitForNewPrimaryApi pattern; unit
 * tests never open a socket) + the one real-socket probe.
 *
 * Manual-DNS deploys DEGRADE instead of failing: with `manual` DNS the
 * customer may not have pointed the domain yet, and HTTP-01 issuance
 * cannot even start until they do — failing the deploy would punish the
 * documented "deploy first, point DNS after" flow. We gate hard only on
 * what we control (managed-DNS providers, where update-dns just wrote the
 * records ourselves).
 */

import tls from 'node:tls';
import { stagingProbeCa } from './staging-ca.js';

/**
 * Poll budget for the apex to serve a trusted chain. 480s mirrors the k8s
 * path's CERT_MANAGER_READY_BUDGET_MS: issuance itself is seconds, but
 * lego's TXT-propagation wait against slow anycast DNS POPs is the long
 * tail this budget exists to absorb. Much of it overlaps nothing — the
 * gate runs last, and Traefik has been issuing since start-compose-stack.
 */
export const TLS_READY_BUDGET_MS = 480_000;

/** Poll cadence — matches the e2e ssl_valid retry cadence order of magnitude. */
export const TLS_READY_POLL_MS = 5_000;

/**
 * The manual-DNS courtesy window. Manual DNS can't gate hard — the customer
 * may not have pointed the domain yet, so issuance may legitimately be
 * impossible right now. One short window catches the "DNS already pointed,
 * cert just finishing" case; after it, degrade with a warning, never fail.
 */
export const TLS_READY_MANUAL_BUDGET_MS = 60_000;

/** Per-attempt socket timeout for the real probe. */
export const TLS_PROBE_TIMEOUT_MS = 10_000;

/**
 * One real TLS probe of `domain`:443 with full verification (SNI +
 * hostname + chain against the platform store, plus the LE staging roots
 * when ACME_CA_SERVER points at staging — same policy as
 * probePublicHealth). On an untrusted chain, retries once WITHOUT
 * verification purely to NAME the served cert for the error message — that
 * insecure attempt can never produce trusted:true.
 *
 * @param {string} domain
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{trusted: boolean, reason?: string, served?: {subject: string, issuer: string}|null}>}
 */
export async function probeTlsTrustOnce(domain, { timeoutMs = TLS_PROBE_TIMEOUT_MS } = {}) {
  const ca = (process.env.ACME_CA_SERVER || '').includes('staging') ? stagingProbeCa() : undefined;
  try {
    await tlsHandshake(domain, { ca, rejectUnauthorized: true, timeoutMs });
    return { trusted: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    let served = null;
    try {
      served = await tlsHandshake(domain, { ca, rejectUnauthorized: false, timeoutMs });
    } catch {
      // Connection-level failure (refused, reset, no DNS) — nothing served.
    }
    return { trusted: false, reason, served };
  }
}

/**
 * @param {string} domain
 * @param {{ ca?: string[], rejectUnauthorized: boolean, timeoutMs: number }} opts
 * @returns {Promise<{subject: string, issuer: string}|null>} peer cert
 *   identity (insecure mode) or null; resolves only on a completed
 *   handshake, rejects otherwise.
 */
function tlsHandshake(domain, { ca, rejectUnauthorized, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: domain, port: 443, servername: domain, ca, rejectUnauthorized },
      () => {
        const peer = socket.getPeerCertificate();
        socket.destroy();
        resolve(
          peer && peer.subject
            ? {
                subject: peer.subject.CN ?? JSON.stringify(peer.subject),
                issuer: peer.issuer?.CN ?? JSON.stringify(peer.issuer ?? {}),
              }
            : null,
        );
      },
    );
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`TLS probe timed out after ${timeoutMs}ms`));
    });
    socket.on('error', (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

/**
 * Budgeted poll: keep probing until the apex serves a trusted chain or the
 * budget expires. Probe throws (connection refused, ENOTFOUND while DNS
 * propagates) are retryable — within the budget, "not reachable yet" and
 * "untrusted cert" are the same waiting game.
 *
 * @param {string} domain
 * @param {{
 *   budgetMs?: number, intervalMs?: number,
 *   probe?: typeof probeTlsTrustOnce,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   onProgress?: (msg: string) => void,
 * }} [opts]
 * @returns {Promise<{trusted: true, elapsedMs: number} |
 *   {trusted: false, reason: string, served: {subject: string, issuer: string}|null}>}
 */
export async function waitForTrustedTls(domain, opts = {}) {
  const {
    budgetMs = TLS_READY_BUDGET_MS,
    intervalMs = TLS_READY_POLL_MS,
    probe = probeTlsTrustOnce,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
    onProgress,
  } = opts;
  const start = now();
  const deadline = start + budgetMs;
  let last = { trusted: false, reason: 'never probed', served: null };
  for (;;) {
    try {
      const result = await probe(domain);
      if (result.trusted) return { trusted: true, elapsedMs: now() - start };
      last = {
        trusted: false,
        reason: result.reason ?? 'untrusted',
        served: result.served ?? null,
      };
    } catch (err) {
      last = {
        trusted: false,
        reason: err instanceof Error ? err.message : String(err),
        served: null,
      };
    }
    if (now() >= deadline) return last;
    onProgress?.(`waiting for trusted TLS on ${domain}: ${last.reason}`);
    await sleep(intervalMs);
  }
}

/**
 * Pure decision: trusted → done; untrusted on manual DNS → degraded (the
 * deploy proceeds with a warning — issuance can't complete before the
 * customer points DNS); untrusted on managed DNS → abort with everything a
 * human needs in one message.
 *
 * @param {{
 *   trusted: boolean, managedDns?: boolean, reason?: string,
 *   served?: {subject: string, issuer: string}|null,
 *   traefikLogTail?: string, fixHint?: string,
 * }} input
 * @returns {{degraded: boolean, reason?: string}}
 */
export function assertTlsReadyOrDegraded({
  trusted,
  managedDns = true,
  reason = '',
  served = null,
  traefikLogTail = '',
  fixHint = '',
}) {
  if (trusted) return { degraded: false };
  if (!managedDns) return { degraded: true, reason };
  const servedDesc = served
    ? `subject=${JSON.stringify(served.subject)} issuer=${JSON.stringify(served.issuer)}`
    : 'nothing verifiable served';
  throw new Error(
    `Deploy aborted: the domain does not serve a trusted TLS certificate, so ` +
      `browsers would show a security warning.\n` +
      `  Reason: ${reason}.\n  Served: ${servedDesc}.\n` +
      `${fixHint ? `  ${fixHint}\n` : ''}` +
      `${traefikLogTail ? `  Traefik/ACME log tail:\n${indent(traefikLogTail, '    ')}\n` : ''}` +
      `  Certificate issuance is retried automatically by Traefik; re-run ` +
      `\`vibecarbon deploy\` once the cause above is fixed (the deploy is idempotent).`,
  );
}

/** @param {string} text @param {string} pad */
function indent(text, pad) {
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}
