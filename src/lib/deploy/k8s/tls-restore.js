/**
 * k8s TLS certificate reuse: the vibecarbon-tls Certificate the deploy
 * renders, the Secret it restores from the last snapshot before cert-manager
 * would issue, and the snapshot it saves once the domain is trusted.
 *
 * The overwrite rule. A restore writes Secret/vibecarbon-tls only when the
 * cluster has none, or has one that does not pass inspectK8sTlsSecret for
 * this deploy's names and issuer: no cert-manager issuer annotation yet (the
 * Secret is not issued), the standby self-signed issuer, another issuer than
 * this Certificate's, unparsable, other names, or under 7 days left. A live
 * Secret that passes is never replaced, not even by a longer-lived snapshot:
 * cert-manager renews it by itself.
 *
 * Key handling. The snapshot is validated in full before anything is written
 * (key matches certificate, exact names, at least 7 days left, not
 * self-signed). The restored Secret goes to `kubectl apply -f -` on stdin,
 * never on argv and never through a temp file. Every kubectl command whose
 * output or input can carry key material runs through quietKubectl, which
 * prints nothing, not even on failure, and a failure is reported by a fixed
 * phrase, never by the command's output. Nothing here logs: callers print
 * the one line (k8sTlsRestoreLine).
 */
import { runCommandAsync } from '../../command.js';
import {
  buildRestoredTlsSecret,
  caSlug,
  inspectK8sTlsSecret,
  readTlsSnapshot,
  tlsSnapshotKey,
  writeTlsSnapshot,
} from '../tls-snapshot.js';
import { PROMOTE_ISSUER_ANNOTATION } from './acme-issuer-policy.js';

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

/**
 * The vibecarbon-tls Certificate for this deploy, as YAML. `effectiveIssuer`
 * is what cert-manager issues from (a pilot standby's local self-signed
 * issuer); the real ACME issuer rides the promote annotation on every role.
 * Flux never prunes it: it is deploy-owned (k8s/flux/clusters/*).
 *
 * @param {{ dnsNames: string[], issuerName: string, effectiveIssuer: string }} args
 * @returns {string}
 */
export function renderTlsCertificateManifest({ dnsNames, issuerName, effectiveIssuer }) {
  if (!Array.isArray(dnsNames) || dnsNames.length === 0 || dnsNames.some((n) => !n)) {
    throw new Error('renderTlsCertificateManifest: dnsNames is empty');
  }
  if (!issuerName || !effectiveIssuer) {
    throw new Error('renderTlsCertificateManifest: no issuer');
  }
  // Every scalar is a JSON string, which YAML reads verbatim (no YAML
  // library ships with the CLI).
  const q = (v) => JSON.stringify(String(v));
  return [
    '# Rendered by the vibecarbon deploy (renderTlsCertificateManifest); Flux does not own it.',
    'apiVersion: cert-manager.io/v1',
    'kind: Certificate',
    'metadata:',
    `  name: ${NAME}`,
    `  namespace: ${NAMESPACE}`,
    '  annotations:',
    `    ${q(PROMOTE_ISSUER_ANNOTATION)}: ${q(issuerName)}`,
    `    ${q('kustomize.toolkit.fluxcd.io/prune')}: ${q('disabled')}`,
    'spec:',
    `  secretName: ${NAME}`,
    '  issuerRef:',
    `    name: ${q(effectiveIssuer)}`,
    '    kind: ClusterIssuer',
    '  dnsNames:',
    ...dnsNames.map((n) => `    - ${q(n)}`),
    '',
  ].join('\n');
}

/**
 * A kubectl runner that prints nothing: output is piped and returned, and a
 * failure throws a fixed message (runCommandAsync's ignoreError path skips
 * its CI/DEBUG dump of a failed command's stdout and stderr). For commands
 * whose stdin or stdout can carry key material. No retry: a restore or
 * snapshot that fails is skipped, and cert-manager issues as it would anyway.
 *
 * @param {NodeJS.ProcessEnv} env - carries KUBECONFIG
 * @returns {(argv: string[], opts?: { input?: string }) => Promise<string>}
 */
export function quietKubectl(env, { timeoutMs = QUIET_TIMEOUT_MS } = {}) {
  return async (argv, { input } = {}) => {
    const out = await runCommandAsync(['kubectl', ...argv], {
      env,
      input,
      silent: true,
      ignoreError: true,
      timeout: timeoutMs,
    });
    if (typeof out !== 'string') throw new Error('kubectl failed');
    return out;
  };
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
 * Restore the last k8s-secret snapshot into Secret/vibecarbon-tls when the
 * cluster has no valid one (the overwrite rule in the header). Runs before
 * the Certificate is applied, so cert-manager finds a Secret that matches it
 * and does not issue. Never throws, never logs.
 *
 * @param {{ s3Config: object|null, projectName: string, envName: string,
 *   ca: 'prod'|'staging'|null, issuerName: string, dnsNames: string[],
 *   runKubectl: (argv: string[], opts?: object) => Promise<string>,
 *   deps?: { read?: Function } }} args
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
  const skip = (reason) => ({ restored: false, reason });
  const missing = backupPreconditions(s3Config, ca);
  if (missing) return skip(missing);
  if (!issuerName) return skip('no issuer');
  if (!Array.isArray(dnsNames) || dnsNames.length === 0) return skip('no certificate names');
  try {
    const live = await readLiveSecret(runKubectl);
    if (live === null) return skip('could not read the live Secret');
    if (live) {
      const verdict = inspectK8sTlsSecret(live, { dnsNames });
      if (verdict.ok && verdict.issuerName === issuerName) return skip(LIVE_SECRET_VALID);
    }

    const key = tlsSnapshotKey({ projectName, envName, ca, format: 'k8s-secret' });
    const { text, reason } = await read(s3Config, key);
    if (!text) return skip(reason ?? 'no snapshot');
    const verdict = inspectK8sTlsSecret(text, { dnsNames });
    if (!verdict.ok) return skip(`snapshot refused: ${verdict.reason}`);
    const manifest = buildRestoredTlsSecret(text, { namespace: NAMESPACE, issuerName });

    try {
      await runKubectl(['apply', '-f', '-'], {
        input: JSON.stringify(manifest),
        captureStdout: true,
        description: 'restore Secret/vibecarbon-tls',
      });
    } catch {
      return skip('could not apply the Secret');
    }
    return { restored: true, reason: 'restored from the last snapshot' };
  } catch {
    return skip('restore errored');
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
