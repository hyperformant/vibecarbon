/**
 * Observability for a re-issue of a restored k8s TLS certificate
 * (src/lib/deploy/k8s/tls-reissue-watch.js).
 *
 * On DO k8s-ha runs the deploy restored Secret/vibecarbon-tls before
 * `apply -k` created the Certificate, the restored serial was served trusted,
 * and cert-manager still issued a new certificate (CertificateRequest
 * vibecarbon-tls-1, created with the Certificate). These tests pin the
 * read-only kubectl argv, the parsers, the one-line timing records and the
 * one-shot warning: a request created after the restore warns with
 * cert-manager's reason, no such request stays silent, and anything
 * unreadable stays silent.
 */
import { describe, expect, it, vi } from 'vitest';

const W = await import('../../../src/lib/deploy/k8s/tls-reissue-watch.js');

const RESTORED_AT = '2026-11-01T10:00:05.400Z';

const certificateJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    metadata: { name: 'vibecarbon-tls', creationTimestamp: '2026-11-01T10:00:07Z' },
    status: {
      revision: 1,
      conditions: [
        { type: 'Ready', status: 'True', reason: 'Ready', message: 'Certificate is up to date' },
      ],
    },
    ...over,
  });

const requestItem = (name: string, created: string, revision = '1') => ({
  metadata: {
    name,
    creationTimestamp: created,
    annotations: {
      'cert-manager.io/certificate-name': 'vibecarbon-tls',
      'cert-manager.io/certificate-revision': revision,
    },
  },
  spec: { request: 'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURSBSRVFVRVNULS0tLS0K' },
});

const requestsJson = (items: unknown[]) => JSON.stringify({ items });

const eventsJson = (items: unknown[]) => JSON.stringify({ items });

const ev = (reason: string, message: string, at: string) => ({
  reason,
  message,
  lastTimestamp: at,
  involvedObject: { kind: 'Certificate', name: 'vibecarbon-tls' },
});

/** A fake quiet runner answering by the argv it is given. */
function runner(answers: { [key: string]: string | Error }) {
  return vi.fn(async (argv: string[]) => {
    const key = Object.keys(answers).find((k) => argv.join(' ').includes(k));
    if (key === undefined) throw Object.assign(new Error('kubectl failed'), { reason: 'failed' });
    const a = answers[key];
    if (a instanceof Error) throw a;
    return a;
  });
}

describe('argv builders (read-only)', () => {
  const all = [
    W.certManagerControllerPodsArgv(),
    W.certManagerLeaseArgv(),
    W.tlsCertificateArgv(),
    W.tlsCertificateRequestsArgv(),
    W.tlsCertificateEventsArgv(),
    W.tlsSecretMetaArgv(),
  ];

  it('only ever reads', () => {
    for (const argv of all) {
      const verb = argv.find((a: string) => ['get', 'describe', 'logs'].includes(a));
      expect(verb).toBe('get');
      for (const w of ['apply', 'create', 'replace', 'patch', 'delete', 'edit']) {
        expect(argv).not.toContain(w);
      }
    }
  });

  it('reads the controller pods by their upstream labels', () => {
    expect(W.certManagerControllerPodsArgv()).toEqual([
      '-n',
      'cert-manager',
      'get',
      'pods',
      '-l',
      'app.kubernetes.io/name=cert-manager,app.kubernetes.io/component=controller',
      '-o',
      'json',
    ]);
  });

  it('reads the controller leader lease, kube-system/cert-manager-controller', () => {
    expect(W.CERT_MANAGER_LEASE).toEqual({
      namespace: 'kube-system',
      name: 'cert-manager-controller',
    });
    expect(W.certManagerLeaseArgv()).toEqual([
      '-n',
      'kube-system',
      'get',
      'lease',
      'cert-manager-controller',
      '-o',
      'json',
      '--ignore-not-found',
    ]);
  });

  it('selects the Certificate events by kind and name, so no window can drop them', () => {
    expect(W.tlsCertificateEventsArgv()).toEqual([
      '-n',
      'vibecarbon',
      'get',
      'events',
      '--field-selector',
      'involvedObject.kind=Certificate,involvedObject.name=vibecarbon-tls',
      '-o',
      'json',
    ]);
  });

  it('reads the Secret through a jsonpath of metadata only, never its data', () => {
    const argv = W.tlsSecretMetaArgv();
    expect(argv.slice(0, 5)).toEqual(['-n', 'vibecarbon', 'get', 'secret', 'vibecarbon-tls']);
    const out = argv.join(' ');
    expect(out).toContain('jsonpath=');
    expect(out).toContain('.metadata.creationTimestamp');
    expect(out).toContain('.metadata.resourceVersion');
    expect(out).not.toContain('.data');
    expect(out).not.toMatch(/-o json\b|-o yaml/);
  });
});

