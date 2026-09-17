import { type ChildProcess, spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForDevTree } from '../../../src/up.js';

/**
 * `vibecarbon up` is the shell's foreground job. If it exits on Ctrl+C before
 * its `npm run dev:start` → dev.js child has finished shutting down, the
 * prompt comes back mid-shutdown and the API's last log lines print over it
 * (tsx's spinner even clears the line) — which reads as a hang and invites a
 * second Ctrl+C. These tests pin the contract: stay alive until the child has
 * closed, then exit with its code; never sooner, and not forever either.
 */
describe('waitForDevTree', () => {
  let savedSigint: NodeJS.SignalsListener[];
  let savedSigterm: NodeJS.SignalsListener[];
  let child: ChildProcess | undefined;

  const node = (script: string) => spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeEach(() => {
    // waitForDevTree replaces the process-wide SIGINT/SIGTERM listeners; put
    // vitest's own back afterwards.
    savedSigint = process.listeners('SIGINT') as NodeJS.SignalsListener[];
    savedSigterm = process.listeners('SIGTERM') as NodeJS.SignalsListener[];
  });

  afterEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    for (const l of savedSigint) process.on('SIGINT', l);
    for (const l of savedSigterm) process.on('SIGTERM', l);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child = undefined;
  });

  it('does not exit on Ctrl+C until the child has closed, then exits with its code', async () => {
    const exit = vi.fn();
    // Child: keep going 300ms after SIGINT would have arrived, then exit 0 —
    // like dev.js waiting on the API's graceful shutdown.
    child = node('setTimeout(() => process.exit(0), 300)');
    waitForDevTree(child, { exit });

    process.emit('SIGINT');
    await tick(50);
    expect(exit).not.toHaveBeenCalled();

    await new Promise((r) => child?.once('close', r));
    await tick(0);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("replaces cli.js's exit-immediately SIGINT handler", async () => {
    const cliHandler = vi.fn(); // stand-in for cli.js's `() => process.exit(130)`
    process.on('SIGINT', cliHandler);
    child = node('setTimeout(() => process.exit(0), 100)');
    waitForDevTree(child, { exit: vi.fn() });

    process.emit('SIGINT');
    expect(cliHandler).not.toHaveBeenCalled();
    await new Promise((r) => child?.once('close', r));
  });

  it('gives up with 130 if the child is still around long after Ctrl+C', async () => {
    const exit = vi.fn();
    child = node('setInterval(() => {}, 1000)'); // never exits
    waitForDevTree(child, { exit, graceMs: 200 });

    process.emit('SIGINT');
    await tick(50);
    expect(exit).not.toHaveBeenCalled();
    await tick(300);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('forwards SIGTERM to the child (the tty only delivers Ctrl+C) and waits for it', async () => {
    const exit = vi.fn();
    child = node("process.on('SIGTERM', () => process.exit(7)); setInterval(() => {}, 1000)");
    waitForDevTree(child, { exit });
    await tick(300); // let the child install its handler

    process.emit('SIGTERM');
    await new Promise((r) => child?.once('close', r));
    await tick(0);
    expect(exit).toHaveBeenCalledWith(7);
  });
});
