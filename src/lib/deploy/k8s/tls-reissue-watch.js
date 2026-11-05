/**
 * Observability for a re-issue of a restored k8s TLS certificate. A
 * diagnosis aid, not a fix.
 *
 * On DigitalOcean k8s-ha e2e runs (Let's Encrypt staging,
 * cert-manager v1.20.2) the deploy restored Secret/vibecarbon-tls from its
 * snapshot before the base apply created the Certificate (tls-restore.js), the
 * restored serial was served trusted, and cert-manager still issued a new
 * certificate: CertificateRequest vibecarbon-tls-1, created with the
 * Certificate, in 2 of 2 runs. A local k3d replay reissued only through a
 * cache race ("Issuing certificate as Secret does not exist"), and the
 * leading suspect is the controller restart the controller-flags patch
 * causes (CERT_MANAGER_CONTROLLER_FLAGS) landing the restore and the
 * Certificate in the middle of a leader handoff.
 *
 * Two things here, both read-only and quiet:
 *
 *  - Timing records the deploy prints, one line each: when the restore wrote
 *    the Secret, when the Certificate was created, and which controller pod
 *    was running and holding the leader lease at that moment.
 *  - A one-shot check once the domain is trusted on a deploy that restored a
 *    snapshot: a CertificateRequest created after the restore is one warning
 *    with cert-manager's own reason (the Certificate's Issuing condition, or
 *    its latest "Issuing certificate as ..." event).
 *
 * Every read goes through the caller's quiet runner (quietKubectl). Nothing
 * here reads a Secret's data: the Secret is read through a jsonpath of two
 * metadata fields. CertificateRequests carry only public material (a CSR and
 * a certificate) and are parsed, never printed. Nothing throws.
 */

const NAMESPACE = 'vibecarbon';
const NAME = 'vibecarbon-tls';

/**
 * cert-manager's controller leader-election lease. `kube-system` is the
 * default `--leader-election-namespace` (the upstream manifest keeps it) and
 * `cert-manager-controller` the controller's lock name.
 */
export const CERT_MANAGER_LEASE = Object.freeze({
  namespace: 'kube-system',
  name: 'cert-manager-controller',
});

/** The upstream manifest's labels on the controller pods. */
const CONTROLLER_SELECTOR =
  'app.kubernetes.io/name=cert-manager,app.kubernetes.io/component=controller';

/** Longest cert-manager reason a warning carries. */
const MAX_REASON_CHARS = 300;

export function certManagerControllerPodsArgv() {
  return ['-n', 'cert-manager', 'get', 'pods', '-l', CONTROLLER_SELECTOR, '-o', 'json'];
}

export function certManagerLeaseArgv() {
  return [
    '-n',
    CERT_MANAGER_LEASE.namespace,
    'get',
    'lease',
    CERT_MANAGER_LEASE.name,
    '-o',
    'json',
    '--ignore-not-found',
  ];
}

export function tlsCertificateArgv() {
  return ['-n', NAMESPACE, 'get', 'certificate', NAME, '-o', 'json', '--ignore-not-found'];
}

export function tlsCertificateRequestsArgv() {
  return ['-n', NAMESPACE, 'get', 'certificaterequests', '-o', 'json'];
}

export function tlsCertificateEventsArgv() {
  return [
    '-n',
    NAMESPACE,
    'get',
    'events',
    '--field-selector',
    `involvedObject.kind=Certificate,involvedObject.name=${NAME}`,
    '-o',
    'json',
  ];
}

/** Two metadata fields of the Secret, never its data. */
export function tlsSecretMetaArgv() {
  return [
    '-n',
    NAMESPACE,
    'get',
    'secret',
    NAME,
    '-o',
    'jsonpath={.metadata.creationTimestamp} {.metadata.resourceVersion}',
    '--ignore-not-found',
  ];
}

