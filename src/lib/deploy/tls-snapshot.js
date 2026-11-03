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
import tls from 'node:tls';
import { createS3Client, envBackupPrefix } from '../walg/restore-base.js';
import { STANDBY_SELFSIGNED_ISSUER } from './tls-issuer-names.js';

/**
 * A stored or live certificate with less than this left is not worth serving.
 * Let's Encrypt's 6-day short-lived certificates are therefore always refused,
 * which is intended: they are never worth snapshotting.
 */
export const MIN_REMAINING_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

const K8S_SECRET_NAME = 'vibecarbon-tls';

/**
 * The label cert-manager puts on every Secret it manages
 * (`cmapi.PartOfCertManagerControllerLabelKey`, cert-manager v1.20.2
 * pkg/apis/certmanager/v1/types.go; set in
 * pkg/controller/certificates/issuing/internal/secret.go, setValues).
 *
 * cert-manager's filtered Secret informer
 * (internal/informers/core_filteredsecrets.go) keeps Secrets with this label
 * in a typed cache and all others in a metadata-only cache. A Secret that
 * gains the label moves between the two, and for that moment the lister's Get
 * answers NotFound. A restored Secret without it was labelled by
 * cert-manager's SecretsManager right after the Certificate was applied, and
 * 0.6 s later the trigger controller re-issued ("Issuing certificate as
 * Secret does not exist"). buildRestoredTlsSecret therefore writes it.
 */
export const CERT_MANAGER_CONTROLLER_LABEL = 'controller.cert-manager.io/fao';

/**
 * The S3 client options of a snapshot read on a failover path, where waiting
 * is outage: one attempt, 10s to connect and 10s for the request.
 */
export const DR_S3_CLIENT_OPTIONS = Object.freeze({
  maxAttempts: 1,
  requestHandler: { connectionTimeout: 10_000, requestTimeout: 10_000 },
});

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

/**
 * The entries of node's `subjectAltName` string, in certificate order, as
 * `{ type, value }` (`DNS`, `IP Address`, `URI`, `email`, ...). Node quotes a
 * value holding a delimiter as a JSON string; that quoting is undone here.
 */
function subjectAltNames(cert) {
  const text = String(cert.subjectAltName ?? '');
  const entries = [];
  const re = /\s*([^:,]+):("(?:[^"\\]|\\.)*"|[^,]*)(?:,|$)/y;
  let m = re.exec(text);
  while (m !== null && m[0] !== '') {
    let value = m[2];
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        // Left as written: an unparsable quote is not a name we compare.
      }
    }
    entries.push({ type: m[1], value });
    m = re.exec(text);
  }
  return entries;
}

function sanValues(cert, type) {
  return subjectAltNames(cert)
    .filter((e) => e.type === type)
    .map((e) => e.value);
}

function sanDnsNames(cert) {
  return sanValues(cert, 'DNS');
}

/**
 * An IP address as Go's net.IP.String() prints it: IPv4 dotted, an
 * IPv4-mapped IPv6 address as its IPv4, other IPv6 in RFC 5952 form. Node
 * prints IPv6 SANs uncompressed and uppercase.
 */
function goIpString(ip) {
  if (!ip.includes(':')) return ip;
  let host;
  try {
    host = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return ip;
  }
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!mapped) return host;
  const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/**
 * One CSV record as Go's encoding/csv Writer writes it, without the trailing
 * newline (cert-manager's util.JoinWithEscapeCSV): a field is quoted when it
 * holds a comma, quote, CR or LF, starts with white space, or is `\.`,
 * and a quote inside is doubled.
 */
