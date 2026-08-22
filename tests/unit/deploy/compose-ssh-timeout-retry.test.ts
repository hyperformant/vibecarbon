/**
 * sshRunAsync's timeout-is-transient branch, proven BEHAVIORALLY.
 *
 * The classifier was written for execa's error wordings ('Command was killed
 * with SIGTERM', 'timed out') during the async-exec migration — but
 * runCommandAsync builds its message as `Command failed: <argv>\n<stderr>`
 * and SIGTERMs the child (which prints nothing), so none of those strings
 * ever appear and the branch was DEAD: the exact iter-validate4 dockerLogin
 * double-timeout the 9-line comment cites would still not have retried.
 * The reliable signal is the `timedOut: true` PROPERTY runCommandAsync sets.
 *
 * This suite drives the REAL runCommandAsync timeout path (a spawned sleep
 * killed by the wrapper's timer — no mocks) to pin the error SHAPE, then
 * proves sshRunAsync's classifier retries exactly that shape. If command.js
 * ever changes its timeout error construction, the shape test fails here
 * rather than silently re-killing the classifier.
 */
import { describe, expect, it, vi } from 'vitest';
import { runCommandAsync } from '../../../src/lib/command.js';
import { isTransientSshCommandError } from '../../../src/lib/deploy/compose/index.js';

describe('runCommandAsync timeout error shape (the classifier contract)', () => {
  it('sets timedOut=true and a message WITHOUT the legacy execa wordings', async () => {
    let caught: (Error & { timedOut?: boolean; stderr?: string }) | undefined;
    try {
      await runCommandAsync(['sleep', '5'], { silent: true, timeout: 150 });
    } catch (err) {
      caught = err as typeof caught;
    }
    expect(caught, 'the wrapper timeout must reject').toBeDefined();
    expect(caught?.timedOut).toBe(true);
    // The legacy strings the old classifier looked for must NOT be relied on:
    expect(caught?.message).not.toMatch(/Command was killed with SIGTERM/);
    expect(caught?.message).not.toMatch(/timed out/i);
    expect(caught?.message).toMatch(/^Command failed: sleep 5/);
  });
});

describe('sshRunAsync retries wrapper timeouts', () => {
  it('classifies a timedOut error as transient and retries it', async () => {
    // Drive the real classifier through runWithRetry by invoking sshRunAsync
    // against a command that times out once, then succeeds. We can't point
    // ssh at a real host in unit tests, so exercise the classifier function
    // via the module's exported behavior: monkey-patch is avoided — instead
    // reproduce the decision with the exact error object shape from the test
    // above and the classifier extracted by invocation. Simplest faithful
    // probe: call sshRunAsync with retryable timings against a guaranteed-
    // failing target and count attempts via the onRetry log.
    const { sshRunAsync } = await import('../../../src/lib/deploy/compose/index.js');
    const progress = await import('../../../src/lib/cli/progress.js');
    const logSpy = vi.spyOn(progress, 'progressLog').mockImplementation(() => {});
    try {
      await sshRunAsync('192.0.2.1', '/nonexistent-key', 'true', {
        // ConnectTimeout in the ssh opts is seconds-granular; the wrapper
        // timeout below fires FIRST, producing the timedOut shape each
        // attempt. 3 attempts with zero-ish delay via retries default.
        timeout: 200,
        retries: 2,
      });
    } catch {
      // expected — every attempt times out; what we assert is that a RETRY
      // happened at all (the dead branch never retried).
    }
    const retried = logSpy.mock.calls.some((c) => /retry|attempt/i.test(String(c[0])));
    expect(retried, 'a wrapper timeout must trigger at least one retry').toBe(true);
  }, 15_000);
});

describe('isTransientSshCommandError', () => {
  it('classifies SSH connection-level drops as transient', () => {
    expect(isTransientSshCommandError(new Error('Connection reset by peer'))).toBe(true);
    expect(isTransientSshCommandError(new Error('ssh: connect: Connection refused'))).toBe(true);
    expect(isTransientSshCommandError(new Error('kex_exchange_identification: read: banner'))).toBe(
      true,
    );
    expect(isTransientSshCommandError(new Error('ssh_exchange_identification: eof'))).toBe(true);
    expect(isTransientSshCommandError(new Error('No route to host'))).toBe(true);
  });

  it('classifies a wrapper timeout as transient (the timedOut property)', () => {
    const err = Object.assign(new Error('Command failed: ssh root@1.2.3.4 sleep 5'), {
      timedOut: true,
    });
    expect(isTransientSshCommandError(err)).toBe(true);
  });

  it('classifies in-container DNS-not-settled remote-command output as transient', () => {
    // sshRunAsync's error.message is `Command failed: <argv>\n<stderr>` — the
    // remote command's own stderr, e.g. reconcile.sh's `docker compose pull`
    // hitting an unsettled resolver on a freshly-provisioned server (same
    // dhcpcd private-NIC race as isTransientBuildError in remote-build.js).
    expect(
      isTransientSshCommandError(
        new Error(
          'Command failed: ssh root@1.2.3.4 /bin/bash /opt/proj/reconcile.sh\n' +
            'Error response from daemon: Get "https://registry-1.docker.io/v2/": ' +
            'dial tcp: lookup registry-1.docker.io: Temporary failure in name resolution',
        ),
      ),
    ).toBe(true);
    expect(
      isTransientSshCommandError(
        new Error(
          'Command failed: ssh root@1.2.3.4 apk add --no-cache libstdc++\n' +
            'WARNING: fetching https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/APKINDEX.tar.gz: ' +
            'DNS: transient error (try again later)\n' +
            'ERROR: unable to select packages: libstdc++ (no such package)',
        ),
      ),
    ).toBe(true);
    expect(
      isTransientSshCommandError(
        new Error(
          "Command failed: ssh root@1.2.3.4 apt-get update\nErr:1 http://deb.debian.org/debian bookworm InRelease\n  Temporary failure resolving 'deb.debian.org'",
        ),
      ),
    ).toBe(true);
    expect(
      isTransientSshCommandError(
        new Error(
          'Command failed: ssh root@1.2.3.4 npm install\nError: getaddrinfo EAI_AGAIN registry.npmjs.org',
        ),
      ),
    ).toBe(true);
  });

  it('does NOT classify a genuine remote command failure as transient', () => {
    expect(
      isTransientSshCommandError(
        new Error(
          'Command failed: ssh root@1.2.3.4 docker compose up -d\nERROR: no such service: app',
        ),
      ),
    ).toBe(false);
    expect(
      isTransientSshCommandError(
        new Error(
          'Command failed: ssh root@1.2.3.4 apk add nonexistent-pkg\nERROR: unable to select packages: nonexistent-pkg (no such package)',
        ),
      ),
    ).toBe(false);
  });
});
