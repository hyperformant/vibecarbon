#!/usr/bin/env node
/**
 * Recalibrate the e2e cold-deploy budgets from real runs.
 *
 *   node scripts/calibrate-deploy-budgets.js --db <e2e.db> [--db <e2e.db> ...] --since <iso> [--out <json>] [--report <md>]
 *
 * Pass every results db there is: the local tests/results/e2e.db and the
 * e2e.db each GitHub e2e leg uploads (`gh run download <run id>`). Local and
 * GitHub runs are pooled on purpose: one table judges both, and a laptop's
 * fixed overhead (pushing the image, SSH round trips to far regions) is part
 * of what the rule's constant absorbs. A step that appears in two dbs (a copy
 * of the same run) counts once.
 *
 * Reads the results dbs READ-ONLY (never written) and writes
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
 * recorded class goes in the provider + mode row `any`, never a guessed class.
 * Only modes in a provider's SUPPORTED_TIERS are enumerated.
 *
 * Rule (seconds):
 *   owned     = ceil5(1.5 x median + 60) of deploy.total minus the TLS first
 *               look, at any sample count. The median is nearest-rank.
 *   endToEnd  = owned + the TLS allowance, ceil5(1.5 x the slowest TLS first
 *               look) and never under 60 s: that wait is the CA's, not ours.
 * ceil5 rounds up to a multiple of 5.
 *
 * Why this rule (2026-11-14): a budget is there to catch a regression, not to
 * fail a matrix on ordinary variance. The old rule (p90 + 15 at n >= 4, else
 * max + 30) put about one in ten cold deploys over budget on runs it had not
 * seen, which fails most 16-scenario matrices. Judged leave-one-out over 198
 * cold deploys since 2026-11-05 (102 GitHub, 96 local), this rule missed 1%
 * on GitHub and none locally, while every budget stays near 1.8x a typical
 * deploy (2x at most), so a deploy that doubles still fails. The +60 is the
 * laptop's fixed overhead: local medians ran 1.4-1.5x GitHub's on the short
 * Hetzner compose deploys and about 1.07x elsewhere.
 *
 * Seeds: a provider + mode with no samples at all (a mode a provider supports
 * but has never passed a cold deploy in) gets a seeded row, so its first run
 * is judged against a number instead of failing with `no budget yet`. The
 * seed is the mean of every calibrated row of that mode on the other
 * providers, ceil5'd, with `samples: 0` and `seededFrom` naming those rows. A
 * seed is never an input to another seed, and the first passing cold deploy
 * replaces it with a calibrated row. A mode with no calibrated row on any
 * provider gets no seed; the check then fails with `no budget yet`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getProviderClass, PROVIDERS } from '../src/lib/providers/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = path.join(here, '..', 'tests', 'e2e', 'checks', 'deploy-budgets.json');
export const MODES = ['compose', 'compose-ha', 'k8s', 'k8s-ha'];
export const OWNED_MEDIAN_FACTOR = 1.5;
export const OWNED_PAD_S = 60;
export const TLS_FACTOR = 1.5;
export const TLS_ALLOWANCE_FLOOR_S = 60;
export const STANDARD_CLASS = 'standard';
export const ANY_CLASS = 'any';

export const ceil5 = (s) => Math.ceil(s / 5) * 5;

/** Nearest-rank percentile of a non-empty list. */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/** The rule's owned statistic: ceil5(1.5 x median + 60), at any sample count. */
export function budgetStat(values) {
  return ceil5(OWNED_MEDIAN_FACTOR * percentile(values, 0.5) + OWNED_PAD_S);
}

/**
 * One row from samples `{ ownedS, tlsS }` (seconds).
 * @returns {{ownedS: number, endToEndS: number, tlsAllowanceS: number, samples: number}}
 */
export function budgetFromSamples(samples) {
  const ownedS = budgetStat(samples.map((x) => x.ownedS));
  // The TLS first look is the CA's time and has a long tail (p99 56 s, max
  // 85 s over every cold deploy since 2026-11-05), so its allowance covers the
  // slowest one seen with room, never less than the floor.
  const tlsAllowanceS = Math.max(
    TLS_ALLOWANCE_FLOOR_S,
    ceil5(TLS_FACTOR * Math.max(...samples.map((x) => x.tlsS))),
  );
  return { ownedS, endToEndS: ownedS + tlsAllowanceS, tlsAllowanceS, samples: samples.length };
}

/**
 * The seed for `provider` + `mode` from the calibrated rows (samples > 0) of
 * that mode on every other provider, or undefined when there are none.
 * @returns {{ownedS: number, endToEndS: number, tlsAllowanceS: number, samples: 0, seededFrom: string[]} | undefined}
 */
export function seededRow(budgets, provider, mode) {
  const from = [];
  for (const [p, modes] of Object.entries(budgets)) {
    if (p === provider) continue;
    for (const [cls, row] of Object.entries(modes[mode] ?? {})) {
      if (row.samples > 0) from.push({ name: `${p}/${mode}/${cls}`, row });
    }
  }
  if (from.length === 0) return undefined;
  const mean = (k) => from.reduce((sum, f) => sum + f.row[k], 0) / from.length;
  const ownedS = ceil5(mean('ownedS'));
  const tlsAllowanceS = Math.max(TLS_ALLOWANCE_FLOOR_S, ceil5(mean('tlsAllowanceS')));
  return {
    ownedS,
    endToEndS: ownedS + tlsAllowanceS,
    tlsAllowanceS,
    samples: 0,
    seededFrom: from.map((f) => f.name).sort(),
  };
}

/** The row key a provider's seed goes in: `standard` when classless, else `any`. */
export function seedClass(provider) {
  return declaredClasses(provider).includes(STANDARD_CLASS) ? STANDARD_CLASS : ANY_CLASS;
}

