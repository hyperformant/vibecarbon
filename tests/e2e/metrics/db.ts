/**
 * SQLite database layer for e2e test metrics.
 *
 * Stores structured results from every e2e run so that trends
 * can be compared across commits, branches, and machine configs.
 *
 * Uses WAL mode for concurrent read performance and prepared statements
 * for all queries.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { StepName } from '../scenarios/types.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Absolute path to the project root (three levels up from tests/e2e/metrics/) */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DB_DIR = path.join(PROJECT_ROOT, 'tests', 'results');
const DB_PATH = path.join(DB_DIR, 'e2e.db');

// ---------------------------------------------------------------------------
// Row types returned by queries
// ---------------------------------------------------------------------------

export interface RunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  git_sha: string | null;
  git_branch: string | null;
  vibecarbon_version: string | null;
  overall_status: string;
  machine_info: string | null;
}

export interface ScenarioRow {
  id: string;
  run_id: string;
  mode: string;
  dns_provider: string | null;
  domain: string | null;
  features: string | null;
  /**
   * Cloud provider this scenario deployed against (registry key from
   * `tests/config.ts` `e2e.providers`, e.g. 'hetzner' | 'digitalocean').
   * Column added via migration — pre-existing rows default to 'hetzner'
   * (see `addColumnIfMissing` below), matching the era before multi-provider
   * scenarios existed. Feeds the reporter's per-provider README blocks.
   */
  provider: string;
  status: string;
  error_message: string | null;
  /** Project name (e.g. `testapp-compose-1714…`). Stable per scenario instance. */
  project_name: string | null;
  /** Environment prefix passed to `vibecarbon deploy <env>` (e.g. `e1`). */
  env_prefix: string | null;
  /**
   * Total orphan-resource count surfaced by the post-destroy sweep.
   * Non-zero means `vibecarbon destroy` silently no-op'd on at least one
   * resource type. Subagents query `WHERE orphans_swept > 0` to find
   * destroy regressions across runs (e.g. PR 1BD's 25-firewall pagination
   * bug stayed buried for 5+ runs because this signal wasn't persisted).
   */
  orphans_swept: number;
  /**
   * JSON-encoded {@link SweepBreakdown}: per-category orphan counts so a
   * subagent can route the regression to the right destroy code path.
   */
  orphans_swept_breakdown: string | null;
}

/** Per-category orphan counts persisted to scenarios.orphans_swept_breakdown. */
export interface SweepBreakdown {
  servers: number;
  volumes: number;
  placementGroups: number;
  firewalls: number;
  floatingIps: number;
  networks: number;
  s3Buckets: number;
  sshKeys: number;
  /** DigitalOcean load balancers (CCM-created for k8s Services). Optional so
   *  the Hetzner sweep's historical rows stay shape-compatible. */
  loadBalancers?: number;
}

/**
 * Cold/warm tag for a deploy step.
 *
 * - 'warm' when a prior `deploy` step with status='pass' exists for the same
 *   (project_name, env_prefix) within the last 24h.
 * - 'cold' otherwise (first deploy or stale history).
 *
 * Scope: the tag is recorded on every step, not just `deploy`, so reports can
 * distinguish e.g. cold-vs-warm `verify-deploy` latency too — the tag inherits
 * from the first deploy of the lifecycle and applies to subsequent steps.
 */
export type ColdWarm = 'cold' | 'warm';

export interface StepRow {
  id: string;
  scenario_id: string;
  name: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  command: string | null;
  error_message: string | null;
  error_stack: string | null;
  cold_warm: ColdWarm;
}

export interface MetricRow {
  id: string;
  step_id: string;
  metric_type: string;
  metric_name: string;
  value: number | null;
  recorded_at: string | null;
}

export interface VerificationRow {
  id: string;
  step_id: string;
  check_name: string;
  status: string;
  response_time_ms: number | null;
  error_message: string | null;
  details: string | null;
}

export interface StepTrendRow {
  run_id: string;
  started_at: string | null;
  duration_ms: number | null;
  status: string;
  cold_warm: ColdWarm;
}

