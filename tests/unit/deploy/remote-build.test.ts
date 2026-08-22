import { afterEach, describe, expect, it, vi } from 'vitest';

// remote-build shells out via command.js: runCommand (sync) for the SSH probe,
// runCommandAsync (async, capturing) for the docker build itself. Mock both.
vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    runCommand: vi.fn(),
    runCommandAsync: vi.fn(),
  };
});

const { runCommand, runCommandAsync } = await import('../../../src/lib/command.js');
const {
  buildRemote,
  isTransientBuildError,
  isDnsNotSettledBuildError,
  SSH_PROBE_DELAYS_MS,
  TRANSPORT_DROP_RETRY_DELAYS_MS,
  DNS_NOT_SETTLED_RETRY_DELAYS_MS,
} = await import('../../../src/lib/deploy/remote-build.js');
const { PLATFORM_BUILD_FLAG } = await import('../../../src/lib/deploy/platform.js');

afterEach(() => {
  vi.mocked(runCommand).mockReset();
  vi.mocked(runCommandAsync).mockReset();
  vi.useRealTimers();
});

describe('isTransientBuildError (F6)', () => {
  it('classifies BuildKit-over-SSH session drops as transient (worth a retry)', () => {
    expect(
      isTransientBuildError(
        'http2: server: error reading preface from client ...: file already closed',
      ),
    ).toBe(true);
    expect(isTransientBuildError('unexpected EOF: connection reset by peer')).toBe(true);
    expect(
      isTransientBuildError('kex_exchange_identification: Connection closed by remote host'),
    ).toBe(true);
    expect(isTransientBuildError('client_loop: send disconnect: Broken pipe')).toBe(true);
  });

  it('classifies a genuine Dockerfile / RUN failure as NON-transient (fail fast)', () => {
    expect(
      isTransientBuildError(
        'ERROR: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
      ),
    ).toBe(false);
    expect(isTransientBuildError('COPY failed: file not found in build context')).toBe(false);
    expect(isTransientBuildError('')).toBe(false);
    expect(isTransientBuildError(undefined as unknown as string)).toBe(false);
  });

  it('classifies in-container DNS-not-settled errors on a fresh server as transient (worth a retry)', () => {
    // Verbatim capture from a freshly-provisioned Hetzner primary (dhcpcd
    // private-NIC race; init self-heals ~30s) — hetzner/compose-ha 2026-08-10.
    expect(
      isTransientBuildError(
        'WARNING: fetching https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/APKINDEX.tar.gz: DNS: transient error (try again later)\n' +
          'ERROR: unable to select packages: libstdc++ (no such package)',
      ),
    ).toBe(true);
    // apt (Debian/Ubuntu base images).
    expect(
      isTransientBuildError(
        "Err:1 http://deb.debian.org/debian bookworm InRelease\n  Temporary failure resolving 'deb.debian.org'",
      ),
    ).toBe(true);
    // glibc/musl resolver (curl, git clone, etc. inside the build).
    expect(
      isTransientBuildError(
        'curl: (6) Could not resolve host: github.com'.concat(
          '\ngetaddrinfo: Temporary failure in name resolution',
        ),
      ),
    ).toBe(true);
    // Node/npm.
    expect(isTransientBuildError('Error: getaddrinfo EAI_AGAIN registry.npmjs.org')).toBe(true);
  });

  it('does NOT classify a genuinely missing apk package (no DNS wording) as transient', () => {
    // Same tail message as the DNS case above ("unable to select packages")
    // but with no DNS/temporary-failure wording — a real missing package,
    // must fail fast rather than burn 3 retries on an identical error.
    expect(
      isTransientBuildError('ERROR: unable to select packages: nonexistent-pkg (no such package)'),
    ).toBe(false);
  });
});

describe('buildRemote SSH-probe ladder (F5)', () => {
  it('is trimmed to a short [1s,2s,3s] ladder — the caller already proved SSH live', () => {
    expect(SSH_PROBE_DELAYS_MS).toEqual([1000, 2000, 3000]);
  });
});

describe('build-retry ladder sizing (fresh-server DNS-not-settled window)', () => {
  it('keeps the transport-blip ladder fast (unchanged): 3s then 6s', () => {
    // Common case — a genuine SSH-down after dockerReady is an anomaly, not
    // a slow boot, so this must NOT be widened by the DNS-branch fix below.
    expect(TRANSPORT_DROP_RETRY_DELAYS_MS).toEqual([3000, 6000]);
  });

  it('sizes the DNS-not-settled ladder past the fresh-server self-heal window with margin', () => {
    // The one hard data point in the project record for a fresh-Hetzner-boot
    // network race self-healing is the private-NIC (enp7s0) dhcpcd race:
    // init scripts retrigger the lease after 30s of no IP (project record:
    // "Hetzner private NIC dhcpcd race"). Tonight's failure was PUBLIC DNS
    // resolution (apk fetching dl-cdn.alpinelinux.org), a different
    // interface/subsystem than that record covers — but the same
    // fresh-server-network-still-settling family, so the same order-of-
    // magnitude margin applies until a dedicated RCA pins the exact
    // resolver-settle timing.
    const FRESH_SERVER_SELF_HEAL_WINDOW_MS = 30_000;
    const cumulativeWaitMs = DNS_NOT_SETTLED_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(cumulativeWaitMs).toBeGreaterThan(FRESH_SERVER_SELF_HEAL_WINDOW_MS);
    // Pin the actual ladder so a future edit can't quietly shrink the margin
    // back under the window without this test's comment forcing a re-look.
    expect(DNS_NOT_SETTLED_RETRY_DELAYS_MS).toEqual([10000, 15000, 20000]);
  });
});