describe('parsers', () => {
  it('parseControllerPods: name, start time and deletion, oldest first', () => {
    const text = JSON.stringify({
      items: [
        {
          metadata: { name: 'cert-manager-b', creationTimestamp: '2026-11-01T09:58:00Z' },
          status: { startTime: '2026-11-01T09:58:01Z' },
        },
        {
          metadata: {
            name: 'cert-manager-a',
            creationTimestamp: '2026-11-01T09:50:00Z',
            deletionTimestamp: '2026-11-01T09:58:30Z',
          },
          status: { startTime: '2026-11-01T09:50:02Z' },
        },
      ],
    });
    expect(W.parseControllerPods(text)).toEqual([
      { name: 'cert-manager-a', startTime: '2026-11-01T09:50:02Z', deleting: true },
      { name: 'cert-manager-b', startTime: '2026-11-01T09:58:01Z', deleting: false },
    ]);
    expect(W.parseControllerPods('not json')).toBeNull();
    expect(W.parseControllerPods(JSON.stringify({}))).toBeNull();
  });

  it('parseLease: holder and renew time; absent is null', () => {
    const text = JSON.stringify({
      spec: {
        holderIdentity: 'cert-manager-b_1234',
        renewTime: '2026-11-01T10:00:10.123456Z',
        acquireTime: '2026-11-01T09:58:20.000000Z',
        leaseTransitions: 3,
      },
    });
    expect(W.parseLease(text)).toEqual({
      holder: 'cert-manager-b_1234',
      renewTime: '2026-11-01T10:00:10.123456Z',
      acquireTime: '2026-11-01T09:58:20.000000Z',
      transitions: 3,
    });
    expect(W.parseLease('')).toBeNull();
    expect(W.parseLease('{')).toBeNull();
  });

  it('parseCertificate: created, revision, and the Issuing condition message when present', () => {
    expect(W.parseCertificate(certificateJson())).toEqual({
      createdAt: '2026-11-01T10:00:07Z',
      revision: 1,
      issuingMessage: null,
    });
    const issuing = certificateJson({
      status: {
        conditions: [
          {
            type: 'Issuing',
            status: 'True',
            reason: 'DoesNotExist',
            message: 'Issuing certificate as Secret does not exist',
          },
        ],
      },
    });
    expect(W.parseCertificate(issuing)).toMatchObject({
      revision: null,
      issuingMessage: 'Issuing certificate as Secret does not exist',
    });
    expect(W.parseCertificate('')).toBeNull();
    expect(W.parseCertificate('nope')).toBeNull();
  });

  it("parseCertificateRequests: only vibecarbon-tls's requests, oldest first, no request body", () => {
    const text = requestsJson([
      requestItem('vibecarbon-tls-2', '2026-11-01T10:04:00Z', '2'),
      requestItem('vibecarbon-tls-1', '2026-11-01T10:00:07Z', '1'),
      {
        metadata: {
          name: 'other-1',
          creationTimestamp: '2026-11-01T10:00:00Z',
          annotations: { 'cert-manager.io/certificate-name': 'other' },
        },
      },
    ]);
    const parsed = W.parseCertificateRequests(text);
    expect(parsed).toEqual([
      { name: 'vibecarbon-tls-1', createdAt: '2026-11-01T10:00:07Z', revision: '1' },
      { name: 'vibecarbon-tls-2', createdAt: '2026-11-01T10:04:00Z', revision: '2' },
    ]);
    expect(W.parseCertificateRequests('x')).toBeNull();
    expect(W.parseCertificateRequests(requestsJson([]))).toEqual([]);
  });

  it('issuingEventMessage: the latest "Issuing certificate as ..." reason, never the success line', () => {
    const text = eventsJson([
      ev('Issuing', 'Issuing certificate as Secret does not exist', '2026-11-01T10:00:07Z'),
      ev('Issuing', 'The certificate has been successfully issued', '2026-11-01T10:04:30Z'),
      ev(
        'Requested',
        'Created new CertificateRequest resource "vibecarbon-tls-1"',
        '2026-11-01T10:00:08Z',
      ),
    ]);
    expect(W.issuingEventMessage(text)).toBe('Issuing certificate as Secret does not exist');
    expect(W.issuingEventMessage(eventsJson([]))).toBeNull();
    expect(W.issuingEventMessage('{')).toBeNull();
  });

  it('parseSecretMeta: created and resourceVersion from the jsonpath line', () => {
    expect(W.parseSecretMeta('2026-11-01T10:00:05Z 4321')).toEqual({
      createdAt: '2026-11-01T10:00:05Z',
      resourceVersion: '4321',
    });
    expect(W.parseSecretMeta('')).toBeNull();
  });
});

