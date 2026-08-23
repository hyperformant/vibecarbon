/**
 * Checked-in perf-data layer — the single source of truth behind every
 * published performance surface.
 *
 * A green CI run does not patch README per provider straight from its own
 * db anymore (each CI leg only ever carries ONE provider's scenarios, so a
 * per-run patch could never refresh a table that shows all providers).
 * Instead `updatePerfDataFromRun` merges the run's full-green providers
 * into `docs/perf-data.json`, and every surface re-renders as a pure
 * function of that JSON:
 *
 *   - the unified README super table (`patchReadmeUnifiedPerfTable`)
 *   - the inline `<!-- perf:… -->` headline markers (`patchInlinePerfMarkers`)
 *   - the marketing component's data file (`syncCarbonPerfData`)
 *
 * The merge keeps the per-provider publication rules the retired
 * per-provider block patcher enforced: full registry coverage, every
 * scenario green, anomaly-guarded via `opts.excludeProviders`, and only
 * green steps contribute numbers.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { testConfig } from '../../config.js';
import type { E2EDb } from './db.js';
import { formatDuration, PERF_TABLE_ROWS } from './reporter.js';

type ProviderId = keyof typeof testConfig.e2e.providers;

function isKnownProvider(provider: string): provider is ProviderId {
  return Object.hasOwn(testConfig.e2e.providers, provider);
}

export interface PerfRunProvenance {
  /** Short (7-char) run id, traceable to a specific CI run. */
  id: string;
  /** Run start date, YYYY-MM-DD (UTC). */
  date: string;
  /** Measurement origin, e.g. "GitHub-hosted runner". */
  origin?: string;
}

export interface PerfProviderEntry {
  run: PerfRunProvenance;
  /** mode -> curated step -> wall-clock duration in ms. */
  scenarios: Record<string, Partial<Record<string, number>>>;
}

export interface PerfData {
  providers: Record<string, PerfProviderEntry>;
}

/** Canonical serialization: 2-space JSON + trailing newline (biome-stable). */
export function serializePerfData(data: PerfData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Load the checked-in data file; a missing file is an empty data set. */
export function loadPerfData(dataPath: string): PerfData {
  if (!existsSync(dataPath)) return { providers: {} };
  return JSON.parse(readFileSync(dataPath, 'utf8')) as PerfData;
}

function isGreenStatus(status: string): boolean {
  const upper = status.toUpperCase();
  return upper === 'PASS' || upper === 'PASS_AFTER_RETRY';
}

/**
 * Collect one provider's entry from a run, or null when the run must not
 * update that provider (the same rules the per-provider README patcher
 * enforced): unknown provider or run, no/partial registry coverage, or any
 * non-green scenario. Within a green scenario only green steps contribute
 * numbers — a pass_after_retry scenario's one failed step stays absent
 * rather than surfacing a number.
 */
export function collectProviderRunData(
  db: E2EDb,
  runId: string,
  provider: string,
  opts: { origin?: string } = {},
): PerfProviderEntry | null {
  if (!isKnownProvider(provider)) return null;
  const details = db.getRunDetails(runId);
  if (!details) return null;

  const modes = testConfig.e2e.providers[provider].scenarios.map((s: { mode: string }) => s.mode);

  const scenariosByMode = new Map<string, (typeof details.scenarios)[number]>();
  for (const sc of details.scenarios) {
    if (sc.provider !== provider) continue;
    scenariosByMode.set(sc.mode, sc);
  }
  for (const mode of modes) {
    const sc = scenariosByMode.get(mode);
    if (!sc || !isGreenStatus(sc.status)) return null;
  }

  const scenarioIdToMode = new Map<string, string>();
  for (const sc of scenariosByMode.values()) scenarioIdToMode.set(sc.id, sc.mode);

  const scenarios: Record<string, Partial<Record<string, number>>> = {};
  for (const mode of modes) scenarios[mode] = {};
  const curatedSteps = new Set(PERF_TABLE_ROWS.map((r) => r.step));
  for (const step of details.steps) {
    if (!isGreenStatus(step.status) || step.duration_ms == null) continue;
    if (!curatedSteps.has(step.name)) continue;
    const mode = scenarioIdToMode.get(step.scenario_id);
    if (!mode) continue;
    // Prefer the CLI's own wall where the step recorded one: the published
    // grid describes what a customer experiences, and the step wall carries
    // harness tail (the 2026-08-23 audit's "11x DO warm-deploy" was 6.2s of
    // CLI inside a 123.5s step). Steps without substeps keep the step wall.
    scenarios[mode][step.name] = details.cliWallByStep.get(step.id) ?? step.duration_ms;
  }

  const run: PerfRunProvenance = {
    id: details.run.id.slice(0, 7),
    date: details.run.started_at ? details.run.started_at.slice(0, 10) : 'unknown',
    ...(opts.origin ? { origin: opts.origin } : {}),
  };

  return { run, scenarios };
}

/**
 * Merge a run's full-green providers into the checked-in data file. Walks
 * the provider registry in order; a provider without full-green coverage
 * (or vetoed via `opts.excludeProviders` — the anomaly guard's wiring)
 * keeps its existing entry untouched. Writes only if bytes changed.
 */
export function updatePerfDataFromRun(
  dataPath: string,
  db: E2EDb,
  runId: string,
  opts: { origin?: string; excludeProviders?: readonly string[] } = {},
): { updated: string[]; skipped: string[] } {
  const data = loadPerfData(dataPath);
  const excluded = new Set(opts.excludeProviders ?? []);
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const providerId of Object.keys(testConfig.e2e.providers)) {
    const entry = excluded.has(providerId)
      ? null
      : collectProviderRunData(db, runId, providerId, { origin: opts.origin });
    if (entry == null) {
      skipped.push(providerId);
      continue;
    }
    data.providers[providerId] = entry;
    updated.push(providerId);
  }

  if (updated.length > 0) {
    const next = serializePerfData(sortProviders(data));
    const before = existsSync(dataPath) ? readFileSync(dataPath, 'utf8') : null;
    if (next !== before) writeFileSync(dataPath, next);
  }
  return { updated, skipped };
}

