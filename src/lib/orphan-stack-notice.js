/**
 * The short warning `create`, `up`, and `status` print when a local
 * vibecarbon stack has outlived its project folder. Best-effort: a docker
 * failure means no warning, never an error.
 */

import * as p from '@clack/prompts';
import { findOrphanStacks, formatStackPath, listVibecarbonStacks } from './local-stacks.js';

/**
 * @param {Array<{ project: string, workingDir: string }>} orphans
 * @param {{ home?: string }} [options]
 * @returns {string[] | null} lines to print, or null when there is nothing to say
 */
export function formatOrphanNotice(orphans, { home } = {}) {
  if (!orphans || orphans.length === 0) return null;
  const list = orphans
    .map((o) => `${o.project} (${formatStackPath(o.workingDir, home)})`)
    .join(', ');
  const head =
    orphans.length === 1
      ? `found a local stack whose project folder is gone: ${list}`
      : `found ${orphans.length} local stacks whose project folders are gone: ${list}`;
  return [
    head,
    'if you moved a project, run `vibecarbon up` in its new folder to pick it back up',
    'otherwise `vibecarbon down -orphans` removes them',
  ];
}

/**
 * @param {{ exclude?: string[], list?: () => any[], find?: typeof findOrphanStacks, log?: { warn: (m: string) => void, info: (m: string) => void } }} [options]
 */
export function warnAboutOrphanStacks({
  exclude = [],
  list = listVibecarbonStacks,
  find = findOrphanStacks,
  log = p.log,
} = {}) {
  try {
    const orphans = find(list()).filter((o) => !exclude.includes(o.project));
    const lines = formatOrphanNotice(orphans);
    if (!lines) return;
    log.warn(lines[0]);
    for (const hint of lines.slice(1)) log.info(hint);
  } catch {
    // best-effort
  }
}
