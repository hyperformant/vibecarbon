/**
 * A write into the project goes to `join(projectRoot, relPath)`, and the
 * filesystem follows any symlink on the way: a project (a cloned one
 * included) that turned `k8s/base/observability` or a file into a symlink
 * would have an upgrade write wherever the link points. Writers refuse such
 * a path instead.
 */
import { lstatSync } from 'node:fs';
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
