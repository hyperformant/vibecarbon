#!/usr/bin/env node
/**
 * The audit gate for the lockfile the template ships (run from carbon/ by the
 * "Template Tests" job). It fails on any high or critical advisory, as
 * `npm audit --audit-level=high` did, with one difference: an advisory that
 * has no fixed release anywhere is listed in NO_FIX_YET and reported without
 * failing, because no lockfile, ours or a customer's fresh install, can be
 * free of it.
 *
 * An entry cannot outlive its reason:
 *   - it names the newest release of the package when it was added; the day a
 *     newer one is published the gate fails again and says to refresh the
 *     lockfile and delete the entry;
 *   - an entry whose advisory the audit no longer reports fails the gate too.
 *
 * Add an entry only after checking that the advisory's first patched version
 * is empty (`gh api /advisories/<id>`). Never add one for an advisory that a
 * lockfile refresh or an override can clear.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** @type {Array<{ advisory: string, package: string, newestRelease: string, added: string }>} */
export const NO_FIX_YET = [];

const BLOCKING = new Set(['high', 'critical']);

/** The advisory id at the end of an advisory URL. */
const idOf = (url) =>
  String(url ?? '')
    .replace(/\/+$/, '')
    .split('/')
    .pop();

/**
 * The high and critical advisories in an `npm audit --json` report, one per
 * advisory and package (the report repeats each under every dependent).
 *
 * @param {{ vulnerabilities?: Record<string, { via?: unknown[] }> }} report
 */
export function blockingAdvisories(report) {
  const seen = new Map();
  for (const entry of Object.values(report.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      if (!BLOCKING.has(via.severity)) continue;
      const advisory = idOf(via.url);
      seen.set(`${advisory} ${via.name}`, {
        advisory,
        package: via.name,
        severity: via.severity,
        title: via.title,
        range: via.range,
      });
    }
  }
  return [...seen.values()];
}

/**
 * Sort the report into what fails the gate and what is only reported.
 *
 * @param {object} args
 * @param {ReturnType<typeof blockingAdvisories>} args.advisories
 * @param {typeof NO_FIX_YET} args.noFixYet
 * @param {(pkg: string) => string} args.newestReleaseOf
 * @returns {{ failures: string[], waived: string[] }}
 */
export function judge({ advisories, noFixYet, newestReleaseOf }) {
  const failures = [];
  const waived = [];
  const used = new Set();
  for (const found of advisories) {
    const entry = noFixYet.find(
      (e) => e.advisory === found.advisory && e.package === found.package,
    );
    const label = `${found.severity}: ${found.package} ${found.range} (${found.advisory}) ${found.title}`;
    if (!entry) {
      failures.push(label);
      continue;
    }
    used.add(entry);
    const newest = newestReleaseOf(found.package);
    if (newest !== entry.newestRelease) {
      failures.push(
        `${label}\n    ${found.package} ${newest} is out (the entry was written against ${entry.newestRelease}): refresh carbon/package-lock.json, and delete the NO_FIX_YET entry if the advisory is gone`,
      );
      continue;
    }
    waived.push(
      `${label}\n    no fixed release exists (newest is ${newest}); listed since ${entry.added}`,
    );
  }
  for (const entry of noFixYet) {
    if (used.has(entry)) continue;
    failures.push(
      `${entry.advisory} (${entry.package}) is in NO_FIX_YET but the audit no longer reports it: delete the entry`,
    );
  }
  return { failures, waived };
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  return res;
}

function main() {
  // `npm audit` exits 1 when it finds anything; only its JSON is read here.
  const audit = run('npm', ['audit', '--json']);
  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    console.error(`npm audit did not return a report (exit ${audit.status}):\n${audit.stderr}`);
    process.exit(2);
  }
  if (report.error) {
    console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
    process.exit(2);
  }
  const { failures, waived } = judge({
    advisories: blockingAdvisories(report),
    noFixYet: NO_FIX_YET,
    newestReleaseOf: (pkg) => {
      const view = run('npm', ['view', pkg, 'version']);
      const version = view.stdout.trim();
      if (view.status !== 0 || !version) {
        console.error(`could not read the newest release of ${pkg}:\n${view.stderr}`);
        process.exit(2);
      }
      return version;
    },
  });
  for (const line of waived) console.log(`not failing the gate, ${line}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} advisory problem(s) in the shipped lockfile:`);
    for (const line of failures) console.error(`  ${line}`);
    console.error(
      '\nThe fix is almost always a lockfile refresh:\n  cd carbon && npm audit fix --package-lock-only && npm ci --dry-run',
    );
    process.exit(1);
  }
  console.log('No high or critical advisory that a release can fix.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
