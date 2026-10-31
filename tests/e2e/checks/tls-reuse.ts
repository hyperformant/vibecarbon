/**
 * Proof that a certificate is REUSED, not re-issued.
 *
 * A restore, a scale or a failover puts the env's last certificate snapshot
 * back (compose: Traefik's acme.json; k8s: the vibecarbon-tls Secret) so the
 * domain keeps serving the certificate it had, with no new Let's Encrypt
 * order. ssl_valid cannot see the difference: a fresh issuance is trusted
 * too. Two checks can:
 *
 * - `tls_reused`: the serial the domain serves now equals the serial an
 *   earlier verify step recorded (verify-deploy first). Let's Encrypt never
 *   reuses a serial, so the same serial is the same certificate.
 * - `certificate_request_unchanged` (k8s tiers): a redeploy or a promotion
 *   creates no cert-manager CertificateRequest, the object every issuance
 *   starts from. Compared by uid, so a request garbage-collected with a
 *   deleted Certificate does not hide a new one.
 *
 * Never a hollow pass: no recorded serial, an unread served certificate or
 * an unread CertificateRequest listing fails (tests/unit/e2e/
 * hollow-pass-census.test.ts registers every check here). Reads only the
 * certificate's public serial and fingerprint, never key material.
 */
import { spawnSync } from 'node:child_process';
import tls from 'node:tls';
import { gitScrubbedEnv } from '../../_shared/git-env.js';
import type { VerificationResult } from '../scenarios/types.js';
import { resolveCheckIp } from './health.js';

const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface ServedCertificate {
  serialNumber: string;
  fingerprint256?: string;
  validTo?: string;
}

/**
 * The certificate `domain` serves over a VERIFIED handshake (the harness
 * trusts the Let's Encrypt staging roots, tests/e2e/utils/e2e-env.js).
 * Dials the address resolveCheckIp gives (the verify-failover pin when one
 * is active) with the domain as SNI. Rejects on an untrusted chain.
 */
export function readServedCertificate(domain: string): Promise<ServedCertificate> {
  return resolveCheckIp(domain).then(
    (ip) =>
      new Promise<ServedCertificate>((resolve, reject) => {
        const socket = tls.connect(
          { host: ip || domain, port: 443, servername: domain, rejectUnauthorized: true },
          () => {
            const peer = socket.getPeerCertificate();
            socket.destroy();
            resolve({
              serialNumber: peer?.serialNumber ?? '',
              fingerprint256: peer?.fingerprint256,
              validTo: peer?.valid_to,
            });
          },
        );
        socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
          socket.destroy();
          reject(new Error(`TLS handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`));
        });
        socket.on('error', (err) => {
          socket.destroy();
          reject(err);
        });
      }),
  );
}

/**
 * `tls_reused`: the domain serves the certificate `previousSerial` names.
 * The result's `details.servedSerial` is what the domain serves now, pass or
 * fail, so the caller compares the next step against it.
 */
export async function checkTlsReused(
  previousSerial: string,
  domain: string,
  deps: { readServed?: (domain: string) => Promise<ServedCertificate> } = {},
): Promise<VerificationResult> {
  const checkName = 'tls_reused';
  if (!previousSerial) {
    return {
      checkName,
      status: 'fail',
      errorMessage:
        'no certificate serial was recorded at an earlier verify step (ssl_valid did not pass ' +
        'there), so reuse cannot be proven',
    };
  }
  const readServed = deps.readServed ?? readServedCertificate;
  let served: ServedCertificate;
  try {
    served = await readServed(domain);
  } catch (err) {
    return {
      checkName,
      status: 'fail',
      errorMessage: `could not read the certificate ${domain} serves: ${err instanceof Error ? err.message : String(err)}`,
      details: { previousSerial },
    };
  }
  const details = {
    previousSerial,
    servedSerial: served.serialNumber,
    fingerprint256: served.fingerprint256,
    validTo: served.validTo,
  };
  if (!served.serialNumber) {
    return {
      checkName,
      status: 'fail',
      errorMessage: `${domain} served a certificate with no serial number`,
      details,
    };
  }
  if (served.serialNumber.toUpperCase() !== previousSerial.toUpperCase()) {
    return {
      checkName,
      status: 'fail',
      errorMessage:
        `${domain} serves certificate serial ${served.serialNumber}, not the recorded ` +
        `${previousSerial}: re-issued instead of reused (the certificate snapshot was not restored)`,
      details,
    };
  }
  return { checkName, status: 'pass', details };
}

/**
 * The uids of a `kubectl get certificaterequest -o json` list, or null when
 * the output is not a list (an error, a timeout).
 */
export function parseCertificateRequestUids(out: string): string[] | null {
  try {
    const parsed = JSON.parse(out) as { items?: Array<{ metadata?: { uid?: string } }> };
    if (!Array.isArray(parsed.items)) return null;
    return parsed.items.map((i) => i.metadata?.uid ?? '').filter(Boolean);
  } catch {
    return null;
  }
}

/** The CertificateRequest uids in the vibecarbon namespace, or null when unread. */
export function listCertificateRequestUids(kubeconfig: string): string[] | null {
  const r = spawnSync(
    'kubectl',
    ['--kubeconfig', kubeconfig, '-n', 'vibecarbon', 'get', 'certificaterequest', '-o', 'json'],
    { encoding: 'utf-8', timeout: 30_000, env: gitScrubbedEnv() },
  );
  if (r.status !== 0) return null;
  return parseCertificateRequestUids(r.stdout || '');
}

/**
 * `certificate_request_unchanged`: no CertificateRequest in `after` that was
 * not in `before`. `where` names the cluster for the message.
 */
export function checkNoNewCertificateRequest({
  before,
  after,
  where,
}: {
  before: string[] | null;
  after: string[] | null;
  where: string;
}): VerificationResult {
  const checkName = 'certificate_request_unchanged';
  if (!before || !after) {
    return {
      checkName,
      status: 'fail',
      errorMessage:
        `could not list CertificateRequests on ${where} ` +
        `(${!before ? 'before' : 'after'} the step), so a re-issue cannot be ruled out`,
    };
  }
  const known = new Set(before);
  const added = after.filter((uid) => !known.has(uid));
  if (added.length > 0) {
    return {
      checkName,
      status: 'fail',
      errorMessage:
        `${where} created CertificateRequest ${added.join(', ')} during the step: ` +
        're-issued instead of reused (cert-manager did not find a valid vibecarbon-tls Secret)',
      details: { before: before.length, after: after.length, added },
    };
  }
  return { checkName, status: 'pass', details: { before: before.length, after: after.length } };
}
