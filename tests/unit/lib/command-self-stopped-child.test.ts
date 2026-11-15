/**
 * A child that runCommandAsync stopped itself (its caller's abort signal, or
 * its own timeout) is never read as the operator's Ctrl-C.
 *
 * runCommandAsync exits the whole CLI with 130 when a child ends with SIGINT
 * or exit code 130, because that is what a Ctrl-C looks like from a child.
 * But docker 29's CLI also exits 130 when it gets SIGTERM, which is how an
 * abort or a timeout stops a child. GitHub run 43689099038
 * (digitalocean/k8s-ha): the primary's `pulumi up` failed (DigitalOcean 422,
 * size not available), the deploy reaped its own background `docker build`,
 * docker exited 130, and the CLI exited at once. That killed the standby's
 * `pulumi up` while it was creating droplets, so they never reached state and
 * the final destroy could not delete the standby VPC ("Can not delete VPC with
 * members"). The readable size message never printed either.
 *
 * The child below does what docker does: exit 130 on SIGTERM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommandAsync } from '../../../src/lib/command.js';

const EXITS_130_ON_SIGTERM = [
  process.execPath,
  '-e',
  [
    "process.on('SIGTERM', () => { process.stdout.write('vc-stopped'); process.exit(130); });",
    "process.stdout.write('vc-ready\\n');",
    'setInterval(() => {}, 1000);',
  ].join(' '),
];

/** Resolves once the 'close' handler has run to its end. */
function closeWatch() {
  let seen!: () => void;
  const stopped = new Promise<void>((resolve) => {
    seen = resolve;
  });
  return {
    // 'vc-stopped' has no newline, so the 'close' handler delivers it; the
    // exit check runs in the same synchronous pass, done by the next tick.
    onLine: (line: string, onReady?: () => void) => {
      if (line === 'vc-ready') onReady?.();
      if (line === 'vc-stopped') seen();
    },
    closed: () => stopped.then(() => new Promise((r) => setTimeout(r, 20))),
  };
}

describe('runCommandAsync: a child it stopped itself is not a Ctrl-C', () => {
  let exit: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('an aborted child that exits 130 rejects, and the CLI keeps running', async () => {
    const ac = new AbortController();
    const watch = closeWatch();
    const run = runCommandAsync(EXITS_130_ON_SIGTERM, {
      silent: true,
      signal: ac.signal,
      onStdoutLine: (line: string) => watch.onLine(line, () => ac.abort()),
    });
    await expect(run).rejects.toThrow(/abort/i);
    await watch.closed();
    expect(exit).not.toHaveBeenCalled();
  });

  it('a timed-out child that exits 130 rejects as a timeout, and the CLI keeps running', async () => {
    const watch = closeWatch();
    const run = runCommandAsync(EXITS_130_ON_SIGTERM, {
      silent: true,
      timeout: 300,
      onStdoutLine: (line: string) => watch.onLine(line),
    });
    await expect(run).rejects.toMatchObject({ timedOut: true, status: 130 });
    await watch.closed();
    expect(exit).not.toHaveBeenCalled();
  });

  it('a child that exits 130 on its own still exits the CLI with 130', async () => {
    const run = runCommandAsync([process.execPath, '-e', 'process.exit(130)'], { silent: true });
    // With process.exit stubbed, the handler goes on to reject as a failure.
    await run.catch(() => {});
    expect(exit).toHaveBeenCalledWith(130);
  });
});