describe('timing records (one line each)', () => {
  it('the restore line names when it wrote the Secret and the Secret it wrote', async () => {
    const run = runner({ 'secret vibecarbon-tls': '2026-11-01T10:00:05Z 4321' });
    const line = await W.tlsRestoreTimingLine(run, RESTORED_AT);
    expect(line).toBe(
      `tls-timing: restore wrote Secret/vibecarbon-tls at ${RESTORED_AT} (created 2026-11-01T10:00:05Z, resourceVersion 4321).`,
    );
  });

  it('after the apply: when the Certificate was created, and the controller and its lease', async () => {
    const run = runner({
      'certificate vibecarbon-tls': certificateJson(),
      'get pods': JSON.stringify({
        items: [
          {
            metadata: { name: 'cert-manager-b', creationTimestamp: '2026-11-01T09:58:00Z' },
            status: { startTime: '2026-11-01T09:58:01Z' },
          },
        ],
      }),
      'lease cert-manager-controller': JSON.stringify({
        spec: { holderIdentity: 'cert-manager-b_1', renewTime: '2026-11-01T10:00:09Z' },
      }),
    });
    const lines = await W.tlsApplyTimingLines(run);
    expect(lines).toEqual([
      'tls-timing: Certificate/vibecarbon-tls created 2026-11-01T10:00:07Z.',
      'tls-timing: cert-manager controller pod cert-manager-b started 2026-11-01T09:58:01Z; leader lease held by cert-manager-b_1, renewed 2026-11-01T10:00:09Z.',
    ]);
  });

  it('unreadable state reads as unreadable, never throws', async () => {
    const run = runner({});
    expect(await W.tlsRestoreTimingLine(run, RESTORED_AT)).toBe(
      `tls-timing: restore wrote Secret/vibecarbon-tls at ${RESTORED_AT} (metadata unreadable).`,
    );
    expect(await W.tlsApplyTimingLines(run)).toEqual([
      'tls-timing: Certificate/vibecarbon-tls creation time unreadable.',
      'tls-timing: cert-manager controller pods unreadable; leader lease unreadable.',
    ]);
  });

  it('a rollout in flight lists every controller pod', () => {
    expect(
      W.certManagerStateLine({
        pods: [
          { name: 'a', startTime: 't1', deleting: true },
          { name: 'b', startTime: null, deleting: false },
        ],
        lease: null,
      }),
    ).toBe(
      'tls-timing: cert-manager controller pods a started t1 (terminating), b started (not started); leader lease unreadable.',
    );
  });
});

