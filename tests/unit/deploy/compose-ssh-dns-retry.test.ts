/**
 * sshRunAsync's DNS-not-settled retry-ladder sizing, proven BEHAVIORALLY.
 *
 * compose-ssh-timeout-retry.test.ts deliberately drives a REAL ssh subprocess
 * (no mocks) for the wrapper-timeout branch — that works because a 150-200ms
 * wrapper timeout resolves fast regardless of what's on the other end. This
 * suite can't do the same: the DNS-not-settled ladder's cumulative wait is
 * 45s, and there's no way to make a real `ssh` invocation fail with the
 * exact remote-command-stderr shape (`Command failed: <argv>\n<stderr>`)
 * without a live host. So this file mocks command.js's runCommandAsync
 * directly — the same approach remote-build.test.ts already uses for its
 * (also long-running) DNS-ladder assertions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    runCommandAsync: vi.fn(),
  };
});

const { runCommandAsync } = await import('../../../src/lib/command.js');
const { sshRunAsync, isDnsNotSettledSshCommandError, DNS_NOT_SETTLED_RETRY_DELAYS_MS } =
  await import('../../../src/lib/deploy/compose/index.js');
const { DNS_NOT_SETTLED_RETRY_DELAYS_MS: REMOTE_BUILD_DNS_NOT_SETTLED_RETRY_DELAYS_MS } =
  await import('../../../src/lib/deploy/remote-build.js');
const progress = await import('../../../src/lib/cli/progress.js');

afterEach(() => {
  vi.mocked(runCommandAsync).mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isDnsNotSettledSshCommandError', () => {
  it('matches the same DNS-not-settled wordings as isTransientSshCommandError', () => {
    expect(
      isDnsNotSettledSshCommandError(
        new Error('Command failed: ...\nDNS: transient error (try again later)'),
      ),
    ).toBe(true);
    expect(
      isDnsNotSettledSshCommandError(
        new Error("Command failed: ...\nTemporary failure resolving 'deb.debian.org'"),
      ),
    ).toBe(true);
    expect(
      isDnsNotSettledSshCommandError(
        new Error('Command failed: ...\ngetaddrinfo: Temporary failure in name resolution'),
      ),
    ).toBe(true);
    expect(
      isDnsNotSettledSshCommandError(new Error('Command failed: ...\ngetaddrinfo EAI_AGAIN')),
    ).toBe(true);
    // A transport drop is NOT the DNS sub-class — the ladder-selection logic
    // depends on this staying false so transport blips keep the fast ladder.
    expect(isDnsNotSettledSshCommandError(new Error('Connection reset by peer'))).toBe(false);
    expect(
      isDnsNotSettledSshCommandError(new Error('Command failed: ...\nERROR: no such service: app')),
    ).toBe(false);
  });
});

describe('DNS-not-settled retry ladder sizing (fresh-server dhcpcd-adjacent window)', () => {
  it('sizes the ladder past the ~30s fresh-server self-heal window with margin', () => {
    // Same ~30s order-of-magnitude margin as remote-build.js's
    // DNS_NOT_SETTLED_RETRY_DELAYS_MS — see that file's docstring for the
    // sizing rationale (private-NIC dhcpcd race data point, not confirmed
    // identical to this public-DNS-resolution failure mode).
    const FRESH_SERVER_SELF_HEAL_WINDOW_MS = 30_000;
    const cumulativeWaitMs = DNS_NOT_SETTLED_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(cumulativeWaitMs).toBeGreaterThan(FRESH_SERVER_SELF_HEAL_WINDOW_MS);
    expect(DNS_NOT_SETTLED_RETRY_DELAYS_MS).toEqual([10000, 15000, 20000]);
  });

  it('is the exact SAME array as remote-build.js exports — imported, not a re-declared copy', () => {
    // Import-identity, not just value-equality: compose/index.js re-exports
    // remote-build.js's constant rather than declaring its own [10000,
    // 15000, 20000] literal. Two independently-declared-but-equal arrays
    // would pass a .toEqual() check and still be free to drift the moment
    // either file's copy gets edited without the other — this pins the
    // single source of truth directly.
    expect(DNS_NOT_SETTLED_RETRY_DELAYS_MS).toBe(REMOTE_BUILD_DNS_NOT_SETTLED_RETRY_DELAYS_MS);
  });
});

describe('sshRunAsync retry-ladder behavior', () => {
  it('keeps the default transport ladder (5s, 5s) for a connection-drop error — unchanged, 3 total attempts', async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(progress, 'progressLog').mockImplementation(() => {});
    const dropErr = new Error('Command failed: ssh root@1.2.3.4 true\nConnection reset by peer');
    vi.mocked(runCommandAsync)
      .mockRejectedValueOnce(dropErr)
      .mockRejectedValueOnce(dropErr)
      .mockResolvedValueOnce('ok');

    const promise = sshRunAsync('1.2.3.4', '/tmp/key', 'true', {});
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toBe('ok');
    expect(runCommandAsync).toHaveBeenCalledTimes(3);
    expect(logSpy.mock.calls.some((c) => /retrying in 5s/.test(String(c[0])))).toBe(true);
    // Never widened to the DNS ladder for a non-DNS transient.
    expect(
      logSpy.mock.calls.some((c) =>
        /retrying in 10s|retrying in 15s|retrying in 20s/.test(String(c[0])),
      ),
    ).toBe(false);
  });

  it('widens to the DNS-not-settled ladder (10s/15s/20s) on a DNS-classified failure, succeeding on the 4th attempt', async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(progress, 'progressLog').mockImplementation(() => {});
    const dnsErr = new Error(
      'Command failed: ssh root@1.2.3.4 /bin/bash /opt/proj/reconcile.sh\n' +
        'Error response from daemon: Get "https://registry-1.docker.io/v2/": ' +
        'dial tcp: lookup registry-1.docker.io: Temporary failure in name resolution',
    );
    vi.mocked(runCommandAsync)
      .mockRejectedValueOnce(dnsErr)
      .mockRejectedValueOnce(dnsErr)
      .mockRejectedValueOnce(dnsErr)
      .mockResolvedValueOnce('ok');

    const promise = sshRunAsync('1.2.3.4', '/tmp/key', 'bash reconcile.sh', {});
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(15000);
    await vi.advanceTimersByTimeAsync(20000);
    const result = await promise;

    expect(result).toBe('ok');
    // 4 attempts, one more than the default transport ladder's 3.
    expect(runCommandAsync).toHaveBeenCalledTimes(4);
    expect(logSpy.mock.calls.some((c) => /retrying in 10s/.test(String(c[0])))).toBe(true);
    expect(logSpy.mock.calls.some((c) => /retrying in 15s/.test(String(c[0])))).toBe(true);
    expect(logSpy.mock.calls.some((c) => /retrying in 20s/.test(String(c[0])))).toBe(true);
  });

  it('gives up after exhausting the DNS-not-settled ladder (4 attempts) if the resolver never settles', async () => {
    vi.useFakeTimers();
    vi.spyOn(progress, 'progressLog').mockImplementation(() => {});
    const dnsErr = new Error(
      'Command failed: ssh root@1.2.3.4 npm install\nError: getaddrinfo EAI_AGAIN registry.npmjs.org',
    );
    vi.mocked(runCommandAsync).mockRejectedValue(dnsErr);

    const promise = sshRunAsync('1.2.3.4', '/tmp/key', 'npm install', {});
    const assertion = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(15000);
    await vi.advanceTimersByTimeAsync(20000);
    await assertion;

    expect(runCommandAsync).toHaveBeenCalledTimes(4);
  });

  it('does NOT widen the ladder when the caller opted out of retries (retries: 1) even on a DNS-classified failure', async () => {
    // compose/ha.js's restoreComposeWalgRole / demoteComposeWalgRole DR
    // fast-fail path: targets an ALREADY-established server (not
    // freshly-provisioned), so the DNS-not-settled window correctly does
    // not apply — the opt-out must be respected as-is.
    vi.spyOn(progress, 'progressLog').mockImplementation(() => {});
    const dnsErr = new Error(
      'Command failed: ssh root@1.2.3.4 true\nDNS: transient error (try again later)',
    );
    vi.mocked(runCommandAsync).mockRejectedValue(dnsErr);

    await expect(sshRunAsync('1.2.3.4', '/tmp/key', 'true', { retries: 1 })).rejects.toThrow();

    expect(runCommandAsync).toHaveBeenCalledTimes(1);
  });
});
