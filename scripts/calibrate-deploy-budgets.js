#!/usr/bin/env node
/**
 * Recalibrate the e2e cold-deploy budgets from real runs.
 *
 *   node scripts/calibrate-deploy-budgets.js --since 2026-11-05T13:00:00Z
 *   node scripts/calibrate-deploy-budgets.js --db <path> --since <iso> --out <json> --report <md>
 *
 * Reads the results db READ-ONLY (never written) and writes
 * tests/e2e/checks/deploy-budgets.json, the table
 * tests/e2e/checks/deploy-budget.ts judges against. Keyed on provider, mode
 * and CPU class: one provider's speed cannot hide behind another's.
 *
 * Samples: a deploy step that PASSED and is `cold` in the db (the same
 * cold/warm classification the check applies when it judges), from a run that
 * started at or after --since (so a run recorded before the current code
 * shape never sets a budget). The class is what the check recorded in the
 * step's `deploy_budget` verification details; a provider that declares no CPU
 * classes is always `standard`. A sample of a classed provider with no
 * recorded class is excluded and counted, never guessed.
 *
 * Rule (seconds):
 *   owned     = ceil5(p90 + 15) of deploy.total minus the TLS first look, at
 *               n >= 4 samples; otherwise ceil5(max + 30). p90 is nearest-rank.
 *   endToEnd  = owned + 15, unless the first-ever TLS issue needs more: when
 *               the same statistic over the TLS first look is above 15 s,
 *               its ceil5 is the allowance instead of 15.
 * ceil5 rounds up to a multiple of 5.
 *
 * A combination with no samples gets no row; the check then fails with
 * `no budget yet`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getProviderClass, PROVIDERS } from '../src/lib/providers/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB =
  '/home/brandon/repos/vibecarbon/.claude/worktrees/perf-run/tests/results/e2e.db';
export const DEFAULT_OUT = path.join(here, '..', 'tests', 'e2e', 'checks', 'deploy-budgets.json');
export const MODES = ['compose', 'compose-ha', 'k8s', 'k8s-ha'];
export const MIN_P90_SAMPLES = 4;
export const TLS_ALLOWANCE_FLOOR_S = 15;
export const STANDARD_CLASS = 'standard';

export const ceil5 = (s) => Math.ceil(s / 5) * 5;

/** Nearest-rank percentile of a non-empty list. */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/** The rule's statistic: p90 + 15 at n >= 4, else max + 30, ceil5'd. */
export function budgetStat(values) {
  const n = values.length;
  return n >= MIN_P90_SAMPLES
    ? ceil5(percentile(values, 0.9) + 15)
    : ceil5(Math.max(...values) + 30);
}

/**
 * One row from samples `{ ownedS, tlsS }` (seconds).
 * @returns {{ownedS: number, endToEndS: number, tlsAllowanceS: number, samples: number}}
 */
export function budgetFromSamples(samples) {
  const ownedS = budgetStat(samples.map((x) => x.ownedS));
  const tlsValues = samples.map((x) => x.tlsS);
  // The TLS needs its own statistic without the +15/+30 pad folded into a
  // 15 s floor: compare the raw statistic, allow its ceil5.
  const tlsRaw =
    samples.length >= MIN_P90_SAMPLES ? percentile(tlsValues, 0.9) : Math.max(...tlsValues);
  const tlsAllowanceS = tlsRaw > TLS_ALLOWANCE_FLOOR_S ? ceil5(tlsRaw) : TLS_ALLOWANCE_FLOOR_S;
  return { ownedS, endToEndS: ownedS + tlsAllowanceS, tlsAllowanceS, samples: samples.length };
}

/** The classes a provider can deploy on: its declared ones, else `standard`. */
export function declaredClasses(provider) {
  const classes = getProviderClass(provider).CPU_CLASSES ?? [];
  return classes.length > 0 ? [...classes] : [STANDARD_CLASS];
}

const SAMPLE_SQL = `
  SELECT COALESCE(s.provider, 'hetzner') AS provider, s.mode AS mode,
    (SELECT MAX(duration_ms) FROM perf_substep WHERE step_id = st.id AND name = 'deploy.total') AS total_ms,
    (SELECT COALESCE(SUM(duration_ms), 0) FROM perf_substep
       WHERE step_id = st.id AND name IN ('deploy.tls.ready', 'deploy.tls.snapshot')) AS tls_ms,
    (SELECT details FROM verifications WHERE step_id = st.id AND check_name = 'deploy_budget'
       ORDER BY rowid DESC LIMIT 1) AS details
  FROM steps st
  JOIN scenarios s ON s.id = st.scenario_id
  JOIN runs r ON r.id = s.run_id
  WHERE st.name = 'deploy' AND st.status = 'pass' AND st.cold_warm = 'cold'
    AND r.started_at >= ?`;