describe('reissueAfterRestore (pure)', () => {
  const cert = { createdAt: '2026-11-01T10:00:07Z', revision: 1, issuingMessage: null };

  it('a request created after the restore is a re-issue, with the event reason', () => {
    const finding = W.reissueAfterRestore({
      restoredAt: RESTORED_AT,
      certificate: cert,
      requests: [{ name: 'vibecarbon-tls-1', createdAt: '2026-11-01T10:00:07Z', revision: '1' }],
      eventMessage: 'Issuing certificate as Secret does not exist',
    });
    expect(finding).toEqual({
      request: 'vibecarbon-tls-1',
      createdAt: '2026-11-01T10:00:07Z',
      revision: 1,
      reason: 'Issuing certificate as Secret does not exist',
    });
  });

  it('a request in the same second as the restore counts (timestamps are whole seconds)', () => {
    const finding = W.reissueAfterRestore({
      restoredAt: RESTORED_AT,
      certificate: cert,
      requests: [{ name: 'vibecarbon-tls-1', createdAt: '2026-11-01T10:00:05Z', revision: '1' }],
      eventMessage: null,
    });
    expect(finding?.request).toBe('vibecarbon-tls-1');
  });

  it("the Issuing condition's message wins over the event", () => {
    const finding = W.reissueAfterRestore({
      restoredAt: RESTORED_AT,
      certificate: { ...cert, issuingMessage: 'Renewing certificate as renewal was scheduled' },
      requests: [{ name: 'vibecarbon-tls-1', createdAt: '2026-11-01T10:00:07Z', revision: '1' }],
      eventMessage: 'Issuing certificate as Secret does not exist',
    });
    expect(finding?.reason).toBe('Renewing certificate as renewal was scheduled');
  });

  it('no reason recorded is said plainly', () => {
    const finding = W.reissueAfterRestore({
      restoredAt: RESTORED_AT,
      certificate: cert,
      requests: [{ name: 'vibecarbon-tls-1', createdAt: '2026-11-01T10:00:07Z', revision: '1' }],
      eventMessage: null,
    });
    expect(finding?.reason).toBe('cert-manager recorded no reason');
  });

  it('the latest request after the restore is the one named', () => {
    const finding = W.reissueAfterRestore({
      restoredAt: RESTORED_AT,
      certificate: cert,
      requests: [
        { name: 'vibecarbon-tls-1', createdAt: '2026-11-01T10:00:07Z', revision: '1' },
        { name: 'vibecarbon-tls-2', createdAt: '2026-11-01T10:03:00Z', revision: '2' },
      ],
      eventMessage: null,
    });
    expect(finding?.request).toBe('vibecarbon-tls-2');
  });

  it('no request after the restore is no finding', () => {
    expect(
      W.reissueAfterRestore({
        restoredAt: RESTORED_AT,
        certificate: cert,
        requests: [{ name: 'vibecarbon-tls-1', createdAt: '2026-10-01T10:00:00Z', revision: '1' }],
        eventMessage: 'Issuing certificate as Secret does not exist',
      }),
    ).toBeNull();
    expect(
      W.reissueAfterRestore({
        restoredAt: RESTORED_AT,
        certificate: cert,
        requests: [],
        eventMessage: null,
      }),
    ).toBeNull();
  });

  it('unreadable state, or no restore, is no finding', () => {
    const requests = [
      { name: 'vibecarbon-tls-1', createdAt: '2026-11-01T10:00:07Z', revision: '1' },
    ];
    expect(
      W.reissueAfterRestore({
        restoredAt: RESTORED_AT,
        certificate: null,
        requests,
        eventMessage: null,
      }),
    ).toBeNull();
    expect(
      W.reissueAfterRestore({
        restoredAt: RESTORED_AT,
        certificate: cert,
        requests: null,
        eventMessage: null,
      }),
    ).toBeNull();
    expect(
      W.reissueAfterRestore({ restoredAt: null, certificate: cert, requests, eventMessage: null }),
    ).toBeNull();
    expect(
      W.reissueAfterRestore({
        restoredAt: 'garbage',
        certificate: cert,
        requests,
        eventMessage: null,
      }),
    ).toBeNull();
  });
});

