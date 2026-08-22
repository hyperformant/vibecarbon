import { describe, expect, it, vi } from 'vitest';
import {
  createAcmeIssuanceWatchdog,
  DEPLOY_OWNED_CERTIFICATES,
  findTerminalAcmeFailures,
  PROBED_APEX_CERTIFICATE,
  recoverTerminalAcmeFailure,
  TERMINAL_ORDER_STATES,
  TERMINAL_REQUEST_REASONS,
} from '../../../src/lib/deploy/k8s/acme-order-recovery.js';

/**
 * Regression cover for the 2026-08-11 e2e hetzner/k8s restore failure: both
 * DNS-01 challenges validated, then the Order errored with
 *   403 orderNotReady: Error finalizing order :: Order was already processing
 * and stayed errored for 28 minutes while the public health probe burned its
 * whole budget against a Traefik default cert.
 *
 * The fixtures below are shaped like the real
 * `kubectl get certificate,certificaterequest,order -A -o json` payload,
 * including the ownership chain the finder walks
 * (Certificate → CertificateRequest → Order).
 */

const FINALIZE_ERROR =
  'Failed to finalize Order: 403 urn:ietf:params:acme:error:orderNotReady: Error finalizing ' +
  'order :: Order was already processing. This may indicate your client finalized the same ' +
  'order multiple times, possibly due to a client bug.';

function certificate(
  name: string,
  { namespace = 'vibecarbon', ready = false }: { namespace?: string; ready?: boolean } = {},
) {
  return {
    kind: 'Certificate',
    metadata: { name, namespace },
    status: {
      conditions: [
        ready
          ? { type: 'Ready', status: 'True', reason: 'Ready' }
          : {
              type: 'Ready',
              status: 'False',
              reason: 'DoesNotExist',
              message: 'Issuing certificate as Secret does not exist',
            },
      ],
    },
  };
}

function certificateRequest(
  name: string,
  owner: string,
  {
    namespace = 'vibecarbon',
    reason = 'Failed',
    status = 'False',
    revision = 1,
  }: { namespace?: string; reason?: string; status?: string; revision?: number } = {},
) {
  return {
    kind: 'CertificateRequest',
    metadata: {
      name,
      namespace,
      annotations: { 'cert-manager.io/certificate-revision': String(revision) },
      ownerReferences: [{ kind: 'Certificate', name: owner }],
    },
    status: {
      conditions: [
        { type: 'Ready', status, reason, message: `Failed to wait for order resource: ${reason}` },
      ],
    },
  };
}

function order(
  name: string,
  owner: string,
  {
    namespace = 'vibecarbon',
    state = 'errored',
    reason = FINALIZE_ERROR,
  }: { namespace?: string; state?: string; reason?: string } = {},
) {
  return {
    kind: 'Order',
    metadata: { name, namespace, ownerReferences: [{ kind: 'CertificateRequest', name: owner }] },
    status: { state, reason },
  };
}

/** The exact resource triple observed on e3 the night this was written. */
function e3Fixture() {
  return [
    certificate('vibecarbon-tls'),
    certificateRequest('vibecarbon-tls-1', 'vibecarbon-tls'),
    order('vibecarbon-tls-1-3540367894', 'vibecarbon-tls-1'),
  ];
}