function recordedClass(details) {
  try {
    const c = JSON.parse(details ?? 'null')?.cpuClass;
    return typeof c === 'string' && c ? c : null;
  } catch {
    return null;
  }
}

/**
 * Read the samples, opened read-only. Returns the grouped samples and the
 * excluded counts.
 */
export function readSamples(dbPath, since) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const groups = new Map();
    const unclassed = new Map();
    for (const row of db.prepare(SAMPLE_SQL).all(since)) {
      if (!MODES.includes(row.mode) || !Object.hasOwn(PROVIDERS, row.provider)) continue;
      if (row.total_ms == null) continue;
      const cls =
        recordedClass(row.details) ??
        (declaredClasses(row.provider).includes(STANDARD_CLASS) ? STANDARD_CLASS : null);
      const key = `${row.provider}/${row.mode}`;
      if (cls === null) {
        unclassed.set(key, (unclassed.get(key) ?? 0) + 1);
        continue;
      }
      const gk = `${key}/${cls}`;
      if (!groups.has(gk))
        groups.set(gk, { provider: row.provider, mode: row.mode, cls, rows: [] });
      groups.get(gk).rows.push({
        ownedS: (row.total_ms - row.tls_ms) / 1000,
        tlsS: row.tls_ms / 1000,
      });
    }
    return { groups: [...groups.values()], unclassed };
  } finally {
    db.close();
  }
}

/** The table and the report from the samples. */
export function buildTable({ groups, unclassed }, since) {
  const budgets = {};
  const rows = [];
  for (const g of groups.sort((a, b) =>
    `${a.provider}/${a.mode}/${a.cls}`.localeCompare(`${b.provider}/${b.mode}/${b.cls}`),
  )) {
    const row = budgetFromSamples(g.rows);
    budgets[g.provider] ??= {};
    budgets[g.provider][g.mode] ??= {};
    budgets[g.provider][g.mode][g.cls] = row;
    rows.push({ ...g, ...row });
  }
  const noData = [];
  for (const provider of Object.keys(PROVIDERS).sort()) {
    for (const mode of MODES) {
      for (const cls of declaredClasses(provider)) {
        if (!budgets[provider]?.[mode]?.[cls]) {
          const skipped = unclassed.get(`${provider}/${mode}`) ?? 0;
          noData.push({ provider, mode, cls, skipped });
        }
      }
    }
  }
  const table = {
    rule:
      'owned = ceil5(p90 + 15) at n >= 4 else ceil5(max + 30); endToEnd = owned + tlsAllowanceS ' +
      '(15, or ceil5 of the TLS first-look statistic when above 15). Regenerate with ' +
      'scripts/calibrate-deploy-budgets.js.',
    since,
    budgets,
  };
  return { table, rows, noData };
}

export function renderReport({ rows, noData }, since) {
  const out = [
    `# Deploy budgets (runs since ${since})`,
    '',
    '| provider | mode | class | n | owned s | end-to-end s | TLS allowance s | rule |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.provider} | ${r.mode} | ${r.cls} | ${r.samples} | ${r.ownedS} | ${r.endToEndS} | ${r.tlsAllowanceS} | ${
          r.samples >= MIN_P90_SAMPLES ? 'p90 + 15' : 'max + 30'
        } |`,
    ),
    '',
    '## No data (no number; the check fails with `no budget yet`)',
    '',
    ...noData.map(
      (n) =>
        `- ${n.provider}/${n.mode}/${n.cls}${n.skipped ? ` (${n.skipped} passing cold deploy(s) excluded: class not recorded)` : ''}`,
    ),
    '',
  ];
  return out.join('\n');
}

function parseArgs(argv) {
  const args = { db: DEFAULT_DB, since: null, out: DEFAULT_OUT, report: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--db') args.db = v();
    else if (a === '--since') args.since = v();
    else if (a === '--out') args.out = v();
    else if (a === '--report') args.report = v();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.since || Number.isNaN(Date.parse(args.since))) {
    throw new Error('--since <ISO run time> is required: runs recorded before it are ignored');
  }
  args.since = new Date(args.since).toISOString();
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const built = buildTable(readSamples(args.db, args.since), args.since);
    mkdirSync(path.dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(built.table, null, 2)}\n`);
    const report = renderReport(built, args.since);
    if (args.report) writeFileSync(args.report, report);
    console.log(report);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
