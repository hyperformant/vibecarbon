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
import { X509Certificate } from 'node:crypto';
import { createS3Client } from '../walg/restore-base.js';
// paid-boundary-ignore: acme-issuer-policy.js is an import-free constants leaf, so the free compose path shares the issuer name without pulling in engine code
import { STANDBY_SELFSIGNED_ISSUER } from './k8s/acme-issuer-policy.js';

/** A stored or live certificate with less than this left is not worth serving. */
export const MIN_REMAINING_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

const K8S_SECRET_NAME = 'vibecarbon-tls';

/** 'staging' iff the ACME directory URL or issuer name mentions staging. */
export function caSlug(acmeServerOrIssuerName) {
  return String(acmeServerOrIssuerName ?? '').includes('staging') ? 'staging' : 'prod';
}

/** Object key of a snapshot, inside the env folder `-purge` deletes. */
export function tlsSnapshotKey({ projectName, envName, ca, format }) {
  return `backups/${projectName}/${envName}/tls/${ca}/${format}.json`;
}

/** `s3://` prefix holding the snapshots of one CA, for server-side `st put`. */
export function tlsSnapshotS3Prefix({ backupBucket, projectName, envName, ca }) {
  return `s3://${backupBucket}/backups/${projectName}/${envName}/tls/${ca}`;
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

/** `{ ok: true, notAfter }` when the cert has enough validity left. */
function checkValidity(cert, now) {
  const notAfter = new Date(cert.validTo);
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
  for (const resolver of Object.values(parsed)) {
    const uri = resolver?.Account?.Registration?.uri;
    if (typeof uri !== 'string') continue;
    if (caSlug(uri) !== ca)
      return { ok: false, reason: `acme.json was issued by a different CA than ${ca}` };
    const entry = (resolver.Certificates ?? []).find((c) => c?.domain?.main === domain);
    if (!entry) continue;
    const pem = Buffer.from(String(entry.certificate ?? ''), 'base64').toString('utf8');
    const cert = parseCert(pem);
    if (!cert) return { ok: false, reason: `certificate for ${domain} is unparsable` };
    if (!entry.key) return { ok: false, reason: `certificate for ${domain} has no key` };
    return checkValidity(cert, now);
  }
  return { ok: false, reason: `no certificate for ${domain} in acme.json` };
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
  if (issuerName === STANDBY_SELFSIGNED_ISSUER)
    return { ok: false, reason: 'secret is standby self-signed' };
  if (!decodeSecretField(secret, 'tls.key')) return { ok: false, reason: 'secret has no tls.key' };
  const cert = parseCert(decodeSecretField(secret, 'tls.crt'));
  if (!cert) return { ok: false, reason: 'tls.crt is missing or unparsable' };
  const have = new Set(sanDnsNames(cert));
  const want = new Set(dnsNames);
  if (have.size !== want.size || [...want].some((n) => !have.has(n))) {
    return { ok: false, reason: 'certificate names differ from the required names' };
  }
  const validity = checkValidity(cert, now);
  return validity.ok ? { ...validity, issuerName } : validity;
}

/** A clean vibecarbon-tls manifest from a snapshot, ready for `kubectl apply -f -`. */
export function buildRestoredTlsSecret(secretJsonText, { namespace, issuerName }) {
  const secret = JSON.parse(secretJsonText);
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
