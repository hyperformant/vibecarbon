import { describe, expect, it, vi } from 'vitest';
import {
  awaitAcmeChallengesSettled,
  CERT_MANAGER_CONTROLLER,
  CHALLENGE_FINAL_STATES,
  CHALLENGES_ARGV,
  certManagerLogArgv,
  challengesOfOrder,
  challengeWaitLine,
  explainOrderFailure,
  liveChallenges,
  logLinesNaming,
  orderFailureCause,
  TRAEFIK_RESTART_CHALLENGE_WAIT_MS,
  WATCHDOG_LOG_BOUNDS,
} from '../../../src/lib/deploy/k8s/acme-challenges.js';

/**
 * The reading of cert-manager Challenges behind two fixes (hetzner k8s-ha,
 * CI run 42426102569, 2026-11-08):
 *   - the ACME watchdog logged `order is in "invalid" state: ` with nothing
 *     after it, because an Order a failed Challenge turns invalid carries no
 *     reason of its own; the Challenge does;
 *   - the deploy force-restarted Traefik, which serves the HTTP-01 token,
 *     with nothing stopping it while a challenge was being validated.
 *
 * Shapes follow `kubectl get ... -o json`. The reason strings are
 * illustrative ACME problems, not the run's cause (which was never captured).
 */

const NS = 'vibecarbon';
const ORDER = 'vibecarbon-tls-1-4255483814';
const CHALLENGE = `${ORDER}-3698937788`;
const DOMAIN = 'ci4-70da95.carbonstack.dev';
const LE_REASON =
  `Error accepting authorization: acme: authorization error for ${DOMAIN}: 403 ` +
  'urn:ietf:params:acme:error:unauthorized: 116.203.165.133: Invalid response from ' +
  `http://${DOMAIN}/.well-known/acme-challenge/tok: 404`;

function order(
  name = ORDER,
  { state = 'invalid', reason = '', namespace = NS }: Record<string, string> = {},
) {
  return {
    kind: 'Order',
    metadata: { name, namespace, ownerReferences: [{ kind: 'CertificateRequest', name: 'x-1' }] },
    status: { state, reason },
  };
}

function challenge(
  name = CHALLENGE,
  {
    owner = ORDER,
    state = 'invalid',
    reason = LE_REASON,
    namespace = NS,
    dnsName = DOMAIN,
    processing = false,
    deleting = false,
  }: {
    owner?: string;
    state?: string;
    reason?: string;
    namespace?: string;
    dnsName?: string;
    processing?: boolean;
    deleting?: boolean;
  } = {},
) {
  return {
    kind: 'Challenge',
    metadata: {
      name,
      namespace,
      ownerReferences: [{ kind: 'Order', name: owner, controller: true }],
      ...(deleting ? { deletionTimestamp: '2026-11-08T00:00:40Z' } : {}),
    },
    spec: { dnsName, type: 'HTTP-01' },
    status: { state, reason, processing },
  };
}