describe('findTerminalAcmeFailures', () => {
  it('reports the errored-order chain from the e3 restore failure', () => {
    const findings = findTerminalAcmeFailures(e3Fixture());

    expect(findings).toEqual([
      {
        namespace: 'vibecarbon',
        certificate: 'vibecarbon-tls',
        request: 'vibecarbon-tls-1',
        order: 'vibecarbon-tls-1-3540367894',
        state: 'errored',
        reason: FINALIZE_ERROR,
      },
    ]);
  });

  it('prefers the Order reason over the request message so the ACME problem survives', () => {
    const [finding] = findTerminalAcmeFailures(e3Fixture());
    expect(finding.reason).toContain('orderNotReady');
    expect(finding.reason).toContain('already processing');
  });

  it.each(TERMINAL_ORDER_STATES)('treats order state %s as terminal', (state) => {
    const findings = findTerminalAcmeFailures([
      certificate('vibecarbon-tls'),
      certificateRequest('vibecarbon-tls-1', 'vibecarbon-tls', { reason: 'Pending' }),
      order('vibecarbon-tls-1-abc', 'vibecarbon-tls-1', { state }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].state).toBe(state);
  });

  it.each(['pending', 'ready', 'processing', 'valid'])(
    'leaves live order state %s alone',
    (state) => {
      const findings = findTerminalAcmeFailures([
        certificate('vibecarbon-tls'),
        certificateRequest('vibecarbon-tls-1', 'vibecarbon-tls', { reason: 'Pending' }),
        order('vibecarbon-tls-1-abc', 'vibecarbon-tls-1', { state }),
      ]);
      expect(findings).toEqual([]);
    },
  );

  it.each(TERMINAL_REQUEST_REASONS)(
    'reports a %s CertificateRequest even with no Order yet',
    (reason) => {
      const findings = findTerminalAcmeFailures([
        certificate('vibecarbon-tls'),
        certificateRequest('vibecarbon-tls-1', 'vibecarbon-tls', { reason }),
      ]);
      expect(findings).toHaveLength(1);
      expect(findings[0].order).toBeNull();
    },
  );

  it('never reports a Certificate that is already Ready, stale errored order and all', () => {
    const findings = findTerminalAcmeFailures([
      certificate('vibecarbon-tls', { ready: true }),
      certificateRequest('vibecarbon-tls-1', 'vibecarbon-tls'),
      order('vibecarbon-tls-1-3540367894', 'vibecarbon-tls-1'),
    ]);
    expect(findings).toEqual([]);
  });

  it('does not cross namespaces when matching owners', () => {
    // Same resource names in two namespaces — the observability add-on's
    // grafana-tls chain uses the same naming scheme as the app's.
    const findings = findTerminalAcmeFailures([
      certificate('grafana-tls', { namespace: 'vibecarbon-observability' }),
      certificateRequest('grafana-tls-1', 'grafana-tls', { namespace: 'vibecarbon' }),
    ]);
    expect(findings).toEqual([]);
  });

  it('reports both namespaces when the app and the add-on cert both fail', () => {
    const findings = findTerminalAcmeFailures([
      ...e3Fixture(),
      certificate('grafana-tls', { namespace: 'vibecarbon-observability' }),
      certificateRequest('grafana-tls-1', 'grafana-tls', {
        namespace: 'vibecarbon-observability',
      }),
      order('grafana-tls-1-999', 'grafana-tls-1', { namespace: 'vibecarbon-observability' }),
    ]);
    expect(findings.map((f) => `${f.namespace}/${f.certificate}`)).toEqual([
      'vibecarbon/vibecarbon-tls',
      'vibecarbon-observability/grafana-tls',
    ]);
  });

  it('survives empty, missing and malformed input', () => {
    expect(findTerminalAcmeFailures([])).toEqual([]);
    // @ts-expect-error deliberately malformed
    expect(findTerminalAcmeFailures(undefined)).toEqual([]);
    expect(findTerminalAcmeFailures([{ kind: 'Certificate' }, { kind: 'Order' }, {}])).toEqual([]);
  });
});

describe('recoverTerminalAcmeFailure', () => {
  const finding = {
    namespace: 'vibecarbon',
    certificate: 'vibecarbon-tls',
    request: 'vibecarbon-tls-1',
    order: 'vibecarbon-tls-1-3540367894',
    state: 'errored',
    reason: FINALIZE_ERROR,
  };

  it('deletes the failed request, then clears the failure stamp on the Certificate', async () => {
    const runKubectl = vi.fn().mockResolvedValue('');
    const ran = await recoverTerminalAcmeFailure({ finding, runKubectl });

    expect(ran[0]).toEqual([
      '-n',
      'vibecarbon',
      'delete',
      'certificaterequest',
      'vibecarbon-tls-1',
      '--ignore-not-found',
    ]);

    // The status patch is what defeats cert-manager's 1h (then exponential)
    // reissue backoff — deleting the request alone leaves lastFailureTime
    // set and issuance does not retry until the backoff elapses.
    const patch = ran[1];
    expect(patch.slice(0, 7)).toEqual([
      '-n',
      'vibecarbon',
      'patch',
      'certificate',
      'vibecarbon-tls',
      '--type=merge',
      '--subresource=status',
    ]);
    expect(JSON.parse(patch[8])).toEqual({
      status: { lastFailureTime: null, failedIssuanceAttempts: null },
    });
  });

  it('is idempotent — deletion tolerates an already-gone request', async () => {
    const runKubectl = vi.fn().mockResolvedValue('');
    const ran = await recoverTerminalAcmeFailure({ finding, runKubectl });
    expect(ran[0]).toContain('--ignore-not-found');
  });

  it('names the kubectl >= 1.24 requirement when --subresource is unsupported', async () => {
    // kubectl < 1.24 has no `patch --subresource`. The request delete already
    // happened, so issuance retries — but only after cert-manager's ~1h
    // backoff, i.e. not within this deploy. That is a different outcome from
    // a generic patch failure and has to read differently.
    const runKubectl = vi.fn(async (argv: string[]) => {
      if (argv.includes('patch')) throw new Error('Error: unknown flag: --subresource');
      return '';
    });

    await expect(recoverTerminalAcmeFailure({ finding, runKubectl })).rejects.toThrow(
      /kubectl >= 1\.24/,
    );
    await expect(recoverTerminalAcmeFailure({ finding, runKubectl })).rejects.toThrow(
      /~1h backoff/,
    );
  });

  it('reads the flag error out of stderr, not just the wrapper message', async () => {
    // runCommandAsync rejects with a wrapper message and the real kubectl
    // output on `.stderr` — reading only `.message` would miss it.
    const runKubectl = vi.fn(async (argv: string[]) => {
      if (argv.includes('patch')) {
        const err: Error & { stderr?: string } = new Error('Command failed: kubectl patch ...');
        err.stderr = 'unknown flag: --subresource';
        throw err;
      }
      return '';
    });
    await expect(recoverTerminalAcmeFailure({ finding, runKubectl })).rejects.toThrow(
      /kubectl >= 1\.24/,
    );
  });

  it('passes through an unrelated patch failure unchanged', async () => {
    const runKubectl = vi.fn(async (argv: string[]) => {
      if (argv.includes('patch')) throw new Error('certificates.cert-manager.io "x" not found');
      return '';
    });
    await expect(recoverTerminalAcmeFailure({ finding, runKubectl })).rejects.toThrow(
      /"x" not found/,
    );
  });

  it('still clears the Certificate when there is no request to delete', async () => {
    const runKubectl = vi.fn().mockResolvedValue('');
    const ran = await recoverTerminalAcmeFailure({
      finding: { ...finding, request: null },
      runKubectl,
    });
    expect(ran).toHaveLength(1);
    expect(ran[0]).toContain('patch');
  });
});

describe('createAcmeIssuanceWatchdog', () => {
  /** kubectl stub that returns `items` for the state read and '' otherwise. */
  function kubectlReturning(items: unknown[]) {
    return vi.fn(async (argv: string[]) => (argv[0] === 'get' ? JSON.stringify({ items }) : ''));
  }

  it('does nothing while issuance is healthy', async () => {
    const runKubectl = kubectlReturning([certificate('vibecarbon-tls', { ready: true })]);
    const poll = createAcmeIssuanceWatchdog({ runKubectl });
    expect(await poll()).toEqual({ action: 'none' });
    expect(runKubectl).toHaveBeenCalledTimes(1);
  });

  it('recovers on first detection instead of aborting the deploy', async () => {
    const runKubectl = kubectlReturning(e3Fixture());
    const poll = createAcmeIssuanceWatchdog({ runKubectl });

    const verdict = await poll();
    expect(verdict.action).toBe('recovered');
    const verbs = runKubectl.mock.calls.map(([argv]) => argv[0]);
    expect(verbs).toEqual(['get', '-n', '-n']);
  });

  it('aborts with the ACME reason once the recovery budget is spent', async () => {
    // Every poll sees the same terminal state — recovery never takes.
    const runKubectl = kubectlReturning(e3Fixture());
    const poll = createAcmeIssuanceWatchdog({ runKubectl, maxRecoveries: 2 });

    expect((await poll()).action).toBe('recovered');
    expect((await poll()).action).toBe('recovered');

    const verdict = await poll();
    expect(verdict.action).toBe('abort');
    expect(verdict.reason).toContain('vibecarbon/vibecarbon-tls');
    expect(verdict.reason).toContain('after 2 recovery attempts');
    expect(verdict.reason).toContain('vibecarbon-tls-1-3540367894');
    // The operator-actionable part: the ACME problem document, surfaced
    // instead of "fetch failed (118 attempts)".
    expect(verdict.reason).toContain('orderNotReady');
  });

  it('caps repairs per Certificate no matter how often the probe polls', async () => {
    const runKubectl = kubectlReturning(e3Fixture());
    const poll = createAcmeIssuanceWatchdog({ runKubectl, maxRecoveries: 1 });
    for (let i = 0; i < 10; i++) await poll();

    const deletes = runKubectl.mock.calls.filter(([argv]) => argv.includes('delete'));
    expect(deletes).toHaveLength(1);
  });

  it('stops polling-induced repairs once the Certificate goes Ready', async () => {
    let items = e3Fixture();
    const runKubectl = vi.fn(async (argv: string[]) =>
      argv[0] === 'get' ? JSON.stringify({ items }) : '',
    );
    const poll = createAcmeIssuanceWatchdog({ runKubectl });

    expect((await poll()).action).toBe('recovered');
    items = [certificate('vibecarbon-tls', { ready: true })];
    expect(await poll()).toEqual({ action: 'none' });
  });

  it('fails OPEN — a broken kubectl never aborts the deploy', async () => {
    const poll = createAcmeIssuanceWatchdog({
      runKubectl: vi.fn().mockRejectedValue(new Error('kubeconfig not found')),
    });
    expect(await poll()).toEqual({ action: 'none' });
  });

  it('fails OPEN on unparseable kubectl output', async () => {
    const poll = createAcmeIssuanceWatchdog({ runKubectl: vi.fn().mockResolvedValue('<html>') });
    expect(await poll()).toEqual({ action: 'none' });
  });

  /** A terminal chain for a Certificate nobody in this repo created. */
  function foreignFixture() {
    return [
      certificate('wildcard-tls', { namespace: 'ingress-nginx' }),
      certificateRequest('wildcard-tls-1', 'wildcard-tls', { namespace: 'ingress-nginx' }),
      order('wildcard-tls-1-777', 'wildcard-tls-1', { namespace: 'ingress-nginx' }),
    ];
  }

  it('REPAIR SCOPE: reports a foreign Certificate but never writes to it', async () => {
    const runKubectl = kubectlReturning(foreignFixture());
    const logged: string[] = [];
    const poll = createAcmeIssuanceWatchdog({ runKubectl, log: (m) => logged.push(m) });

    expect(await poll()).toEqual({ action: 'none' });

    // Read only. Not one mutating verb reached the foreign namespace.
    const verbs = runKubectl.mock.calls.map(([argv]) => argv[0]);
    expect(verbs).toEqual(['get']);
    expect(logged.join('\n')).toContain('ingress-nginx/wildcard-tls');
    expect(logged.join('\n')).toContain('NOT deploy-owned');
  });

  it('REPAIR SCOPE: repairs ours in the same sweep that ignores a foreign one', async () => {
    const runKubectl = kubectlReturning([...e3Fixture(), ...foreignFixture()]);
    const poll = createAcmeIssuanceWatchdog({ runKubectl });

    expect((await poll()).action).toBe('recovered');

    const mutations = runKubectl.mock.calls
      .map(([argv]) => argv)
      .filter((argv) => argv[0] !== 'get');
    expect(mutations.length).toBeGreaterThan(0);
    for (const argv of mutations) {
      expect(argv[1]).toBe('vibecarbon');
      expect(argv.join(' ')).not.toContain('ingress-nginx');
    }
  });

  it('REPAIR SCOPE: logs a foreign Certificate once, not on every poll', async () => {
    const runKubectl = kubectlReturning(foreignFixture());
    const logged: string[] = [];
    const poll = createAcmeIssuanceWatchdog({ runKubectl, log: (m) => logged.push(m) });

    for (let i = 0; i < 5; i++) await poll();

    expect(logged.filter((m) => m.includes('ingress-nginx/wildcard-tls'))).toHaveLength(1);
  });

  it('ABORT SCOPE: an exhausted grafana-tls never stops the probe', async () => {
    // Only the add-on cert is failing. It gets repaired up to the budget and
    // then left alone — /admin/grafana is not what the probe is asking about,
    // and the apex may still be converging.
    const runKubectl = kubectlReturning([
      certificate('grafana-tls', { namespace: 'vibecarbon-observability' }),
      certificateRequest('grafana-tls-1', 'grafana-tls', {
        namespace: 'vibecarbon-observability',
      }),
      order('grafana-tls-1-999', 'grafana-tls-1', { namespace: 'vibecarbon-observability' }),
    ]);
    const poll = createAcmeIssuanceWatchdog({ runKubectl, maxRecoveries: 2 });

    expect((await poll()).action).toBe('recovered');
    expect((await poll()).action).toBe('recovered');
    // Budget spent. An unscoped watchdog would abort here.
    for (let i = 0; i < 4; i++) expect((await poll()).action).toBe('none');

    const deletes = runKubectl.mock.calls.filter(([argv]) => argv.includes('delete'));
    expect(deletes).toHaveLength(2);
  });

  it('ABORT SCOPE: only the apex Certificate stops the probe', async () => {
    const runKubectl = kubectlReturning(e3Fixture());
    const poll = createAcmeIssuanceWatchdog({ runKubectl, maxRecoveries: 1 });

    expect((await poll()).action).toBe('recovered');
    const verdict = await poll();
    expect(verdict.action).toBe('abort');
    expect(verdict.reason).toContain(PROBED_APEX_CERTIFICATE);
  });

  it('ABORT SCOPE: an exhausted grafana-tls alongside a live apex still just repairs', async () => {
    const runKubectl = kubectlReturning([
      ...e3Fixture(),
      certificate('grafana-tls', { namespace: 'vibecarbon-observability' }),
      certificateRequest('grafana-tls-1', 'grafana-tls', {
        namespace: 'vibecarbon-observability',
      }),
      order('grafana-tls-1-999', 'grafana-tls-1', { namespace: 'vibecarbon-observability' }),
    ]);
    const poll = createAcmeIssuanceWatchdog({ runKubectl, maxRecoveries: 3 });

    // Both get repaired together; neither is exhausted, so no abort.
    expect((await poll()).action).toBe('recovered');
    expect((await poll()).action).toBe('recovered');
    expect((await poll()).action).toBe('recovered');
    // Now BOTH are exhausted — the apex is what triggers the abort.
    const verdict = await poll();
    expect(verdict.action).toBe('abort');
    expect(verdict.reason).toContain('vibecarbon/vibecarbon-tls');
    expect(verdict.reason).not.toContain('grafana');
  });

  it('the allowlist is exactly the two Certificates this deploy creates', () => {
    expect([...DEPLOY_OWNED_CERTIFICATES]).toEqual([
      'vibecarbon/vibecarbon-tls',
      'vibecarbon-observability/grafana-tls',
    ]);
    expect(DEPLOY_OWNED_CERTIFICATES).toContain(PROBED_APEX_CERTIFICATE);
  });

  it('fails OPEN when a thrown logger would otherwise escape the poll', async () => {
    const runKubectl = kubectlReturning(e3Fixture());
    const poll = createAcmeIssuanceWatchdog({
      runKubectl,
      log: () => {
        throw new Error('spinner is gone');
      },
    });
    expect((await poll()).action).toBe('recovered');
  });

  it('fails OPEN when the repair itself errors, and still retries next poll', async () => {
    const runKubectl = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'get') return JSON.stringify({ items: e3Fixture() });
      throw new Error('the server could not find the requested resource');
    });
    const poll = createAcmeIssuanceWatchdog({ runKubectl, maxRecoveries: 2 });

    expect((await poll()).action).toBe('recovered');
    expect((await poll()).action).toBe('recovered');
    expect((await poll()).action).toBe('abort');
  });
});
