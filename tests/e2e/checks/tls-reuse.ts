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
 * - `tls_served_is_secret` (k8s tiers, verify-deploy): the domain serves the
 *   certificate Secret/vibecarbon-tls holds, the one every snapshot and
 *   restore covers. A second certificate for the same name in Traefik's
 *   global store (the observability add-on's old grafana-tls) let the domain
 *   serve either, and a correct restore then failed `tls_reused`.
 * - `tls_one_certificate_per_name` (k8s tiers, verify-deploy): the
 *   deterministic half of the above. The served serial is one sample, which
 *   a second certificate can pass by luck; the primary's inventory cannot.
 *   No cert-manager Certificate and no `kubernetes.io/tls` Secret other than
 *   vibecarbon/vibecarbon-tls may cover the domain, in any namespace.
 *
 * Never a hollow pass: no recorded serial, an unread served certificate or
 * an unread CertificateRequest listing fails (tests/unit/e2e/
 * hollow-pass-census.test.ts registers every check here). Reads only the
 * certificate's public serial and fingerprint, never key material.
 */
import { spawnSync } from 'node:child_process';
import tls from 'node:tls';
import {
  certificateSerial,
  normalizeSerial,
  pemCertificates,
} from '../../../src/lib/deploy/tls-snapshot.js';
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

/**
 * The serial of the certificate in a Secret's base64 `tls.crt` (the leaf), in
 * the CLI's one spelling (normalizeSerial), or null when there is none.
 */
export function parseSecretCertificateSerial(tlsCrtBase64: string): string | null {
  const b64 = tlsCrtBase64.trim();
  if (!b64) return null;
  return certificateSerial(Buffer.from(b64, 'base64').toString('utf8')) || null;
}

/**
 * The serial of the certificate Secret/vibecarbon-tls holds, or null when
 * unread. Asks kubectl for tls.crt alone: the key never leaves the cluster.
 */
export function readSecretCertificateSerial(kubeconfig: string): string | null {
  const r = spawnSync(
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      '-n',
      'vibecarbon',
      'get',
      'secret',
      'vibecarbon-tls',
      '-o',
      'jsonpath={.data.tls\\.crt}',
    ],
    { encoding: 'utf-8', timeout: 30_000, env: gitScrubbedEnv() },
  );
  if (r.status !== 0) return null;
  return parseSecretCertificateSerial(r.stdout || '');
}

/**
 * `tls_served_is_secret`: the serial the domain serves (ssl_valid's, at
 * verify-deploy) is the serial of Secret/vibecarbon-tls on the primary.
 */
export function checkServedIsSecret(
  servedSerial: string,
  kubeconfig: string | null,
  deps: { readSecretSerial?: (kubeconfig: string) => string | null } = {},
): VerificationResult {
  const checkName = 'tls_served_is_secret';
  const served = normalizeSerial(servedSerial);
  if (!served) {
    return {
      checkName,
      status: 'fail',
      errorMessage:
        'no served certificate serial (ssl_valid did not pass), so the served certificate ' +
        'cannot be matched to Secret/vibecarbon-tls',
    };
  }
  if (!kubeconfig) {
    return {
      checkName,
      status: 'fail',
      errorMessage: 'no kubeconfig for the primary cluster, so Secret/vibecarbon-tls was not read',
      details: { servedSerial: served },
    };
  }
  const secret = (deps.readSecretSerial ?? readSecretCertificateSerial)(kubeconfig);
  if (!secret) {
    return {
      checkName,
      status: 'fail',
      errorMessage: `could not read the certificate of Secret/vibecarbon-tls through ${kubeconfig}`,
      details: { servedSerial: served },
    };
  }
  const details = { servedSerial: served, secretSerial: secret };
  if (served !== secret) {
    return {
      checkName,
      status: 'fail',
      errorMessage:
        `the domain serves certificate serial ${served}, but Secret/vibecarbon-tls holds ` +
        `${secret}: Traefik holds another certificate for the same name, so a restore of ` +
        'vibecarbon-tls would not change what is served',
      details,
    };
  }
  return { checkName, status: 'pass', details };
}

/** A Certificate or TLS Secret and the DNS names it covers. */
export interface TlsObject {
  namespace: string;
  name: string;
  dnsNames: string[];
}

const BASE_TLS = { namespace: 'vibecarbon', name: 'vibecarbon-tls' };

/** `domain` matches one of `dnsNames` exactly or through a one-label wildcard. */
export function coversDomain(dnsNames: string[], domain: string): boolean {
  const d = domain.toLowerCase();
  const parent = d.slice(d.indexOf('.') + 1);
  return dnsNames.some((raw) => {
    const n = raw.toLowerCase();
    return n === d || (d.includes('.') && parent.includes('.') && n === `*.${parent}`);
  });
}

