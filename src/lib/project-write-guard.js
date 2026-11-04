/**
 * A write into the project goes to `join(projectRoot, relPath)`, and the
 * filesystem follows any symlink on the way: a project (a cloned one
 * included) that turned `k8s/base/observability` or a file into a symlink
 * would have an upgrade write wherever the link points. Writers refuse such
 * a path instead.
 */
import { lstatSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The first component of `relPath` (a directory on the way, or the file
 * itself) that is a symlink in `projectRoot`, as a project-relative path, or
 * null when there is none. A component that does not exist yet is no
 * symlink, and nothing below it can be one.
 *
 * @param {string} projectRoot
 * @param {string} relPath - a contained, project-relative path
 * @returns {string|null}
 */
export function symlinkedComponent(projectRoot, relPath) {
  const parts = relPath.split(/[\\/]+/).filter((s) => s && s !== '.');
  for (let i = 1; i <= parts.length; i++) {
    const rel = parts.slice(0, i).join('/');
    let stat;
    try {
      stat = lstatSync(join(projectRoot, rel));
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return rel;
  }
  return null;
}

/**
 * Write an upgrade sidecar (`.upgrade-backup`, `.upgrade-new`) without
 * following a symlink planted at its path: anything there but a plain file
 * (a symlink, dangling or not, or a directory) is refused and left as it
 * is, a plain old sidecar is unlinked first, and
 * the write is an exclusive create (`wx`), so a link created in between
 * fails the write instead of redirecting it.
 *
 * @param {string} path
 * @param {string} content
 * @returns {boolean} false when the path holds (or came to hold) something
 *   other than a plain file
 */
export function writeSidecar(path, content) {
  let stat = null;
  try {
    stat = lstatSync(path);
  } catch {
    stat = null;
  }
  if (stat && !stat.isFile()) return false;
  if (stat) unlinkSync(path);
  try {
    writeFileSync(path, content, { flag: 'wx' });
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
  return true;
}

/**
 * True when `path` exists as something writeSidecar refuses: anything but a
 * plain file (a symlink, dangling or not, a directory).
 */
export function sidecarBlocked(path) {
  try {
    return !lstatSync(path).isFile();
  } catch {
    return false;
  }
}
