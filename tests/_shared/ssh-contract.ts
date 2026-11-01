/**
 * Test fakes for src/lib/ssh.js that keep its REAL contracts, so a test cannot
 * pass a call production would reject: `sshRun` takes a non-empty argv array
 * and throws otherwise (exactly as ssh.js does), `sshRunScript` takes a
 * script string. A string-accepting fake let fix round 3 ship a compose scale
 * that threw before its restore.
 */
export const SSH_RUN_ARGV_ERROR = 'sshRun requires a non-empty argv array';

/** Throw as ssh.js's sshRun does on a non-array argv. */
export function assertSshRunArgv(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error(SSH_RUN_ARGV_ERROR);
}

/** An sshRun fake: checks the argv contract, then answers with `answer`. */
export function contractSshRun(
  answer: (ip: string, argv: string[], opts: Record<string, unknown>) => unknown = () => '',
) {
  return async (ip: string, _key: string, argv: unknown, opts: Record<string, unknown> = {}) => {
    assertSshRunArgv(argv);
    return answer(ip, argv, opts);
  };
}

/**
 * Wrap a test's own sshRun fake (a vi.fn the test asserts on) so every call
 * first meets the real argv contract, then reaches the fake unchanged. For
 * code that takes ssh.js's sshRun by injection (deps.sshRun, `runner`).
 */
export function withSshContract<T extends (...args: never[]) => unknown>(fake: T): T {
  return ((...args: unknown[]) => {
    assertSshRunArgv(args[2]);
    return (fake as unknown as (...a: unknown[]) => unknown)(...args);
  }) as unknown as T;
}
