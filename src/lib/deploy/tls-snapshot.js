/**
 * TLS certificate snapshots: keys, validation and storage.
 *
 * Issued certificates are saved to the backups bucket and restored on deploy,
 * failover and scale, so a new or promoted server serves a trusted cert
 * immediately instead of re-issuing. Certificates and private keys must never
 * be logged or put on argv: every helper here returns a short reason string,
 * never the input text, and the read/write helpers never log (the caller
 * prints the one info line).
 */
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { createS3Client, envBackupPrefix } from '../walg/restore-base.js';
import { STANDBY_SELFSIGNED_ISSUER } from './tls-issuer-names.js';

/**
 * A stored or live certificate with less than this left is not worth serving.
 * Let's Encrypt's 6-day short-lived certificates are therefore always refused,
 * which is intended: they are never worth snapshotting.
 */
export const MIN_REMAINING_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

const K8S_SECRET_NAME = 'vibecarbon-tls';

/** 'staging' iff the ACME directory URL or issuer name mentions staging. */
export function caSlug(acmeServerOrIssuerName) {
  return String(acmeServerOrIssuerName ?? '').includes('staging') ? 'staging' : 'prod';
}

/** Object key of a snapshot, inside the env folder `-purge` deletes. */
export function tlsSnapshotKey({ projectName, envName, ca, format }) {
  return `${envBackupPrefix(projectName, envName)}tls/${ca}/${format}.json`;
}

