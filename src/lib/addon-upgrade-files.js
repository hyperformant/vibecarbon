/**
 * The files `vibecarbon upgrade` refreshes for the add-ons a project
 * installed. `vibecarbon add` copies each add-on from the CLI's bundled
 * `services/<name>/` through the add-on's manifest `files` map (a key ending
 * in `/` is a directory, copied file by file); upgrade reads the same map,
 * so an add-on's compose, k8s and volume files move with the CLI the way the
 * template's own files do, under the same safe / merge / never policy
 * (./upgrade-policy.js).
 *
 * Containment. The add-on names come from the project's `.vibecarbon.json`,
 * which a cloned project controls, and the manifest's paths are joined into
 * file paths. So a name counts only when it is a directory in the listing of
 * the bundled services/ dir, every manifest source must resolve inside that
 * add-on's own directory, and every destination must be a relative path
 * that resolves inside the project (no absolute path, no `..` segment).
 * Anything else is left out and reported through `onReject`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix, resolve, sep, win32 } from 'node:path';

/**
 * @typedef {{ relPath: string, sourcePath: string, src: string }} AddonUpgradeEntry
 *   `relPath` is the path in the project; `sourcePath` the bundled file;
 *   `src` its path inside services/<name>/ (what getAddonFilePolicy reads).
 */

/** The add-on directories of the bundled services/ dir, by name. */
function bundledAddonNames(servicesDir) {
  try {
    return new Set(
      readdirSync(servicesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}

function readManifest(servicesDir, name) {
  try {
    return JSON.parse(readFileSync(join(servicesDir, name, 'manifest.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * True when `relPath` is a relative project path that stays inside the
 * project: not empty, not absolute (posix or Windows), and with no `..`
 * segment under either separator. `.` alone (the project root) is refused.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
export function isContainedRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return false;
  if (isAbsolute(relPath) || posix.isAbsolute(relPath) || win32.isAbsolute(relPath)) return false;
  const segments = relPath.split(/[\\/]+/);
  if (segments.includes('..')) return false;
  const normalized = posix.normalize(relPath.replaceAll('\\', '/'));
  return normalized !== '.' && normalized !== './' && normalized !== '';
}

/** `child` resolves strictly inside `root` (never `root` itself). */
function resolvesInside(root, child) {
  const r = resolve(root);
  return resolve(r, child).startsWith(r + sep);
}

/** Every file under `dir`, as posix paths relative to it. */
function filesUnder(dir, prefix = '') {
  let entries;
  try {
    entries = readdirSync(join(dir, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const rel = prefix ? posix.join(prefix, e.name) : e.name;
    return e.isDirectory() ? filesUnder(dir, rel) : [rel];
  });
}

/**
 * The installed add-ons: the services `.vibecarbon.json` records whose name
 * is a directory in the bundled services/ listing and ships a manifest (a
 * record such as `cicd` is configuration, not an add-on). Sorted.
 *
 * @param {{ services?: Record<string, unknown> }} projectConfig
 * @param {string} servicesDir
 * @returns {string[]}
 */
export function installedAddonNames(projectConfig, servicesDir) {
  const bundled = bundledAddonNames(servicesDir);
  return Object.keys(projectConfig?.services ?? {})
    .filter((name) => bundled.has(name))
    .filter((name) => existsSync(join(servicesDir, name, 'manifest.json')))
    .sort();
}

/**
 * One add-on's files, as its manifest maps them. A mapped source that does
 * not exist is left out; a source outside the add-on's directory or a
 * destination outside the project is left out and reported.
 *
 * @param {string} name - a name from the bundled listing
 * @param {string} servicesDir
 * @param {string} projectRoot
 * @param {(why: string) => void} onReject
 * @returns {AddonUpgradeEntry[]}
 */
function addonEntries(name, servicesDir, projectRoot, onReject) {
  const addonDir = join(servicesDir, name);
  const files = readManifest(servicesDir, name)?.files ?? {};
  const out = [];
  const accept = (relPath, sourcePath, fileSrc) => {
    if (!isContainedRelPath(relPath) || !resolvesInside(projectRoot, relPath)) {
      onReject(`${name}: destination ${relPath} is outside the project`);
      return;
    }
    out.push({ relPath, sourcePath, src: fileSrc });
  };
  for (const [src, dest] of Object.entries(files)) {
    if (typeof src !== 'string' || typeof dest !== 'string' || !resolvesInside(addonDir, src)) {
      onReject(`${name}: source ${src} is outside the add-on directory`);
      continue;
    }
    const sourcePath = resolve(addonDir, src);
    if (src.endsWith('/')) {
      for (const rel of filesUnder(sourcePath)) {
        accept(posix.join(dest, rel), join(sourcePath, rel), posix.join(src, rel));
      }
    } else if (existsSync(sourcePath)) {
      accept(dest, sourcePath, src);
    }
  }
  return out;
}

/**
 * The files of every installed add-on, one entry per project path (the first
 * add-on to map a path keeps it). A name absent from the bundled services/
 * listing is refused.
 *
 * @param {{ installed: string[], servicesDir: string, projectRoot: string,
 *   onReject?: (why: string) => void }} args
 * @returns {AddonUpgradeEntry[]}
 */
export function addonUpgradeEntries({ installed, servicesDir, projectRoot, onReject = () => {} }) {
  const bundled = bundledAddonNames(servicesDir);
  const seen = new Set();
  const out = [];
  for (const name of installed) {
    if (!bundled.has(name)) {
      onReject(`${name}: not an add-on this CLI ships`);
      continue;
    }
    for (const entry of addonEntries(name, servicesDir, projectRoot, onReject)) {
      if (seen.has(entry.relPath)) continue;
      seen.add(entry.relPath);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Every project path any bundled add-on maps, installed or not. The add-on is
 * the source of these files: upgrade never takes them from the template,
 * whose copies (carbon/docker-compose.n8n.yml and the like) serve the
 * template's own development stack. Uncontained paths are left out, as in
 * addonUpgradeEntries; containment is judged against a stand-in root, since
 * only the path set matters here.
 *
 * @param {string} servicesDir
 * @returns {Set<string>}
 */
export function addonOwnedPaths(servicesDir) {
  const root = resolve(servicesDir, '..', '.vibecarbon-owned-paths-root');
  return new Set(
    [...bundledAddonNames(servicesDir)].flatMap((n) =>
      addonEntries(n, servicesDir, root, () => {}).map((e) => e.relPath),
    ),
  );
}
