#!/usr/bin/env tsx
/**
 * Perf-table PR collector — the CI-only counterpart to the per-provider
 * README patching runner.ts already does in-process at the end of every
 * `pnpm test:e2e:batch` invocation (see the "README perf-table refresh"
 * block in runner.ts). That in-process patch only ever touches the
 * checkout of whichever job ran it; in the provider-parallel CI topology
 * (.github/workflows/e2e-us-perf.yml) each provider runs in its OWN job on
 * its OWN ephemeral checkout, so those in-process patches are discarded
 * with the runner. This script re-derives the same patch against a single
 * shared checkout, from each leg's uploaded `e2e.db`, and opens the one PR.
 *
 * Design: no db merge. Each provider leg invokes the runner with
 * `--provider <x>`, so a leg's `e2e.db` only ever contains scenario rows
 * for that ONE provider (see db.ts's `scenarios.provider` column and
 * E2EDb.createScenario). Calling `updatePerfDataFromRun` — which walks
 * EVERY registered provider per call — against a single-provider db can
 * therefore only ever merge that db's own provider into the checked-in
 * data file: every other provider has zero scenario rows in that db, so
 * `collectProviderRunData` returns null for it and its entry is left
 * untouched. Merging leg-by-leg, sequentially, into the same data file is
 * consequently safe by construction and order-independent — there is no
 * scenario where one leg's merge could mis-attribute or clobber another
 * leg's entry. After every leg has merged, the published surfaces (the
 * unified README table, the inline markers, and the carbon component's
 * data copy) re-render ONCE as pure functions of the merged data file.
 *
 * Usage: npx tsx tests/e2e/metrics/publish-perf-pr.ts <artifacts-dir>
 *
 * <artifacts-dir> is the root `actions/download-artifact@v8` extracted
 * into via `pattern: e2e-results-*`. Layout depends on how many artifacts
 * matched: with TWO OR MORE (both legs uploaded), each lands in its own
 * `<artifact-name>/` subdirectory (`e2e-results-hetzner/e2e.db`,
 * `e2e-results-digitalocean/e2e.db`). With EXACTLY ONE match — the default
 * single-provider dispatch, or a partial-green run where the other leg died
 * before ever uploading — download-artifact extracts it FLATTENED directly
 * into the root with no subdirectory at all (`isSingleArtifactDownload ||
 * mergeMultiple || artifacts.length === 1`, a documented v5+ behavior
 * change, not something `merge-multiple: false` turns off). See
 * `discoverLegArtifacts`'s flattened-layout fallback below — missing this
 * case originally meant a single-provider dispatch (the default!) silently
 * published nothing, ever (task-8-review.md C-1). A leg whose job died
 * before ever producing a db (or whose upload warned-and-skipped on
 * `if-no-files-found`) simply has no artifact at all and is silently
 * omitted — that provider's block gets no patch attempt this run, exactly
 * like any other partial-coverage run.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2EDb } from './db.js';
import {
  loadPerfData,
  patchInlinePerfMarkers,
  patchReadmeUnifiedPerfTable,
  syncCarbonPerfData,
  updatePerfDataFromRun,
} from './perf-data.js';

const __dirname_ = resolve(fileURLToPath(import.meta.url), '..');
/** Absolute path to the project root (three levels up from tests/e2e/metrics/) */
const PROJECT_ROOT = resolve(__dirname_, '..', '..', '..');

// ---------------------------------------------------------------------------
// Leg discovery
// ---------------------------------------------------------------------------

export interface LegArtifact {
  /** Provider registry key, e.g. 'hetzner' | 'digitalocean'. Parsed from the
   *  artifact directory name `e2e-results-<provider>` in the nested layout;
   *  in the flattened single-artifact layout there is no such directory, so
   *  it comes from the sibling `ci-batch-<provider>.log` filename or the db's
   *  own `scenarios.provider` column (see `resolveFlattenedProvider`). */
  provider: string;
  /** Absolute path to that leg's downloaded `e2e.db`. */
  dbPath: string;
}