/** Registry order for providers in the file, so diffs stay stable. */
function sortProviders(data: PerfData): PerfData {
  const registryOrder = Object.keys(testConfig.e2e.providers);
  const ordered: Record<string, PerfProviderEntry> = {};
  const known = registryOrder.filter((id) => Object.hasOwn(data.providers, id));
  const unknown = Object.keys(data.providers).filter((id) => !registryOrder.includes(id));
  for (const id of [...known, ...unknown]) ordered[id] = data.providers[id];
  return { providers: ordered };
}

// =========================================================================
// Unified README super table
// =========================================================================

/** Marker pair for the single unified README perf-table block. */
export const UNIFIED_PERF_TABLE_MARKERS = {
  begin: '<!-- BEGIN:perf-table -->',
  end: '<!-- END:perf-table -->',
} as const;

// Column headers name the CLI command each number measures — the table
// doubles as the command reference. `deploy` appears twice because a warm
// re-`deploy` of an existing environment is its own headline number.
const CLI_COLUMN_HEADERS: Record<string, string> = {
  deploy: 'Cold `deploy`',
  'warm-deploy': 'Warm `deploy`',
  backup: '`backup`',
  restore: '`restore`',
  scale: '`scale`',
  destroy: '`destroy`',
  // One-command role flip (HA modes only; other rows render an em-dash).
  failover: '`failover`',
};

/** One markdown table row; an empty cell renders as `| |` (group continuation). */
function tableRow(cells: string[]): string {
  return `|${cells.map((c) => (c === '' ? ' ' : ` ${c} `)).join('|')}|`;
}

/**
 * Render the unified super table: one row per (provider × scenario it
 * supports, per the registry), grouped by provider (registry order) with
 * the provider's display name named only on its first row; each provider's
 * scenarios walk in the provider's own registry order. A registered
 * provider×mode with no measurement in `data` renders as `_pending_` cells
 * — support and measurement stay distinguishable ("not measured yet" is
 * never disguised as "not offered", and absent rows mean "not offered"). A
 * measured scenario missing one step renders that cell as an em-dash.
 *
 * Ends with a provenance footer naming each measured provider's CI run
 * (shared origin folded to a single mention); omitted entirely while no
 * provider has been measured.
 */