describe('checkReissueAfterRestore (the one-shot watch)', () => {
  const answers = (over: { [key: string]: string | Error } = {}) => ({
    'certificate vibecarbon-tls': certificateJson(),
    certificaterequests: requestsJson([requestItem('vibecarbon-tls-1', '2026-11-01T10:00:07Z')]),
    'get events': eventsJson([
      ev('Issuing', 'Issuing certificate as Secret does not exist', '2026-11-01T10:00:07Z'),
    ]),
    ...over,
  });

  it('a request after the restore warns once, naming the reason and vibecarbon diagnose', async () => {
    const warn = vi.fn();
    await W.checkReissueAfterRestore({
      restoredAt: RESTORED_AT,
      domain: 'app.example.com',
      environment: 'prod',
      runKubectl: runner(answers()),
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain(`restored at ${RESTORED_AT}`);
    expect(line).toContain('CertificateRequest vibecarbon-tls-1');
    expect(line).toContain('created 2026-11-01T10:00:07Z');
    expect(line).toContain('revision 1');
    expect(line).toContain('Issuing certificate as Secret does not exist');
    expect(line).toContain('`vibecarbon diagnose prod`');
    expect(line).not.toContain('\u2014');
  });

  it('no request after the restore stays silent', async () => {
    const warn = vi.fn();
    await W.checkReissueAfterRestore({
      restoredAt: RESTORED_AT,
      domain: 'app.example.com',
      environment: 'prod',
      runKubectl: runner(answers({ certificaterequests: requestsJson([]) })),
      warn,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('unreadable Certificate or requests stays silent', async () => {
    for (const broken of ['certificate vibecarbon-tls', 'certificaterequests']) {
      const warn = vi.fn();
      await W.checkReissueAfterRestore({
        restoredAt: RESTORED_AT,
        domain: 'app.example.com',
        environment: 'prod',
        runKubectl: runner(answers({ [broken]: new Error('kubectl failed') })),
        warn,
      });
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it('unreadable events still warn, with no reason recorded', async () => {
    const warn = vi.fn();
    await W.checkReissueAfterRestore({
      restoredAt: RESTORED_AT,
      domain: 'app.example.com',
      environment: 'prod',
      runKubectl: runner(answers({ 'get events': new Error('kubectl failed') })),
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('cert-manager recorded no reason');
  });

  it('a deploy that restored nothing reads nothing', async () => {
    const warn = vi.fn();
    const run = runner(answers());
    await W.checkReissueAfterRestore({
      restoredAt: null,
      domain: 'app.example.com',
      environment: 'prod',
      runKubectl: run,
      warn,
    });
    expect(run).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a reason is held to one bounded line', async () => {
    const warn = vi.fn();
    const long = `Issuing certificate as\nSecret ${'x'.repeat(1000)}`;
    await W.checkReissueAfterRestore({
      restoredAt: RESTORED_AT,
      domain: 'app.example.com',
      environment: 'prod',
      runKubectl: runner(
        answers({ 'get events': eventsJson([ev('Issuing', long, '2026-11-01T10:00:07Z')]) }),
      ),
      warn,
    });
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(800);
  });
});