const LEG_DIR_RE = /^e2e-results-(.+)$/;
const LEG_LOG_RE = /^ci-batch-(.+)\.log$/;

/**
 * Scan `rootDir` (the `download-artifact` extraction root) for per-provider
 * leg artifacts. Returns one entry per `e2e-results-<provider>` subdirectory
 * that actually contains an `e2e.db`, sorted by provider name for
 * deterministic ordering (patch order doesn't affect the result — see the
 * module doc — but deterministic ordering keeps logs and test assertions
 * stable).
 *
 * Falls back to a FLATTENED single-artifact layout — a root-level `e2e.db`
 * with no `e2e-results-<provider>/` subdirectory at all — when the nested
 * scan finds nothing. This is the common case, not an edge case: it's what
 * `download-artifact@v8` produces for the default single-provider dispatch,
 * and for the partial-green case where the OTHER leg died before ever
 * uploading (see the module doc). Skipping this fallback originally meant
 * `discoverLegArtifacts` returned `[]` for both of those, and the collector
 * silently published nothing (task-8-review.md C-1).
 */
export function discoverLegArtifacts(rootDir: string): LegArtifact[] {
  if (!existsSync(rootDir)) return [];

  const legs: LegArtifact[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = LEG_DIR_RE.exec(entry.name);
    if (!match) continue;
    const dbPath = join(rootDir, entry.name, 'e2e.db');
    if (!existsSync(dbPath)) continue;
    legs.push({ provider: match[1], dbPath });
  }

  if (legs.length === 0) {
    const flatDb = join(rootDir, 'e2e.db');
    if (existsSync(flatDb)) {
      legs.push({ provider: resolveFlattenedProvider(rootDir, flatDb), dbPath: flatDb });
    }
  }

  legs.sort((a, b) => a.provider.localeCompare(b.provider));
  return legs;
}

/**
 * Recover a provider label for a flattened single-artifact leg. Cosmetic
 * only — `patchLeg` delegates all provider SELECTION to the Task 4 patch
 * functions, which self-select from the db's own content regardless of
 * what this returns; the label is used only for logging and sort order.
 *
 * Prefers the sibling `ci-batch-<provider>.log` filename (matches the
 * "Upload results" step's naming exactly, no db read needed) and falls back
 * to the db's own `scenarios.provider` column when the log is absent (e.g.
 * `if-no-files-found: warn` dropped it while the db still made it).
 * Returns 'unknown' only if neither source has an answer (a db with a run
 * row but zero scenario rows — the process died between createRun and its
 * first createScenario call).
 */