export function renderUnifiedPerfTableMd(data: PerfData): string {
  const providerIds = Object.keys(testConfig.e2e.providers) as ProviderId[];
  const lines: string[] = [
    tableRow(['Provider', 'Scenario', ...PERF_TABLE_ROWS.map((r) => CLI_COLUMN_HEADERS[r.step])]),
    tableRow([':---', ':---', ...PERF_TABLE_ROWS.map(() => ':---:')]),
  ];

  for (const providerId of providerIds) {
    const registryModes = testConfig.e2e.providers[providerId].scenarios.map(
      (s: { mode: string }) => s.mode,
    );
    let firstOfGroup = true;
    for (const mode of registryModes) {
      const measured = data.providers[providerId]?.scenarios[mode];
      const cells = PERF_TABLE_ROWS.map((r) => {
        if (measured == null) return '_pending_';
        const ms = measured[r.step];
        return ms != null ? formatDuration(ms) : '—';
      });
      lines.push(
        tableRow([
          firstOfGroup ? testConfig.e2e.providers[providerId].displayName : '',
          `\`${mode}\``,
          ...cells,
        ]),
      );
      firstOfGroup = false;
    }
  }

  const measuredIds = providerIds.filter((id) => data.providers[id] != null);
  if (measuredIds.length === 0) return lines.join('\n');

  const origins = [
    ...new Set(measuredIds.map((id) => data.providers[id].run.origin).filter(Boolean)),
  ] as string[];
  const sharedOrigin = origins.length === 1 ? origins[0] : null;
  const parts = measuredIds.map((id) => {
    const { run } = data.providers[id];
    const originSuffix = sharedOrigin == null && run.origin ? `, ${run.origin}` : '';
    return `${testConfig.e2e.providers[id].displayName} \`${run.id}\` (${run.date}${originSuffix})`;
  });
  if (sharedOrigin != null) parts.push(sharedOrigin);
  parts.push('methodology: [docs/tests.md](./docs/tests.md)');

  return [...lines, '', `_Latest green CI runs: ${parts.join(' · ')}._`].join('\n');
}

/**
 * Re-render the unified block in README between its markers. Throws when
 * the markers are missing — the README must have opted into the section.
 * Returns whether the file's bytes changed.
 */
export function patchReadmeUnifiedPerfTable(readmePath: string, data: PerfData): boolean {
  const original = readFileSync(readmePath, 'utf8');
  const { begin, end } = UNIFIED_PERF_TABLE_MARKERS;
  const beginIdx = original.indexOf(begin);
  const endIdx = beginIdx === -1 ? -1 : original.indexOf(end, beginIdx);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(`README is missing the unified perf-table markers (${begin} … ${end}).`);
  }

  const next =
    original.slice(0, beginIdx + begin.length) +
    `\n${renderUnifiedPerfTableMd(data)}\n` +
    original.slice(endIdx);
  if (next === original) return false;
  writeFileSync(readmePath, next);
  return true;
}

// ---------------------------------------------------------------------------
// Inline headline markers — `<!-- perf:<step>:<provider>/<mode> -->12.3s
// <!-- /perf -->` spans anywhere in README, now resolved from the checked-in
// data set (so a marker refreshes whenever ANY run updates its provider,
// and stays untouched while its provider has no measurement).
// ---------------------------------------------------------------------------

const INLINE_PERF_RE = /<!-- perf:([a-z0-9-]+):([a-z0-9-]+)\/([a-z0-9-]+) -->.*?<!-- \/perf -->/g;

/**
 * Rewrite every inline perf span from `data`. Returns the
 * `<step>:<provider>/<mode>` keys actually resolved. Writes only on change.
 */
export function patchInlinePerfMarkers(readmePath: string, data: PerfData): string[] {
  const original = readFileSync(readmePath, 'utf8');
  const updated: string[] = [];
  const next = original.replace(
    INLINE_PERF_RE,
    (match, step: string, provider: string, mode: string) => {
      const ms = data.providers[provider]?.scenarios[mode]?.[step];
      if (ms == null) return match; // no measurement — leave as-is
      updated.push(`${step}:${provider}/${mode}`);
      return `<!-- perf:${step}:${provider}/${mode} -->${formatDuration(ms)}<!-- /perf -->`;
    },
  );
  if (next !== original) writeFileSync(readmePath, next);
  return updated;
}

// ---------------------------------------------------------------------------
// Marketing component data sync — carbon/ is a separate project with no
// workspace link to the root repo, so the vibecarbon.com component consumes
// a byte-identical generated copy of the data file instead of importing it.
// ---------------------------------------------------------------------------

/** Write the canonical serialization to the carbon copy. Returns whether bytes changed. */
export function syncCarbonPerfData(carbonJsonPath: string, data: PerfData): boolean {
  const next = serializePerfData(data);
  const before = existsSync(carbonJsonPath) ? readFileSync(carbonJsonPath, 'utf8') : null;
  if (next === before) return false;
  writeFileSync(carbonJsonPath, next);
  return true;
}
