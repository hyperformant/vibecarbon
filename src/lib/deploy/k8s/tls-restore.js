/**
 * k8s TLS certificate reuse: the Secret the deploy restores from the last
 * snapshot before cert-manager would issue, and the snapshot it saves once
 * the domain is trusted. (The Certificate itself is rendered by
 * carbon/scripts/render-tls-certificate.mjs, shared with the GitOps workflow.)
 *
 * The overwrite rule. A restore writes Secret/vibecarbon-tls only when the
 * cluster has none, or has one that does not pass inspectK8sTlsSecret for
 * this deploy's names and issuer: no cert-manager issuer annotation yet (the
 * Secret is not issued), the standby self-signed issuer, another issuer than
 * this Certificate's, unparsable, other names, or under 7 days left. A live
 * Secret that passes is never replaced, not even by a longer-lived snapshot:
 * cert-manager renews it by itself. The write holds the read's verdict as a
 * precondition: an absent Secret is filled with `kubectl create` (a Secret
 * issued meanwhile makes it AlreadyExists, and it is kept), an invalid one
 * with `kubectl replace` at the resourceVersion that was judged (a change
 * meanwhile makes it Conflict, and the change is kept).
 *
 * The snapshot is restored only when it is from this deploy's own issuer
 * (same CA and same provider issuer as the Certificate), and, for the prod
 * CA, only when the chain in its tls.crt reaches a root of the platform
 * store.
 *
 * Key handling. The snapshot is validated in full before anything is written
 * (key matches certificate, exact names, at least 7 days left, not
 * self-signed). The restored Secret goes to kubectl on stdin, never on argv
 * and never through a temp file. Every kubectl command whose output or input
 * can carry key material runs through quietKubectl (quietSshKubectl on the
 * failover promotion, which reaches the cluster over ssh), which prints nothing, not
 * even on failure, and a failure is reported by a fixed phrase, never by the
 * command's output. Nothing here logs: callers print the one line
 * (k8sTlsRestoreLine).
 */
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { sshKubectlArgv } from '../../ssh.js';
import {
  buildRestoredTlsSecret,
  caSlug,
  inspectK8sTlsSecret,
  readTlsSnapshot,
  tlsSnapshotKey,
  writeTlsSnapshot,
} from '../tls-snapshot.js';

/**
 * cert-manager's minimum backoff after a failed CertificateRequest (the
 * controller's `--certificate-request-minimum-backoff-duration`; its own
 * default is 1h). A first issuance that misses the deploy's first look is
 * retried within minutes, while the deploy has already finished with TLS
 * pending.
 */
export const CERT_MANAGER_MIN_BACKOFF = '5m';

/** The reason a restore leaves a valid live Secret alone. */
export const LIVE_SECRET_VALID = 'live Secret valid';

const NAMESPACE = 'vibecarbon';
const NAME = 'vibecarbon-tls';
const QUIET_TIMEOUT_MS = 30_000;

/** `kubectl get` of the one Secret, as JSON; empty output when it is absent. */
const LIVE_SECRET_ARGV = Object.freeze([
  'get',
  'secret',
  NAME,
  '-n',
  NAMESPACE,
  '-o',
  'json',
  '--ignore-not-found',
]);

/** The class of a failed kubectl call, read from its stderr (never the text itself). */
function kubectlFailureClass(stderr) {
  if (/\(AlreadyExists\)/.test(stderr)) return 'AlreadyExists';
  if (/\(Conflict\)/.test(stderr)) return 'Conflict';
  if (/\(NotFound\)/.test(stderr)) return 'NotFound';
  return 'failed';
}

/**
 * Run one command printing nothing, not even on failure: stdout is piped and
 * returned, stdin carries `input` (closed right after, or at once when there
 * is none), and a failure throws the fixed message `kubectl failed` with a
 * `reason` class read from stderr; the output itself never leaves here.
 */
