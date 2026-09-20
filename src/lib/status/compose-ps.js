import { execFileSync } from 'node:child_process';

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
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return { available: false, running: [] };
  }

  const trimmed = String(output).trim();
  if (!trimmed) return { available: true, running: [] };

  const entries = [];
  if (trimmed.startsWith('[')) {
    try {
      entries.push(...JSON.parse(trimmed));
    } catch {
      // Truncated or otherwise invalid array body: the probe could not
      // read the stack at all, so report unavailable rather than throw.
      return { available: false, running: [] };
    }
  } else {
    for (const line of trimmed.split('\n')) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
  }

  const running = entries
    .filter((entry) => entry !== null && typeof entry === 'object' && entry.State === 'running')
    .map((entry) => entry.Service ?? entry.Name);

  return { available: true, running };
}
