/**
 * TLS verdict for the compose tiers.
 *
 * THE RULE: a deploy reports its TLS state; it does not wait out a CA.
 * Compose fires Traefik/lego ACME issuance asynchronously, and on slow DNS-01
 * propagation (DigitalOcean's anycast POPs, run 33252884427) the domain sat
 * on the Traefik self-signed default (compose) or an apex-less wildcard
 * (compose-ha) for minutes after "success". The first answer was a hard
 * gate (480s, then abort), which failed deploys whose app was healthy only
 * because a CA was slow. Now the deploy looks for a trusted chain for one
 * first-look window (TLS_FIRST_LOOK_BUDGET_MS), then finishes either trusted
 * or pending. A pending deploy names the cause in one warning, records
 * envConfig.tls for `vibecarbon status`, and the server's tls-retry cron
 * (carbon/backup/tls-retry.sh) restarts Traefik to retry issuance, because
 * Traefik never retries a failed first issuance on its own.
 *
 * Shape: pure decision function (tlsVerdict) + a budgeted poll with
 * injectable probe/sleep/clock (the waitForNewPrimaryApi pattern; unit
 * tests never open a socket) + the one real-socket probe.
 *
 * Manual-DNS deploys get a shorter courtesy window: the customer may not
 * have pointed the domain yet, and HTTP-01 issuance cannot even start until
 * they do (the documented "deploy first, point DNS after" flow).
 */

import tls from 'node:tls';
import { readOperatorVar } from '../operator-env.js';
import { stagingProbeCa } from './staging-ca.js';

/**
 * First-look budget for the apex to serve a trusted chain on managed DNS.
 * The DNS-01 settle floor (legoTuningEnv, ACME_DNS_DELAY_BEFORE_CHECKS) puts
 * healthy issuance at about 120s (2026-10-20 trials: wildcard 119s, apex
 * 124s), and Traefik has been issuing since start-compose-stack, so a
 * healthy CA lands inside it. A slower one leaves the deploy finished with
 * TLS pending instead of holding it open.
 */
export const TLS_FIRST_LOOK_BUDGET_MS = 180_000;

/** Poll cadence — matches the e2e ssl_valid retry cadence order of magnitude. */
export const TLS_READY_POLL_MS = 5_000;

/**
 * The manual-DNS courtesy window. The customer may not have pointed the
 * domain yet, so issuance may legitimately be impossible right now. One
 * short window catches the "DNS already pointed, cert just finishing" case;
 * after it, the deploy finishes with TLS pending.
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
 * A trusted handshake also names the certificate it verified: its expiry
 * (`validTo`, ISO 8601) and `serialNumber` (hex), for `vibecarbon status`.
 * Never the key or the certificate body.
 *
 * @param {string} domain
 * @param {{ timeoutMs?: number, port?: number, ca?: string[] }} [opts] `port`
 *   and `ca` are test seams (a local server and its throwaway CA).
 * @returns {Promise<{trusted: true, validTo: string|null, serialNumber: string|null} |
 *   {trusted: false, reason: string, served: {subject: string, issuer: string}|null}>}
 */
export async function probeTlsTrustOnce(
  domain,
  {
    timeoutMs = TLS_PROBE_TIMEOUT_MS,
    port = 443,
    ca = (readOperatorVar('ACME_CA_SERVER').value || '').includes('staging')
      ? stagingProbeCa()
      : undefined,
  } = {},
) {
  try {
    const peer = await tlsHandshake(domain, { ca, port, rejectUnauthorized: true, timeoutMs });
    return {
      trusted: true,
      validTo: peer?.validTo ?? null,
      serialNumber: peer?.serialNumber ?? null,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    let served = null;
    try {
      const peer = await tlsHandshake(domain, { ca, port, rejectUnauthorized: false, timeoutMs });
      served = peer ? { subject: peer.subject, issuer: peer.issuer } : null;
    } catch {
      // Connection-level failure (refused, reset, no DNS) — nothing served.
    }
    return { trusted: false, reason, served };
  }
}

/**
 * @param {string} domain
 * @param {{ ca?: string[], port: number, rejectUnauthorized: boolean, timeoutMs: number }} opts
 * @returns {Promise<{subject: string, issuer: string, validTo: string|null, serialNumber: string|null}|null>}
 *   the peer certificate's identity, expiry and serial, or null when none
 *   was presented; resolves only on a completed handshake, rejects otherwise.
 */
function tlsHandshake(domain, { ca, port, rejectUnauthorized, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: domain, port, servername: domain, ca, rejectUnauthorized },
      () => {
        const peer = socket.getPeerCertificate();
        socket.destroy();
        const validTo = peer?.valid_to ? new Date(peer.valid_to) : null;
        resolve(
          peer?.subject
            ? {
                subject: peer.subject.CN ?? JSON.stringify(peer.subject),
                issuer: peer.issuer?.CN ?? JSON.stringify(peer.issuer ?? {}),
                validTo: validTo && !Number.isNaN(validTo.getTime()) ? validTo.toISOString() : null,
                serialNumber: peer.serialNumber || null,
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
    budgetMs = TLS_FIRST_LOOK_BUDGET_MS,
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
 * Pure decision, never a throw: trusted, or pending with the reason and a
 * detail block (what was served, the fix hint, the Traefik log tail) for
 * the one warning the deploy prints.
 *
 * @param {{
 *   trusted: boolean, managedDns?: boolean, reason?: string,
 *   served?: {subject: string, issuer: string}|null,
 *   traefikLogTail?: string, fixHint?: string,
 * }} input
 * @returns {{state: 'trusted'|'pending', reason?: string, detail?: string}}
 */
export function tlsVerdict({
  trusted,
  managedDns = true,
  reason = '',
  served = null,
  traefikLogTail = '',
  fixHint = '',
}) {
  if (trusted) return { state: 'trusted' };
  const servedDesc = served
    ? `subject=${JSON.stringify(served.subject)} issuer=${JSON.stringify(served.issuer)}`
    : 'nothing verifiable served';
  const detail =
    `  Served: ${servedDesc}.` +
    `${managedDns && fixHint ? `\n  ${fixHint}` : ''}` +
    `${traefikLogTail ? `\n  Traefik/ACME log tail:\n${indent(traefikLogTail, '    ')}` : ''}`;
  return { state: 'pending', reason: reason || 'untrusted', detail };
}

/** @param {string} text @param {string} pad */
function indent(text, pad) {
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}