function resolveFlattenedProvider(rootDir: string, dbPath: string): string {
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = LEG_LOG_RE.exec(entry.name);
    if (match) return match[1];
  }

  const db = new E2EDb(dbPath);
  try {
    const run = db.getRecentRuns(1)[0];
    const provider = run ? db.getRunDetails(run.id)?.scenarios[0]?.provider : undefined;
    return provider ?? 'unknown';
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Per-leg merge into the checked-in data file
// ---------------------------------------------------------------------------

export interface LegUpdateResult {
  provider: string;
  /** The leg's own most recent run id, or null when its db has no runs
   *  recorded (an empty/corrupt db — nothing to merge from). */
  runId: string | null;
  updated: string[];
  skipped: string[];
}

/** The three files the collector may rewrite: the checked-in data file and
 *  the two surfaces rendered from it. */
export interface SurfacePaths {
  dataPath: string;
  readmePath: string;
  carbonDataPath: string;
}

/**
 * Merge ONE leg's downloaded db into the checked-in data file. Resolves the
 * leg's own most recent run (each `pnpm test:e2e:batch` invocation creates
 * exactly one `runs` row) and delegates all green-coverage gating to
 * `updatePerfDataFromRun` — see the module doc for why per-leg sequential
 * merging is safe without a db merge.
 *
 * Never throws on a leg with no runs (or a missing/corrupt db) — returns a
 * result with `runId: null` instead, so one odd leg can't abort the whole
 * collector.
 */
export function updateLeg(
  dataPath: string,
  leg: LegArtifact,
  opts: { origin?: string } = {},
): LegUpdateResult {
  const db = new E2EDb(leg.dbPath);
  try {
    const runId = db.getRecentRuns(1)[0]?.id ?? null;
    if (runId == null) {
      return { provider: leg.provider, runId: null, updated: [], skipped: [] };
    }
    const { updated, skipped } = updatePerfDataFromRun(dataPath, db, runId, {
      origin: opts.origin,
    });
    return { provider: leg.provider, runId, updated, skipped };
  } finally {
    db.close();
  }
}

export interface CollectorResult {
  legs: LegUpdateResult[];
  /**
   * The absolute paths (of the three surface files) whose BYTES actually
   * changed — the real publish gate, byte-compared before/after. A leg can
   * "resolve" values that are already on disk without moving any bytes
   * (task-8-review.md H-2), so per-leg `updated` lists are for logging only.
   */
  changedFiles: string[];
}

/**
 * Merge every leg into the data file, sequentially, then re-render every
 * surface ONCE from the merged result: the unified README table, the inline
 * headline markers, and the carbon component's byte-identical data copy.
 * Legs are expected pre-sorted (discoverLegArtifacts sorts by provider) for
 * stable logs; order doesn't affect the outcome (see module doc).
 */
export function collectAndRender(
  paths: SurfacePaths,
  legs: LegArtifact[],
  opts: { origin?: string } = {},
): CollectorResult {
  const files = [paths.dataPath, paths.readmePath, paths.carbonDataPath];
  const before = new Map(
    files.map((f) => [f, existsSync(f) ? readFileSync(f, 'utf8') : null] as const),
  );

  const results = legs.map((leg) => updateLeg(paths.dataPath, leg, opts));

  const data = loadPerfData(paths.dataPath);
  patchReadmeUnifiedPerfTable(paths.readmePath, data);
  patchInlinePerfMarkers(paths.readmePath, data);
  syncCarbonPerfData(paths.carbonDataPath, data);

  const changedFiles = files.filter(
    (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null) !== before.get(f),
  );
  return { legs: results, changedFiles };
}

// ---------------------------------------------------------------------------
// PR publish — thin git/gh shelling, intentionally untested here (CI-verified
// by Task 9's post-landing dispatch, per the repo's convention for the
// existing sweep/scrub steps in this same workflow).
// ---------------------------------------------------------------------------

function commitMessage(): string {
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  const lines = ['docs(perf): refresh performance data from CI US-region run'];
  if (runUrl) lines.push('', runUrl);
  return lines.join('\n');
}

/**
 * Commit the changed surface files to a standing `perf-table-update` branch
 * and open (or update) its PR. A single fixed branch name, force-pushed
 * from a fresh `main` checkout each run, so there is at most one open
 * perf-table PR at a time rather than one per run number — `gh pr create`
 * failing because that PR already exists is the expected, harmless outcome
 * of a second green run before the first PR merged; the force-push above
 * already carried the new numbers onto it.
 *
 * No `--no-verify` on the commit — the repo's pre-commit hook (lint + full
 * unit suite) runs exactly as it would for a human commit. That hook is
 * exactly what would have caught the sweep-pagination E2E_NAMESPACE=ci
 * regression class before it reached main.
 */
function publishPr(changedFiles: string[]): void {
  const branch = 'perf-table-update';
  const relFiles = changedFiles.map((f) => relative(PROJECT_ROOT, f));
  // Callers only reach here after main() has confirmed GITHUB_REF_NAME ===
  // 'main' — hardcoded rather than re-read so this function can't drift
  // from that check and open a PR against whatever ref happened to be set.
  const base = 'main';

  const run = (cmd: string, cmdArgs: string[]) =>
    execFileSync(cmd, cmdArgs, { cwd: PROJECT_ROOT, stdio: 'inherit' });

  run('git', ['config', 'user.name', 'github-actions[bot]']);
  run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  run('git', ['checkout', '-B', branch]);
  run('git', ['add', ...relFiles]);
  run('git', ['commit', '-m', commitMessage()]);
  run('git', ['push', '--force', 'origin', `HEAD:${branch}`]);

  try {
    run('gh', ['pr', 'create', '--fill', '--head', branch, '--base', base]);
  } catch {
    console.log(
      `[publish-perf-pr] gh pr create failed (a PR for ${branch} likely already exists) — the push above already carried the new numbers onto it.`,
    );
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rootDir = process.argv[2];
  if (!rootDir) {
    console.error('Usage: publish-perf-pr.ts <artifacts-dir>');
    process.exit(2);
  }

  const legs = discoverLegArtifacts(rootDir);
  if (legs.length === 0) {
    console.log(`No leg artifacts with an e2e.db found under ${rootDir} — nothing to publish.`);
    return;
  }
  console.log(`Found ${legs.length} leg artifact(s): ${legs.map((l) => l.provider).join(', ')}`);

  const paths: SurfacePaths = {
    dataPath: join(PROJECT_ROOT, 'docs', 'perf-data.json'),
    readmePath: join(PROJECT_ROOT, 'README.md'),
    carbonDataPath: join(
      PROJECT_ROOT,
      'carbon',
      'src',
      'client',
      'components',
      'sections',
      'vendor-matrix-data.json',
    ),
  };
  // Region-level origin detail (e.g. "ash/hil") lives only in the runner's
  // in-memory scenario config, not in e2e.db (db.ts's ScenarioRow has no
  // region column) — it isn't recoverable from a downloaded db alone. The
  // per-leg in-process merge runner.ts already performed (and discarded,
  // per the module doc above) carried the full origin; this collector-authored
  // merge settles for the host class alone.
  const origin = 'GitHub-hosted runner';

  const result = collectAndRender(paths, legs, { origin });
  for (const leg of result.legs) {
    if (leg.runId == null) {
      console.log(`[${leg.provider}] no run recorded in this leg's db — skipped`);
      continue;
    }
    console.log(
      `[${leg.provider}] run ${leg.runId.slice(0, 7)} — merged: ${leg.updated.join(', ') || 'none'}; skipped: ${leg.skipped.join(', ') || 'none'}`,
    );
  }

  if (result.changedFiles.length === 0) {
    console.log(
      'All surface files byte-identical after merging every leg — nothing to publish (no provider had full-green coverage, or every merged value already matched what was on disk).',
    );
    return;
  }
  console.log(
    `Changed files: ${result.changedFiles.map((f) => relative(PROJECT_ROOT, f)).join(', ')}`,
  );

  // Branch dispatches must never publish numbers from unmerged code — the
  // same invariant the deleted workflow step enforced with
  // `if: success() && github.ref == 'refs/heads/main'` (docs/tests.md's "CI
  // US-region perf runs" section states this as a guarantee). Legs run on
  // whatever ref was dispatched; only the PUBLISH step is main-gated.
  // GITHUB_REF_NAME is the dispatch ref for a workflow_dispatch run; unset
  // (e.g. a local invocation outside CI) is treated the same as "not
  // main" — publishing is opt-in, never a silent default.
  const ref = process.env.GITHUB_REF_NAME;
  if (ref !== 'main') {
    console.log(
      `Surfaces changed, but this run is on ${ref ? `"${ref}"` : 'an unknown ref'}, not "main" — skipping publish.`,
    );
    return;
  }

  publishPr(result.changedFiles);
}

const __filename = fileURLToPath(import.meta.url);
const isMainModule =
  process.argv[1] === __filename ||
  // Handle tsx rewriting .ts -> .js or vice versa
  process.argv[1]?.replace(/\.ts$/, '.js') === __filename.replace(/\.ts$/, '.js');

if (isMainModule) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
