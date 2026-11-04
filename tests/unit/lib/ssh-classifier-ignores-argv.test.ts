/**
 * The transient classifier judges what the failure SAID, never the command
 * line runCommandAsync echoes into err.message (`Command failed: <argv>`).
 *
 * Every scp and ssh vibecarbon runs passes `-o ConnectTimeout=10`, and the
 * classifier's /timed out|timeout/i matched that echo, so EVERY failed copy
 * read as transient and retried three times with 5s and 15s waits, a missing
 * file included (found 2026-11-04 by the kubectl-compression work, whose tests
 * had to mock scpWithRetry to dodge the wait).
 */
import { describe, expect, it } from 'vitest';
import {
  isDnsNotSettledSshCommandError,
  isTransientSshCommandError,
} from '../../../src/lib/ssh.js';

/** The shape runCommandAsync throws: argv echoed in message, stderr apart. */
const failure = (argv: string, stderr: string, extra: Record<string, unknown> = {}) =>
  Object.assign(
    new Error(
      stderr.trim() ? `Command failed: ${argv}\n${stderr.trim()}` : `Command failed: ${argv}`,
    ),
    { stderr, stdout: '', status: 1, timedOut: false, ...extra },
  );

const SCP =
  'scp -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new /local/.env root@1.2.3.4:/opt/app/.env';

describe('isTransientSshCommandError reads the failure, not the argv', () => {
  it('a missing file is permanent even though the argv says ConnectTimeout', () => {
    expect(
      isTransientSshCommandError(failure(SCP, 'scp: /opt/app/.env: No such file or directory\n')),
    ).toBe(false);
  });

  it('a permission error with no stderr text is permanent too', () => {
    expect(isTransientSshCommandError(failure(SCP, ''))).toBe(false);
  });

  it("ssh's own keepalive death is still transient", () => {
    expect(
      isTransientSshCommandError(
        failure(SCP, 'Timeout, server 1.2.3.4 not responding.\nlost connection\n', { status: 255 }),
      ),
    ).toBe(true);
  });

  it('a connection refused in stderr is still transient', () => {
    expect(
      isTransientSshCommandError(
        failure(SCP, 'ssh: connect to host 1.2.3.4 port 22: Connection refused\n', { status: 255 }),
      ),
    ).toBe(true);
  });

  it("the wrapper's own timeout (timedOut) is still transient with empty stderr", () => {
    expect(isTransientSshCommandError(failure(SCP, '', { timedOut: true }))).toBe(true);
  });

  it('an error with no stderr property (not from runCommandAsync) is judged on its message', () => {
    expect(isTransientSshCommandError(new Error('connect ETIMEDOUT 1.2.3.4:22'))).toBe(true);
    expect(isTransientSshCommandError(new Error('permission denied'))).toBe(false);
  });
});

describe('isDnsNotSettledSshCommandError reads the failure, not the argv', () => {
  it('an argv that merely names a resolver option is not a DNS failure', () => {
    const argv = "ssh root@1.2.3.4 'getent hosts registry || echo temporary failure resolving'";
    expect(isDnsNotSettledSshCommandError(failure(argv, 'exit status 2\n'))).toBe(false);
  });
  it('the DNS wording in stderr still is', () => {
    expect(
      isDnsNotSettledSshCommandError(
        failure('ssh root@1.2.3.4 docker pull x', 'Temporary failure in name resolution\n'),
      ),
    ).toBe(true);
  });
});