describe('orderFailureCause: the reason lives on the Challenge', () => {
  it('names the failed Challenge when the invalid Order carries no reason (run 42426102569)', () => {
    const cause = orderFailureCause([order(), challenge()], { namespace: NS, order: ORDER });
    expect(cause).toBe(`HTTP-01 challenge for ${DOMAIN} is invalid: ${LE_REASON}`);
  });

  it.each(['invalid', 'errored', 'expired'])('a %s Challenge is a failed one', (state) => {
    const cause = orderFailureCause([order(), challenge(CHALLENGE, { state })], {
      namespace: NS,
      order: ORDER,
    });
    expect(cause).toContain(`is ${state}: ${LE_REASON}`);
  });

  it('falls back to an unfinished Challenge (its last self-check) when none failed', () => {
    const selfCheck =
      'Waiting for HTTP-01 challenge propagation: failed to perform self check GET request: connection refused';
    const cause = orderFailureCause(
      [order(), challenge(CHALLENGE, { state: 'pending', reason: selfCheck })],
      { namespace: NS, order: ORDER },
    );
    expect(cause).toBe(`HTTP-01 challenge for ${DOMAIN} is pending: ${selfCheck}`);
  });

  it('prefers a failed Challenge over an unfinished one, and skips a valid one', () => {
    const cause = orderFailureCause(
      [
        order(),
        challenge('a', { state: 'valid', reason: 'Successfully authorized domain' }),
        challenge('b', { state: 'pending', reason: 'Waiting for propagation' }),
        challenge('c', { state: 'invalid', reason: LE_REASON, dnsName: 'www.example.test' }),
      ],
      { namespace: NS, order: ORDER },
    );
    expect(cause).toBe(`HTTP-01 challenge for www.example.test is invalid: ${LE_REASON}`);
  });

  it("falls back to the Order's own reason (a finalize error) when no Challenge says", () => {
    const finalize = 'Failed to finalize Order: 403 urn:ietf:params:acme:error:orderNotReady';
    const cause = orderFailureCause(
      [
        order(ORDER, { state: 'errored', reason: finalize }),
        challenge(CHALLENGE, { state: 'valid', reason: 'Successfully authorized domain' }),
      ],
      { namespace: NS, order: ORDER },
    );
    expect(cause).toBe(finalize);
  });

  it('returns null when nothing in the cluster says', () => {
    expect(orderFailureCause([order()], { namespace: NS, order: ORDER })).toBeNull();
    expect(
      orderFailureCause([order(), challenge(CHALLENGE, { reason: '' })], {
        namespace: NS,
        order: ORDER,
      }),
    ).toBeNull();
  });

  it("reads only this Order's Challenges, in its namespace", () => {
    const items = [
      order(),
      challenge('other-order-1', { owner: 'other-order' }),
      challenge(CHALLENGE, { namespace: 'elsewhere' }),
    ];
    expect(challengesOfOrder(items, { namespace: NS, order: ORDER })).toEqual([]);
    expect(orderFailureCause(items, { namespace: NS, order: ORDER })).toBeNull();
  });

  it('keeps the cause on one line', () => {
    const cause = orderFailureCause(
      [order(), challenge(CHALLENGE, { reason: `line one\n  line two\n${'x'.repeat(2000)}` })],
      { namespace: NS, order: ORDER },
    );
    expect(cause).not.toContain('\n');
    expect((cause ?? '').length).toBeLessThanOrEqual(600);
    expect(cause).toMatch(/\.\.\.$/);
  });
});

describe('logLinesNaming', () => {
  const LOG = [
    'I1108 00:00:06.548868       1 trigger_controller.go:238] "Certificate must be re-issued"',
    `I1108 00:00:12.000000       1 sync.go:300] "Presented challenge" resource_name="${CHALLENGE}"`,
    `E1108 00:00:38.100000       1 sync.go:420] "error waiting for authorization" err="${LE_REASON}" resource_name="${CHALLENGE}"`,
    `E1108 00:00:39.200000       1 acme.go:200] "Failed to wait for order resource \\"${ORDER}\\" to become ready"`,
    'I1108 00:00:41.681329       1 conditions.go:201] "Found status change"',
  ].join('\n');

  it('keeps the error lines naming the order or its challenges, klog header stripped', () => {
    const lines = logLinesNaming(LOG, [ORDER, CHALLENGE]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^"error waiting for authorization"/);
    expect(lines[0]).toContain('403 urn:ietf:params:acme:error:unauthorized');
    expect(lines[1]).toContain('Failed to wait for order resource');
  });

  it('falls back to info lines when no error line names it', () => {
    const lines = logLinesNaming(LOG.split('\n').slice(0, 2).join('\n'), [ORDER]);
    expect(lines).toEqual([`"Presented challenge" resource_name="${CHALLENGE}"`]);
  });

  it('returns nothing when no line names it, or no name is given', () => {
    expect(logLinesNaming(LOG, ['vibecarbon-tls-9-1'])).toEqual([]);
    expect(logLinesNaming(LOG, [])).toEqual([]);
    expect(logLinesNaming('', [ORDER])).toEqual([]);
  });

  it('keeps at most the last three', () => {
    const many = Array.from(
      { length: 10 },
      (_, i) => `E1108 00:00:0${i}.0 1 a.go:1] "boom ${i}" resource_name="${ORDER}"`,
    ).join('\n');
    const lines = logLinesNaming(many, [ORDER]);
    expect(lines.map((l) => l.match(/boom (\d)/)?.[1])).toEqual(['7', '8', '9']);
  });
});

describe('certManagerLogArgv: a bounded read', () => {
  it('names the controller and carries --since, --tail and a request timeout', () => {
    const argv = certManagerLogArgv({ sinceMinutes: 30, tailLines: 2000, requestTimeoutSec: 5 });
    expect(argv).toEqual([
      '-n',
      CERT_MANAGER_CONTROLLER.namespace,
      'logs',
      `deployment/${CERT_MANAGER_CONTROLLER.deployment}`,
      '--since=30m',
      '--tail=2000',
      '--request-timeout=5s',
    ]);
  });

  it('the watchdog reads at most a few seconds', () => {
    expect(WATCHDOG_LOG_BOUNDS.requestTimeoutSec).toBeLessThanOrEqual(5);
    expect(WATCHDOG_LOG_BOUNDS.tailLines).toBeGreaterThan(0);
    expect(WATCHDOG_LOG_BOUNDS.sinceMinutes).toBeGreaterThan(0);
  });
});

