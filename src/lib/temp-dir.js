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
 * Earlier versions left the deploy bundle (and other dirs and files with
 * secrets in them) behind on every deploy. startStaleSecretSweep removes
 * those, once per deploy, in the background.
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
  // A Pulumi state import (iac/index.js importStackState): the whole
  // deployment with every secret in plain text, a provider token among them.
  'vc-state-import-',
]);

/**
 * Secret-bearing temp names that released versions made and src/ no longer
 * does, each with the versions that made it and its shape: a dir by prefix,
 * or a file by its exact name pattern. The census
 * (tests/unit/lib/temp-dir-census.test.ts) takes an entry here only with its
 * version range.
 *
 * @type {ReadonlyArray<Readonly<{shape: 'dir', prefix: string, versions: string, held: string}
 *   | {shape: 'file', name: RegExp, versions: string, held: string}>>}
 */
export const LEGACY_SECRET_TEMP = Object.freeze([
  Object.freeze({
    shape: 'dir',
    prefix: 'vibecarbon-repl-',
    versions: 'up to v0.50.1',
    held: 'primary-init.sql with the k8s-ha replication password, while it was copied to the primary',
  }),
  Object.freeze({
    shape: 'file',
    // The old k8s deploy's values file, vibecarbon-<stack>-values-<pid>-<ms>.yaml.
    // The stack's name is a retired word (tests/unit/lib/terminology-census.test.ts),
    // so the pattern takes any word there; no other file of this shape was made.
    name: /^vibecarbon-[a-z]+-values-\d+-\d+\.yaml$/,
    versions: 'up to v0.49.0',
    held: 'the Helm values with the admin password, for the whole `helm upgrade --wait`',
  }),
  Object.freeze({
    shape: 'file',
    name: /^vc-deploy-[a-z0-9-]+-[0-9A-Za-z_]+-\d+-[0-9a-f]{12}\.tar\.gz$/,
    versions: 'up to v0.52.0',
    held: "the deploy bundle's tarball with the app's .env, which tar made readable by every local user under the usual umask",
  }),
]);

/** How old a leftover must be before the sweep takes it: no live run is that old. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * What a temp dir entry named `name` is, if it is one the stale sweep takes:
 * 'dir' for a secret-bearing dir prefix (current or legacy), 'file' for a
 * legacy file name, null for anything else.
 * @param {string} name
 * @returns {'dir' | 'file' | null}
 */
function staleShape(name) {
  if (STALE_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'dir';
  for (const entry of LEGACY_SECRET_TEMP) {
    if (entry.shape === 'dir' ? name.startsWith(entry.prefix) : entry.name.test(name)) {
      return entry.shape;
    }
  }
  return null;
}

/**
 * Remove the secret-bearing temp dirs and files earlier runs left: each entry
 * of the OS temp dir (one readdir) that staleShape names, of exactly that
 * shape (lstat: a dir must be a real directory, a file a regular file, and a
 * symlink is never followed), owned by this user, and last changed more than
 * 24 h ago. Best effort: an entry that fails is skipped, a sweep that fails
 * stops, and it never rejects. One removal at a time, and it prints nothing:
 * startStaleSecretSweep holds its line for a quiet point.
 *
 * @param {{ dir?: string, now?: number, uid?: number | null }} [opts]
 * @returns {Promise<{dir: string, dirs: number, files: number}>} what it removed
 */
export async function sweepStaleSecretTempDirs({
  dir = tmpdir(),
  now = Date.now(),
  uid = process.getuid?.() ?? null,
} = {}) {
  // With no user id to compare (null: Windows has no process.getuid), no
  // entry's owner matches, so nothing goes.
  const removed = { dir, dirs: 0, files: 0 };
  try {
    for (const name of await readdir(dir)) {
      const shape = staleShape(name);
      if (!shape) continue;
      const path = join(dir, name);
      try {
        const st = await lstat(path);
        const isShape = shape === 'dir' ? st.isDirectory() : st.isFile();
        if (!isShape || st.uid !== uid || now - st.mtimeMs <= STALE_AFTER_MS) continue;
        await rm(path, { recursive: shape === 'dir', force: true });
        if (shape === 'dir') removed.dirs += 1;
        else removed.files += 1;
      } catch {
        // Gone already, or not ours to remove: the next deploy looks again.
      }
    }
  } catch {
    // Best effort: an unreadable temp dir costs the deploy nothing.
  }
  return removed;
}

/**
 * The one line a stale sweep prints, or null when it removed nothing.
 * @param {{dir: string, dirs: number, files: number}} removed
 * @returns {string | null}
 */
export function staleSweepLine({ dir, dirs, files }) {
  const total = dirs + files;
  if (total === 0) return null;
  const plural = (n, noun) => (n === 1 ? noun : `${noun}s`);
  const what =
    dirs > 0 && files > 0
      ? `${dirs} old vibecarbon temp ${plural(dirs, 'dir')} and ${files} ${plural(files, 'file')}`
      : dirs > 0
        ? `${dirs} old vibecarbon temp ${plural(dirs, 'dir')}`
        : `${files} old vibecarbon temp ${plural(files, 'file')}`;
  const why =
    total === 1
      ? 'an earlier run left it, and it can hold deploy secrets'
      : 'earlier runs left them, and they can hold deploy secrets';
  return `removed ${what} from ${dir}: ${why}`;
}

/**
 * Start the stale sweep in the background, so a deploy never waits on it,
 * and hold its line for a quiet point: a line written while a spinner
 * animates breaks the spinner's line (progress.js). The deploy prints it
 * with `flush` before its outro. A process that exits first (a failed
 * deploy, a Ctrl-C) prints it on its way out, on a line of its own.
 *
 * @param {{ dir?: string, now?: number, uid?: number | null,
 *   proc?: { once: Function, off: Function } | null,
 *   write?: (text: string) => void }} [opts]
 *   `proc`: where the exit print hooks in; null (the default under vitest,
 *   like the deploy completion guard) hooks nothing.
 * @returns {{ flush: (print: (line: string) => void) => Promise<void> }}
 */
export function startStaleSecretSweep({
  proc = process.env.VITEST ? null : process,
  write = (text) => process.stderr.write(text),
  ...sweepOpts
} = {}) {
  let line = null;
  const atExit = () => {
    const pending = line;
    line = null;
    if (pending) write(`\n${pending}\n`);
  };
  const settled = sweepStaleSecretTempDirs(sweepOpts).then((removed) => {
    line = staleSweepLine(removed);
    if (line) proc?.once('exit', atExit);
  });
  return {
    async flush(print) {
      await settled;
      proc?.off('exit', atExit);
      const pending = line;
      line = null;
      if (pending) print(pending);
    },
  };
}