/**
 * Seed every supported provider + mode that has no row. Seeds are computed
 * from the calibrated table alone, so none feeds another. Mutates and returns
 * `budgets`, plus the seeds it added.
 */
export function addSeeds(budgets) {
  const seeds = [];
  for (const provider of Object.keys(PROVIDERS).sort()) {
    for (const mode of supportedModes(provider)) {
      if (budgets[provider]?.[mode]) continue;
      const row = seededRow(budgets, provider, mode);
      if (row) seeds.push({ provider, mode, cls: seedClass(provider), ...row });
    }
  }
  for (const { provider, mode, cls, ...row } of seeds) {
    budgets[provider] ??= {};
    budgets[provider][mode] = { [cls]: row };
  }
  return { budgets, seeds };
}

/** The modes a provider can really run (its SUPPORTED_TIERS). */
export function supportedModes(provider) {
  const tiers = getProviderClass(provider).SUPPORTED_TIERS ?? [];
  return MODES.filter((m) => tiers.includes(m));
}

/** The classes a provider can deploy on: its declared ones, else `standard`. */
export function declaredClasses(provider) {
  const classes = getProviderClass(provider).CPU_CLASSES ?? [];
  return classes.length > 0 ? [...classes] : [STANDARD_CLASS];
}

const SAMPLE_SQL = `
  SELECT st.id AS step_id, COALESCE(s.provider, 'hetzner') AS provider, s.mode AS mode,
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
 * Read the samples from one or more dbs, each opened read-only. A step id seen
 * in an earlier db (a copy of the same run) is not counted again. Returns the
 * grouped samples.
 * @param {string | string[]} dbPaths
 * @param {string} since
 */
export function readSamples(dbPaths, since) {
  const groups = new Map();
  const seen = new Set();
  for (const dbPath of [dbPaths].flat()) readOne(dbPath, since, groups, seen);
  return { groups: [...groups.values()] };
}

function readOne(dbPath, since, groups, seen) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    for (const row of db.prepare(SAMPLE_SQL).all(since)) {
      if (seen.has(row.step_id)) continue;
      seen.add(row.step_id);
      if (!MODES.includes(row.mode) || !Object.hasOwn(PROVIDERS, row.provider)) continue;
      if (!supportedModes(row.provider).includes(row.mode)) continue;
      if (row.total_ms == null) continue;
      // No recorded class goes in the provider + mode `any` row: a class is
      // never guessed (the default type moves with capacity).
      const cls =
        recordedClass(row.details) ??
        (declaredClasses(row.provider).includes(STANDARD_CLASS) ? STANDARD_CLASS : ANY_CLASS);
      const key = `${row.provider}/${row.mode}`;
      const gk = `${key}/${cls}`;
      if (!groups.has(gk))
        groups.set(gk, { provider: row.provider, mode: row.mode, cls, rows: [] });
      groups.get(gk).rows.push({
        ownedS: (row.total_ms - row.tls_ms) / 1000,
        tlsS: row.tls_ms / 1000,
      });
    }
  } finally {
    db.close();
  }
}

/** The table and the report from the samples. */
export function buildTable({ groups }, since) {
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
  const { seeds } = addSeeds(budgets);
  // What is left has no number at all: the check fails with `no budget yet`.
  const noData = [];
  for (const provider of Object.keys(PROVIDERS).sort()) {
    for (const mode of supportedModes(provider)) {
      if (!budgets[provider]?.[mode]) noData.push({ provider, mode });
    }
  }
  const table = {
    rule: RULE,
    since,
    budgets,
  };
  return { table, rows, seeds, noData };
}

export const RULE =
  'owned = ceil5(1.5 x median + 60) over local and GitHub cold deploys pooled; endToEnd = owned + ' +
  'tlsAllowanceS (ceil5(1.5 x the slowest TLS first look), at least 60). A provider + mode with no ' +
  "samples is seeded (samples 0) with the ceil5'd mean of that mode's calibrated rows on the " +
  'other providers. Regenerate with scripts/calibrate-deploy-budgets.js.';

export function renderReport({ rows, seeds = [], noData }, since) {
  const out = [
    `# Deploy budgets (runs since ${since})`,
    '',
    '| provider | mode | class | n | owned s | end-to-end s | TLS allowance s | rule |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.provider} | ${r.mode} | ${r.cls} | ${r.samples} | ${r.ownedS} | ${r.endToEndS} | ${r.tlsAllowanceS} | ${
          '1.5 x median + 60'
        } |`,
    ),
    '',
    '## Seeded (no samples yet; the mean of the other providers until a cold deploy passes)',
    '',
    ...seeds.map(
      (x) =>
        `- ${x.provider}/${x.mode}/${x.cls}: owned ${x.ownedS} s, end-to-end ${x.endToEndS} s, from ${x.seededFrom.join(', ')}`,
    ),
    '',
    '## No data (no number; the check fails with `no budget yet`)',
    '',
    ...noData.map((n) => `- ${n.provider}/${n.mode}`),
    '',
  ];
  return out.join('\n');
}

function parseArgs(argv) {
  const args = { db: [], since: null, out: DEFAULT_OUT, report: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--db') args.db.push(v());
    else if (a === '--since') args.since = v();
    else if (a === '--out') args.out = v();
    else if (a === '--report') args.report = v();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.since || Number.isNaN(Date.parse(args.since))) {
    throw new Error('--since <ISO run time> is required: runs recorded before it are ignored');
  }
  if (args.db.length === 0) {
    throw new Error(
      '--db <e2e.db> is required, once per results db (the local tests/results/e2e.db and each GitHub leg\'s)',
    );
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
