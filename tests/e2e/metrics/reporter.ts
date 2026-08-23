/**
 * E2E test reporter — live progress logging + historical trend CLI.
 *
 * Part 1: Exported functions called during test execution to print step-by-step
 *         progress to the terminal.
 * Part 2: Standalone script (`pnpm test:e2e:report`) that opens the
 *         SQLite metrics database and prints a summary of recent runs with
 *         duration trends and regression detection.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeVerifications } from '../scenarios/verification-summary.js';
import type { RunRow, StepTrendRow } from './db.js';
import { E2EDb } from './db.js';

// ---------------------------------------------------------------------------
// Color helpers — ANSI escape codes gated on TTY
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY ?? false;

const ANSI = {
  green: isTTY ? '\x1b[32m' : '',
  red: isTTY ? '\x1b[31m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  brightRed: isTTY ? '\x1b[91m' : '',
  brightGreen: isTTY ? '\x1b[92m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  reset: isTTY ? '\x1b[0m' : '',
};

function colorStatus(status: string): string {
  const upper = status.toUpperCase();
  if (upper === 'PASS') return `${ANSI.green}${upper}${ANSI.reset}`;
  if (upper === 'PASS_AFTER_RETRY') return `${ANSI.yellow}PASS*${ANSI.reset}`;
  if (upper === 'FAIL' || upper === 'ERROR') return `${ANSI.red}${upper}${ANSI.reset}`;
  if (upper === 'REGRESSION') return `${ANSI.yellow}${upper}${ANSI.reset}`;
  return upper;
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

/**
 * ROUND FIRST, THEN DECOMPOSE. Deriving minutes and seconds independently from
 * an unrounded total loses the carry: `Math.floor(359.6/60)` is 5 while
 * `Math.round(359.6%60)` is 60, which shipped **"5m 60s"** to the README's
 * Linode row. It is periodic, not a one-off — every duration in
 * [Xm 59.5s, X+1m) hit it, at every minute AND at the hour boundary
 * (`59m 60s`). Rounding to whole seconds up front makes the carry propagate
 * through the same arithmetic that splits it.
 */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;

  // One tenth-of-a-second value drives both the sub-minute branch and the
  // carry test, so `59.96s` cannot print as `60.0s` here and `1m 0s` there.
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;

  const totalSeconds = Math.round(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

// ---------------------------------------------------------------------------
// Table drawing helpers
// ---------------------------------------------------------------------------

/** Regex to strip ANSI escape codes for visible-length measurement. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape code stripping
const ANSI_STRIP_RE = /\x1b\[[0-9;]*m/g;

/** Pad a string to `width` characters, stripping ANSI codes for length calc. */
function padRight(str: string, width: number): string {
  const visible = str.replace(ANSI_STRIP_RE, '');
  const pad = Math.max(0, width - visible.length);
  return `${str}${' '.repeat(pad)}`;
}

function padLeft(str: string, width: number): string {
  const visible = str.replace(ANSI_STRIP_RE, '');
  const pad = Math.max(0, width - visible.length);
  return `${' '.repeat(pad)}${str}`;
}

interface Column {
  header: string;
  width: number;
  align?: 'left' | 'right';
}

function drawTable(columns: Column[], rows: string[][]): string {
  const lines: string[] = [];

  // Top border
  const topParts = columns.map((c) => '\u2500'.repeat(c.width + 2));
  lines.push(`\u250c${topParts.join('\u252c')}\u2510`);

  // Header row
  const headerCells = columns.map((c) => ` ${padRight(c.header, c.width)} `);
  lines.push(`\u2502${headerCells.join('\u2502')}\u2502`);

  // Header separator
  const sepParts = columns.map((c) => '\u2500'.repeat(c.width + 2));
  lines.push(`\u251c${sepParts.join('\u253c')}\u2524`);

  // Data rows
  for (const row of rows) {
    const cells = columns.map((c, i) => {
      const val = row[i] ?? '';
      const padded = c.align === 'right' ? padLeft(val, c.width) : padRight(val, c.width);
      return ` ${padded} `;
    });
    lines.push(`\u2502${cells.join('\u2502')}\u2502`);
  }

  // Bottom border
  const bottomParts = columns.map((c) => '\u2500'.repeat(c.width + 2));
  lines.push(`\u2514${bottomParts.join('\u2534')}\u2518`);

  return lines.join('\n');
}

// =========================================================================
// Part 1: Live progress functions (exported for test execution)
// =========================================================================

/**
 * Print a step completion message with duration and status.
 */
export function logStepComplete(
  mode: string,
  stepName: string,
  durationMs: number,
  status: string,
): void {
  const duration = formatDuration(durationMs);
  const colored = colorStatus(status);
  console.log(`[${mode}] ${stepName} ${colored} (${duration})`);
}

/**
 * Parse [perf] lines emitted by VIBECARBON_PERF=1 out of a CLI run's
 * combined stdout+stderr. Each line has the form:
 *
 *   [perf] <name> <ms>ms [<note>]
 *
 * Returns entries sorted descending by duration so the slowest sub-step
 * always lands at the top of the logged table.
 */
export function parsePerfLines(output: string): Array<{ name: string; ms: number; note?: string }> {
  const out: Array<{ name: string; ms: number; note?: string }> = [];
  // Non-newline whitespace only so an optional trailing note never swallows
  // the line break and consumes the next output line as its note.
  const re = /^\[perf\][ \t]+(\S+)[ \t]+(\d+)ms(?:[ \t]+([^\n]*))?$/gm;
  let m: RegExpExecArray | null = re.exec(output);
  while (m !== null) {
    const entry: { name: string; ms: number; note?: string } = {
      name: m[1],
      ms: Number(m[2]),
    };
    if (m[3]) entry.note = m[3];
    out.push(entry);
    m = re.exec(output);
  }
  out.sort((a, b) => b.ms - a.ms);
  return out;
}

/**
 * Print a per-sub-step perf breakdown for one CLI invocation. Silent when
 * no [perf] lines are present. Slowest-first so the critical path is
 * obvious at a glance.
 */
export function logPerfBreakdown(
  mode: string,
  stepName: string,
  timings: Array<{ name: string; ms: number; note?: string }>,
): void {
  if (timings.length === 0) return;
  const totalMs = timings.reduce((sum, t) => sum + t.ms, 0);
  console.log(
    `${ANSI.dim}[${mode}] ${stepName} perf breakdown (sum of timed stages: ${formatDuration(totalMs)}):${ANSI.reset}`,
  );
  const maxName = Math.max(...timings.map((t) => t.name.length), 12);
  for (const { name, ms, note } of timings) {
    const pct = totalMs > 0 ? ` ${((ms / totalMs) * 100).toFixed(1)}%` : '';
    const noteStr = note ? ` ${ANSI.yellow}${note}${ANSI.reset}` : '';
    console.log(
      `${ANSI.dim}  ${name.padEnd(maxName)}${ANSI.reset}  ${formatDuration(ms).padStart(9)}${pct}${noteStr}`,
    );
  }
}

/**
 * Print a scenario summary.
 */
export function logScenarioSummary(mode: string, status: string, totalDurationMs: number): void {
  const duration = formatDuration(totalDurationMs);
  const colored = colorStatus(status);
  console.log(`[${mode}] Scenario ${colored} (${duration})`);
}

/**
 * Label a scenario for display. `provider/mode` when the run spans more than
 * one provider (under `--provider all`, "compose-ha" alone names two
 * different scenarios); bare mode when it doesn't, which keeps the far more
 * common single-provider run reading exactly as it always has.
 *
 * Note this is DISPLAY only — callers key their lookup tables on the
 * unconditional `${provider}/${mode}`, never on the label.
 */
function scenarioLabel(provider: string, mode: string, multiProvider: boolean): string {
  return multiProvider ? `${provider}/${mode}` : mode;
}

/**
 * Print the full run summary at the end.
 *
 * The Category column distinguishes "infra is having a bad day" from
 * "we shipped regressions" — without it a 0/4 morning of unrelated
 * causes looks identical to a 0/4 morning of one root-cause regression.
 * Category is only shown for failures (passes leave it blank).
 *
 * Footer breaks down failures by category so a glance says e.g.
 * "Overall: FAIL (1/4 — failures: 2 infra, 1 regression)".
 */
export function logRunSummary(
  scenarios: Array<{
    provider: string;
    mode: string;
    status: string;
    durationMs: number;
    failureCategory?: string;
  }>,
): void {
  console.log('');
  console.log(`${ANSI.bold}=== Run Summary ===${ANSI.reset}`);
  console.log('');

  const multiProvider = new Set(scenarios.map((s) => s.provider)).size > 1;
  const labels = scenarios.map((s) => scenarioLabel(s.provider, s.mode, multiProvider));

  const columns: Column[] = [
    // Widened to fit the longest label — drawTable pads but never truncates,
    // so an over-long cell would break the whole table's alignment.
    { header: 'Scenario', width: Math.max(14, ...labels.map((l) => l.length)) },
    { header: 'Status', width: 10 },
    { header: 'Duration', width: 12, align: 'right' },
    { header: 'Category', width: 12 },
  ];

  const rows = scenarios.map((s, i) => [
    labels[i],
    colorStatus(s.status),
    formatDuration(s.durationMs),
    s.failureCategory ? colorCategory(s.failureCategory) : '',
  ]);

  console.log(drawTable(columns, rows));

  // pass_after_retry counts as pass — the scenario did eventually succeed,
  // it just needed an infra retry. The yellow PASS* in the table makes that
  // visible to a reader; the overall pass/fail summary should still be honest.
  const passCount = scenarios.filter(
    (s) => s.status.toUpperCase() === 'PASS' || s.status.toUpperCase() === 'PASS_AFTER_RETRY',
  ).length;
  const totalCount = scenarios.length;
  const overallStatus = passCount === totalCount ? 'PASS' : 'FAIL';

  // Category breakdown for failures only — most useful when the run is red.
  const categoryCounts = scenarios.reduce<Record<string, number>>((acc, s) => {
    if (s.failureCategory) acc[s.failureCategory] = (acc[s.failureCategory] ?? 0) + 1;
    return acc;
  }, {});
  const categoryBreakdown = Object.entries(categoryCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, n]) => `${n} ${cat}`)
    .join(', ');

  console.log('');
  const tail = categoryBreakdown ? ` — failures: ${categoryBreakdown}` : '';
  console.log(
    `Overall: ${colorStatus(overallStatus)} (${passCount}/${totalCount} scenarios passed)${tail}`,
  );
}