function runQuiet(argv, { env, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const fail = (stderr = '') =>
      reject(Object.assign(new Error('kubectl failed'), { reason: kubectlFailureClass(stderr) }));
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      fail();
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      fail();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else fail(stderr);
    });
    // A command that exits before reading its stdin must not surface EPIPE.
    child.stdin?.on?.('error', () => {});
    if (input !== undefined) child.stdin?.write(input);
    child.stdin?.end();
  });
}

/**
 * A kubectl runner that prints nothing, not even under CI or DEBUG: stdout is
 * piped and returned, stdin carries `input` (closed right after, or at once
 * when there is none), and a failure throws the fixed message
 * `kubectl failed` with a `reason` class (AlreadyExists, Conflict, NotFound,
 * failed) read from stderr; the output itself never leaves this function.
 * For commands whose stdin or stdout can carry key material. No retry: a
 * restore or snapshot that fails is skipped, and cert-manager issues as it
 * would anyway.
 *
 * The runner accepts the runKubectlWithRetry option shape, but only `input`
 * means anything here: `captureStdout` is always the behavior (nothing is
 * ever streamed) and `description` is unused (nothing is ever printed).
 *
 * @param {NodeJS.ProcessEnv} env - carries KUBECONFIG
 * @returns {(argv: string[], opts?: { input?: string, captureStdout?: boolean, description?: string }) => Promise<string>}
 */
export function quietKubectl(env, { timeoutMs = QUIET_TIMEOUT_MS } = {}) {
  return (argv, { input } = {}) => runQuiet(['kubectl', ...argv], { env, input, timeoutMs });
}

/**
 * quietKubectl for a k3s server reached over ssh, as sshKubectl reaches it
 * (same argv, host-key pinning and BatchMode), for the failover promotion.
 * No transport retry: a write whose connection dropped after it ran would
 * meet its own Secret. Prints nothing; a failure throws `kubectl failed`
 * with its class (an ssh failure is `failed`).
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv }} [options] - `env`
 *   defaults to this process's own
 * @returns {(argv: string[], opts?: { input?: string }) => Promise<string>}
 */
export function quietSshKubectl(ip, sshKeyPath, { timeoutMs = QUIET_TIMEOUT_MS, env } = {}) {
  return (argv, { input } = {}) =>
    runQuiet(sshKubectlArgv(ip, sshKeyPath, argv), { env, input, timeoutMs });
}