function parseJson(text) {
  try {
    const v = JSON.parse(String(text ?? ''));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const str = (v) => (typeof v === 'string' && v ? v : null);

/** Milliseconds since the epoch, or NaN. */
const ms = (iso) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);

/**
 * The controller pods, oldest first: name, container start time, and
 * whether it is terminating. Null when unreadable.
 *
 * @param {string} text - `get pods -o json`
 * @returns {{ name: string, startTime: string|null, deleting: boolean }[] | null}
 */
export function parseControllerPods(text) {
  const items = parseJson(text)?.items;
  if (!Array.isArray(items)) return null;
  return items
    .map((pod) => ({
      name: String(pod?.metadata?.name ?? '?'),
      startTime: str(pod?.status?.startTime),
      deleting: !!pod?.metadata?.deletionTimestamp,
      created: ms(pod?.metadata?.creationTimestamp),
    }))
    .sort((a, b) => (a.created || 0) - (b.created || 0))
    .map(({ created: _created, ...pod }) => pod);
}

/**
 * The leader lease: holder, renew and acquire times, transitions. Null when
 * absent or unreadable.
 *
 * @param {string} text - `get lease -o json --ignore-not-found`
 */
export function parseLease(text) {
  const spec = parseJson(text)?.spec;
  if (!spec) return null;
  return {
    holder: str(spec.holderIdentity),
    renewTime: str(spec.renewTime),
    acquireTime: str(spec.acquireTime),
    transitions: Number.isFinite(spec.leaseTransitions) ? spec.leaseTransitions : null,
  };
}

/**
 * The Certificate's creation time, its status.revision, and the message of
 * its Issuing condition while one stands. Null when absent or unreadable.
 *
 * @param {string} text - `get certificate -o json --ignore-not-found`
 * @returns {{ createdAt: string|null, revision: number|null, issuingMessage: string|null } | null}
 */
export function parseCertificate(text) {
  const cert = parseJson(text);
  if (!cert?.metadata) return null;
  const conditions = Array.isArray(cert.status?.conditions) ? cert.status.conditions : [];
  const issuing = conditions.find((c) => c?.type === 'Issuing');
  return {
    createdAt: str(cert.metadata.creationTimestamp),
    revision: Number.isFinite(cert.status?.revision) ? cert.status.revision : null,
    issuingMessage: str(issuing?.message),
  };
}

/** Whether a CertificateRequest belongs to Certificate/vibecarbon-tls. */
function isOurRequest(cr) {
  const owner = cr?.metadata?.annotations?.['cert-manager.io/certificate-name'];
  if (owner !== undefined) return owner === NAME;
  const refs = Array.isArray(cr?.metadata?.ownerReferences) ? cr.metadata.ownerReferences : [];
  if (refs.length > 0) return refs.some((r) => r?.kind === 'Certificate' && r?.name === NAME);
  return /^vibecarbon-tls-\d+$/.test(String(cr?.metadata?.name ?? ''));
}

/**
 * The CertificateRequests of Certificate/vibecarbon-tls, oldest first: name,
 * creation time, revision. Null when unreadable.
 *
 * @param {string} text - `get certificaterequests -o json`
 * @returns {{ name: string, createdAt: string|null, revision: string|null }[] | null}
 */
export function parseCertificateRequests(text) {
  const items = parseJson(text)?.items;
  if (!Array.isArray(items)) return null;
  return items
    .filter(isOurRequest)
    .map((cr) => ({
      name: String(cr.metadata.name),
      createdAt: str(cr.metadata.creationTimestamp),
      revision: str(cr.metadata.annotations?.['cert-manager.io/certificate-revision']),
    }))
    .sort((a, b) => (ms(a.createdAt) || 0) - (ms(b.createdAt) || 0));
}

const eventTime = (e) => ms(e?.lastTimestamp ?? e?.eventTime ?? e?.metadata?.creationTimestamp);

/**
 * cert-manager's latest reason for issuing, from the Certificate's events:
 * an "Issuing certificate as ..." (or a re-issue) message, never the
 * "successfully issued" one that shares its event reason. Null when there is
 * none or the events are unreadable.
 *
 * @param {string} text - `get events --field-selector ... -o json`
 * @returns {string|null}
 */
export function issuingEventMessage(text) {
  const items = parseJson(text)?.items;
  if (!Array.isArray(items)) return null;
  const reasons = items
    .filter((e) => {
      const m = String(e?.message ?? '');
      return /^(Issuing|Renewing) certificate as\b/.test(m) || /re-issu/i.test(m);
    })
    .sort((a, b) => (eventTime(a) || 0) - (eventTime(b) || 0));
  return str(reasons.at(-1)?.message);
}

/**
 * The Secret's creation time and resourceVersion from tlsSecretMetaArgv's
 * output. Null when absent or unreadable.
 */
export function parseSecretMeta(text) {
  const [createdAt, resourceVersion] = String(text ?? '')
    .trim()
    .split(/\s+/);
  if (!createdAt || !resourceVersion) return null;
  return { createdAt, resourceVersion };
}

/** Run one quiet read; null on any failure. */
async function read(runKubectl, argv) {
  try {
    return String(
      (await runKubectl(argv, { captureStdout: true, description: 'tls re-issue watch' })) ?? '',
    );
  } catch {
    return null;
  }
}

/**
 * The timing record for the moment the restore wrote the Secret.
 *
 * @param {(argv: string[], opts?: object) => Promise<string>} runKubectl - quiet
 * @param {string} restoredAt - ISO time the write returned, operator clock
 * @returns {Promise<string>}
 */
export async function tlsRestoreTimingLine(runKubectl, restoredAt) {
  const meta = parseSecretMeta(await read(runKubectl, tlsSecretMetaArgv()));
  const detail = meta
    ? `created ${meta.createdAt}, resourceVersion ${meta.resourceVersion}`
    : 'metadata unreadable';
  return `tls-timing: restore wrote Secret/${NAME} at ${restoredAt} (${detail}).`;
}

/**
 * One line naming the controller pods (start times; terminating ones marked)
 * and the leader lease's holder and renew time.
 *
 * @param {{ pods: ReturnType<typeof parseControllerPods>, lease: ReturnType<typeof parseLease> }} state
 * @returns {string}
 */
export function certManagerStateLine({ pods, lease }) {
  let podPart;
  if (!pods) podPart = 'cert-manager controller pods unreadable';
  else if (pods.length === 0) podPart = 'cert-manager controller pods: none';
  else {
    const each = pods.map(
      (pod) =>
        `${pod.name} started ${pod.startTime ?? '(not started)'}${pod.deleting ? ' (terminating)' : ''}`,
    );
    podPart = `cert-manager controller pod${pods.length > 1 ? 's' : ''} ${each.join(', ')}`;
  }
  const leasePart = lease
    ? `leader lease held by ${lease.holder ?? '(nobody)'}, renewed ${lease.renewTime ?? '(never)'}`
    : 'leader lease unreadable';
  return `tls-timing: ${podPart}; ${leasePart}.`;
}

/**
 * The timing records right after the apply that creates the Certificate:
 * when it was created, and the controller and its lease at that moment.
 *
 * @param {(argv: string[], opts?: object) => Promise<string>} runKubectl - quiet
 * @returns {Promise<string[]>}
 */
export async function tlsApplyTimingLines(runKubectl) {
  const [certText, podsText, leaseText] = await Promise.all([
    read(runKubectl, tlsCertificateArgv()),
    read(runKubectl, certManagerControllerPodsArgv()),
    read(runKubectl, certManagerLeaseArgv()),
  ]);
  const created = parseCertificate(certText)?.createdAt;
  return [
    created
      ? `tls-timing: Certificate/${NAME} created ${created}.`
      : `tls-timing: Certificate/${NAME} creation time unreadable.`,
    certManagerStateLine({ pods: parseControllerPods(podsText), lease: parseLease(leaseText) }),
  ];
}

/**
 * Did cert-manager issue after the restore? The latest CertificateRequest of
 * vibecarbon-tls created at or after the restore (API timestamps are whole
 * seconds, so the restore time is floored to its second), with cert-manager's
 * reason: the Issuing condition's message, else the latest issuing event,
 * else "cert-manager recorded no reason". Null for no restore, no such
 * request, or anything unreadable: an unread state proves nothing.
 *
 * @param {{ restoredAt: string|null, certificate: ReturnType<typeof parseCertificate>,
 *   requests: ReturnType<typeof parseCertificateRequests>, eventMessage: string|null }} args
 * @returns {{ request: string, createdAt: string, revision: number|null, reason: string } | null}
 */
export function reissueAfterRestore({ restoredAt, certificate, requests, eventMessage }) {
  const restoredMs = ms(restoredAt);
  if (!Number.isFinite(restoredMs) || !certificate || !Array.isArray(requests)) return null;
  const floor = Math.floor(restoredMs / 1000) * 1000;
  const after = requests.filter((r) => ms(r.createdAt) >= floor);
  const latest = after.at(-1);
  if (!latest) return null;
  return {
    request: latest.name,
    createdAt: latest.createdAt,
    revision: certificate.revision,
    reason: certificate.issuingMessage ?? eventMessage ?? 'cert-manager recorded no reason',
  };
}

/** A cluster-sourced message as one bounded line. */
function oneLine(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS)}...` : flat;
}

/**
 * The warning for a re-issue after a restore.
 *
 * @param {{ domain: string, environment: string, restoredAt: string,
 *   finding: NonNullable<ReturnType<typeof reissueAfterRestore>> }} args
 * @returns {string}
 */
export function reissueWarning({ domain, environment, restoredAt, finding }) {
  const revision = finding.revision === null ? '' : `, Certificate revision ${finding.revision}`;
  return (
    `TLS certificate for ${domain} was restored at ${restoredAt}, but cert-manager requested a new one after it ` +
    `(CertificateRequest ${finding.request}, created ${finding.createdAt}${revision}). ` +
    `cert-manager's reason: ${oneLine(finding.reason)}. ` +
    'The deploy still succeeded. The restored certificate will be replaced, and each new one counts against the CA rate limit. ' +
    `Run \`vibecarbon diagnose ${environment}\` to see the Certificate's events.`
  );
}