/**
 * Print a per-step × per-mode pass/fail matrix with each cell's wall-clock
 * duration. Steps are rows (canonical lifecycle order); scenarios are
 * columns. A cell shows status + duration ("PASS 9.7s") or "·" when the
 * scenario didn't run that step (HA-only failover, expanded-only
 * verify-autoscale, or skip-after-prior-failure). Useful for spotting
 * drift in a single step across modes (e.g. deploy fast on compose, slow
 * on k8s-ha) and for catching one mode regressing while others pass.
 *
 * Step rows are filtered to the union of steps that ANY scenario ran, in
 * canonical order. Empty rows (every column "·") are dropped — they add
 * noise without signal (e.g. verify-autoscale when --expanded is off).
 *
 * Columns are keyed on `provider/mode`, not mode: under `--provider all`,
 * hetzner/compose-ha and digitalocean/compose-ha are two different
 * scenarios, and keying on mode alone made the later one overwrite the
 * earlier one's cells — both columns would render one cloud's numbers, and a
 * Hetzner-only failure could be attributed to DigitalOcean.
 */
export function logStepMatrix(
  scenarios: Array<{
    provider: string;
    mode: string;
    steps: Array<{ name: string; status: string; durationMs: number }>;
  }>,
): void {
  if (scenarios.length === 0) return;

  // Canonical lifecycle order — keep in sync with StepName in
  // tests/e2e/scenarios/types.ts. Hardcoding here (rather than
  // importing) keeps the reporter free of cross-module type imports
  // during the live progress path.
  const STEP_ORDER = [
    'create',
    'setup-repo',
    'add-features',
    'deploy',
    'verify-deploy',
    'warm-deploy',
    'verify-load',
    'verify-autoscale',
    'scale',
    'verify-scale',
    'backup',
    'destroy',
    'restore',
    'verify-restore',
    'failover',
    'verify-failover',
    'reconverge-deploy',
    'final-destroy',
    'teardown-repo',
  ];

  // Column key is ALWAYS provider/mode (unlike the header label below, which
  // drops the provider on a single-provider run) — two scenarios must never
  // collide in this index.
  const key = (sc: { provider: string; mode: string }) => `${sc.provider}/${sc.mode}`;

  const stepIndex: Record<string, Record<string, { status: string; durationMs: number }>> = {};
  for (const sc of scenarios) {
    for (const st of sc.steps) {
      if (!stepIndex[st.name]) stepIndex[st.name] = {};
      stepIndex[st.name][key(sc)] = { status: st.status, durationMs: st.durationMs };
    }
  }

  // Drop steps that no scenario actually ran (e.g. verify-autoscale outside
  // --expanded). Status === 'skip' DOES count as ran-and-skipped — those
  // rows are useful signal ("scenario got far enough to skip").
  const activeSteps = STEP_ORDER.filter((name) => stepIndex[name]);
  if (activeSteps.length === 0) return;

  console.log('');
  console.log(`${ANSI.bold}${ANSI.cyan}=== Step Matrix ===${ANSI.reset}`);
  console.log('');

  const multiProvider = new Set(scenarios.map((s) => s.provider)).size > 1;
  const labels = scenarios.map((s) => scenarioLabel(s.provider, s.mode, multiProvider));

  const stepColWidth = Math.max('Step'.length, ...activeSteps.map((s) => s.length));
  const scenarioColWidth = Math.max(13, ...labels.map((l) => l.length));

  const columns: Column[] = [
    { header: `${ANSI.bold}${ANSI.cyan}Step${ANSI.reset}`, width: stepColWidth },
    ...labels.map((label) => ({
      header: `${ANSI.bold}${ANSI.cyan}${label}${ANSI.reset}`,
      width: scenarioColWidth,
    })),
  ];

  // Per-scenario reachability flag — once a scenario hits its first non-pass
  // step, downstream cells are either explicit `skip` or absent. Either way
  // they rendered the same in v1, which made it hard to spot the failure
  // site at a glance. With this flag we render the cell where the scenario
  // *first* went red as the headline `✗ FAIL <dur>` and any subsequent cell
  // for that same scenario as a dim `↷ blocked`. The reader's eye lands on
  // exactly one ✗ per failed column instead of fishing through 8 rows of
  // identical-looking `skip` to find which one was the cause.
  const failedAt: Record<string, string | null> = {};
  for (const sc of scenarios) {
    failedAt[key(sc)] = null;
    for (const name of activeSteps) {
      const entry = stepIndex[name]?.[key(sc)];
      if (entry && (entry.status === 'fail' || entry.status === 'error')) {
        failedAt[key(sc)] = name;
        break;
      }
    }
  }

  const rows = activeSteps.map((stepName) => [
    `${ANSI.bold}${stepName}${ANSI.reset}`,
    ...scenarios.map((sc) => {
      const entry = stepIndex[stepName]?.[key(sc)];
      const blocked =
        failedAt[key(sc)] !== null &&
        failedAt[key(sc)] !== stepName &&
        // only mark as blocked AFTER the failure point; same-name and earlier
        // steps render normally (the failure cell is itself the headline ✗).
        activeSteps.indexOf(stepName) > activeSteps.indexOf(failedAt[key(sc)] ?? '');
      return formatMatrixCell(entry, blocked);
    }),
  ]);

  console.log(drawTable(columns, rows));
}