describe('buildRemote build-retry gating (F6)', () => {
  it('fails FAST (a single build attempt) on a genuine Dockerfile error', async () => {
    // SSH probe answers immediately (caller already ran waitForDockerReady).
    vi.mocked(runCommand).mockReturnValue(true);
    const err = Object.assign(new Error('Command failed'), {
      status: 1,
      stderr:
        'ERROR: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
      stdout: '',
    });
    vi.mocked(runCommandAsync).mockRejectedValue(err);

    const ok = await buildRemote('1.2.3.4', '/tmp/key', 'proj-app:local', '/tmp/ctx', {});

    expect(ok).toBe(false);
    // Non-transient → NOT retried: exactly one build invocation.
    expect(runCommandAsync).toHaveBeenCalledTimes(1);
  });

  it('RETRIES a transient BuildKit/SSH drop, then succeeds', async () => {
    vi.useFakeTimers();
    vi.mocked(runCommand).mockReturnValue(true);
    const transient = Object.assign(new Error('Command failed'), {
      status: 1,
      stderr: 'http2: server: error reading preface from client ...: file already closed',
      stdout: '',
    });
    vi.mocked(runCommandAsync)
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(true);

    const promise = buildRemote('1.2.3.4', '/tmp/key', 'proj-app:local', '/tmp/ctx', {});
    // Backoff is 3s then 6s between attempts — advance through both.
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(6000);
    const ok = await promise;

    expect(ok).toBe(true);
    expect(runCommandAsync).toHaveBeenCalledTimes(3);
  });

  it('RETRIES a DNS-not-settled failure on the longer ladder (10s/15s/20s), succeeding on the 4th attempt', async () => {
    vi.useFakeTimers();
    vi.mocked(runCommand).mockReturnValue(true);
    const dnsNotSettled = Object.assign(new Error('Command failed'), {
      status: 1,
      stderr:
        'WARNING: fetching https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/APKINDEX.tar.gz: DNS: transient error (try again later)\n' +
        'ERROR: unable to select packages: libstdc++ (no such package)',
      stdout: '',
    });
    vi.mocked(runCommandAsync)
      .mockRejectedValueOnce(dnsNotSettled)
      .mockRejectedValueOnce(dnsNotSettled)
      .mockRejectedValueOnce(dnsNotSettled)
      .mockResolvedValueOnce(true);

    const promise = buildRemote('1.2.3.4', '/tmp/key', 'proj-app:local', '/tmp/ctx', {});
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(15000);
    await vi.advanceTimersByTimeAsync(20000);
    const ok = await promise;

    expect(ok).toBe(true);
    // 4 attempts (one more than the transport ladder's 3) — the extra
    // attempt is what buys the cumulative 45s of deliberate wait.
    expect(runCommandAsync).toHaveBeenCalledTimes(4);
  });

  it('gives up after exhausting the DNS-not-settled ladder (4 attempts) if the resolver never settles', async () => {
    vi.useFakeTimers();
    vi.mocked(runCommand).mockReturnValue(true);
    const dnsNotSettled = Object.assign(new Error('Command failed'), {
      status: 1,
      stderr: 'Error: getaddrinfo EAI_AGAIN registry.npmjs.org',
      stdout: '',
    });
    vi.mocked(runCommandAsync).mockRejectedValue(dnsNotSettled);

    const promise = buildRemote('1.2.3.4', '/tmp/key', 'proj-app:local', '/tmp/ctx', {});
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(15000);
    await vi.advanceTimersByTimeAsync(20000);
    const ok = await promise;

    expect(ok).toBe(false);
    expect(runCommandAsync).toHaveBeenCalledTimes(4);
  });
});

describe('isDnsNotSettledBuildError', () => {
  it('is the sub-predicate the ladder-selection decision uses (kept in sync with isTransientBuildError)', () => {
    expect(isDnsNotSettledBuildError('WARNING: ...: DNS: transient error (try again later)')).toBe(
      true,
    );
    expect(isDnsNotSettledBuildError("Temporary failure resolving 'deb.debian.org'")).toBe(true);
    expect(isDnsNotSettledBuildError('getaddrinfo: Temporary failure in name resolution')).toBe(
      true,
    );
    expect(isDnsNotSettledBuildError('getaddrinfo EAI_AGAIN registry.npmjs.org')).toBe(true);
    // A transport drop is transient too (isTransientBuildError), but it is
    // NOT the DNS sub-class — the ladder-selection logic depends on this
    // staying false so transport blips keep the fast [3s,6s] ladder.
    expect(
      isDnsNotSettledBuildError('http2: server: error reading preface ...: file already closed'),
    ).toBe(false);
    expect(isDnsNotSettledBuildError('COPY failed: file not found in build context')).toBe(false);
  });
});

describe('buildRemote target platform', () => {
  it('pins the build to linux/amd64', async () => {
    vi.mocked(runCommand).mockReturnValue(true);
    vi.mocked(runCommandAsync).mockResolvedValue(true);

    await buildRemote('1.2.3.4', '/tmp/key', 'proj-app:local', '/tmp/ctx', {
      VITE_SUPABASE_URL: 'https://x.example',
    });

    const argv = vi.mocked(runCommandAsync).mock.calls[0][0] as string[];
    expect(argv.slice(0, 3)).toEqual(['docker', 'build', PLATFORM_BUILD_FLAG]);
    expect(PLATFORM_BUILD_FLAG).toBe('--platform=linux/amd64');
    // vibecarbon is amd64-only; this build runs on the target VPS, so the pin
    // is redundant today but keeps the invariant explicit at the build itself.
    expect(argv.filter((a) => a.startsWith('--platform'))).toHaveLength(1);
  });
});
