import { execFileSync } from 'node:child_process';
import { localComposeEnv } from '../images.js';

/**
 * Read `docker compose ps --format json`, in either shape it has had: one
 * array before Compose 2.21, one object per line from 2.21 on (run against both
 * binaries, runtime-floors.js compose-ps-json-lines). The one reader, so a
 * laptop's Compose version never decides whether a caller can see its stack.
 *
 * @param {string | null | undefined} output
 * @returns {Array<Record<string, any>> | null} the rows, or null for an array
 *   that does not parse. No containers is an empty list.
 */
export function parseComposePs(output) {
  const trimmed = String(output ?? '').trim();
  if (!trimmed) return [];
  const isRow = (entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry);
  if (trimmed.startsWith('[')) {
    try {
      const rows = JSON.parse(trimmed);
      return Array.isArray(rows) ? rows.filter(isRow) : null;
    } catch {
      return null;
    }
  }
  const rows = [];
  for (const line of trimmed.split('\n')) {
    try {
      const row = JSON.parse(line);
      if (isRow(row)) rows.push(row);
    } catch {
      // Compose can print a warning line among the rows.
    }
  }
  return rows;
}

/**
 * The host ports the rows publish.
 *
 * @param {Array<Record<string, any>> | null} rows - from parseComposePs
 * @returns {Set<number>}
 */
export function publishedPorts(rows) {
  const ports = new Set();
  for (const row of rows ?? []) {
    // Publishers is an array of { URL, TargetPort, PublishedPort, Protocol }
    if (!Array.isArray(row.Publishers)) continue;
    for (const pub of row.Publishers) {
      if (pub.PublishedPort) ports.add(pub.PublishedPort);
    }
  }
  return ports;
}

/**
 * Which services of the project's compose stack are running, from one
 * `docker compose ps --format json` call in cwd.
 *
 * This is the one probe the `?` guide needs to answer "is the local stack
 * up." It exists as its own file, separate from src/status.js, because
 * status.js's container probes are heavier: they pull in providers, ssh and
 * remote health checks that the guide has no need of.
 *
 * @param {string} cwd
 * @param {{ execFile?: typeof execFileSync, timeoutMs?: number }} [options]
 * @returns {{ available: boolean, running: string[] }}
 */
export function composeRunningServices(cwd, { execFile = execFileSync, timeoutMs = 5000 } = {}) {
  let output;
  try {
    output = execFile('docker', ['compose', 'ps', '--format', 'json'], {
      cwd,
      // `compose ps` interpolates the compose file, which requires the db
      // image pair (see localComposeEnv).
      env: localComposeEnv(),
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return { available: false, running: [] };
  }

  const entries = parseComposePs(output);
  // A truncated or otherwise invalid array body: the probe could not read the
  // stack at all, so report unavailable rather than throw.
  if (entries === null) return { available: false, running: [] };

  const running = entries
    .filter((entry) => entry.State === 'running')
    .map((entry) => entry.Service ?? entry.Name)
    // A row with neither key would otherwise put undefined in the list, and
    // the guide counts and prints these.
    .filter(Boolean);

  return { available: true, running };
}