/**
 * Render a single matrix cell. Each status gets a glyph:
 *   ✓ pass           — green
 *   ↻ pass_after_retry — yellow (eventually green, but used a retry)
 *   ✗ fail / error   — bright red, bold
 *   ↷ skip           — dim (cascade-skip after a prior failure)
 *   · not run        — dim (this scenario never reaches this step, e.g.
 *                      compose has no failover, k8s skips verify-failover)
 *
 * `blocked=true` overrides the entry (which may itself be `skip` or absent)
 * with a `↷ blocked` rendering. Used downstream of a scenario's first ✗
 * so the reader's eye locks onto the actual failure cell instead of
 * scanning a column of identical-looking `skip` rows.
 */
function formatMatrixCell(
  entry: { status: string; durationMs: number } | undefined,
  blocked = false,
): string {
  if (blocked) return `${ANSI.dim}↷ blocked${ANSI.reset}`;
  if (!entry) return `${ANSI.dim}·${ANSI.reset}`;
  const status = entry.status.toUpperCase();
  if (status === 'SKIP') return `${ANSI.dim}↷ skip${ANSI.reset}`;
  const dur = formatDuration(entry.durationMs);
  const dimDur = `${ANSI.dim}${dur}${ANSI.reset}`;
  if (status === 'PASS') {
    return `${ANSI.brightGreen}✓${ANSI.reset} ${dimDur}`;
  }
  if (status === 'PASS_AFTER_RETRY') {
    return `${ANSI.yellow}↻${ANSI.reset} ${dimDur}`;
  }
  if (status === 'FAIL' || status === 'ERROR') {
    return `${ANSI.brightRed}${ANSI.bold}✗ ${status}${ANSI.reset} ${ANSI.red}${dur}${ANSI.reset}`;
  }
  return `${status} ${dur}`;
}

