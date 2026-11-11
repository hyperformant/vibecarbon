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
 *
 * Earlier versions left the deploy bundle (and other dirs with secrets in
 * them) behind on every deploy. sweepStaleSecretTempDirs removes those, once
 * per deploy, in the background.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
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

/**
 * The temp dirs that held secrets, by prefix: what an earlier version (or a
 * killed run) can have left in the OS temp dir. tests/unit/lib/temp-dir-census.test.ts
 * holds every temp-dir prefix in src/ to this list or a stated reason.
 */
export const STALE_SECRET_PREFIXES = Object.freeze([
  // The deploy bundle (deploy/bundle.js): the rendered .env and app.env.
  'vc-deploy-bundle-',
  // The bundle's tarball (deploy/compose/index.js): the same .env.
  'vc-bundle-tar-',
  // A server's .env, pulled down for a merge (deploy/utils.js).
  'vibecarbon-envmerge-',
  // A script run over ssh (ssh.js), which can carry a token.
  'vb-sshscript-',
]);

/** How old a leftover must be before the sweep takes it: no live run is that old. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Remove the secret-bearing temp dirs earlier runs left: each entry of the OS
 * temp dir (one readdir) with a STALE_SECRET_PREFIXES prefix that is a real
 * directory (lstat: a symlink is never followed), owned by this user, and
 * last changed more than 24 h ago. Best effort: an entry that fails is
 * skipped, a sweep that fails stops, and it never rejects. Runs in the
 * background, one removal at a time, so a deploy never waits on it. Reports
 * one line only when it removed something.
 *
 * @param {{ dir?: string, now?: number, uid?: number | null, report?: (line: string) => void }} [opts]
 * @returns {Promise<number>} how many it removed
 */
export async function sweepStaleSecretTempDirs({
  dir = tmpdir(),
  now = Date.now(),
  uid = process.getuid?.() ?? null,
  report = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  // With no user id to compare (null: Windows has no process.getuid), no
  // entry's owner matches, so nothing goes.
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      if (!STALE_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      const path = join(dir, name);
      try {
        const st = await lstat(path);
        if (!st.isDirectory() || st.uid !== uid || now - st.mtimeMs <= STALE_AFTER_MS) continue;
        await rm(path, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Gone already, or not ours to remove: the next deploy looks again.
      }
    }
    if (removed > 0) {
      report(
        `removed ${removed} old vibecarbon temp ${removed === 1 ? 'dir' : 'dirs'} from ${dir}: ` +
          'earlier versions left them there, with deploy secrets in them',
      );
    }
  } catch {
    // Best effort: an unreadable temp dir costs the deploy nothing.
  }
  return removed;
}
