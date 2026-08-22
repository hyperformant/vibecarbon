/**
 * Deterministic content digest of a directory tree.
 *
 * Deploy step-skip gates (state.js) hash a small set of coarse inputs — image
 * ref, domain, service toggles — to decide whether a step can be skipped on a
 * resumed/warm redeploy. Those inputs are blind to the *contents* of the files a
 * step ships: editing e.g. `docker-compose.observability.yml` or a k8s manifest
 * leaves image ref/domain/toggles unchanged, so the gate wrongly skips the
 * upload/apply and the change silently never reaches the server (prod bug
 * 2026-07-11). Folding this digest into a step's gate inputs closes that gap.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Walk `dir` recursively and fold every regular file's relative path + byte
 * content into one sha256. Entries are sorted by their POSIX-normalized relative
 * path so the result is independent of readdir order and stable across OSes.
 * Symlinks and special files are ignored (bundles/manifests contain neither).
 *
 * A missing or unreadable directory yields the digest of the empty set rather
 * than throwing — callers use this purely as a change signal, and "no dir" is a
 * legitimate, stable state.
 *
 * @param {string} dir Absolute path to the directory to digest.
 * @returns {string} Hex-encoded sha256.
 */
export function digestDir(dir) {
  const hash = createHash('sha256');
  /** @type {{ abs: string, rel: string }[]} */
  let files;
  try {
    files = collectFiles(dir, dir);
  } catch {
    return hash.digest('hex');
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const f of files) {
    // NUL separators so { "a", "b/c" } and { "a/b", "c" } can't collide.
    hash.update(f.rel);
    hash.update('\0');
    hash.update(readFileSync(f.abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Deterministic digest of an EXPLICIT set of root-relative paths, each of which
 * may be a file or a directory.
 *
 * `digestDir` is the right tool when a step ships a whole tree (a rendered
 * bundle, a manifest directory). It's the wrong tool when the thing a step
 * consumes is a hand-picked subset of a much larger tree — digesting the whole
 * project directory to watch the app image's build context would fold in
 * `.vibecarbon/deploy-state-<env>.json`, which THIS deploy rewrites on every
 * step transition, so the gate would bust on every single run and turn the
 * most expensive step in the deploy into an unconditional one.
 *
 * Paths are de-duplicated and sorted, so the result is independent of the
 * caller's ordering. A missing path contributes a stable "absent" marker rather
 * than throwing: a path that is absent on both runs must not bust the gate, and
 * one that appears or disappears must.
 *
 * @param {string} root Absolute path the entries are relative to.
 * @param {string[]} relPaths Root-relative file or directory paths.
 * @returns {string} Hex-encoded sha256.
 */
export function digestPaths(root, relPaths) {
  const hash = createHash('sha256');
  for (const rel of [...new Set(relPaths)].sort()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(digestEntry(join(root, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Digest one path, tagged with its kind. The `d:`/`f:` prefixes keep an empty
 * directory from colliding with an empty file at the same path (both hash the
 * empty byte string otherwise).
 *
 * @returns {string}
 */
function digestEntry(abs) {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return 'absent';
  }
  if (st.isDirectory()) return `d:${digestDir(abs)}`;
  if (!st.isFile()) return 'absent';
  try {
    return `f:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`;
  } catch {
    return 'absent';
  }
}

/**
 * Junk that an OS or a VCS drops into a working tree and that `npm pack`
 * always strips from the published package. Digesting it means a dev clone and
 * an installed CLI compute different digests for byte-identical manifests — a
 * one-time false bust of the gate (harmless, since a re-apply is idempotent,
 * but confusing) purely because someone opened a folder in Finder.
 *
 * NOT "every dotfile": the rendered compose bundle digested by
 * `compose-setup-files` contains `.env`, whose content changing is precisely
 * what must bust that gate. Only the always-stripped junk classes are excluded.
 */
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.directory']);
const JUNK_DIRS = new Set(['.git', '.hg', '.svn', 'CVS', 'node_modules']);
/** AppleDouble sidecars (`._foo`) and editor swapfiles. */
const JUNK_FILE_PATTERN = /^\._|\.sw[po]$|~$/;

/** @returns {{ abs: string, rel: string }[]} */
function collectFiles(root, dir) {
  /** @type {{ abs: string, rel: string }[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (JUNK_DIRS.has(entry.name)) continue;
      out.push(...collectFiles(root, abs));
    } else if (entry.isFile()) {
      if (JUNK_FILES.has(entry.name) || JUNK_FILE_PATTERN.test(entry.name)) continue;
      out.push({ abs, rel: relative(root, abs).split(sep).join('/') });
    }
  }
  return out;
}
