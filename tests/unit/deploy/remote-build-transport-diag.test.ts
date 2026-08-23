/**
 * When the remote-build transport ladder exhausts, the failure must carry
 * ssh evidence — not just BuildKit's last words.
 *
 * 2026-08-23 (linode, three occurrences): docker's dial-stdio ssh died with
 * exit 255 at the daemon _ping while the plain probe ssh succeeded seconds
 * earlier. The ladder retried and threw with only the build output, which
 * says nothing about WHY ssh died — so the class stayed "transient" for
 * another night. The exhaustion path now runs one verbose ssh probe through
 * the SAME wrapper and appends either "probe succeeded → session-specific
 * drop" or the probe's own ssh -vv tail. Diagnostics must never mask the
 * real failure: the throw still happens, buildRemote still returns false.
 */
import { describe, expect, it, vi } from 'vitest';

const runCommand = vi.fn();
const runCommandAsync = vi.fn();
vi.mock('../../../src/lib/command.js', () => ({
  runCommand: (...a: unknown[]) => runCommand(...a),
  runCommandAsync: (...a: unknown[]) => runCommandAsync(...a),
}));
vi.mock('@clack/prompts', () => ({
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn(), step: vi.fn() },
}));

const { buildRemote } = await import('../../../src/lib/deploy/remote-build.js');

function transportDropError() {
  // The real shape from linode runs 32614839037/32620565774 — and the real
  // ERROR SHAPE from lib/command.js, which attaches captured output as
  // `.stderr`/`.stdout` on the rejection. The classifier reads exactly those
  // (`err.stderr || '' + err.stdout || ''`), so a fixture that carries the
  // text only in `.message` exercises nothing.
  const err = new Error('docker build exited with code 1') as Error & {
    stderr?: string;
    stdout?: string;
  };
  err.stderr =
    'error during connect: Get "http://docker.example.com/_ping": ' +
    'command [ssh -l root -o ConnectTimeout=30 -T -- 172.233.207.48 docker system dial-stdio] ' +
    'has exited with exit status 255';
  return err;
}

describe('remote-build transport exhaustion diagnostics', () => {
  it('appends the verbose ssh probe outcome to the exhaustion error, and still fails', async () => {
    // probe ssh (attempt 0) succeeds; every docker build rejects as transport drop
    runCommand.mockImplementation((argv: string[]) => {
      if (argv[0] === 'ssh' && argv.includes('-vv')) {
        throw new Error('debug1: kex_exchange_identification: read: Connection reset by peer');
      }
      return 'ready';
    });
    runCommandAsync.mockRejectedValue(transportDropError());

    const errorLog = vi.fn();
    const { log } = await import('@clack/prompts');
    (log.error as ReturnType<typeof vi.fn>).mockImplementation(errorLog);

    const ok = await buildRemote('172.233.207.48', '/tmp/fake-key', 'proj-app:local', '/tmp', {});
    expect(ok, 'diagnostics must not turn a failure into a success').toBe(false);

    const logged = errorLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('[ssh-diag]');
    expect(logged).toContain('Connection reset by peer');
  }, 60_000);

  it('reports a session-specific drop when the verbose probe succeeds', async () => {
    runCommand.mockReturnValue('ready');
    runCommandAsync.mockRejectedValue(transportDropError());

    const errorLog = vi.fn();
    const { log } = await import('@clack/prompts');
    (log.error as ReturnType<typeof vi.fn>).mockImplementation(errorLog);

    const ok = await buildRemote('172.233.207.48', '/tmp/fake-key', 'proj-app:local', '/tmp', {});
    expect(ok).toBe(false);
    const logged = errorLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('build-session-specific');
  }, 60_000);
});
