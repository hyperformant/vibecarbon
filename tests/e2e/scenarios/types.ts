/**
 * Shared types for e2e test scenarios
 */

export type DeployMode = 'compose' | 'compose-ha' | 'k8s' | 'k8s-ha';
/**
 * Managed-DNS backend a scenario's records live in. Keys match
 * `DNS_PROVIDERS` in src/lib/dns-provider.js — the registry that maps each
 * id to its token env var and provider module. `manual` is the only member
 * with no registry row (it means "operator edits records by hand", so there
 * is no API to drive).
 *
 * DNS provider and cloud provider are independent axes: `digitalocean`,
 * `linode`, and `vultr` name DNS backends here, not compute. They happen to
 * share their compute namesake's API token, which is exactly why a DO
 * scenario on DO DNS needs no credential beyond DIGITALOCEAN_API_TOKEN.
 */
export type DnsProvider = 'hetzner' | 'cloudflare' | 'digitalocean' | 'linode' | 'vultr' | 'manual';
/** Cloud provider a scenario provisions against. Absent/undefined means 'hetzner'. */
export type Provider = 'hetzner' | 'digitalocean' | 'linode' | 'vultr' | 'scaleway';

export interface ScenarioConfig {
  mode: DeployMode;
  dnsProvider: DnsProvider;
  envPrefix: string;
  serverType: string;
  region: string;
  secondaryRegion?: string;
  domain: string;
  features: readonly string[];
  adminEmail: string;
  adminPassword: string;
  scaleToType: string;
  projectName: string;
  projectDir: string;
  testRepoSlug?: string;
  /**
   * Cloud provider this scenario deploys against. Always explicit — every
   * scenario the selection grammar produces (tests/e2e/selection.ts,
   * resolving tests/config.ts `e2e.providers`) carries a real provider,
   * including the release-matrix scenarios (which now say 'hetzner'
   * explicitly rather than relying on an implicit default). Rig sentinels
   * (tests/e2e/scenarios/_run-lifecycle.ts, read by scripts/iter-step.js)
   * are both NAMED by this (`.rig-<provider>-<mode>.json`) and carry it as a
   * field — the two must agree; a disagreement means a hand-edited or stale
   * artifact, never an implicit 'hetzner'.
   */
  provider: Provider;
}

export type StepName =
  | 'create'
  | 'setup-repo'
  | 'add-features'
  | 'deploy'
  | 'verify-deploy'
  // Re-invokes `vibecarbon deploy` against the already-provisioned env to
  // time the no-op convergence path — the push-to-deploy iteration loop
  // customers actually live in after the initial cold deploy.
  | 'warm-deploy'
  // k8s only. Mutates a bundled manifest AND an app source file, re-invokes
  // `vibecarbon deploy` against the EXISTING state, and asserts both changes
  // are live. Deliberately a separate step from `warm-deploy` (which is a
  // curated perf-table column measuring the NO-OP convergence path — making
  // that step mutating would silently redefine a published number and move
  // the anomaly-guard baselines).
  | 'warm-redeploy-change'
  // Lightweight concurrent-burst probe right after verify-deploy. Catches
  // "deploy passed but app is dead under any concurrency" without turning
  // into a sustained load test (operators run those via `pnpm test:loadtest`
  // against a dedicated env). Always runs.
  | 'verify-load'
  // Phase 9: gated on `--expanded` + (mode === 'k8s' || mode === 'k8s-ha').
  // Drives the cluster-autoscaler ceiling end-to-end (load → poll → drain →
  // poll). Only runs in the expanded e2e tier.
  | 'verify-autoscale'
  | 'scale'
  | 'verify-scale'
  | 'backup'
  | 'destroy'
  | 'restore'
  | 'verify-restore'
  | 'failover'
  | 'verify-failover'
  // k8s-ha only. Re-invokes `vibecarbon deploy` after failover to converge
  // the recovered ex-primary to pilot-light (app tier + workers to zero,
  // full serial reseed as the new streaming standby) — proves the DR
  // posture that failover alone leaves degraded is actually restorable.
  | 'reconverge-deploy'
  | 'final-destroy'
  | 'teardown-repo';