describe('explainOrderFailure: one line, every source, never throws', () => {
  const failingOrder = [order()];

  it('source 1, the Challenge: no log read at all', async () => {
    const runKubectl = vi.fn();
    const r = await explainOrderFailure({
      items: [order(), challenge()],
      namespace: NS,
      order: ORDER,
      runKubectl,
    });
    expect(r).toEqual({
      found: true,
      cause: `HTTP-01 challenge for ${DOMAIN} is invalid: ${LE_REASON}`,
    });
    expect(runKubectl).not.toHaveBeenCalled();
  });

  it("source 2, the Order's own reason: no log read at all", async () => {
    const runKubectl = vi.fn();
    const r = await explainOrderFailure({
      items: [order(ORDER, { state: 'errored', reason: 'Failed to finalize Order: 403' })],
      namespace: NS,
      order: ORDER,
      runKubectl,
    });
    expect(r).toEqual({ found: true, cause: 'Failed to finalize Order: 403' });
    expect(runKubectl).not.toHaveBeenCalled();
  });

  it('source 3, the controller log: one bounded read, lines naming the order', async () => {
    const runKubectl = vi.fn(
      async () =>
        `E1108 00:00:38.1 1 sync.go:420] "error waiting for authorization" err="${LE_REASON}" resource_name="${CHALLENGE}"\n`,
    );
    const r = await explainOrderFailure({
      items: failingOrder,
      namespace: NS,
      order: ORDER,
      runKubectl,
    });
    expect(r.found).toBe(true);
    expect(r.cause).toMatch(/^cert-manager log: "error waiting for authorization"/);
    expect(r.cause).toContain('urn:ietf:params:acme:error:unauthorized');
    expect(runKubectl).toHaveBeenCalledTimes(1);
    expect(runKubectl).toHaveBeenCalledWith(certManagerLogArgv(WATCHDOG_LOG_BOUNDS));
  });

  it("source 3 also finds lines naming the order's challenges by name", async () => {
    // A challenge whose name does not start with the order's (cert-manager
    // truncates a long prefix) is still matched by its own name.
    const runKubectl = vi.fn(
      async () => `E1108 00:00:38.1 1 sync.go:420] "boom" resource_name="short-ch-1"\n`,
    );
    const r = await explainOrderFailure({
      items: [order(), challenge('short-ch-1', { reason: '' })],
      namespace: NS,
      order: ORDER,
      runKubectl,
    });
    expect(r).toEqual({
      found: true,
      cause: 'cert-manager log: "boom" resource_name="short-ch-1"',
    });
  });

  it('nothing found: says the reason was unavailable, and why', async () => {
    const runKubectl = vi.fn(async () => 'I1108 00:00:01.0 1 a.go:1] "unrelated"\n');
    const r = await explainOrderFailure({
      items: failingOrder,
      namespace: NS,
      order: ORDER,
      runKubectl,
    });
    expect(r.found).toBe(false);
    expect(r.cause).toBe(
      'reason unavailable: its Challenges and the Order carry none, and no cert-manager log ' +
        `line in the last ${WATCHDOG_LOG_BOUNDS.sinceMinutes} minutes names it`,
    );
  });

  it('log unreadable: says the reason was unavailable, and why', async () => {
    const err: Error & { stderr?: string } = new Error('Command failed: kubectl logs');
    err.stderr = 'error: context deadline exceeded';
    const r = await explainOrderFailure({
      items: failingOrder,
      namespace: NS,
      order: ORDER,
      runKubectl: vi.fn().mockRejectedValue(err),
    });
    expect(r.found).toBe(false);
    expect(r.cause).toMatch(/^reason unavailable: .*the cert-manager log could not be read/);
    expect(r.cause).toContain('Command failed: kubectl logs');
  });

  it('never throws, even on malformed input', async () => {
    const r = await explainOrderFailure({
      // @ts-expect-error deliberately malformed
      items: null,
      namespace: NS,
      order: ORDER,
      runKubectl: vi.fn(async () => {
        throw 'not an Error';
      }),
    });
    expect(r.found).toBe(false);
    expect(r.cause).toMatch(/^reason unavailable/);
  });
});