/** The Certificates of a `kubectl get certificate -A -o json`, or null when not a list. */
export function parseCertificateInventory(json: string): TlsObject[] | null {
  try {
    const parsed = JSON.parse(json) as {
      items?: Array<{
        metadata?: { namespace?: string; name?: string };
        spec?: { dnsNames?: string[] };
      }>;
    };
    if (!Array.isArray(parsed.items)) return null;
    return parsed.items.map((i) => ({
      namespace: i.metadata?.namespace ?? '',
      name: i.metadata?.name ?? '',
      dnsNames: i.spec?.dnsNames ?? [],
    }));
  } catch {
    return null;
  }
}

/**
 * The TLS Secrets of a `namespace<TAB>name<TAB>base64 tls.crt` listing (one
 * per line, the jsonpath readClusterTlsInventory asks for), with the SAN DNS
 * names of each leaf certificate. Only the certificate is ever read.
 */
export function parseTlsSecretInventory(text: string): TlsObject[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [namespace = '', name = '', b64 = ''] = line.split('\t');
      const [leaf] = b64.trim()
        ? pemCertificates(Buffer.from(b64.trim(), 'base64').toString('utf8'))
        : [];
      const dnsNames = String(leaf?.subjectAltName ?? '')
        .split(',')
        .map((s: string) => s.trim())
        .filter((s: string) => s.startsWith('DNS:'))
        .map((s: string) => s.slice(4));
      return { namespace, name, dnsNames };
    });
}

/**
 * Every Certificate and every `kubernetes.io/tls` Secret on the cluster, in
 * all namespaces; null for a list that could not be read. The Secrets are
 * read through a jsonpath for namespace, name and tls.crt: no key is ever
 * fetched.
 */
export function readClusterTlsInventory(kubeconfig: string): {
  certificates: TlsObject[] | null;
  secrets: TlsObject[] | null;
} {
  const run = (args: string[]) =>
    spawnSync('kubectl', ['--kubeconfig', kubeconfig, ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: gitScrubbedEnv(),
    });
  const certs = run(['get', 'certificate', '--all-namespaces', '-o', 'json']);
  const secrets = run([
    'get',
    'secret',
    '--all-namespaces',
    '--field-selector',
    'type=kubernetes.io/tls',
    '-o',
    'jsonpath={range .items[*]}{.metadata.namespace}{"\\t"}{.metadata.name}{"\\t"}{.data.tls\\.crt}{"\\n"}{end}',
  ]);
  return {
    certificates: certs.status === 0 ? parseCertificateInventory(certs.stdout || '') : null,
    secrets: secrets.status === 0 ? parseTlsSecretInventory(secrets.stdout || '') : null,
  };
}

/**
 * `tls_one_certificate_per_name`: on the primary, only
 * vibecarbon/vibecarbon-tls covers `domain`, as a Certificate and as a TLS
 * Secret, and that Secret is there.
 */
export function checkOneCertificatePerName({
  domain,
  certificates,
  secrets,
}: {
  domain: string;
  certificates: TlsObject[] | null;
  secrets: TlsObject[] | null;
}): VerificationResult {
  const checkName = 'tls_one_certificate_per_name';
  if (!certificates || !secrets) {
    return {
      checkName,
      status: 'fail',
      errorMessage:
        `could not list the ${!certificates ? 'Certificates' : 'TLS Secrets'} in all namespaces, ` +
        'so a second certificate for the domain cannot be ruled out',
    };
  }
  const isBase = (o: TlsObject) => o.namespace === BASE_TLS.namespace && o.name === BASE_TLS.name;
  const covering = (kind: string, list: TlsObject[]) =>
    list
      .filter((o) => !isBase(o) && coversDomain(o.dnsNames, domain))
      .map((o) => `${kind} ${o.namespace}/${o.name}`);
  const others = [...covering('Certificate', certificates), ...covering('Secret', secrets)];
  if (others.length > 0) {
    return {
      checkName,
      status: 'fail',
      errorMessage:
        `${others.join(', ')} also cover ${domain}: Traefik can serve either certificate, ` +
        'and only vibecarbon/vibecarbon-tls is snapshotted and restored',
      details: { others },
    };
  }
  if (!secrets.some((o) => isBase(o) && coversDomain(o.dnsNames, domain))) {
    return {
      checkName,
      status: 'fail',
      errorMessage: `no Secret vibecarbon/vibecarbon-tls covering ${domain} was found`,
    };
  }
  return {
    checkName,
    status: 'pass',
    details: { certificates: certificates.length, secrets: secrets.length },
  };
}