/**
 * Why a step (or scenario) failed. Lets a 0/4 morning of "infra is having
 * a bad day" read very differently from a 0/4 morning of real regressions.
 *
 * - infra: external system (Hetzner API 5xx, LE rate limit, k3s download
 *   timeout, DNS, Docker Hub) — not our code.
 * - regression: a step that passed against a recent green commit now fails
 *   with a non-infra error. Set after diff-vs-green analysis.
 * - flake: failed once, passed on retry. Set when retry succeeds.
 * - unknown: doesn't match any pattern; default for unclassified failures.
 */
export type FailureCategory = 'infra' | 'regression' | 'flake' | 'unknown';

/**
 * Diagnostic snippets captured at failure time so a reviewer doesn't have
 * to SSH into a (now-destroyed) box to figure out what went wrong. Each
 * entry is a short label + a stdout/stderr blob (truncated to ~4KB).
 */
export interface DiagnosticSnippet {
  label: string;
  output: string;
  exitCode?: number;
}

export interface StepResult {
  name: StepName;
  status: 'pass' | 'fail' | 'skip' | 'error' | 'pass_after_retry';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  command?: string;
  errorMessage?: string;
  errorStack?: string;
  /** Set when status is fail/error/pass_after_retry. */
  failureCategory?: FailureCategory;
  /** How many attempts the step took (1 = passed first try, 2+ = retried). */
  attempts?: number;
  /** Targeted diagnostics captured at failure time. */
  diagnostics?: DiagnosticSnippet[];
}

export interface VerificationResult {
  checkName: string;
  /**
   * - pass: the check ran and its assertion held.
   * - fail: the check ran and its assertion did NOT hold (reddens the run).
   * - skip: the check could not run because a PRECONDITION was missing (no SSH
   *   handle, feature not enabled, no Chrome, unresolved standby IP). NOT a
   *   pass — a missing precondition must never read as green, which is exactly
   *   the skip-as-pass blindspot this status closes.
   */
  status: 'pass' | 'fail' | 'skip';
  responseTimeMs?: number;
  errorMessage?: string;
  details?: Record<string, unknown>;
}

export interface ResourceMetrics {
  cpuPercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  diskUsedGb: number;
  diskTotalGb: number;
}

export interface HealthLatencies {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface CostSnapshot {
  hourlyEur: number;
  monthlyEur: number;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  durationMs: number;
  exitCode: number;
  /**
   * Sub-stage [perf] timings parsed from the CLI's stderr (sorted slowest
   * first). Empty when VIBECARBON_PERF was off or the command emitted none.
   * cli-runner additionally persists these to perf_substep via the
   * scenarioContext.recordPerfSubsteps hook when available.
   */
  perfLines: Array<{ name: string; ms: number; note?: string }>;
}

export interface ScenarioResult {
  /**
   * Cloud provider registry key ('hetzner' | 'digitalocean' | …). Scenario
   * identity is provider/mode everywhere else (selection grammar, rig
   * sentinels, scenario logs, README perf blocks) and the run summaries need
   * it for the same reason: under `--provider all` two scenarios share a
   * mode, and a summary keyed on mode alone silently renders one cloud's
   * numbers in the other's cell.
   */
  provider: string;
  mode: DeployMode;
  dnsProvider: DnsProvider;
  domain: string;
  status: 'pass' | 'fail' | 'error' | 'pass_after_retry';
  steps: StepResult[];
  errorMessage?: string;
  /** Roll-up of step failureCategory: the worst (regression > infra > flake > unknown). */
  failureCategory?: FailureCategory;
  /** Number of times the scenario was attempted. 1 = no retry, 2 = retried once. */
  attempts?: number;
}

export interface RunResult {
  id: string;
  startedAt: string;
  finishedAt: string;
  gitSha: string;
  gitBranch: string;
  vibecarbonVersion: string;
  overallStatus: 'pass' | 'fail' | 'error';
  scenarios: ScenarioResult[];
}
