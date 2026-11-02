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
 * following a symlink planted at its path: a symlink there (dangling or not)
 * is refused and left as it is, a plain old sidecar is unlinked first, and
 * the write is an exclusive create (`wx`), so a link created in between
 * fails the write instead of redirecting it.
 *
 * @param {string} path
 * @param {string} content
 * @returns {boolean} false when the path is (or became) a symlink
 */
export function writeSidecar(path, content) {
  let stat = null;
  try {
    stat = lstatSync(path);
  } catch {
    stat = null;
  }
  if (stat?.isSymbolicLink()) return false;
  if (stat) unlinkSync(path);
  try {
    writeFileSync(path, content, { flag: 'wx' });
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
  return true;
}

/** True when `path` exists as a symlink (dangling or not). */
export function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