export interface RunDetails {
  run: RunRow;
  scenarios: ScenarioRow[];
  steps: StepRow[];
  metrics: MetricRow[];
  verifications: VerificationRow[];
  /**
   * step_id -> the CLI's own wall (`cli.<cmd>.total` perf substep), where the
   * step recorded one. The step wall includes harness tail — most visibly the
   * CLI process lingering after completion on k8s warm deploys (123.5s step
   * vs 6.2s CLI, DO run 32614839037) — so consumers describing CUSTOMER
   * latency must prefer this.
   */
  cliWallByStep: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  git_sha TEXT,
  git_branch TEXT,
  vibecarbon_version TEXT,
  overall_status TEXT DEFAULT 'running',
  machine_info TEXT
);

CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id),
  mode TEXT NOT NULL,
  dns_provider TEXT,
  domain TEXT,
  features TEXT,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  -- Project + env identify the (project_name, env_prefix) tuple that the
  -- cold/warm classifier looks up across runs. Without these we can't
  -- correlate "is this the first time we've seen this env in 24h?".
  project_name TEXT,
  env_prefix TEXT,
  -- Orphan-resource counts surfaced by the post-destroy sweep. Total > 0
  -- means vibecarbon destroy silently no-op'd on at least one resource
  -- type (the sweep is the safety net behind destroy). Subagents query
  -- WHERE orphans_swept > 0 to find destroy regressions across runs.
  -- Breakdown is JSON {servers, volumes, placementGroups, firewalls,
  -- floatingIps, networks, s3Buckets}.
  orphans_swept INTEGER DEFAULT 0,
  orphans_swept_breakdown TEXT
);

CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  scenario_id TEXT REFERENCES scenarios(id),
  name TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  command TEXT,
  error_message TEXT,
  error_stack TEXT,
  -- 'cold' when no prior pass-status deploy step exists for the same
  -- (project_name, env_prefix) within the last 24h; 'warm' otherwise.
  -- Computed at step-insert time (see E2EDb.createStep).
  cold_warm TEXT DEFAULT 'cold'
);

-- Hot path for the cold/warm lookup: SELECT … WHERE name='deploy' AND status='pass'
-- AND scenario.project_name = ? AND scenario.env_prefix = ? AND finished_at >= ?.
-- Without these indexes the lookup degrades to a full scan as runs accumulate.
CREATE INDEX IF NOT EXISTS idx_scenarios_project_env ON scenarios(project_name, env_prefix);
CREATE INDEX IF NOT EXISTS idx_steps_name_status_finished ON steps(name, status, finished_at);

CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  step_id TEXT REFERENCES steps(id),
  metric_type TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  value REAL,
  recorded_at TEXT
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  step_id TEXT REFERENCES steps(id),
  check_name TEXT NOT NULL,
  status TEXT NOT NULL,
  response_time_ms INTEGER,
  error_message TEXT,
  details TEXT
);

-- Per-CLI-invocation sub-stage timings emitted as [perf] stderr lines by
-- VIBECARBON_PERF=1. Persisting them lets reports diff a fresh run's
-- sub-stage durations against P50 of recent green runs to catch perf
-- regressions before they show up as top-level step slowdowns.
CREATE TABLE IF NOT EXISTS perf_substep (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id TEXT REFERENCES steps(id),
  name TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  note TEXT,
  recorded_at TEXT NOT NULL
);

