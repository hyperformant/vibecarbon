/**
 * The process's own temp dirs. Every temp dir src/ makes comes from here
 * (tests/unit/lib/temp-dir-census.test.ts), because some of them hold
 * secrets: the deploy bundle carries the app's .env, a merged remote .env
 * passes through one, and a script can carry a token.
 *
 * Its owner removes a dir when the work is done (withTempDir does it for
 * you). Whatever is still live when the process exits goes in the exit sweep:
 * that is the only cleanup a Ctrl-C reaches, since cli.js answers SIGINT with
 * process.exit(130) and no finally block runs. A kill that skips exit
 * handlers (SIGKILL, a terminal hang-up) still leaves a dir behind.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Dirs made here and not yet removed. */
const live = new Set();

/** The exit listener: on the process only while a dir is live. */
const onExit = () => sweepTempDirs();

/**
 * Make a private (0700) temp dir, in the OS temp dir or under `parent`.
 *
 * @param {string} prefix - the dir name's start, e.g. 'vc-deploy-bundle-'
 * @param {{ parent?: string }} [opts]
 * @returns {string} the dir's path
 */
export function makeTempDir(prefix, { parent = tmpdir() } = {}) {
  const dir = mkdtempSync(join(parent, prefix));
  if (live.size === 0) process.on('exit', onExit);
  live.add(dir);
  return dir;
}

/**
 * Remove a temp dir and everything in it. Never throws: it runs in finally
 * blocks, where a throw would replace the error that got there. A dir that
 * cannot be removed stays live, so the exit sweep tries it again and names it.
 *
 * @param {string} dir
 */
export function removeTempDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    return;
  }
  live.delete(dir);
  if (live.size === 0) process.off('exit', onExit);
}

/**
 * Run `fn` with a fresh temp dir, and remove it once `fn` settles.
 *
 * @template T
 * @param {string} prefix
 * @param {(dir: string) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withTempDir(prefix, fn) {
  const dir = makeTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    removeTempDir(dir);
  }
}

/**
 * withTempDir for synchronous work.
 *
 * @template T
 * @param {string} prefix
 * @param {(dir: string) => T} fn
 * @returns {T}
 */
export function withTempDirSync(prefix, fn) {
  const dir = makeTempDir(prefix);
  try {
    return fn(dir);
  } finally {
    removeTempDir(dir);
  }
}

/**
 * Remove every live temp dir: the process 'exit' listener. A dir that cannot
 * be removed is named, since it may hold secrets.
 *
 * @param {{ report?: (line: string) => void }} [opts]
 */
export function sweepTempDirs({ report = (line) => process.stderr.write(line) } = {}) {
  for (const dir of live) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      report(
        `vibecarbon could not remove its temp dir ${dir} (${err?.code ?? err?.message ?? err}). ` +
          'It may hold deploy secrets, so delete it yourself.\n',
      );
    }
  }
  live.clear();
  process.off('exit', onExit);
}