/** Color a failure-category label for the summary table. */
function colorCategory(category: string): string {
  switch (category) {
    case 'regression':
      return `${ANSI.red}${category}${ANSI.reset}`;
    case 'unknown':
      return `${ANSI.yellow}${category}${ANSI.reset}`;
    case 'infra':
      return `${ANSI.dim}${category}${ANSI.reset}`;
    case 'flake':
      return `${ANSI.dim}${category}${ANSI.reset}`;
    default:
      return category;
  }
}

// =========================================================================
// Part 1b: curated perf steps + anomaly guard
//
// The published performance surfaces (unified README table, inline
// headline markers, marketing component data) render from the checked-in
// docs/perf-data.json via tests/e2e/metrics/perf-data.ts. What stays here
// is the shared vocabulary (the curated step list) and the anomaly guard
// that decides whether a green-but-slow run may update that data file.
// =========================================================================

interface PerfRow {
  header: string;
  step: string;
}

// Rendered as table ROWS (one row per deploy mode, one column per curated
// step) — the README orientation, not the step-matrix/TUI orientation.
export const PERF_TABLE_ROWS: PerfRow[] = [
  { header: 'Cold deploy', step: 'deploy' },
  { header: 'Warm deploy', step: 'warm-deploy' },
  { header: 'Backup', step: 'backup' },
  { header: 'Restore', step: 'restore' },
  { header: 'Scale', step: 'scale' },
  // `destroy` is the mid-matrix destroy (between backup and restore), NOT
  // `final-destroy`. final-destroy is the post-restore test cleanup and
  // doesn't reflect what a user experiences.
  { header: 'Destroy', step: 'destroy' },
  // HA modes only — the one-command role flip a customer runs in an incident.
  // Non-HA scenarios never record this step, so their cells render empty
  // rather than zero. The site's vendor-matrix failover tab sat on "Coming
  // soon" until this row existed: the tab was typed and waiting, the data
  // byte-syncs from perf-data.json, and emission was the only missing piece
  // (launch rule: HA/failover claims pin to the latest green matrix).
  { header: 'Failover', step: 'failover' },
];