-- Hot path for regression queries: SELECT … WHERE name=? plus an inner
-- join on steps WHERE status='pass' to filter to green-run history.
CREATE INDEX IF NOT EXISTS idx_perf_substep_name ON perf_substep(name);
CREATE INDEX IF NOT EXISTS idx_perf_substep_step ON perf_substep(step_id);
`;

// ---------------------------------------------------------------------------
// E2EDb
// ---------------------------------------------------------------------------

export class E2EDb {
  private db: Database.Database;

  // -- Prepared statements (lazily assigned in constructor) --

  // Runs
  private insertRun: Database.Statement;
  private updateRunComplete: Database.Statement;
  private selectRecentRuns: Database.Statement;
  private selectRunById: Database.Statement;

  // Scenarios
  private insertScenario: Database.Statement;
  private updateScenarioSt: Database.Statement;
  private updateScenarioOrphans: Database.Statement;
  private selectScenariosByRun: Database.Statement;
  private selectScenarioForCold: Database.Statement;

  // Steps
  private insertStep: Database.Statement;
  private updateStepStart: Database.Statement;
  private updateStepComplete: Database.Statement;
  private selectStepsByScenarios: Database.Statement;
  private selectCliWallsByRun: Database.Statement;
  private selectStepTrends: Database.Statement;
  private selectColdWarm: Database.Statement;
  private selectLastGreenScenario: Database.Statement;
  private selectStepsByScenarioId: Database.Statement;
  private selectGreenStepDurations: Database.Statement;

  // Metrics
  private insertMetric: Database.Statement;
  private selectMetricsBySteps: Database.Statement;

  // Verifications
  private insertVerification: Database.Statement;
  private selectVerificationsBySteps: Database.Statement;

  // Perf sub-steps
  private insertPerfSubstep: Database.Statement;
  private selectPerfSubstepBaseline: Database.Statement;
  private selectPerfSubstepsByStep: Database.Statement;

  /**
   * @param dbPath - Optional override for the SQLite file location. Defaults
   *   to `<repo>/tests/results/e2e.db`. Tests pass an in-memory
   *   `:memory:` or a tmp file to keep runs isolated.
   */
  constructor(dbPath?: string) {
    const resolved = dbPath ?? DB_PATH;
    // Ensure the parent dir exists for filesystem-backed DBs. ':memory:' has
    // no parent dir; skip the mkdir to avoid a spurious 'memory:' directory
    // appearing in the cwd.
    if (resolved !== ':memory:') {
      const parent = path.dirname(resolved);
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
      }
    }

    this.db = new Database(resolved);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');
    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // Create tables
    this.db.exec(SCHEMA_SQL);

    // Idempotent column migrations. CREATE TABLE IF NOT EXISTS is a no-op
    // for pre-existing schemas, so add-column migrations have to run as
    // separate ALTERs. SQLite raises "duplicate column name" if the column
    // already exists — swallow that one error code and bubble anything else.
    // Inputs are hardcoded literals, not user input — no SQL-injection risk.
    const addColumnIfMissing = (table: string, column: string, type: string) => {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) throw err;
      }
    };
    addColumnIfMissing('scenarios', 'orphans_swept', 'INTEGER DEFAULT 0');
    addColumnIfMissing('scenarios', 'orphans_swept_breakdown', 'TEXT');
    // Pre-multi-provider rows default to 'hetzner' — the only provider that
    // existed before this column. SQLite resolves the column default for
    // every pre-existing row on read, no backfill UPDATE required.
    addColumnIfMissing('scenarios', 'provider', "TEXT DEFAULT 'hetzner'");

    // -----------------------------------------------------------------------
    // Prepare all statements
    // -----------------------------------------------------------------------

    // Runs
    this.insertRun = this.db.prepare(`
      INSERT INTO runs (id, started_at, git_sha, git_branch, vibecarbon_version, overall_status, machine_info)
      VALUES (?, ?, ?, ?, ?, 'running', ?)
    `);

    this.updateRunComplete = this.db.prepare(`
      UPDATE runs SET finished_at = ?, overall_status = ? WHERE id = ?
    `);

    this.selectRecentRuns = this.db.prepare(`
      SELECT * FROM runs ORDER BY started_at DESC LIMIT ?
    `);

    this.selectRunById = this.db.prepare(`
      SELECT * FROM runs WHERE id = ?
    `);

    // Scenarios
    this.insertScenario = this.db.prepare(`
      INSERT INTO scenarios (id, run_id, mode, dns_provider, domain, features, status, project_name, env_prefix, provider)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);

    this.updateScenarioSt = this.db.prepare(`
      UPDATE scenarios SET status = ?, error_message = ? WHERE id = ?
    `);

    this.updateScenarioOrphans = this.db.prepare(`
      UPDATE scenarios SET orphans_swept = ?, orphans_swept_breakdown = ? WHERE id = ?
    `);

    this.selectScenariosByRun = this.db.prepare(`
      SELECT * FROM scenarios WHERE run_id = ?
    `);

    this.selectScenarioForCold = this.db.prepare(`
      SELECT project_name, env_prefix FROM scenarios WHERE id = ?
    `);

    // Steps
    this.insertStep = this.db.prepare(`
      INSERT INTO steps (id, scenario_id, name, status, command, cold_warm)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `);

    // Cold/warm lookup: any prior PASS deploy step for the same
    // (project_name, env_prefix) in the last 24h => warm. Joins steps with
    // scenarios to filter by project/env. Uses finished_at since started_at
    // can lag for a still-running deploy.
    this.selectColdWarm = this.db.prepare(`
      SELECT 1
      FROM steps s
      JOIN scenarios sc ON s.scenario_id = sc.id
      WHERE s.name = 'deploy'
        AND s.status = 'pass'
        AND sc.project_name = ?
        AND sc.env_prefix = ?
        AND s.finished_at IS NOT NULL
        AND s.finished_at >= ?
      LIMIT 1
    `);

    this.updateStepStart = this.db.prepare(`
      UPDATE steps SET status = 'running', started_at = ? WHERE id = ?
    `);

    this.updateStepComplete = this.db.prepare(`
      UPDATE steps SET status = ?, finished_at = ?, duration_ms = ?, error_message = ?, error_stack = ?
      WHERE id = ?
    `);

    // Steps and downstream data are fetched by run_id via JOINs,
    // avoiding dynamic IN clauses which are incompatible with prepared statements.
    this.selectStepsByScenarios = this.db.prepare(`
      SELECT s.* FROM steps s
      JOIN scenarios sc ON s.scenario_id = sc.id
      WHERE sc.run_id = ?
      ORDER BY s.started_at ASC
    `);

    this.selectCliWallsByRun = this.db.prepare(`
      SELECT p.step_id as step_id, SUM(p.duration_ms) as duration_ms
      FROM perf_substep p
      JOIN steps s ON p.step_id = s.id
      JOIN scenarios sc ON s.scenario_id = sc.id
      WHERE sc.run_id = ? AND p.name LIKE 'cli.%.total'
      GROUP BY p.step_id
    `);

    this.selectStepTrends = this.db.prepare(`
      SELECT sc.run_id as run_id, s.started_at, s.duration_ms, s.status, s.cold_warm
      FROM steps s
      JOIN scenarios sc ON s.scenario_id = sc.id
      JOIN runs r ON sc.run_id = r.id
      WHERE s.name = ?
      ORDER BY r.started_at DESC
      LIMIT ?
    `);

    // Find the most recent green (status='pass') scenario for a given
    // provider + mode + dnsProvider, *excluding* a specific run_id (the
    // current run, so we diff against history rather than ourselves). Used by
    // the diff-vs-green pass to flag regressions and perf drift.
    //
    // `provider` is part of the key for the same reason it is on
    // selectGreenStepDurations below: hetzner/compose-ha and
    // digitalocean/compose-ha both resolve to (compose-ha, cloudflare), so
    // without it a DigitalOcean green becomes the Hetzner baseline (or vice
    // versa) and the timing delta between two different clouds is reported
    // as this run's perf drift — worse, a step that legitimately differs
    // gets failureCategory upgraded to 'regression' and RE-PERSISTED
    // (runner.ts), which also suppresses the E2E_RETRY_FLAKES retry (it
    // fires on 'infra' only). CI legs run fresh dbs, so this bites local
    // multi-provider iteration, where diff-vs-green is most useful.
    this.selectLastGreenScenario = this.db.prepare(`
      SELECT sc.id, sc.run_id, r.started_at
      FROM scenarios sc
      JOIN runs r ON sc.run_id = r.id
      WHERE sc.provider = ?
        AND sc.mode = ?
        AND sc.dns_provider = ?
        AND sc.status = 'pass'
        AND sc.run_id != ?
      ORDER BY r.started_at DESC
      LIMIT 1
    `);

    // Last N green (PASS) durations for a (provider, mode, dnsProvider, step),
    // most-recent first, EXCLUDING the current run. Feeds the README
    // perf-table anomaly guard so a green-but-slow matrix run can't
    // overwrite the fast numbers. `provider` is part of the key so two
    // providers sharing a (mode, dnsProvider) pair never pollute each
    // other's baseline (the anomaly guard is scoped per provider).
    this.selectGreenStepDurations = this.db.prepare(`
      SELECT s.duration_ms as duration_ms
      FROM steps s
      JOIN scenarios sc ON s.scenario_id = sc.id
      JOIN runs r ON sc.run_id = r.id
      WHERE sc.provider = ?
        AND sc.mode = ?
        AND sc.dns_provider = ?
        AND sc.status = 'pass'
        AND s.name = ?
        AND s.status = 'pass'
        AND s.duration_ms IS NOT NULL
        AND sc.run_id != ?
      ORDER BY r.started_at DESC
      LIMIT ?
    `);

    this.selectStepsByScenarioId = this.db.prepare(`
      SELECT name, status, duration_ms FROM steps
      WHERE scenario_id = ?
      ORDER BY started_at ASC
    `);

    // Metrics
    this.insertMetric = this.db.prepare(`
      INSERT INTO metrics (id, step_id, metric_type, metric_name, value, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.selectMetricsBySteps = this.db.prepare(`
      SELECT m.* FROM metrics m
      JOIN steps s ON m.step_id = s.id
      JOIN scenarios sc ON s.scenario_id = sc.id
      WHERE sc.run_id = ?
    `);

    // Verifications
    this.insertVerification = this.db.prepare(`
      INSERT INTO verifications (id, step_id, check_name, status, response_time_ms, error_message, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.selectVerificationsBySteps = this.db.prepare(`
      SELECT v.* FROM verifications v
      JOIN steps s ON v.step_id = s.id
      JOIN scenarios sc ON s.scenario_id = sc.id
      WHERE sc.run_id = ?
    `);

    // Perf sub-steps
    this.insertPerfSubstep = this.db.prepare(`
      INSERT INTO perf_substep (step_id, name, duration_ms, note, recorded_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    // Pull last N green PASS step durations for a given substep name across
    // recent runs — feeds the --perf-regression mode in reporter.ts. Uses
    // p.id DESC as a coarse proxy for recency (auto-increment monotonic;
    // recorded_at is also stored but ID ordering is cheaper and avoids a
    // sort across the whole table).
    this.selectPerfSubstepBaseline = this.db.prepare(`
      SELECT p.duration_ms
      FROM perf_substep p
      JOIN steps s ON p.step_id = s.id
      WHERE p.name = ?
        AND s.status = 'pass'
      ORDER BY p.id DESC
      LIMIT ?
    `);

    this.selectPerfSubstepsByStep = this.db.prepare(`
      SELECT name, duration_ms, note
      FROM perf_substep
      WHERE step_id = ?
      ORDER BY duration_ms DESC
    `);
  }

  // =========================================================================
  // Run management
  // =========================================================================

  createRun(params: {
    id: string;
    gitSha: string;
    gitBranch: string;
    vibecarbonVersion: string;
    machineInfo: object;
  }): void {
    this.insertRun.run(
      params.id,
      new Date().toISOString(),
      params.gitSha,
      params.gitBranch,
      params.vibecarbonVersion,
      JSON.stringify(params.machineInfo),
    );
  }

  completeRun(id: string, status: string): void {
    this.updateRunComplete.run(new Date().toISOString(), status, id);
  }

  // =========================================================================
  // Scenario management
  // =========================================================================

  createScenario(params: {
    id: string;
    runId: string;
    mode: string;
    dnsProvider: string;
    domain: string;
    features: string[];
    projectName: string;
    envPrefix: string;
    /**
     * Cloud provider this scenario deploys against (registry key, e.g.
     * 'hetzner' | 'digitalocean'). Optional so single-provider fixtures
     * predating the multi-provider registry keep compiling — defaults to
     * 'hetzner', matching the scenarios.provider column's migration default.
     */
    provider?: string;
  }): void {
    this.insertScenario.run(
      params.id,
      params.runId,
      params.mode,
      params.dnsProvider,
      params.domain,
      JSON.stringify(params.features),
      params.projectName,
      params.envPrefix,
      params.provider ?? 'hetzner',
    );
  }

  updateScenarioStatus(id: string, status: string, errorMessage?: string): void {
    this.updateScenarioSt.run(status, errorMessage ?? null, id);
  }

  /**
   * Persist post-destroy sweep findings to the scenario row. Total > 0 means
   * `vibecarbon destroy` silently no-op'd on at least one resource type;
   * the breakdown JSON tells subagents which destroy code path to fix.
   * Idempotent — last write wins (sweep runs at most once per scenario).
   */
  recordOrphansSwept(scenarioId: string, breakdown: SweepBreakdown): void {
    const total =
      breakdown.servers +
      breakdown.volumes +
      breakdown.placementGroups +
      breakdown.firewalls +
      breakdown.floatingIps +
      breakdown.networks +
      breakdown.s3Buckets +
      breakdown.sshKeys +
      (breakdown.loadBalancers ?? 0);
    this.updateScenarioOrphans.run(total, JSON.stringify(breakdown), scenarioId);
  }

  // =========================================================================
  // Step management
  // =========================================================================

  createStep(params: {
    id: string;
    scenarioId: string;
    name: StepName;
    command?: string;
    /**
     * Optional override for cold/warm classification. When omitted, the
     * classifier runs `classifyColdWarm` against the scenario's
     * (project_name, env_prefix) tuple in a 24h window. Tests pass an
     * explicit value to make the check deterministic without history.
     */
    coldWarm?: ColdWarm;
  }): void {
    let tag: ColdWarm = params.coldWarm ?? 'cold';
    if (params.coldWarm === undefined) {
      // Resolve project/env from the scenario row. A scenario that wasn't
      // created via createScenario() (or pre-schema-migration rows) has no
      // project_name → default to 'cold'.
      const scenario = this.selectScenarioForCold.get(params.scenarioId) as
        | { project_name: string | null; env_prefix: string | null }
        | undefined;
      if (scenario?.project_name && scenario?.env_prefix) {
        tag = this.classifyColdWarm(scenario.project_name, scenario.env_prefix);
      }
    }
    this.insertStep.run(params.id, params.scenarioId, params.name, params.command ?? null, tag);
  }

  /**
   * Return 'warm' iff a prior PASS `deploy` step for the same
   * (project_name, env_prefix) finished within the last 24h. Else 'cold'.
   *
   * Public + side-effect-free so the lifecycle runner (or tests) can call it
   * directly when a step is recorded outside the normal createStep flow.
   */
  classifyColdWarm(
    projectName: string,
    envPrefix: string,
    windowMs = 24 * 60 * 60 * 1000,
  ): ColdWarm {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const hit = this.selectColdWarm.get(projectName, envPrefix, cutoff);
    return hit ? 'warm' : 'cold';
  }

  startStep(id: string): void {
    this.updateStepStart.run(new Date().toISOString(), id);
  }

  completeStep(
    id: string,
    status: string,
    durationMs: number,
    errorMessage?: string,
    errorStack?: string,
  ): void {
    this.updateStepComplete.run(
      status,
      new Date().toISOString(),
      durationMs,
      errorMessage ?? null,
      errorStack ?? null,
      id,
    );
  }

  // =========================================================================
  // Metrics
  // =========================================================================

  recordMetric(params: {
    stepId: string;
    metricType: string;
    metricName: string;
    value: number;
  }): void {
    this.insertMetric.run(
      randomUUID(),
      params.stepId,
      params.metricType,
      params.metricName,
      params.value,
      new Date().toISOString(),
    );
  }

  // =========================================================================
  // Verifications
  // =========================================================================

  recordVerification(params: {
    stepId: string;
    checkName: string;
    status: string;
    responseTimeMs?: number;
    errorMessage?: string;
    details?: object;
  }): void {
    this.insertVerification.run(
      randomUUID(),
      params.stepId,
      params.checkName,
      params.status,
      params.responseTimeMs ?? null,
      params.errorMessage ?? null,
      params.details ? JSON.stringify(params.details) : null,
    );
  }

  // =========================================================================
  // Perf sub-steps
  // =========================================================================

  /**
   * Persist a batch of [perf] sub-stage timings parsed from a single CLI
   * invocation's stderr. All rows share the parent step_id; the lifecycle
   * runner calls this once per CLI invocation that completes successfully
   * (or partially — partial timings are still useful diagnostic data).
   *
   * Wraps the inserts in a transaction so a 30-row deploy commit happens
   * once, not 30 times.
   */
  recordPerfSubsteps(
    stepId: string,
    timings: Array<{ name: string; ms: number; note?: string }>,
  ): void {
    if (timings.length === 0) return;
    const recordedAt = new Date().toISOString();
    const tx = this.db.transaction((rows: Array<{ name: string; ms: number; note?: string }>) => {
      for (const t of rows) {
        this.insertPerfSubstep.run(stepId, t.name, t.ms, t.note ?? null, recordedAt);
      }
    });
    tx(timings);
  }

  /**
   * Return the most recent N PASS-status durations for a given perf substep
   * name. Caller computes P50/P95 from the array. Returns [] when there is
   * no green history yet.
   */
  getPerfSubstepBaseline(name: string, limit = 10): number[] {
    const rows = this.selectPerfSubstepBaseline.all(name, limit) as Array<{ duration_ms: number }>;
    return rows.map((r) => r.duration_ms);
  }

  /**
   * Return all perf substeps recorded under a given step_id, slowest first.
   * Used by the regression reporter to present the substeps for a run.
   */
  getPerfSubstepsByStep(
    stepId: string,
  ): Array<{ name: string; duration_ms: number; note: string | null }> {
    return this.selectPerfSubstepsByStep.all(stepId) as Array<{
      name: string;
      duration_ms: number;
      note: string | null;
    }>;
  }

  // =========================================================================
  // Queries for reporting
  // =========================================================================

  getRecentRuns(limit = 10): RunRow[] {
    return this.selectRecentRuns.all(limit) as RunRow[];
  }

  getRunDetails(runId: string): RunDetails | null {
    const run = this.selectRunById.get(runId) as RunRow | undefined;
    if (!run) return null;

    const scenarios = this.selectScenariosByRun.all(runId) as ScenarioRow[];
    const steps = this.selectStepsByScenarios.all(runId) as StepRow[];
    const metrics = this.selectMetricsBySteps.all(runId) as MetricRow[];
    const verifications = this.selectVerificationsBySteps.all(runId) as VerificationRow[];
    const cliWallByStep = new Map<string, number>();
    for (const row of this.selectCliWallsByRun.all(runId) as Array<{
      step_id: string;
      duration_ms: number;
    }>) {
      cliWallByStep.set(row.step_id, row.duration_ms);
    }

    return { run, scenarios, steps, metrics, verifications, cliWallByStep };
  }

  getStepTrends(stepName: string, limit = 20): StepTrendRow[] {
    return this.selectStepTrends.all(stepName, limit) as StepTrendRow[];
  }

  /**
   * Return the per-step status + duration from the most recent green
   * (status='pass') scenario matching this provider + mode + dnsProvider.
   * Used by the runner's diff-vs-green pass:
   *   - if a step that was 'pass' last green is 'fail' now, that's a
   *     regression (override failureCategory).
   *   - if a step that was 'pass' last green is much slower now, surface
   *     the delta so perf drift is visible without staring at the trend tab.
   *
   * Excludes the current run so we compare against HISTORY, not ourselves.
   * Returns an empty array when there's no green prior — first-time scenarios
   * (and a provider's first green of a mode another provider already ran)
   * have nothing to compare against.
   */
  getLastGreenStepBaselines(
    provider: string,
    mode: string,
    dnsProvider: string,
    currentRunId: string,
  ): Array<{ name: string; status: string; durationMs: number }> {
    const scenario = this.selectLastGreenScenario.get(provider, mode, dnsProvider, currentRunId) as
      | { id: string; run_id: string; started_at: string }
      | undefined;
    if (!scenario) return [];
    const rows = this.selectStepsByScenarioId.all(scenario.id) as Array<{
      name: string;
      status: string;
      duration_ms: number;
    }>;
    return rows.map((r) => ({ name: r.name, status: r.status, durationMs: r.duration_ms ?? 0 }));
  }

  /**
   * Last `limit` green (PASS) durations for a (provider, mode, dnsProvider,
   * step), most-recent first, EXCLUDING the current run. Feeds the README
   * perf-table anomaly guard (detectPerfAnomalies in reporter.ts): a
   * green-but-slow run shouldn't overwrite the recorded fast numbers.
   * Returns [] when there's no comparable green history yet.
   */
  getGreenStepDurations(
    provider: string,
    mode: string,
    dnsProvider: string,
    stepName: string,
    currentRunId: string,
    limit = 5,
  ): number[] {
    const rows = this.selectGreenStepDurations.all(
      provider,
      mode,
      dnsProvider,
      stepName,
      currentRunId,
      limit,
    ) as Array<{ duration_ms: number }>;
    return rows.map((r) => r.duration_ms);
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  close(): void {
    this.db.close();
  }
}