describe('liveChallenges', () => {
  it.each(['', 'pending', 'processing', 'ready'])('a %s Challenge is live', (state) => {
    expect(liveChallenges([challenge(CHALLENGE, { state })], [NS])).toHaveLength(1);
  });

  it.each(CHALLENGE_FINAL_STATES)('a %s Challenge is finished', (state) => {
    expect(liveChallenges([challenge(CHALLENGE, { state })], [NS])).toEqual([]);
  });

  it('a Challenge being deleted is not live (cert-manager is cleaning it up)', () => {
    expect(
      liveChallenges([challenge(CHALLENGE, { state: 'pending', deleting: true })], [NS]),
    ).toEqual([]);
  });

  it('reads only the given namespaces and only Challenges', () => {
    const items = [challenge(CHALLENGE, { state: 'pending', namespace: 'user-ns' }), order()];
    expect(liveChallenges(items, [NS])).toEqual([]);
  });
});

describe('awaitAcmeChallengesSettled', () => {
  /** A fake clock that advances only when the wait sleeps. */
  function clock() {
    let t = 0;
    return {
      now: () => t,
      sleep: vi.fn(async (ms: number) => {
        t += ms;
      }),
    };
  }
  const listOf = (...items: unknown[]) => JSON.stringify({ items });

  it('returns at once when nothing is live (the usual case: one read)', async () => {
    const c = clock();
    const runKubectl = vi.fn(async () => listOf());
    const r = await awaitAcmeChallengesSettled({ runKubectl, namespaces: [NS], ...c });
    expect(r).toMatchObject({ settled: true, reads: 1, waitedMs: 0 });
    expect(runKubectl).toHaveBeenCalledWith([...CHALLENGES_ARGV]);
    expect(c.sleep).not.toHaveBeenCalled();
    expect(challengeWaitLine(r)).toBeNull();
  });

  it('waits while a challenge is live and returns the moment it finishes', async () => {
    const c = clock();
    const answers = [
      listOf(challenge(CHALLENGE, { state: 'pending', processing: true })),
      listOf(challenge(CHALLENGE, { state: 'pending', processing: true })),
      listOf(), // valid: cert-manager deleted it
    ];
    const runKubectl = vi.fn(async () => answers.shift() ?? listOf());
    const r = await awaitAcmeChallengesSettled({
      runKubectl,
      namespaces: [NS],
      intervalMs: 2000,
      ...c,
    });
    expect(r).toMatchObject({ settled: true, reads: 3, waitedMs: 4000 });
    expect(challengeWaitLine(r)).toBe('traefik restart held 4s until the ACME challenge finished');
  });

  it('gives up at its bound and names the challenge still live', async () => {
    const c = clock();
    const runKubectl = vi.fn(async () =>
      listOf(challenge(CHALLENGE, { state: 'pending', reason: 'Waiting for propagation' })),
    );
    const r = await awaitAcmeChallengesSettled({
      runKubectl,
      namespaces: [NS],
      budgetMs: 10_000,
      intervalMs: 2000,
      ...c,
    });
    expect(r.settled).toBe(false);
    expect(r.waitedMs).toBe(10_000);
    expect(r.live).toHaveLength(1);
    const line = challengeWaitLine(r);
    expect(line).toContain(`HTTP-01 challenge for ${DOMAIN} is pending: Waiting for propagation`);
    expect(line).toContain('still live after 10s, restarting anyway');
    expect(line).not.toContain('—');
  });

  it('never sleeps past its bound', async () => {
    const c = clock();
    const runKubectl = vi.fn(async () => listOf(challenge(CHALLENGE, { state: 'pending' })));
    await awaitAcmeChallengesSettled({
      runKubectl,
      namespaces: [NS],
      budgetMs: 5000,
      intervalMs: 2000,
      ...c,
    });
    expect(c.now()).toBe(5000);
  });

  it('an unreadable cluster ends the wait at once instead of stalling the deploy', async () => {
    const c = clock();
    const r = await awaitAcmeChallengesSettled({
      runKubectl: vi.fn().mockRejectedValue(new Error('kubectl failed')),
      namespaces: [NS],
      ...c,
    });
    expect(r).toMatchObject({ settled: false, reads: 1, error: 'kubectl failed' });
    expect(c.sleep).not.toHaveBeenCalled();
    expect(challengeWaitLine(r)).toBe(
      'traefik restart: could not read the ACME challenges (kubectl failed), restarting without waiting',
    );
  });

  it('ignores challenges outside the deploy-owned namespaces', async () => {
    const c = clock();
    const runKubectl = vi.fn(async () =>
      listOf(challenge(CHALLENGE, { state: 'pending', namespace: 'user-ns' })),
    );
    const r = await awaitAcmeChallengesSettled({ runKubectl, namespaces: [NS], ...c });
    expect(r).toMatchObject({ settled: true, reads: 1 });
  });

  it('the bound is one minute', () => {
    expect(TRAEFIK_RESTART_CHALLENGE_WAIT_MS).toBe(60_000);
  });
});
