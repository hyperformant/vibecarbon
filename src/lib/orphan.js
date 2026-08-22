/**
 * Orphan dev-session reclaim helpers for `vibecarbon up`.
 *
 * When a project port is in use, the most common cause is an orphaned dev
 * session belonging to the SAME project — a previous `node scripts/dev.js`
 * tree (its child Vite + tsx API servers) that outlived its parent and was
 * reparented to init while still holding the port. Rather than dodge the
 * conflict by bumping DEV_PORT_OFFSET (which leaves the runaway alive and
 * drifts the project onto a new port band), we identify the process actually
 * listening on the port and, if it belongs to this project's working
 * directory, kill its whole process group so a clean restart can reuse the
 * normal ports.
 *
 * Strict scoping is the safety contract: we kill a process only when its
 * working directory resolves to the project dir (or a subdir). A process we
 * can't introspect (different user → EACCES) is treated as foreign and never
 * touched. On non-Unix platforms, or when `lsof`/`ps` are unavailable, the
 * helpers degrade to no-ops and the caller falls back to offset-bumping.
 */

import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const isUnix = () => process.platform !== 'win32';

const RUN_OPTS = { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] };

/**
 * PIDs listening on the given TCP port. Returns deduped positive integers,
 * or [] on non-Unix, missing `lsof`, or any error.
 * @param {number} port
 * @returns {number[]}
 */
export function findPortListeners(port) {
  if (!isUnix()) return [];
  try {
    const out = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], RUN_OPTS);
    const pids = out
      .trim()
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    return [...new Set(pids)];
  } catch {
    return [];
  }
}

/**
 * Resolved working directory of a process, or null if it can't be read
 * (gone, foreign user / EACCES, or unsupported platform). Linux reads
 * /proc/<pid>/cwd; other Unixes fall back to `lsof`.
 * @param {number} pid
 * @returns {string | null}
 */
function getProcessCwd(pid) {
  if (!isUnix()) return null;
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch (err) {
    // Different user owns the process — treat as foreign, never kill.
    if (err && err.code === 'EACCES') return null;
    // ENOENT (no /proc, e.g. macOS) → try lsof; other errors → null below.
  }
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], RUN_OPTS);
    const nameLine = out.split('\n').find((line) => line.startsWith('n'));
    return nameLine ? nameLine.slice(1) : null;
  } catch {
    return null;
  }
}

/**
 * Process group id (pgid) of a process, or null on failure.
 * @param {number} pid
 * @returns {number | null}
 */
export function getProcessGroup(pid) {
  if (!isUnix()) return null;
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], RUN_OPTS);
    const pgid = Number(out.trim());
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

/**
 * True iff the process's working directory resolves to `projectCwd` or a
 * subdirectory of it.
 * @param {number} pid
 * @param {string} projectCwd
 * @returns {boolean}
 */
export function isOwnedByProject(pid, projectCwd) {
  const cwd = getProcessCwd(pid);
  if (!cwd) return false;
  const proc = resolve(cwd);
  const root = resolve(projectCwd);
  return proc === root || proc.startsWith(root + sep);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True if the process is still alive (signal 0 probe). */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → gone. EPERM → alive but not ours (shouldn't happen for an
    // owned orphan) — report alive so we don't claim a false reclaim.
    return !!err && err.code !== 'ESRCH';
  }
}

/** Best-effort signal to a target; swallows ESRCH/EPERM races. */
function signal(target, sig) {
  try {
    process.kill(target, sig);
  } catch {
    // Already gone or not permitted — nothing more we can do.
  }
}

/**
 * Reclaim a port held by this project's own orphaned dev session.
 *
 * Finds the listeners on `port`, keeps only those whose working directory
 * belongs to `projectCwd`, and kills each owned holder's process group
 * (SIGTERM, then SIGKILL after a grace period). Foreign holders are reported
 * but never touched.
 *
 * @param {number} port
 * @param {string} projectCwd
 * @param {{ graceMs?: number, intervalMs?: number }} [opts]
 * @returns {Promise<{ killed: number[], foreign: number[], freed: boolean }>}
 */
export async function reclaimPort(port, projectCwd, { graceMs = 2000, intervalMs = 100 } = {}) {
  const listeners = findPortListeners(port);
  if (listeners.length === 0) return { killed: [], foreign: [], freed: false };

  const owned = [];
  const foreign = [];
  for (const pid of listeners) {
    if (isOwnedByProject(pid, projectCwd)) owned.push(pid);
    else foreign.push(pid);
  }
  if (owned.length === 0) return { killed: [], foreign, freed: false };

  // Prefer group-targeted kills so the whole dev.js → vite/tsx tree dies in
  // one shot; fall back to the bare pid if we can't resolve a pgid.
  const seenGroups = new Set();
  const targets = [];
  for (const pid of owned) {
    const pgid = getProcessGroup(pid);
    if (pgid) {
      if (!seenGroups.has(pgid)) {
        seenGroups.add(pgid);
        targets.push(-pgid);
      }
    } else {
      targets.push(pid);
    }
  }

  for (const target of targets) signal(target, 'SIGTERM');

  const deadline = Date.now() + graceMs;
  while (owned.some(isAlive) && Date.now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }

  if (owned.some(isAlive)) {
    for (const target of targets) signal(target, 'SIGKILL');
    await sleep(intervalMs);
  }

  const killed = owned.filter((pid) => !isAlive(pid));
  const freed = !findPortListeners(port).length;
  return { killed, foreign, freed };
}

/**
 * @typedef {{ name: string, port: number }} PortConflict
 */

/**
 * Reclaim each conflicting port held by this project's orphaned dev session,
 * then report which conflicts remain (foreign or otherwise unrecoverable) so
 * the caller can fall back to offset-bumping for just those.
 *
 * Each port is re-checked after reclaim because killing one orphan's process
 * group can free a sibling port in the same dev tree.
 *
 * @param {PortConflict[]} conflicts
 * @param {string} projectCwd
 * @param {{
 *   reclaim?: (port: number, cwd: string) => Promise<{ killed: number[], foreign: number[], freed: boolean }>,
 *   recheck: (port: number) => Promise<boolean>,
 *   onReclaim?: (conflict: PortConflict, result: { killed: number[] }) => void,
 * }} deps
 * @returns {Promise<{ reclaimed: Array<PortConflict & { killed: number[] }>, remaining: PortConflict[] }>}
 */
export async function reclaimOrphanPorts(conflicts, projectCwd, deps) {
  const { reclaim = reclaimPort, recheck, onReclaim } = deps;
  const reclaimed = [];
  const remaining = [];
  for (const conflict of conflicts) {
    const result = await reclaim(conflict.port, projectCwd);
    if (result.killed.length > 0) {
      reclaimed.push({ ...conflict, killed: result.killed });
      onReclaim?.(conflict, result);
    }
    if (await recheck(conflict.port)) remaining.push(conflict);
  }
  return { reclaimed, remaining };
}