/** Every certificate in a PEM bundle, in order; [] when any block is unparsable. */
function pemCertificates(pem) {
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
 * validity is inspectK8sTlsSecret's).
 *
 * @param {string} certPem - a tls.crt: leaf first, then its chain
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

/** The live Secret's JSON text ('' when absent), or null when it could not be read. */
async function readLiveSecret(runKubectl) {
  try {
    const out = await runKubectl([...LIVE_SECRET_ARGV], {
      captureStdout: true,
      description: 'read Secret/vibecarbon-tls',
    });
    return String(out ?? '').trim();
  } catch {
    return null;
  }
}

function backupPreconditions(s3Config, ca) {
  if (!s3Config?.bucket) return 'no backup bucket';
  if (!s3Config.accessKey || !s3Config.secretKey) return 'no backup credentials';
  if (!ca) return 'no recorded CA';
  return null;
}

/**
 * Why a k8s-secret snapshot is not restorable for this issuer and these
 * names, or null when it is: valid in full (inspectK8sTlsSecret), issued by
 * this very issuer (same CA and same provider issuer), and, for the prod CA,
 * chaining to one of `trustRoots`. The reason is a fixed phrase.
 *
 * @param {string} text - the snapshot's Secret JSON
 * @param {{ dnsNames: string[], issuerName: string, ca: 'prod'|'staging',
 *   trustRoots: readonly string[] }} args
 * @returns {string|null}
 */
function judgeK8sTlsSnapshot(text, { dnsNames, issuerName, ca, trustRoots }) {
  const verdict = inspectK8sTlsSecret(text, { dnsNames });
  if (!verdict.ok) return `snapshot refused: ${verdict.reason}`;
  // Only this deploy's own issuer: another CA's or another provider's
  // certificate is no reuse (the Certificate's issuerRef would not match
  // what was issued), and the restored annotation would misstate it.
  if (verdict.issuerName !== issuerName || caSlug(verdict.issuerName) !== ca) {
    return 'snapshot refused: issued by another issuer';
  }
  if (ca === 'prod') {
    const crt = Buffer.from(JSON.parse(text).data['tls.crt'], 'base64').toString('utf8');
    if (!chainReachesTrustedRoot(crt, trustRoots)) {
      return 'snapshot refused: certificate does not chain to a trusted root';
    }
  }
  return null;
}

/**
 * Read the k8s-secret snapshot of this env and CA and judge it as a restore
 * would (judgeK8sTlsSnapshot), before anything on the cluster is touched. A
 * failover reads first because its restore has a step to undo: the
 * Certificate is deleted only once there is a snapshot worth restoring.
 * Never logs, and throws only when its reader does (readTlsSnapshot never
 * does); the reason is a fixed phrase.
 *
 * @param {{ s3Config: object|null, projectName: string, envName: string,
 *   ca: 'prod'|'staging'|null, issuerName: string, dnsNames: string[],
 *   clientOptions?: object,
 *   deps?: { read?: Function, trustRoots?: readonly string[] } }} args
 * @returns {Promise<{ text: string } | { text: null, reason: string, timedOut?: boolean }>}
 */
export async function readRestorableK8sTlsSnapshot({
  s3Config,
  projectName,
  envName,
  ca,
  issuerName,
  dnsNames,
  clientOptions,
  deps = {},
}) {
  const read = deps.read ?? readTlsSnapshot;
  const trustRoots = deps.trustRoots ?? tls.rootCertificates;
  const none = (reason, extra = {}) => ({ text: null, reason, ...extra });
  const missing = backupPreconditions(s3Config, ca);
  if (missing) return none(missing);
  if (!issuerName) return none('no issuer');
  if (!Array.isArray(dnsNames) || dnsNames.length === 0) return none('no certificate names');
  const key = tlsSnapshotKey({ projectName, envName, ca, format: 'k8s-secret' });
  const { text, reason, timedOut } = clientOptions
    ? await read(s3Config, key, { clientOptions })
    : await read(s3Config, key);
  if (!text) return none(reason ?? 'no snapshot', timedOut ? { timedOut: true } : {});
  const refused = judgeK8sTlsSnapshot(text, { dnsNames, issuerName, ca, trustRoots });
  return refused ? none(refused) : { text };
}

/**
 * Restore the last k8s-secret snapshot into Secret/vibecarbon-tls when the
 * cluster has no valid one (the overwrite rule in the header). Runs before
 * the Certificate is applied, so cert-manager finds a Secret that matches it
 * and does not issue. Never throws, never logs.
 *
 * @param {{ s3Config: object|null, projectName: string, envName: string,
 *   ca: 'prod'|'staging'|null, issuerName: string, dnsNames: string[],
 *   runKubectl: (argv: string[], opts?: object) => Promise<string>,
 *   deps?: { read?: Function, trustRoots?: readonly string[] } }} args
 * @returns {Promise<{ restored: boolean, reason: string }>}
 */
export async function restoreK8sTlsSecret({
  s3Config,
  projectName,
  envName,
  ca,
  issuerName,
  dnsNames,
  runKubectl,
  deps = {},
}) {
  const read = deps.read ?? readTlsSnapshot;
  const trustRoots = deps.trustRoots ?? tls.rootCertificates;
  const skip = (reason) => ({ restored: false, reason });
  const missing = backupPreconditions(s3Config, ca);
  if (missing) return skip(missing);
  if (!issuerName) return skip('no issuer');
  if (!Array.isArray(dnsNames) || dnsNames.length === 0) return skip('no certificate names');
  try {
    const live = await readLiveSecret(runKubectl);
    if (live === null) return skip('could not read the live Secret');
    let liveVersion = null;
    if (live) {
      const verdict = inspectK8sTlsSecret(live, { dnsNames });
      if (verdict.ok && verdict.issuerName === issuerName) return skip(LIVE_SECRET_VALID);
      liveVersion = liveResourceVersion(live);
      if (!liveVersion) return skip('could not read the live Secret');
    }

    const key = tlsSnapshotKey({ projectName, envName, ca, format: 'k8s-secret' });
    const { text, reason } = await read(s3Config, key);
    if (!text) return skip(reason ?? 'no snapshot');
    const refused = judgeK8sTlsSnapshot(text, { dnsNames, issuerName, ca, trustRoots });
    if (refused) return skip(refused);
    const manifest = buildRestoredTlsSecret(text, { namespace: NAMESPACE, issuerName });
    if (liveVersion) manifest.metadata.resourceVersion = liveVersion;

    try {
      // Absent: create (never overwrites). Present but invalid: replace at
      // the judged resourceVersion (never overwrites a change made since).
      await runKubectl([liveVersion ? 'replace' : 'create', '-f', '-'], {
        input: JSON.stringify(manifest),
        captureStdout: true,
        description: 'restore Secret/vibecarbon-tls',
      });
    } catch (err) {
      if (err?.reason === 'AlreadyExists') return skip('a Secret was issued meanwhile, kept');
      if (err?.reason === 'Conflict') return skip('the Secret changed meanwhile, kept');
      return skip('could not write the Secret');
    }
    return { restored: true, reason: 'restored from the last snapshot' };
  } catch {
    return skip('restore errored');
  }
}

/** The live Secret's resourceVersion, or null when it has none readable. */
function liveResourceVersion(liveText) {
  try {
    const v = JSON.parse(liveText)?.metadata?.resourceVersion;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/**
 * Save the live Secret/vibecarbon-tls as this env's k8s-secret snapshot, once
 * the domain serves it trusted. Refuses a Secret that would not be restored:
 * standby self-signed, not covering `dnsNames`, under 7 days left, or issued
 * by another CA than `ca`. Never throws, never logs.
 *
 * @param {{ s3Config: object|null, projectName: string, envName: string,
 *   ca: 'prod'|'staging'|null, dnsNames: string[],
 *   runKubectl: (argv: string[], opts?: object) => Promise<string>,
 *   deps?: { write?: Function } }} args
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function snapshotK8sTlsSecret({
  s3Config,
  projectName,
  envName,
  ca,
  dnsNames,
  runKubectl,
  deps = {},
}) {
  const write = deps.write ?? writeTlsSnapshot;
  const refuse = (reason) => ({ ok: false, reason });
  const missing = backupPreconditions(s3Config, ca);
  if (missing) return refuse(missing);
  if (!Array.isArray(dnsNames) || dnsNames.length === 0) return refuse('no certificate names');
  try {
    const live = await readLiveSecret(runKubectl);
    if (live === null) return refuse('could not read the live Secret');
    if (!live) return refuse('no live Secret');
    const verdict = inspectK8sTlsSecret(live, { dnsNames });
    if (!verdict.ok) return refuse(`live Secret refused: ${verdict.reason}`);
    if (caSlug(verdict.issuerName) !== ca) return refuse(`live Secret is not from the ${ca} CA`);
    const key = tlsSnapshotKey({ projectName, envName, ca, format: 'k8s-secret' });
    const res = await write(s3Config, key, live);
    return res?.ok ? { ok: true } : refuse(res?.reason ?? 'S3 error');
  } catch {
    return refuse('snapshot errored');
  }
}

/**
 * The one line a caller prints for a restore result. A reason is one of
 * restoreK8sTlsSecret's fixed phrases, never command output.
 *
 * @param {{ restored: boolean, reason: string }} result
 * @returns {string}
 */
export function k8sTlsRestoreLine(result) {
  if (result.restored) return 'TLS certificate restored from its last snapshot.';
  if (result.reason === LIVE_SECRET_VALID) {
    return 'TLS certificate already in the cluster; nothing to restore.';
  }
  return `TLS certificate not restored (${result.reason}). cert-manager requests a new one.`;
}