// Anomaly guard knobs (Option A). A green-but-slow matrix run — Hetzner
// slowdown, S3 throttle, noisy-neighbor provision — must NOT overwrite the
// recorded fast numbers. Before refreshing README, each curated cell is
// compared to the median of the last N green runs of the SAME provider
// (mode + dnsProvider + step, excluding this run); if any cell exceeds
// median × threshold the runner excludes that provider from this pass and
// warns. A *sustained* regression eventually shifts the median and is
// accepted; a one-off anomaly is rejected.
export const PERF_ANOMALY_WINDOW = 5; // compare against the last N green runs
export const PERF_ANOMALY_THRESHOLD = 1.3; // flag a cell > median × this
export const PERF_ANOMALY_MIN_SAMPLES = 2; // need ≥ this much history to judge

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface PerfAnomaly {
  provider: string;
  mode: string;
  step: string;
  header: string;
  currentMs: number;
  baselineMedianMs: number;
  ratio: number;
  sampleCount: number;
}

/**
 * Detect curated cells in `runId` that are anomalously slow versus the median
 * of the last N green runs of the SAME provider (mode + dnsProvider + step,
 * EXCLUDING this run) — scoped per provider so one provider's baseline never
 * judges another provider's cells.
 *
 * Used by the batch runner to keep a green-but-slow provider from overwriting
 * its README block with infra-noise numbers while a clean sibling provider's
 * block still refreshes. Cells with fewer than MIN_SAMPLES of green history
 * are never flagged — there's no baseline to judge against, so the update is
 * allowed (and seeds the baseline for next time).
 *
 * Returns the flagged cells (empty array = nothing anomalous). Iterates every
 * scenario actually present in the run, so it needs no hardcoded mode/provider
 * list.
 */