/** `s3://` prefix holding the snapshots of one CA, for server-side `st put`. */
export function tlsSnapshotS3Prefix({ backupBucket, projectName, envName, ca }) {
  return `s3://${backupBucket}/${envBackupPrefix(projectName, envName)}tls/${ca}`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseCert(pem) {
  try {
    return new X509Certificate(pem);
  } catch {
    return null;
  }
}

function sanDnsNames(cert) {
  return String(cert.subjectAltName ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('DNS:'))
    .map((s) => s.slice(4));
}

/**
 * Judge one certificate + key pair: parsable, issued by a CA (not
 * self-signed), the key belongs to it, and enough validity is left.
 *
 * @returns {{ ok: true, notAfter: Date } | { ok: false, reason: string }}
 */
function checkCertAndKey(certPem, keyPem, now) {
  const cert = parseCert(certPem);
  if (!cert) return { ok: false, reason: 'certificate is unparsable' };
  if (cert.checkIssued(cert)) return { ok: false, reason: 'certificate is self-signed' };
  try {
    if (!cert.checkPrivateKey(createPrivateKey(keyPem))) throw new Error('mismatch');
  } catch {
    return { ok: false, reason: 'certificate and key do not match' };
  }
  const notAfter = cert.validToDate;
  if (notAfter.getTime() - now.getTime() < MIN_REMAINING_VALIDITY_MS) {
    return { ok: false, reason: `certificate expires ${notAfter.toISOString()}, too soon` };
  }
  return { ok: true, notAfter };
}

/**
 * Judge a Traefik acme.json: right CA, a certificate for `domain`, enough
 * validity left.
 *
 * @returns {{ ok: true, notAfter: Date } | { ok: false, reason: string }}
 */
export function inspectComposeAcme(acmeJsonText, { domain, ca, now = new Date() }) {
  const parsed = parseJson(acmeJsonText);
  if (!parsed || typeof parsed !== 'object')
    return { ok: false, reason: 'acme.json is not valid JSON' };
  let wrongCa = false;
  for (const resolver of Object.values(parsed)) {
    const uri = resolver?.Account?.Registration?.uri;
    if (typeof uri !== 'string') continue;
    const certs = Array.isArray(resolver.Certificates) ? resolver.Certificates : [];
    const entry = certs.find((c) => c?.domain?.main === domain);
    if (!entry) continue;
    if (caSlug(uri) !== ca) {
      wrongCa = true;
      continue;
    }
    const decode = (v) => Buffer.from(String(v ?? ''), 'base64').toString('utf8');
    return checkCertAndKey(decode(entry.certificate), decode(entry.key), now);
  }
  return {
    ok: false,
    reason: wrongCa
      ? `certificate for ${domain} was issued by a different CA than ${ca}`
      : `no certificate for ${domain} in acme.json`,
  };
}

function decodeSecretField(secret, field) {
  const raw = secret?.data?.[field];
  return typeof raw === 'string' && raw ? Buffer.from(raw, 'base64').toString('utf8') : '';
}

/**
 * Judge a `kubectl get secret -o json` of vibecarbon-tls: cert-manager issued
 * (not the standby self-signed issuer), key present, SAN DNS names exactly the
 * required set, enough validity left.
 *
 * @returns {{ ok: true, notAfter: Date, issuerName: string } | { ok: false, reason: string }}
 */
export function inspectK8sTlsSecret(secretJsonText, { dnsNames, now = new Date() }) {
  const secret = parseJson(secretJsonText);
  if (!secret || typeof secret !== 'object')
    return { ok: false, reason: 'secret is not valid JSON' };
  const issuerName = secret.metadata?.annotations?.['cert-manager.io/issuer-name'] ?? '';
  if (!issuerName) return { ok: false, reason: 'secret has no cert-manager issuer' };
  if (issuerName === STANDBY_SELFSIGNED_ISSUER)
    return { ok: false, reason: 'secret is standby self-signed' };
  const certPem = decodeSecretField(secret, 'tls.crt');
  const keyPem = decodeSecretField(secret, 'tls.key');
  if (!keyPem) return { ok: false, reason: 'secret has no tls.key' };
  const cert = parseCert(certPem);
  if (!cert) return { ok: false, reason: 'tls.crt is missing or unparsable' };
  const have = new Set(sanDnsNames(cert));
  const want = new Set(dnsNames);
  if (have.size !== want.size || [...want].some((n) => !have.has(n))) {
    return { ok: false, reason: 'certificate names differ from the required names' };
  }
  const verdict = checkCertAndKey(certPem, keyPem, now);
  return verdict.ok ? { ...verdict, issuerName } : verdict;
}

/** A clean vibecarbon-tls manifest from a snapshot, ready for `kubectl apply -f -`. */
export function buildRestoredTlsSecret(secretJsonText, { namespace, issuerName }) {
  const secret = parseJson(secretJsonText);
  if (!secret?.data?.['tls.crt'] || !secret.data['tls.key']) {
    throw new Error('snapshot secret is unparsable');
  }
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'kubernetes.io/tls',
    metadata: {
      name: K8S_SECRET_NAME,
      namespace,
      annotations: {
        'cert-manager.io/issuer-name': issuerName,
        'cert-manager.io/issuer-kind': 'ClusterIssuer',
        'cert-manager.io/issuer-group': 'cert-manager.io',
        'cert-manager.io/certificate-name': K8S_SECRET_NAME,
      },
    },
    data: { 'tls.crt': secret.data['tls.crt'], 'tls.key': secret.data['tls.key'] },
  };
}

/** True when the stored snapshot should replace the live certificate. */
export function isSnapshotBetter(liveVerdict, storedVerdict) {
  if (!storedVerdict.ok) return false;
  if (!liveVerdict.ok) return true;
  return storedVerdict.notAfter.getTime() > liveVerdict.notAfter.getTime();
}

/** Read a snapshot object. Never throws, never logs. */
export async function readTlsSnapshot(s3Config, key, { makeClient = createS3Client } = {}) {
  try {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await makeClient(s3Config);
    const res = await client.send(new GetObjectCommand({ Bucket: s3Config.bucket, Key: key }));
    return { text: await res.Body.transformToString() };
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      return { text: null, reason: 'no snapshot' };
    }
    return { text: null, reason: `S3 ${err?.name ?? 'error'}` };
  }
}

/** Write a snapshot object. Never throws, never logs. */
export async function writeTlsSnapshot(s3Config, key, body, { makeClient = createS3Client } = {}) {
  try {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await makeClient(s3Config);
    await client.send(new PutObjectCommand({ Bucket: s3Config.bucket, Key: key, Body: body }));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `S3 ${err?.name ?? 'error'}` };
  }
}