function joinCsvLikeGo(values) {
  return values
    .map((v) =>
      v === '\\.' || /[,"\r\n]/.test(v) || /^\s/.test(v) ? `"${v.replace(/"/g, '""')}"` : v,
    )
    .join(',');
}

/** One subject attribute of node's legacy object as a list, in order. */
function subjectList(subject, key) {
  const v = subject?.[key];
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

/**
 * The annotations cert-manager derives from a certificate and writes on its
 * Secret, with the same keys, values and formatting: cert-manager v1.20.2
 * internal/controller/certificates/secrets.go, AnnotationsForCertificate
 * (keys from pkg/apis/certmanager/v1/types.go). common-name, alt-names,
 * ip-sans and uri-sans are kept when empty, every other one only when it has
 * a value. Reads the first (leaf) certificate of `certPem`; {} when there is
 * none, as cert-manager returns for a nil certificate.
 *
 * @param {string} certPem
 * @returns {Record<string, string>}
 */
export function certificateDetailsAnnotations(certPem) {
  const [cert] = pemCertificates(certPem);
  if (!cert) return {};
  const subject = cert.toLegacyObject().subject ?? {};
  const annotations = {};
  const put = (keepEmpty, key, value) => {
    if (value === '' && !keepEmpty) return;
    annotations[`cert-manager.io/${key}`] = value;
  };
  const putList = (keepEmpty, key, values) => {
    if (values.length === 0 && !keepEmpty) return;
    annotations[`cert-manager.io/${key}`] = joinCsvLikeGo(values);
  };
  // pkix.Name keeps the last value of a repeated single-valued attribute.
  put(true, 'common-name', subjectList(subject, 'CN').at(-1) ?? '');
  put(false, 'subject-serialnumber', subjectList(subject, 'serialNumber').at(-1) ?? '');
  putList(false, 'subject-organizations', subjectList(subject, 'O'));
  putList(false, 'subject-organizationalunits', subjectList(subject, 'OU'));
  putList(false, 'subject-countries', subjectList(subject, 'C'));
  putList(false, 'subject-provinces', subjectList(subject, 'ST'));
  putList(false, 'subject-localities', subjectList(subject, 'L'));
  putList(false, 'subject-postalcodes', subjectList(subject, 'postalCode'));
  putList(false, 'subject-streetaddresses', subjectList(subject, 'street'));
  putList(false, 'email-sans', sanValues(cert, 'email'));
  putList(true, 'alt-names', sanDnsNames(cert));
  putList(true, 'ip-sans', sanValues(cert, 'IP Address').map(goIpString));
  putList(true, 'uri-sans', sanValues(cert, 'URI'));
  return annotations;
}

/** Every certificate in a PEM bundle, in order; [] when any block is unparsable. */
export function pemCertificates(pem) {
  const blocks = String(pem ?? '').match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
  );
  if (!blocks) return [];
  try {
    return blocks.map((b) => new X509Certificate(b));
  } catch {
    return [];
  }
}

/**
 * A certificate serial in one spelling: uppercase hex, no colons, no leading
 * zeros (openssl prints `serial=0AB0...`, node and Traefik `AB0...`, some
 * tools `0a:b0:...`). '' when there is none. Serials are public: logging one
 * is how a reader tells two certificates for the same name apart.
 *
 * @param {unknown} serial
 * @returns {string}
 */
export function normalizeSerial(serial) {
  return String(serial ?? '')
    .replace(/[:\s]/g, '')
    .toUpperCase()
    .replace(/^0+(?=.)/, '');
}

/** The serial of the first (leaf) certificate in a PEM bundle; '' when unreadable. */
export function certificateSerial(pem) {
  const [leaf] = pemCertificates(pem);
  return leaf ? normalizeSerial(leaf.serialNumber) : '';
}

/**
 * The serial of the certificate a `kubectl get secret -o json` holds in
 * tls.crt; '' when unreadable. Reads only the certificate, never the key.
 */
export function k8sSecretSerial(secretJsonText) {
  return certificateSerial(decodeSecretField(parseJson(secretJsonText), 'tls.crt'));
}

/** `issuer` issued `cert`: the names match and the signature verifies. */
function issuedBy(cert, issuer) {
  try {
    return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

/**
 * True when the leaf (the first certificate of `certPem`) reaches one of
 * `trustRoots` through the intermediates the bundle carries, each link a
 * verified signature. Expiry of the links is not judged here (the leaf's own
 * validity is checkCertAndKey's).
 *
 * @param {string} certPem - leaf first, then its chain (a tls.crt, an acme.json certificate)
 * @param {readonly string[]} trustRoots - PEM roots (tls.rootCertificates)
 */
export function chainReachesTrustedRoot(certPem, trustRoots) {
  const bundle = pemCertificates(certPem);
  const roots = trustRoots.flatMap((r) => pemCertificates(r));
  if (bundle.length === 0 || roots.length === 0) return false;
  let current = bundle[0];
  const unused = bundle.slice(1);
  for (let hops = 0; hops <= bundle.length; hops++) {
    if (roots.some((root) => issuedBy(current, root))) return true;
    const next = unused.findIndex((c) => issuedBy(current, c));
    if (next < 0) return false;
    [current] = unused.splice(next, 1);
  }
  return false;
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

/** A DNS name or wildcard as Traefik labels an entry; anything else is never echoed. */
const ACME_ENTRY_NAME_RE = /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;

/**
 * Judge one acme.json certificate entry: checkCertAndKey, the leaf's SAN
 * names cover the entry's `domain.main` and every `domain.sans` (the label
 * alone proves nothing), and, for the prod CA, the chain reaches one of
 * `trustRoots`.
 *
 * @returns {{ ok: true, notAfter: Date } | { ok: false, reason: string }}
 */
function checkAcmeEntry(entry, { ca, now, trustRoots }) {
  const decode = (v) => Buffer.from(String(v ?? ''), 'base64').toString('utf8');
  const certPem = decode(entry.certificate);
  const verdict = checkCertAndKey(certPem, decode(entry.key), now);
  if (!verdict.ok) return verdict;
  const sans = Array.isArray(entry.domain.sans) ? entry.domain.sans : [];
  const have = new Set(sanDnsNames(parseCert(certPem)));
  if ([entry.domain.main, ...sans].some((n) => !have.has(n))) {
    return { ok: false, reason: 'certificate names do not cover its domain' };
  }
  if (ca === 'prod' && !chainReachesTrustedRoot(certPem, trustRoots)) {
    return { ok: false, reason: 'certificate does not chain to a trusted root' };
  }
  return verdict;
}

/**
 * Judge the certificates of the resolver holding the apex. The apex entry
 * must pass (its reason is bare); any other entry that fails is stale (an old
 * hostname whose certificate expired, say) and is dropped, not a reason to
 * refuse the file. `kept` is the entries a restore writes.
 *
 * @returns {{ ok: true, notAfter: Date, kept: object[], dropped: number }
 *   | { ok: false, reason: string }}
 */
function checkAcmeResolver(certs, { domain, ca, now, trustRoots }) {
  const entries = certs.filter((c) => c !== null && c !== undefined);
  if (entries.some((c) => !ACME_ENTRY_NAME_RE.test(String(c?.domain?.main ?? '')))) {
    return { ok: false, reason: 'a certificate entry has no valid domain' };
  }
  const apex = entries.find((c) => c.domain.main === domain);
  const apexVerdict = checkAcmeEntry(apex, { ca, now, trustRoots });
  if (!apexVerdict.ok) return apexVerdict;
  const kept = entries.filter(
    (entry) => entry === apex || checkAcmeEntry(entry, { ca, now, trustRoots }).ok,
  );
  return { ...apexVerdict, kept, dropped: entries.length - kept.length };
}

/**
 * Judge a Traefik acme.json: right CA, a valid certificate for `domain`
 * (checkAcmeResolver). Stale non-apex entries are dropped: `text` is the file
 * to restore, the input untouched when nothing was dropped, else re-serialized
 * without them (2-space indent, as Traefik writes it); `dropped` counts them.
 *
 * @param {string} acmeJsonText
 * @param {{ domain: string, ca: 'prod'|'staging', now?: Date,
 *   trustRoots?: readonly string[] }} args - `trustRoots` defaults to
 *   tls.rootCertificates and is only used for the prod CA
 * @returns {{ ok: true, notAfter: Date, text: string, dropped: number }
 *   | { ok: false, reason: string }}
 */
export function inspectComposeAcme(
  acmeJsonText,
  { domain, ca, now = new Date(), trustRoots = tls.rootCertificates },
) {
  const parsed = parseJson(acmeJsonText);
  if (!parsed || typeof parsed !== 'object')
    return { ok: false, reason: 'acme.json is not valid JSON' };
  let wrongCa = false;
  for (const resolver of Object.values(parsed)) {
    const uri = resolver?.Account?.Registration?.uri;
    if (typeof uri !== 'string') continue;
    const certs = Array.isArray(resolver.Certificates) ? resolver.Certificates : [];
    if (!certs.some((c) => c?.domain?.main === domain)) continue;
    if (caSlug(uri) !== ca) {
      wrongCa = true;
      continue;
    }
    const verdict = checkAcmeResolver(certs, { domain, ca, now, trustRoots });
    if (!verdict.ok) return verdict;
    const { kept, dropped, ...rest } = verdict;
    if (dropped === 0) return { ...rest, text: acmeJsonText, dropped };
    resolver.Certificates = kept;
    return { ...rest, text: JSON.stringify(parsed, null, 2), dropped };
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

/**
 * A clean vibecarbon-tls manifest from a snapshot, for `kubectl create` or
 * `replace -f -`. Its labels and annotations are exactly those cert-manager's
 * SecretsManager.setValues writes for this Certificate (cert-manager v1.20.2
 * pkg/controller/certificates/issuing/internal/secret.go): the certificate
 * details (certificateDetailsAnnotations), the certificate name, the issuer
 * reference and CERT_MANAGER_CONTROLLER_LABEL. cert-manager then has no label
 * to add, so the Secret never moves between its informer caches (see
 * CERT_MANAGER_CONTROLLER_LABEL), which is what made it re-issue. The
 * Certificate has no secretTemplate (carbon/k8s/base/traefik/certificate.yaml,
 * carbon/scripts/render-tls-certificate.mjs), so no template labels apply.
 * Every writer of this Secret goes through here
 * (tests/unit/deploy/tls-secret-writer-census.test.ts).
 */
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
      labels: { [CERT_MANAGER_CONTROLLER_LABEL]: 'true' },
      annotations: {
        ...certificateDetailsAnnotations(decodeSecretField(secret, 'tls.crt')),
        'cert-manager.io/certificate-name': K8S_SECRET_NAME,
        'cert-manager.io/issuer-name': issuerName,
        'cert-manager.io/issuer-kind': 'ClusterIssuer',
        'cert-manager.io/issuer-group': 'cert-manager.io',
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
export async function readTlsSnapshot(
  s3Config,
  key,
  { makeClient = createS3Client, clientOptions } = {},
) {
  try {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await makeClient(s3Config, clientOptions);
    const res = await client.send(new GetObjectCommand({ Bucket: s3Config.bucket, Key: key }));
    return { text: await res.Body.transformToString() };
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      return { text: null, reason: 'no snapshot' };
    }
    const reason = `S3 ${err?.name ?? 'error'}`;
    // The SDK's request handler names a connection or request timeout so.
    if (err?.name === 'TimeoutError' || err?.code === 'ETIMEDOUT') {
      return { text: null, reason, timedOut: true };
    }
    return { text: null, reason };
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