export function detectPerfAnomalies(
  db: E2EDb,
  runId: string,
  opts: { window?: number; threshold?: number; minSamples?: number } = {},
): PerfAnomaly[] {
  const window = opts.window ?? PERF_ANOMALY_WINDOW;
  const threshold = opts.threshold ?? PERF_ANOMALY_THRESHOLD;
  const minSamples = opts.minSamples ?? PERF_ANOMALY_MIN_SAMPLES;

  const details = db.getRunDetails(runId);
  if (!details) return [];

  // (scenarioId::step) -> current green duration.
  const currentDur = new Map<string, number>();
  for (const step of details.steps) {
    if (!isGreenStatus(step.status) || step.duration_ms == null) continue;
    currentDur.set(`${step.scenario_id}::${step.name}`, step.duration_ms);
  }

  const anomalies: PerfAnomaly[] = [];
  for (const sc of details.scenarios) {
    if (!isGreenStatus(sc.status)) continue;
    const dns = sc.dns_provider ?? '';
    const provider = sc.provider;
    for (const col of PERF_TABLE_ROWS) {
      const currentMs = currentDur.get(`${sc.id}::${col.step}`);
      if (currentMs == null) continue;
      const history = db.getGreenStepDurations(provider, sc.mode, dns, col.step, runId, window);
      if (history.length < minSamples) continue; // no baseline → don't judge
      const baselineMedianMs = median(history);
      if (baselineMedianMs <= 0) continue;
      const ratio = currentMs / baselineMedianMs;
      if (ratio > threshold) {
        anomalies.push({
          provider,
          mode: sc.mode,
          step: col.step,
          header: col.header,
          currentMs,
          baselineMedianMs,
          ratio,
          sampleCount: history.length,
        });
      }
    }
  }
  return anomalies;
}

function isGreenStatus(status: string): boolean {
  const upper = status.toUpperCase();
  return upper === 'PASS' || upper === 'PASS_AFTER_RETRY';
}

// =========================================================================
// Part 2: Historical trend CLI
// =========================================================================

