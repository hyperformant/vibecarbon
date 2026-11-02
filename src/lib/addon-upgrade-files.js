/**
 * The files `vibecarbon upgrade` refreshes for the add-ons a project
 * installed. `vibecarbon add` copies each add-on from the CLI's bundled
 * `services/<name>/` through the add-on's manifest `files` map (a key ending
 * in `/` is a directory, copied file by file); upgrade reads the same map,
 * so an add-on's compose, k8s and volume files move with the CLI the way the
 * template's own files do, under the same safe / merge / never policy
 * (./upgrade-policy.js).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/**
 * @typedef {{ relPath: string, sourcePath: string }} AddonUpgradeEntry
 *   `relPath` is the path in the project; `sourcePath` the bundled file.
 */

function readManifest(servicesDir, name) {
  try {
    return JSON.parse(readFileSync(join(servicesDir, name, 'manifest.json'), 'utf-8'));
  } catch {
    return null;
  }
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
 * The installed add-ons: the services `.vibecarbon.json` records that ship a
 * manifest in `servicesDir` (a record such as `cicd` is configuration, not
 * an add-on). Sorted.
 *
 * @param {{ services?: Record<string, unknown> }} projectConfig
 * @param {string} servicesDir
 * @returns {string[]}
 */
export function installedAddonNames(projectConfig, servicesDir) {
  return Object.keys(projectConfig?.services ?? {})
    .filter((name) => existsSync(join(servicesDir, name, 'manifest.json')))
    .sort();
}

/**
 * One add-on's files, as its manifest maps them. A mapped source that does
 * not exist is left out.
 *
 * @param {string} name
 * @param {string} servicesDir
 * @returns {AddonUpgradeEntry[]}
 */
function addonEntries(name, servicesDir) {
  const files = readManifest(servicesDir, name)?.files ?? {};
  const out = [];
  for (const [src, dest] of Object.entries(files)) {
    const sourcePath = join(servicesDir, name, src);
    if (src.endsWith('/')) {
      for (const rel of filesUnder(sourcePath)) {
        out.push({ relPath: posix.join(dest, rel), sourcePath: join(sourcePath, rel) });
      }
    } else if (existsSync(sourcePath)) {
      out.push({ relPath: dest, sourcePath });
    }
  }
  return out;
}

/**
 * The files of every installed add-on, one entry per project path (the first
 * add-on to map a path keeps it).
 *
 * @param {{ installed: string[], servicesDir: string }} args
 * @returns {AddonUpgradeEntry[]}
 */
export function addonUpgradeEntries({ installed, servicesDir }) {
  const seen = new Set();
  const out = [];
  for (const name of installed) {
    for (const entry of addonEntries(name, servicesDir)) {
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
 * template's own development stack.
 *
 * @param {string} servicesDir
 * @returns {Set<string>}
 */
export function addonOwnedPaths(servicesDir) {
  let names = [];
  try {
    names = readdirSync(servicesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return new Set();
  }
  return new Set(names.flatMap((n) => addonEntries(n, servicesDir).map((e) => e.relPath)));
}
