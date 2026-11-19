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
 * tests/e2e/checks/deploy-budgets.json (or --out), the table
 * tests/e2e/checks/deploy-budget.ts judges against, after reading the table
 * already there for the rows it carries over (below). Keyed on provider, mode
 * and CPU class: one provider's speed cannot hide behind another's.
 *
 * Samples: a deploy step that PASSED and is `cold` in the db (the same
 * cold/warm classification the check applies when it judges), from a run that
 * started at or after --since (so a run recorded before the current code
 * shape never sets a budget), of a STOCK scenario: `scenarios.features`
 * recorded as `[]`, the app and its database with no add-ons. Budgets are for
 * stock deploys, the e2e baseline (tests/config.ts); a deploy with add-ons,
 * or one whose feature set was never recorded, is counted as ignored and
 * reported, never sampled (tests/e2e/utils/feature-set.js, the same rule the
 * perf table applies). The class is what the check recorded in the
 * step's `deploy_budget` verification details; a provider that declares no CPU
 * classes is always `standard`. A sample of a classed provider with no
 * recorded class goes in the provider + mode row `any`, never a guessed class.
 * Only modes in a provider's SUPPORTED_TIERS are enumerated.
 *
 * Rule (seconds):
 *   owned     = ceil5(1.5 x median + 60) of the deploy-owned time, at any
 *               sample count. The median is nearest-rank.
 *   endToEnd  = owned + the TLS allowance, ceil5(1.5 x the slowest TLS first
 *               look) and never under 60 s: that wait is the CA's, not ours.
 * ceil5 rounds up to a multiple of 5.
 *
 * The deploy-owned time is deploy.total minus the TLS first look and minus the
 * provider's server create (the single longest server-create timing), measured
 * by tests/e2e/utils/deploy-time.js, the same function the check judges with,
 * from the deploy's `[perf]` rows in perf_substep. Since 2026-11-19 the
 * server create is out of it: how long a cloud takes to make a server is not
 * ours to change, and it moved the old number by minutes (Hetzner k8s server
 * creates 29-52 s on most runs and 173-192 s on a slow day, one DigitalOcean
 * droplet 558 s in an incident), failing deploys whose own work was steady.
 * Only the longest create comes out, since creates run in parallel: creates
 * our code serialized would still count. A sample with no server-create row
 * cannot be split that way, so it is ignored and reported, never measured as
 * if the provider had taken no time. Every sample since 2026-11-15T20:06:33Z
 * has one (49 of 49): resource timings predate that table.
 *
 * Judged leave-one-out over those samples (the 44 in rows of two or more), the
 * old quantity missed 3, exactly the three provider-slow deploys above, and
 * the new one none. The cost: the rule's +60 now pads a smaller number, so a
 * row whose own work is under about 2 minutes lets a deploy that doubles still
 * pass: 8 of the 20 rows (all compose, medians 81-127 s), where the same
 * samples on the old quantity gave 3 (Hetzner and Scaleway compose). Every
 * budget sits 1.72x to 2.28x its row's median.
 *
 * Why this rule (2026-11-14): a budget is there to catch a regression, not to
 * fail a matrix on ordinary variance. The old rule (p90 + 15 at n >= 4, else
 * max + 30) put about one in ten cold deploys over budget on runs it had not
 * seen, which fails most 16-scenario matrices. Judged leave-one-out over 198
 * cold deploys since 2026-11-05 (102 GitHub, 96 local), this rule missed 1%
 * on GitHub and none locally. Every budget then sat 1.7x to 2.03x its row's
 * median, so a deploy that doubled failed on every row but the two fastest
 * (Hetzner compose, about 2 minutes), where it just passed. The +60 is the
 * laptop's fixed overhead: local medians ran 1.4-1.5x GitHub's on the short
 * Hetzner compose deploys and about 1.07x elsewhere.
 *
 * Seeds: a provider + mode with no row at all (a mode a provider supports but
 * has never passed a cold deploy in, and nothing carried, below) gets a seeded
 * row, so its first run is judged against a number instead of failing with
 * `no budget yet`. The seed is the mean of every calibrated row of that mode
 * on the other providers, ceil5'd, with `samples: 0` and `seededFrom` naming
 * those rows. A seed is never an input to another seed, and the first passing
 * cold deploy replaces it with a calibrated row. A mode with no calibrated row
 * on any provider gets no seed; the check then fails with `no budget yet`.
 *
 * Carried rows: the table this run overwrites (--out) keeps every calibrated
 * row whose provider + mode + class the new samples do not cover, marked
 * `carriedOver: true` with `carriedFromSince`, the --since of the calibration
 * that measured it (a row carried twice keeps its first). Without them a class
 * no stock run has landed on yet (the default type moves with capacity), and
 * the `any` row a run with no exact row falls back to, would lose their
 * numbers, and the check would fail a deploy there with `no budget yet`. A
 * stock sample of the class replaces its carried row on a later calibration.
 * A carried row is never an input to a seed, and a provider + mode with one is
 * judged by its own older number rather than seeded from other providers. A
 * seed is never carried (it is recomputed), nor a row of a provider, mode or
 * class a deploy can no longer land on.
 *
 * The rows carried in 2026-11-15 came from deploys before e2e runs were stock
 * (#457), which ran the observability add-on and did more work, so a carried
 * row is meant to err loose, not tight. The first stock runs mostly bore that
 * out: the stock row came in at or under the older row on 14 of 16 classes,
 * and 5 s and 15 s over it on the other two (DigitalOcean regular k8s and
 * Linode k8s, n = 2 each). Read a carried row as a ceiling to tighten, not a
 * stock number. A row carried from a table before 2026-11-19 also measured
 * the provider's server create as the deploy's own time, so it errs loose by
 * that much more.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getProviderClass, PROVIDERS } from '../src/lib/providers/index.js';