/** Format an ISO timestamp for display: "2026-03-29 14:30" */
function formatDate(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/** Calculate total run duration in ms from start/finish ISO timestamps. */
function runDurationMs(run: RunRow): number | null {
  if (!run.started_at || !run.finished_at) return null;
  return new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
}

/** Key steps whose trends we track for regression detection. */
const TREND_STEPS = ['deploy', 'scale', 'backup', 'restore', 'failover', 'destroy'] as const;

function printReport(): void {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  const dbPath = path.join(projectRoot, 'tests', 'results', 'e2e.db');

  if (!existsSync(dbPath)) {
    console.log('No e2e test results found. Run `pnpm test:e2e` first.');
    return;
  }

  const db = new E2EDb();

  try {
    const runs = db.getRecentRuns(5);

    if (runs.length === 0) {
      console.log('No e2e test results found. Run `pnpm test:e2e` first.');
      return;
    }

    console.log('');
    console.log(`${ANSI.bold}=== E2E Test Report ===${ANSI.reset}`);

    // ------------------------------------------------------------------
    // Recent Runs table
    // ------------------------------------------------------------------

    console.log('');
    console.log(`${ANSI.bold}Recent Runs:${ANSI.reset}`);

    const runColumns: Column[] = [
      { header: 'Run', width: 10 },
      { header: 'Date', width: 19 },
      { header: 'Branch', width: 12 },
      { header: 'Status', width: 10 },
      { header: 'Duration', width: 12, align: 'right' },
    ];

    const runRows = runs.map((r) => {
      const durationMs = runDurationMs(r);
      return [
        (r.id ?? '').slice(0, 7),
        formatDate(r.started_at),
        r.git_branch ?? '-',
        colorStatus(r.overall_status),
        durationMs != null ? formatDuration(durationMs) : '-',
      ];
    });

    console.log(drawTable(runColumns, runRows));

    // ------------------------------------------------------------------
    // Scenario results for the latest run
    // ------------------------------------------------------------------

    const latestDetails = db.getRunDetails(runs[0].id);
    if (latestDetails && latestDetails.scenarios.length > 0) {
      console.log('');
      console.log(`${ANSI.bold}Scenario Results (latest run):${ANSI.reset}`);

      const scenarioColumns: Column[] = [
        { header: 'Mode', width: 14 },
        { header: 'Path', width: 6 },
        { header: 'Status', width: 10 },
        { header: 'Duration', width: 10, align: 'right' },
        { header: 'Failed Steps', width: 28 },
      ];

      const scenarioRows = latestDetails.scenarios.map((sc) => {
        // Compute scenario duration from its steps
        const scenarioSteps = latestDetails.steps.filter((s) => s.scenario_id === sc.id);
        const totalMs = scenarioSteps.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);

        // Path = cold/warm tag of the deploy step (or the first step if no
        // deploy) — gives a one-glance indication whether this scenario was
        // a fresh first-deploy or a warm restore-after-destroy.
        const deployStep = scenarioSteps.find((s) => s.name === 'deploy');
        const pathStep = deployStep ?? scenarioSteps[0];
        const pathTag = pathStep?.cold_warm ?? '-';

        // Find failed steps
        const failedSteps = scenarioSteps
          .filter((s) => s.status.toUpperCase() === 'FAIL' || s.status.toUpperCase() === 'ERROR')
          .map((s) => s.name);

        return [
          sc.mode,
          pathTag,
          colorStatus(sc.status),
          totalMs > 0 ? formatDuration(totalMs) : '-',
          failedSteps.length > 0 ? failedSteps.join(', ') : '-',
        ];
      });

      console.log(drawTable(scenarioColumns, scenarioRows));
    }

    // ------------------------------------------------------------------
    // Step duration trends
    // ------------------------------------------------------------------

    console.log('');
    console.log(`${ANSI.bold}Step Duration Trends (last 20 runs, split cold/warm):${ANSI.reset}`);

    // Cold and warm deploys have very different cost profiles (cold k8s-ha
    // = ~25-40 min, warm <10 min). Averaging them together hides regressions
    // that only appear in one path. Split them out so a 5-min warm-deploy
    // regression isn't drowned by 20-min cold-deploy noise.
    const trendColumns: Column[] = [
      { header: 'Step', width: 14 },
      { header: 'Path', width: 6 },
      { header: 'Current', width: 10, align: 'right' },
      { header: 'Avg', width: 10, align: 'right' },
      { header: 'N', width: 4, align: 'right' },
      { header: 'Change', width: 10, align: 'right' },
      { header: 'Status', width: 14 },
    ];

    const trendRows: string[][] = [];

    for (const stepName of TREND_STEPS) {
      // Pull a deeper window when slicing by cold/warm so each bucket has
      // enough samples — 20 covers ~4-5 cold deploys and ~15 warm.
      const trends: StepTrendRow[] = db.getStepTrends(stepName, 20);
      if (trends.length === 0) continue;

      for (const path of ['cold', 'warm'] as const) {
        const subset = trends.filter((t) => t.cold_warm === path);
        if (subset.length === 0) continue;

        const current = subset[0];
        const currentMs = current.duration_ms;
        if (currentMs == null) {
          trendRows.push([stepName, path, '-', '-', '0', '-', `${ANSI.dim}NO DATA${ANSI.reset}`]);
          continue;
        }

        const validDurations = subset
          .map((t) => t.duration_ms)
          .filter((d): d is number => d != null);

        if (validDurations.length <= 1) {
          trendRows.push([
            stepName,
            path,
            formatDuration(currentMs),
            '-',
            String(validDurations.length),
            '-',
            `${ANSI.dim}NO HISTORY${ANSI.reset}`,
          ]);
          continue;
        }

        // Average excludes the current run so the change% reflects this run
        // vs prior history rather than vs itself.
        const historicalDurations = validDurations.slice(1);
        const avg = historicalDurations.reduce((sum, d) => sum + d, 0) / historicalDurations.length;
        const changePercent = ((currentMs - avg) / avg) * 100;
        const changeStr =
          changePercent >= 0 ? `+${changePercent.toFixed(1)}%` : `${changePercent.toFixed(1)}%`;

        const isRegression = changePercent > 20;
        const trendStatus = isRegression
          ? `${ANSI.yellow}REGRESSION${ANSI.reset}`
          : `${ANSI.green}OK${ANSI.reset}`;

        trendRows.push([
          stepName,
          path,
          formatDuration(currentMs),
          formatDuration(avg),
          String(validDurations.length),
          changeStr,
          trendStatus,
        ]);
      }
    }

    if (trendRows.length > 0) {
      console.log(drawTable(trendColumns, trendRows));
    } else {
      console.log('  No step trend data available yet.');
    }

    // ------------------------------------------------------------------
    // Verification summary for latest run
    // ------------------------------------------------------------------

    if (latestDetails && latestDetails.verifications.length > 0) {
      console.log('');
      console.log(`${ANSI.bold}Verification Summary (latest run):${ANSI.reset}`);

      const total = latestDetails.verifications.length;
      const tally = summarizeVerifications(latestDetails.verifications);
      // Failed = genuinely red only. A `skip` (missing precondition) is counted
      // on its own axis so it never inflates the failed count — nor gets folded
      // into passed, which was the skip-as-pass blind spot this closes.
      const failed = latestDetails.verifications.filter((v) => {
        const s = v.status.toUpperCase();
        return s !== 'PASS' && s !== 'SKIP';
      });

      console.log(`  Total checks: ${total}`);
      console.log(`  Passed: ${ANSI.green}${tally.passed}${ANSI.reset}`);
      const failedStr = tally.failed > 0 ? `${ANSI.red}${tally.failed}${ANSI.reset}` : '0';
      console.log(`  Failed: ${failedStr}`);
      if (tally.skipped > 0) {
        console.log(
          `  Skipped: ${ANSI.yellow}${tally.skipped}${ANSI.reset} (precondition missing)`,
        );
      }

      if (failed.length > 0) {
        // Resolve mode for each failed verification by walking step -> scenario
        for (const v of failed) {
          const step = latestDetails.steps.find((s) => s.id === v.step_id);
          const scenario = step
            ? latestDetails.scenarios.find((sc) => sc.id === step.scenario_id)
            : null;
          const mode = scenario?.mode ?? '?';
          const errorInfo = v.error_message ? `: ${v.error_message}` : '';
          console.log(`    - [${mode}] ${v.check_name}${errorInfo}`);
        }
      }
    }

    console.log('');
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// CLI entry point detection — run the report when invoked directly
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const isMainModule =
  process.argv[1] === __filename ||
  // Handle tsx rewriting .ts -> .js or vice versa
  process.argv[1]?.replace(/\.ts$/, '.js') === __filename.replace(/\.ts$/, '.js');

if (isMainModule) {
  printReport();
}