/**
 * The one-shot watch: once the domain is trusted on a deploy that restored
 * a snapshot, read the Certificate, its requests and its events, and warn
 * once when a request was created after the restore. Silent for no restore,
 * no such request, or an unreadable Certificate or request list. Never
 * throws.
 *
 * @param {{ restoredAt: string|null|undefined, domain: string, environment: string,
 *   runKubectl: (argv: string[], opts?: object) => Promise<string>,
 *   warn: (message: string) => void }} args
 * @returns {Promise<void>}
 */
export async function checkReissueAfterRestore({
  restoredAt,
  domain,
  environment,
  runKubectl,
  warn,
}) {
  try {
    if (!restoredAt || !Number.isFinite(ms(restoredAt))) return;
    const [certText, requestsText, eventsText] = await Promise.all([
      read(runKubectl, tlsCertificateArgv()),
      read(runKubectl, tlsCertificateRequestsArgv()),
      read(runKubectl, tlsCertificateEventsArgv()),
    ]);
    const finding = reissueAfterRestore({
      restoredAt,
      certificate: parseCertificate(certText),
      requests: parseCertificateRequests(requestsText),
      eventMessage: issuingEventMessage(eventsText),
    });
    if (finding) warn(reissueWarning({ domain, environment, restoredAt, finding }));
  } catch {
    // Observability only: a failed check proves nothing either way.
  }
}
