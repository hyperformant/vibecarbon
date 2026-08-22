/**
 * Dependency-advisory check for `vibecarbon upgrade`.
 *
 * After an upgrade merges the template's security floors into the user's
 * package.json and regenerates the lockfile, this surfaces known CVEs in the
 * resulting dependency set via the package manager's own `audit --json`.
 * Strictly non-fatal: an offline machine, a missing lockfile, or an
 * unsupported package manager downgrades to a skipped/unsupported status the
 * caller renders as a note, never an error.
 *
 * Exit-code semantics matter here: npm and pnpm exit NON-ZERO when
 * advisories are FOUND — the normal interesting case, not an execution
 * failure. runCommand (silent) attaches captured stdout to the thrown error,
 * so the report is recovered from `err.stdout`.
 */

import { runCommand } from './command.js';

/**
 * Argv for `<pm> audit --json`, or null when the package manager has no
 * audit surface we can parse (bun: `bun audit` output is not pinned to the
 * npm-classic JSON shape — skip rather than guess).
 *
 * @param {'npm'|'pnpm'|'bun'|string} pm
 * @returns {string[]|null}
 */
export function buildAuditArgv(pm) {
  if (pm === 'npm') return ['npm', 'audit', '--json'];
  if (pm === 'pnpm') return ['pnpm', 'audit', '--json'];
  return null;
}

/**
 * Extract severity counts from an `audit --json` report. npm v10+ and pnpm
 * both carry the classic `metadata.vulnerabilities` block; nothing else in
 * the report is read.
 *
 * @param {string} stdout
 * @returns {{info:number,low:number,moderate:number,high:number,critical:number,total:number}|null}
 */
export function summarizeAuditJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const v = parsed?.metadata?.vulnerabilities;
  if (!v || typeof v !== 'object') return null;
  const n = (x) => Number(x) || 0;
  const counts = {
    info: n(v.info),
    low: n(v.low),
    moderate: n(v.moderate),
    high: n(v.high),
    critical: n(v.critical),
  };
  return {
    ...counts,
    total: Number.isFinite(Number(v.total))
      ? n(v.total)
      : counts.info + counts.low + counts.moderate + counts.high + counts.critical,
  };
}

/**
 * Run the advisory check. Synchronous (runCommand is spawnSync-based) and
 * never throws.
 *
 * @param {'npm'|'pnpm'|'bun'|string} pm
 * @param {string} cwd - user project directory (needs a lockfile)
 * @param {{ exec?: typeof runCommand }} [deps] - injection seam for tests
 * @returns {{status:'ok', summary: NonNullable<ReturnType<typeof summarizeAuditJson>>}
 *          |{status:'skipped'}|{status:'unsupported'}}
 */
export function runDependencyAudit(pm, cwd, { exec = runCommand } = {}) {
  const argv = buildAuditArgv(pm);
  if (!argv) return { status: 'unsupported' };

  let stdout;
  try {
    // cleanEnv: a wrapper package manager's injected npm_config_* must not
    // reach this spawn (same rule as the upgrade install step, PR #242).
    stdout = exec(argv, { cwd, silent: true, cleanEnv: true, timeout: 120_000 });
  } catch (error) {
    stdout = error?.stdout;
  }

  if (typeof stdout !== 'string' || stdout.trim() === '') return { status: 'skipped' };
  const summary = summarizeAuditJson(stdout);
  if (!summary) return { status: 'skipped' };
  return { status: 'ok', summary };
}
