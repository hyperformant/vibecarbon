import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliEntryPath, launchCli } from '../../../../src/lib/next/launch.js';

/**
 * `launchCli` hands a wizard-driven step (e.g. `['up']`) off to a real child
 * `vibecarbon` process that inherits the terminal, generalizing the
 * SIGINT/SIGTERM handoff `waitForDevTree` (src/up.js) does for `vibecarbon
 * up`'s dev-server child. These tests pin: the child's exit is reported
 * faithfully, Ctrl+C does not resolve early or kill the wizard's own process,
 * the wizard's pre-existing signal listeners come back afterward in order,
 * the exact spawn arguments, and a grace-timeout SIGKILL for a child that
 * ignores SIGTERM.
 */
describe('launchCli', () => {
  let child: ChildProcess | undefined;

  // The injected `spawn` ignores the args launchCli builds and instead runs
  // a small script, so real-child tests can control exit code / signal
  // handling without needing cli.js itself to behave a particular way.
  const scriptSpawn = (script: string) => () => {
    child = nodeSpawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    return child;
  };
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child = undefined;
  });

  describe('cliEntryPath', () => {
    it('resolves to an absolute src/cli.js that exists on disk', () => {
      const path = cliEntryPath();
      expect(path.endsWith('/src/cli.js')).toBe(true);
      expect(existsSync(path)).toBe(true);
    });
  });

  it('resolves with the child exit code (0)', async () => {
    const result = await launchCli(['up'], {
      spawn: scriptSpawn('process.exit(0)'),
      proc: new EventEmitter() as unknown as NodeJS.Process,
    });
    expect(result).toEqual({ code: 0, signal: null });
  });

  it('resolves with the child exit code (3)', async () => {
    const result = await launchCli(['up'], {
      spawn: scriptSpawn('process.exit(3)'),
      proc: new EventEmitter() as unknown as NodeJS.Process,
    });
    expect(result).toEqual({ code: 3, signal: null });
  });

  it('populates signal when the child is killed', async () => {
    const fakeProc = new EventEmitter() as unknown as NodeJS.Process;
    const resultPromise = launchCli(['up'], {
      spawn: scriptSpawn('setInterval(() => {}, 1000)'),
      proc: fakeProc,
    });
    await tick(100); // let the child actually start
    child?.kill('SIGKILL');
    const result = await resultPromise;
    expect(result.code).toBeNull();
    expect(result.signal).toBe('SIGKILL');
  });

  it('does not resolve early or throw when SIGINT arrives while the child runs', async () => {
    const fakeProc = new EventEmitter() as unknown as NodeJS.Process;
    const resolved = vi.fn();
    const resultPromise = launchCli(['up'], {
      spawn: scriptSpawn('setTimeout(() => process.exit(0), 300)'),
      proc: fakeProc,
    }).then(resolved);

    fakeProc.emit('SIGINT');
    await tick(50);
    expect(resolved).not.toHaveBeenCalled();

    await resultPromise;
    expect(resolved).toHaveBeenCalledWith({ code: 0, signal: null });
  });

  it('restores listeners registered before the call, in original order, after close', async () => {
    const fakeProc = new EventEmitter() as unknown as NodeJS.Process;
    const first = () => {};
    const second = () => {};
    fakeProc.on('SIGINT', first);
    fakeProc.on('SIGINT', second);
    const thirdTerm = () => {};
    fakeProc.on('SIGTERM', thirdTerm);

    await launchCli(['up'], {
      spawn: scriptSpawn('process.exit(0)'),
      proc: fakeProc,
    });

    expect(fakeProc.listeners('SIGINT')).toEqual([first, second]);
    expect(fakeProc.listeners('SIGTERM')).toEqual([thirdTerm]);
  });

  it('passes the exact spawn arguments: execPath, [cliEntryPath(), ...argv], cwd/env/stdio', async () => {
    const fakeChild = new EventEmitter() as unknown as ChildProcess;
    const spawn = vi.fn(() => fakeChild);
    const fakeProc = Object.assign(new EventEmitter(), {
      execPath: '/fake/node',
    }) as unknown as NodeJS.Process;
    const env = { FOO: 'bar' };

    const resultPromise = launchCli(['up', 'my-app'], {
      cwd: '/fake/cwd',
      env,
      spawn,
      proc: fakeProc,
    });
    fakeChild.emit('close', 0, null);
    await resultPromise;

    expect(spawn).toHaveBeenCalledWith('/fake/node', [cliEntryPath(), 'up', 'my-app'], {
      cwd: '/fake/cwd',
      env,
      stdio: 'inherit',
    });
  });

  it('SIGKILLs a child that ignores SIGTERM after the grace timer elapses', async () => {
    const fakeProc = new EventEmitter() as unknown as NodeJS.Process;
    const resultPromise = launchCli(['up'], {
      spawn: scriptSpawn("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"),
      proc: fakeProc,
      graceMs: 150,
    });
    await tick(100); // let the child install its SIGTERM trap

    fakeProc.emit('SIGTERM');
    const result = await resultPromise;
    expect(result.signal).toBe('SIGKILL');
  });
});
