/**
 * Run a `vibecarbon` step (a step from the `?` "what's next" ladder, e.g.
 * `['up']` or `['create', 'my-app']`) as a child process that inherits the
 * terminal, exactly as if the user had typed it themselves.
 *
 * This module (like the rest of src/lib/next/) is a pure library: it never
 * prints or prompts. src/next.js decides what to run and what to show for
 * the result.
 *
 * Why the signal handoff: `src/cli.js` (line 111) registers
 * `process.on('SIGINT', () => process.exit(130))`, and `src/lib/command.js`
 * (lines 44-45) registers its own immediate-exit SIGINT/SIGTERM handlers.
 * Both exist so a CLI wedged in a retry loop dies on Ctrl+C. But when the
 * wizard is running a step as a child, the wizard itself is not doing the
 * work; the child is, and it needs the chance to shut down cleanly (for
 * example `docker compose down` under `up`'s own shutdown path) before this
 * process exits. If the wizard's inherited handlers fired first, they would
 * call `process.exit()` immediately and orphan the child mid-shutdown. So
 * for the lifetime of the child, launchCli parks every listener already
 * registered for SIGINT and SIGTERM, installs its own, and puts the saved
 * listeners back (in their original registration order) the instant the
 * child closes or fails to spawn. This generalizes `waitForDevTree`
 * (src/up.js:414-437), which does the same thing for `up`'s single
 * dev-server child.
 *
 * The terminal already delivers Ctrl+C to the whole foreground process
 * group, so on SIGINT the child sees it without any help from us; the only
 * thing launchCli must do is not tear itself down before the child is done.
 * SIGTERM is different: it reaches only this process (e.g. a `kill`), so it
 * is forwarded to the child explicitly. Either signal arms a one-shot grace
 * timer that SIGKILLs the child after `graceMs`, so a wedged child cannot
 * hold the terminal hostage forever. That timer is `unref()`'d so it never
 * by itself keeps this process (or a test) alive, and is cleared the moment
 * the child closes.
 *
 * `proc` is injectable (defaults to the real `process`) so tests can pass a
 * fake EventEmitter with an `execPath` property instead of touching the
 * real process's signal listeners. Only `proc.listeners`,
 * `proc.removeAllListeners`, `proc.on` and `proc.execPath` are used, all of
 * which a plain EventEmitter-plus-`execPath` fake can provide.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of src/cli.js, resolved relative to this module so it works
 * both from source and from an installed package.
 * @returns {string}
 */
export function cliEntryPath() {
  return fileURLToPath(new URL('../../cli.js', import.meta.url));
}

/**
 * Run `vibecarbon <argv...>` as a child that inherits the terminal, exactly
 * as if the user had typed it. Resolves when the child closes.
 *
 * @param {string[]} argv
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   spawn?: typeof nodeSpawn,
 *   proc?: NodeJS.Process,
 *   graceMs?: number,
 * }} [options]
 * @returns {Promise<{ code: number|null, signal: string|null }>}
 */
export function launchCli(
  argv,
  {
    cwd = process.cwd(),
    env = process.env,
    spawn = nodeSpawn,
    proc = process,
    graceMs = 10_000,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const savedSigint = proc.listeners('SIGINT');
    const savedSigterm = proc.listeners('SIGTERM');
    proc.removeAllListeners('SIGINT');
    proc.removeAllListeners('SIGTERM');

    const child = spawn(proc.execPath, [cliEntryPath(), ...argv], { cwd, env, stdio: 'inherit' });

    let graceTimer = null;
    const armGrace = () => {
      if (graceTimer) return;
      graceTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
      graceTimer.unref();
    };

    const onSigint = () => {
      // The tty already delivered Ctrl+C to the whole foreground group, so
      // the child has it too; just bound how long we wait for it.
      armGrace();
    };
    const onSigterm = () => {
      // SIGTERM reaches only this process, so forward it explicitly.
      child.kill('SIGTERM');
      armGrace();
    };
    proc.on('SIGINT', onSigint);
    proc.on('SIGTERM', onSigterm);

    const restore = () => {
      if (graceTimer) clearTimeout(graceTimer);
      proc.removeAllListeners('SIGINT');
      proc.removeAllListeners('SIGTERM');
      for (const listener of savedSigint) proc.on('SIGINT', listener);
      for (const listener of savedSigterm) proc.on('SIGTERM', listener);
    };

    child.on('close', (code, signal) => {
      restore();
      resolve({ code, signal });
    });

    child.on('error', (err) => {
      restore();
      reject(err);
    });
  });
}