import { deployTimes } from '../tests/e2e/utils/deploy-time.js';
import { isStockFeaturesRecord } from '../tests/e2e/utils/feature-set.js';

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
 * The seed for `provider` + `mode` from the calibrated rows (samples > 0, not
 * carried over) of that mode on every other provider, or undefined when there
 * are none.
 * @returns {{ownedS: number, endToEndS: number, tlsAllowanceS: number, samples: 0, seededFrom: string[]} | undefined}
 */
export function seededRow(budgets, provider, mode) {
  const from = [];
  for (const [p, modes] of Object.entries(budgets)) {
    if (p === provider) continue;
    for (const [cls, row] of Object.entries(modes[mode] ?? {})) {
      if (row.samples > 0 && !row.carriedOver) from.push({ name: `${p}/${mode}/${cls}`, row });
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
 * Seed every supported provider + mode that has no row (calibrated or carried).
 * Seeds are computed from the calibrated rows alone, so none feeds another and
 * no carried row feeds one. Mutates and returns `budgets`, plus the seeds it
 * added.
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

const rowKey = (x) => `${x.provider}/${x.mode}/${x.cls}`;
const byRowKey = (a, b) => rowKey(a).localeCompare(rowKey(b));

/**
 * Carry over from `previous` (the table this calibration overwrites) every
 * calibrated row whose provider + mode + class has no row in `budgets`,
 * marked `carriedOver` with `carriedFromSince`, the since of the calibration
 * that measured it. A seed is not carried (it is recomputed), nor a row of a
 * provider, mode or class a deploy can no longer land on. Run it before
 * addSeeds. Mutates and returns `budgets`, plus the rows it carried.
 */
export function carryOver(budgets, previous) {
  const carried = [];
  for (const [provider, modes] of Object.entries(previous?.budgets ?? {})) {
    if (!Object.hasOwn(PROVIDERS, provider)) continue;
    const classes = [...declaredClasses(provider), ANY_CLASS];
    for (const mode of supportedModes(provider)) {
      for (const [cls, row] of Object.entries(modes?.[mode] ?? {})) {
        if (!classes.includes(cls) || !(row?.samples > 0)) continue;
        if (budgets[provider]?.[mode]?.[cls]) continue; // a stock sample replaced it
        const carriedFromSince = row.carriedFromSince ?? previous.since;
        if (Number.isNaN(Date.parse(carriedFromSince ?? ''))) {
          throw new Error(
            `cannot carry over ${provider}/${mode}/${cls}: the table it is in has no since`,
          );
        }
        const { ownedS, endToEndS, tlsAllowanceS, samples } = row;
        const kept = {
          ownedS,
          endToEndS,
          tlsAllowanceS,
          samples,
          carriedOver: true,
          carriedFromSince,
        };
        budgets[provider] ??= {};
        budgets[provider][mode] ??= {};
        budgets[provider][mode][cls] = kept;
        carried.push({ provider, mode, cls, ...kept });
      }
    }
  }
  return { budgets, carried: carried.sort(byRowKey) };
}

/** `budgets` with its provider, mode and class keys in one order, however each row got there. */
function sortedTable(budgets) {
  const entries = [];
  for (const [provider, modes] of Object.entries(budgets)) {
    for (const [mode, classes] of Object.entries(modes)) {
      for (const [cls, row] of Object.entries(classes)) entries.push({ provider, mode, cls, row });
    }
  }
  const sorted = {};
  for (const { provider, mode, cls, row } of entries.sort(byRowKey)) {
    sorted[provider] ??= {};
    sorted[provider][mode] ??= {};
    sorted[provider][mode][cls] = row;
  }
  return sorted;
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
    s.features AS features,
    (SELECT details FROM verifications WHERE step_id = st.id AND check_name = 'deploy_budget'
       ORDER BY rowid DESC LIMIT 1) AS details
  FROM steps st
  JOIN scenarios s ON s.id = st.scenario_id
  JOIN runs r ON r.id = s.run_id
  WHERE st.name = 'deploy' AND st.status = 'pass' AND st.cold_warm = 'cold'
    AND r.started_at >= ?`;

/** A deploy's `[perf]` entries, as the runner recorded them from its output. */
const PERF_SQL = 'SELECT name, duration_ms AS ms FROM perf_substep WHERE step_id = ?';

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
 * grouped samples, how many otherwise-eligible deploys were not stock, and how
 * many had no server-create timing to take out.
 * @param {string | string[]} dbPaths
 * @param {string} since
 */
export function readSamples(dbPaths, since) {
  const groups = new Map();
  const seen = new Set();
  const counts = { nonStock: 0, noServerCreate: 0 };
  for (const dbPath of [dbPaths].flat()) readOne(dbPath, since, groups, seen, counts);
  return { groups: [...groups.values()], ...counts };
}

function readOne(dbPath, since, groups, seen, counts) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const perfOf = db.prepare(PERF_SQL);
    for (const row of db.prepare(SAMPLE_SQL).all(since)) {
      if (seen.has(row.step_id)) continue;
      seen.add(row.step_id);
      if (!MODES.includes(row.mode) || !Object.hasOwn(PROVIDERS, row.provider)) continue;
      if (!supportedModes(row.provider).includes(row.mode)) continue;
      const times = deployTimes(perfOf.all(row.step_id), row.provider);
      if (times.totalMs === null) continue;
      // Budgets are for stock deploys: one with add-ons (or no recorded
      // feature set) would size a budget the stock matrix never runs.
      if (!isStockFeaturesRecord(row.features)) {
        counts.nonStock++;
        continue;
      }
      // No server-create row: the provider's wait cannot be taken out, and
      // counting none would size the budget on a number the check never sees.
      if (times.ownedMs === null) {
        counts.noServerCreate++;
        continue;
      }
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
        ownedS: times.ownedMs / 1000,
        tlsS: times.tlsMs / 1000,
        serverCreateS: times.serverCreate.ms / 1000,
      });
    }
  } finally {
    db.close();
  }
}

/**
 * The table and the report from the samples, carrying over the rows of
 * `previous` (the table being overwritten, if any) that the samples do not
 * cover.
 */
export function buildTable({ groups, nonStock = 0, noServerCreate = 0 }, since, previous) {
  const budgets = {};
  const rows = [];
  for (const g of groups.sort(byRowKey)) {
    const row = budgetFromSamples(g.rows);
    budgets[g.provider] ??= {};
    budgets[g.provider][g.mode] ??= {};
    budgets[g.provider][g.mode][g.cls] = row;
    rows.push({ ...g, ...row });
  }
  // Carry before seeding: a provider + mode with a carried row is judged by
  // it, and seededRow skips carried rows, so none feeds a seed.
  const { carried } = carryOver(budgets, previous);
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
    budgets: sortedTable(budgets),
  };
  return { table, rows, seeds, carried, noData, nonStock, noServerCreate };
}

export const RULE =
  'owned = ceil5(1.5 x median + 60) over local and GitHub stock cold deploys (no add-ons) pooled, ' +
  "of deploy.total minus the TLS first look and minus the provider's server create (the longest " +
  'server-create timing, tests/e2e/utils/deploy-time.js); endToEnd = owned + ' +
  'tlsAllowanceS (ceil5(1.5 x the slowest TLS first look), at least 60). A class with no stock ' +
  'sample keeps its row from the table this one replaced (carriedOver, with carriedFromSince, ' +
  'the since it was calibrated from) until a stock sample replaces it. A provider + mode with ' +
  "no row is seeded (samples 0) with the ceil5'd mean of that mode's calibrated rows on the " +
  'other providers, never a carried row. Regenerate with scripts/calibrate-deploy-budgets.js.';

/** The median server create a row's samples had taken out, or `-` when none recorded one. */
function medianServerCreate(samples = []) {
  const waits = samples.map((x) => x.serverCreateS).filter(Number.isFinite);
  return waits.length ? Math.round(percentile(waits, 0.5)) : '-';
}

export function renderReport(
  { rows, seeds = [], carried = [], noData, nonStock = 0, noServerCreate = 0 },
  since,
) {
  const out = [
    `# Deploy budgets (runs since ${since})`,
    '',
    '| provider | mode | class | n | owned s | end-to-end s | TLS allowance s | median server create s (not counted) | rule |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.provider} | ${r.mode} | ${r.cls} | ${r.samples} | ${r.ownedS} | ${r.endToEndS} | ${r.tlsAllowanceS} | ${medianServerCreate(r.rows)} | ${
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
    '## Carried over (no stock sample of the class yet; the row from the table this one replaced, from deploys before e2e runs were stock, until a stock cold deploy replaces it)',
    '',
    ...carried.map(
      (x) =>
        `- ${x.provider}/${x.mode}/${x.cls}: owned ${x.ownedS} s, end-to-end ${x.endToEndS} s, n ${x.samples}, calibrated since ${x.carriedFromSince}`,
    ),
    '',
    '## No data (no number; the check fails with `no budget yet`)',
    '',
    ...noData.map((n) => `- ${n.provider}/${n.mode}`),
    '',
    '## Not stock (budgets are for stock deploys: the app and its database, no add-ons)',
    '',
    `Ignored ${nonStock} cold deploys that were not stock (add-ons, or no feature set recorded).`,
    '',
    "## No server-create timing (the provider's wait cannot be taken out)",
    '',
    `Ignored ${noServerCreate} cold deploys with no [perf] server-create row for their provider.`,
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
    // The table about to be overwritten: its rows the samples do not cover are carried over.
    const previous = existsSync(args.out) ? JSON.parse(readFileSync(args.out, 'utf8')) : undefined;
    const built = buildTable(readSamples(args.db, args.since), args.since, previous);
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
