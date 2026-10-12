/**
 * Every vibecarbon compose stack on this Docker host, read from the labels
 * Compose stamps on each container, and which of them have lost the folder
 * they were started from.
 *
 * A project folder deleted, moved, or renamed while its stack existed leaves
 * `unless-stopped` containers Docker restarts at every boot. It auto-creates
 * each missing bind-mount source as an empty directory, the db dies, and the
 * services that need it crash-loop forever (2026-10-12: three weeks, 2,000+
 * restarts, Chrome ERR_NETWORK_CHANGED from interface churn).
 *
 * Read-only and best-effort: any docker failure means "no stacks".
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const NETWORK_SUFFIX = '_vibecarbon-network';
const PROJECT_LABEL = 'com.docker.compose.project';
const DIR_LABEL = 'com.docker.compose.project.working_dir';
const FILES_LABEL = 'com.docker.compose.project.config_files';

/**
 * @param {{ execFile?: typeof execFileSync, timeoutMs?: number }} [options]
 * @returns {Array<{ project: string, workingDir: string, configFiles: string[], containers: Array<{ name: string, state: string }> }>}
 */
export function listVibecarbonStacks({ execFile = execFileSync, timeoutMs = 3000 } = {}) {
  const opts = { encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] };
  let inspected;
  try {
    const ids = String(
      execFile('docker', ['ps', '-aq', '--filter', `label=${PROJECT_LABEL}`], opts),
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return [];
    inspected = JSON.parse(String(execFile('docker', ['inspect', ...ids], opts)));
  } catch {
    return [];
  }
  if (!Array.isArray(inspected)) return [];

  const byProject = new Map();
  for (const c of inspected) {
    const labels = c?.Config?.Labels ?? {};
    const project = labels[PROJECT_LABEL];
    const networks = Object.keys(c?.NetworkSettings?.Networks ?? {});
    if (!project || !networks.some((n) => n.endsWith(NETWORK_SUFFIX))) continue;
    if (!byProject.has(project)) {
      byProject.set(project, {
        project,
        workingDir: labels[DIR_LABEL] ?? '',
        configFiles: (labels[FILES_LABEL] ?? '').split(',').filter(Boolean),
        containers: [],
      });
    }
    byProject.get(project).containers.push({
      name: String(c.Name ?? '').replace(/^\//, ''),
      state: c?.State?.Status ?? 'unknown',
    });
  }
  return [...byProject.values()];
}

/**
 * Stacks whose folder is gone, or whose folder exists but no longer holds a
 * compose file the stack was started with (a different checkout at the same
 * path). Either way `docker compose up` from that folder can't recreate it.
 */
export function findOrphanStacks(stacks, { exists = existsSync } = {}) {
  const orphans = [];
  for (const stack of stacks) {
    if (!stack.workingDir || !exists(stack.workingDir)) {
      orphans.push({ ...stack, reason: 'folder-missing' });
    } else if (stack.configFiles.some((f) => !exists(f))) {
      orphans.push({ ...stack, reason: 'files-missing' });
    }
  }
  return orphans;
}

export function formatStackPath(dir, home = homedir()) {
  return home && (dir === home || dir.startsWith(`${home}/`)) ? `~${dir.slice(home.length)}` : dir;
}
