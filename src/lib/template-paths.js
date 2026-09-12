/**
 * Template-path renames: files whose PROJECT name npm refuses to pack.
 *
 * npm's packer drops a fixed set of basenames from every tarball no matter
 * what package.json `files` or .npmignore say — `.gitignore` among them. So
 * carbon/ cannot ship a file literally named `.gitignore`: from the first
 * public release through 0.43.0 it silently did not, and `vibecarbon create`
 * from the npm package aborted on its own .gitignore security check while
 * every test tier (which runs src/cli.js from the git checkout) stayed green.
 *
 * The template therefore stores such files under a name npm keeps, and the
 * two template readers (create's copyTemplate / copyTemplateDir, upgrade's
 * resolveTemplate + getUpgradeableFiles) translate at the boundary. Callers
 * keep using the PROJECT name; only the on-disk template name differs.
 *
 * Basename-keyed so a rename applies at any depth of the template tree.
 * tests/integration/packaging/tarball-ships-template.test.ts proves every
 * tracked template file actually lands in the tarball.
 */

import { basename, dirname, join } from 'node:path';

/** project basename -> template basename */
export const TEMPLATE_RENAMES = Object.freeze({
  '.gitignore': '_gitignore',
});

const PROJECT_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(TEMPLATE_RENAMES).map(([p, t]) => [t, p])),
);

function swapBasename(relPath, table) {
  const name = basename(relPath);
  const mapped = table[name];
  if (!mapped) return relPath;
  const dir = dirname(relPath);
  return dir === '.' ? mapped : join(dir, mapped);
}

/**
 * Where the template stores the file a project knows as `projectRelPath`.
 * @param {string} projectRelPath
 * @returns {string}
 */
export function templatePathFor(projectRelPath) {
  return swapBasename(projectRelPath, TEMPLATE_RENAMES);
}

/**
 * What a project calls the template file at `templateRelPath`.
 * @param {string} templateRelPath
 * @returns {string}
 */
export function projectPathFor(templateRelPath) {
  return swapBasename(templateRelPath, PROJECT_NAMES);
}
