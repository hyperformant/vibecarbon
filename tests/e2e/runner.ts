#!/usr/bin/env tsx
/**
 * E2E Test Runner — interactive by default, batch with --batch.
 *
 * Primary entry point for running e2e tests. Executes deployment
 * scenarios step-by-step, pausing after each step in interactive mode so
 * a human (or Claude Code) can inspect output and decide how to proceed.
 *
 * Usage:
 *   pnpm test:e2e                    # Interactive (default; bare = Hetzner four)
 *   pnpm test:e2e -- --batch         # Unattended / CI
 *   pnpm test:e2e -- --scenario hetzner/compose   # Run a single scenario
 *   pnpm test:e2e -- --provider digitalocean      # DO's default selection
 *   pnpm test:e2e -- --provider all               # every provider's defaults
 *   pnpm test:e2e -- --features=observability,redis    # Override feature set
 *   pnpm test:e2e -- --features=              # Run with zero features
 *
 *   Selection grammar (tests/e2e/selection.ts) — scenario tokens are always
 *   `provider/mode` (e.g. `hetzner/k8s-ha`, `digitalocean/compose`), with an
 *   optional `-dnsProvider` refinement (`hetzner/k8s-ha-cloudflare`). Bare
 *   mode tokens and the old opt-in d1/d2/d3 tokens are not accepted — an
 *   invalid token throws a SelectionError (exit 2) naming the valid forms.
 *
 *   Pattern 2 — persistent rig + iterate one step (fastest debug loop):
 *     pnpm test:e2e:batch -- --scenario hetzner/k8s-ha --skip-steps failover --keep
 *     # ^ deploys + verifies, skips failover, leaves infra alive, writes
 *     #   tests/results/.rig-hetzner-k8s-ha.json with the rig coordinates.
 *     node scripts/iter-step.js hetzner/k8s-ha failover  # iterate the step
 *     node scripts/iter-step.js hetzner/k8s-ha destroy   # tear down
 *
 * Environment / credentials:
 *   REAL_INFRA=true              Required — safety gate
 *
 *   The runner resolves API tokens from process.env (CI / explicit shell
 *   export). Spawned CLI subprocesses inherit the same env, so a token set
 *   here is visible to every scenario's deploy/destroy/scale/etc. calls.
 *
 *   Local convenience: copy tests/.env.e2e.example to tests/.env.e2e and
 *   fill in your tokens — setupE2EEnv() (tests/e2e/utils/e2e-env.js) loads it
 *   into process.env at startup, before any token is read below. Real env
 *   always wins (a shell export or CI secret is never overridden).
 *   tests/.env.e2e is gitignored; never commit real tokens.
 *
 *   scripts/iter-step.js calls the SAME setupE2EEnv() + e2eCliEnv(), so a
 *   step iterated against a kept rig runs under the runner's environment.
 *
 *   Which credentials a run needs is registry-driven (tests/config.ts
 *   `e2e.providers[provider].requiredEnv`) — a missing var aborts loudly,
 *   naming exactly the var and pointing at tests/.env.e2e. As of the two
 *   registered providers:
 *   HETZNER_API_TOKEN           Required for Hetzner scenarios (also used for
 *                                Hetzner DNS-01 since the DNS Console was
 *                                retired in May 2026)
 *   CLOUDFLARE_API_TOKEN        Required for Cloudflare-DNS scenarios
 *   DIGITALOCEAN_API_TOKEN      Required for DigitalOcean scenarios
 *                                (--provider digitalocean, opt-in only)
 *   HETZNER_ACCESS_KEY / HETZNER_SECRET_KEY               Required for every Hetzner scenario
 *   DIGITALOCEAN_ACCESS_KEY / DIGITALOCEAN_SECRET_KEY     Required for DigitalOcean scenarios
 *   DOCKER_HUB_USERNAME / DOCKER_HUB_TOKEN             Optional (raises pull rate limit)
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { cpus, hostname, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { testConfig } from '../config.js';
import { MetricsCollector } from './metrics/collector.js';
import { E2EDb } from './metrics/db.js';
import {
  loadPerfData,
  patchInlinePerfMarkers,
  patchReadmeUnifiedPerfTable,
  syncCarbonPerfData,
  updatePerfDataFromRun,
} from './metrics/perf-data.js';
import {
  detectPerfAnomalies,
  formatDuration,
  logRunSummary,
  logScenarioSummary,
  logStepComplete,
  logStepMatrix,
  PERF_ANOMALY_WINDOW,
} from './metrics/reporter.js';
import { runLifecycle } from './scenarios/_run-lifecycle.js';
import type {
  DeployMode,
  DnsProvider,
  Provider,
  ScenarioConfig,
  ScenarioResult,
  StepResult,
} from './scenarios/types.js';
import { resolveSelection, type SelectedScenario, SelectionError } from './selection.js';
import { scenarioContext } from './utils/cli-runner.js';
import { applyDiffVsGreen, type DiffEntry } from './utils/diff-vs-green.js';
import { setupE2EEnv } from './utils/e2e-env.js';
import { remapEnvPrefix, scratchNamePrefix } from './utils/namespace.js';
import { logPreflight, runPreflight } from './utils/preflight.js';
import { overrideDnsProvider, resolveBaseDomain } from './utils/scenario-overrides.js';
import { sweepStaleScratchRepos } from './utils/scratch-repo-sweep.js';

// Establish the harness environment before anything below reads a token or
// opens a socket: public-DNS pinning, ssh-askpass guards, the staging ACME
// directory, the operator's tests/.env.e2e token file, and explicit trust of
// the Let's Encrypt staging roots.
//
// All of it lives in tests/e2e/utils/e2e-env.js because scripts/iter-step.js
// must establish the SAME environment — a step iterated against a kept rig
// has to behave like that step inside a full run. See that module for the
// per-item rationale.
//
// NOTE on TLS: this used to be `NODE_TLS_REJECT_UNAUTHORIZED = '0'`, which
// disabled certificate verification for the whole process — including the
// checks whose job is noticing that a rig is serving the wrong certificate.
// setupE2EEnv() instead adds the four vendored staging roots to the trust
// store (tests/e2e/certs/letsencrypt-staging-roots.pem), so staging chains
// validate and genuinely bad certificates still fail.
setupE2EEnv();

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const batchMode = args.includes('--batch');

// `--scenario a,b,c` (or `--scenario a --scenario b`) — filter to one or
// more scenarios. Tokens are `provider/mode` (e.g. `hetzner/k8s-ha`), with
// an optional `-dnsProvider` refinement for disambiguation
// (`hetzner/k8s-ha-cloudflare`). `--except a,b` drops named scenarios from
// the run (use to skip already-passing scenarios while iterating on the
// failing ones). `--provider a,b` (or `all`) selects which provider(s)'
// default scenarios run when `--scenario` is omitted, and scopes which
// providers `--scenario` tokens may name. All three compose — see
// tests/e2e/selection.ts (`resolveSelection`) for the full grammar and
// error messages.
function parseListArg(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      out.push(
        ...args[i + 1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (args[i].startsWith(`${flag}=`)) {
      out.push(
        ...args[i]
          .slice(flag.length + 1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
  }
  return out;
}
const scenarioInclude = parseListArg('--scenario');
const scenarioExclude = parseListArg('--except');
// `--provider hetzner,digitalocean` or `--provider all`. REQUIRED unless
// `--scenario` tokens name providers themselves: resolveSelection() throws
// rather than pick a default, because no provider is privileged.
const providerArg = parseListArg('--provider');

// `--keep-on-fail` — sugar for VC_KEEP_ON_FAILURE=1 (lifecycle reads the
// env var). Skips final-destroy + teardown-repo + sweep when a scenario
// fails so the operator can iterate against the surviving infra.
if (args.includes('--keep-on-fail')) {
  process.env.VC_KEEP_ON_FAILURE = '1';
}

// `--keep` — always-keep variant of --keep-on-fail. Skips cleanup
// regardless of pass/fail, so the operator can stand up a "test rig"
// (full deploy minus the failing step) once and then iterate the
// failing step against it many times via the CLI directly:
//   pnpm test:e2e:batch -- --scenario hetzner/k8s-ha --skip-steps failover,verify-failover --keep
//   # ... rig is now alive; project dir + env logged below ...
//   cd <projectDir> && vibecarbon failover <env> -y   # iterate
if (args.includes('--keep')) {
  process.env.VC_KEEP_ALWAYS = '1';
}

// `--skip-steps a,b,c` — drops named steps from the lifecycle. Use to
// shorten the iteration loop when the failing step doesn't depend on
// the skipped ones (e.g., to test failover, skip scale/backup/restore).
// `--minimal` — preset shortcut: skips scale/verify-scale/backup/destroy/
// restore/verify-restore. Cuts HA scenarios from ~60min → ~25min while
// still exercising deploy → verify-deploy → failover → verify-failover.
function parseSkipStepsArg(): Set<string> {
  const skip = new Set<string>();
  if (args.includes('--minimal')) {
    for (const s of ['scale', 'verify-scale', 'backup', 'destroy', 'restore', 'verify-restore']) {
      skip.add(s);
    }
  }
  const addAll = (raw: string) => {
    for (const s of raw
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)) {
      skip.add(s);
    }
  };
  const eqIdx = args.findIndex((a) => a.startsWith('--skip-steps='));
  if (eqIdx !== -1) {
    addAll(args[eqIdx].slice('--skip-steps='.length));
  }
  const spIdx = args.indexOf('--skip-steps');
  if (spIdx !== -1 && spIdx + 1 < args.length && !args[spIdx + 1].startsWith('--')) {
    addAll(args[spIdx + 1]);
  }
  return skip;
}
const skipSteps = parseSkipStepsArg();
// Phase 9: opt-in expanded e2e tier. Adds verify-autoscale (and, in
// follow-up phases, verify-status / verify-diagnose / configure-cicd add-on)
// to k8s + k8s-ha lifecycles. NOT wired into PR CI — for nightly/manual runs
// where the +25-min CA scale-up/down poll is acceptable.
const expanded = args.includes('--expanded');

/**
 * Parse `--features=a,b,c` (or `--features a,b,c`). Empty string → no features.
 * Returns `null` when the flag is absent, so we can fall back to the config
 * default without conflating "flag omitted" with "flag present but empty".
 */
function parseFeaturesArg(): string[] | null {
  const eqIdx = args.findIndex((a) => a.startsWith('--features='));
  if (eqIdx !== -1) {
    const raw = args[eqIdx].slice('--features='.length);
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const spIdx = args.indexOf('--features');
  if (spIdx !== -1 && spIdx + 1 < args.length) {
    return args[spIdx + 1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return null;
}
const featuresOverride = parseFeaturesArg();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

function getVibecarbonVersion(): string {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'));
  return pkg.version as string;
}

/**
 * Retrieve git metadata for the current HEAD.
 *
 * SECURITY: Uses execFileSync (no shell) with hardcoded arguments —
 * no user input reaches these calls.
 */
function getGitInfo(): { sha: string; branch: string } {
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    encoding: 'utf-8',
  }).trim();
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf-8',
  }).trim();
  return { sha, branch };
}

function getMachineInfo(): Record<string, unknown> {
  return {
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    totalMemMb: Math.round(totalmem() / 1_048_576),
  };
}

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------

function createPrompt(): { ask: (question: string) => Promise<string>; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (question: string) => new Promise((res) => rl.question(question, res)),
    close: () => rl.close(),
  };
}

/**
 * Create the step callback. In interactive mode, pauses for user input.
 * In batch mode, always continues automatically.
 */
function createStepHandler(
  prompt: ReturnType<typeof createPrompt>,
): (step: StepResult) => Promise<'continue' | 'skip' | 'abort'> {
  if (batchMode) {
    return async () => 'continue';
  }

  return async (step: StepResult): Promise<'continue' | 'skip' | 'abort'> => {
    logStepComplete(step.name, step.name, step.durationMs, step.status);

    if (step.status === 'fail' || step.status === 'error') {
      console.log(`\n  Error: ${step.errorMessage ?? 'unknown'}\n`);
    }

    const answer = await prompt.ask('\n  [Enter] continue  |  [s] skip remaining  |  [q] quit → ');
    const choice = answer.trim().toLowerCase();

    if (choice === 's') return 'skip';
    if (choice === 'q') return 'abort';
    return 'continue';
  };
}

// ---------------------------------------------------------------------------
// Runner options / result types (internal — the runner is the only entry
// point; the legacy e2e.test.ts vitest wrapper that consumed these is gone)
// ---------------------------------------------------------------------------

interface RunnerOptions {
  batch: boolean;
  /**
   * Scenarios to include. Each entry is a `provider/mode` token (e.g.
   * `hetzner/k8s-ha`) or its `-dnsProvider` refinement (e.g.
   * `hetzner/k8s-ha-cloudflare`) — see tests/e2e/selection.ts. When
   * undefined or empty, runs `providers`' default selection (subject to
   * `scenarioExclude`).
   */
  scenarioFilter?: string | string[];
  /**
   * Scenarios to drop from the run. Same token grammar as `scenarioFilter`.
   * Use to skip already-passing scenarios while iterating on the failing
   * ones (e.g. `--except hetzner/k8s,hetzner/compose` after both have
   * proven green).
   */
  scenarioExclude?: string[];
  /**
   * Cloud provider(s) to run, or `['all']`. Required unless `scenarioFilter`
   * names providers explicitly — there is no default provider, and
   * resolveSelection() throws if neither is given.
   */
  providers?: string[];
  /**
   * Feature set to use for each scenario. Overrides `config.e2e.features`
   * when provided. Pass `[]` to run with no optional services. When omitted,
   * falls back to the CLI `--features=` flag, then to the config default.
   */
  features?: readonly string[];
  /**
   * Phase 9: when true, runs the expanded e2e tier — adds the
   * verify-autoscale step (gated on k8s/k8s-ha modes) for nightly/manual runs.
   * Default lifecycle is unchanged when false.
   */
  expanded?: boolean;
  /**
   * Steps to drop from the lifecycle entirely (skip without recording as
   * "skipped due to prior failure"). Used by `--skip-steps` / `--minimal`
   * to shorten the iteration loop when the failing step doesn't depend
   * on what we're skipping.
   */
  skipSteps?: Set<string>;
}

interface RunnerResult {
  runId: string;
  status: 'pass' | 'fail';
  results: ScenarioResult[];
}

/**
 * Fail fast if a host-side dep needed by the selected scenarios is missing.
 * `gh` is always required (every mode hits `ensureCIImageReady` via a throwaway
 * repo). `kubectl` is only required for k8s / k8s-ha — chart installs now go
 * through Flux (applied as CRs via kubectl), so no local `helm` is needed.
 * We also check that `gh` is authenticated.
 *
 * `requiresGh: false` waives both gh checks — gh only serves the
 * setup-repo/teardown-repo steps (throwaway GitHub repo for the retired
 * CI-image path), so a run that skips setup-repo (--skip-steps, e.g. the
 * CI US-perf workflow) needs no gh auth at all. Deploy's own gh use in
 * the matrix's build modes is nil (destroy's environment cleanup is
 * best-effort try/catch).
 */
function checkLocalDependencies(modes: DeployMode[], requiresGh = true): void {
  const which = (bin: string): boolean => {
    try {
      execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  };

  const missing: string[] = [];
  if (requiresGh && !which('gh')) {
    missing.push('gh — install from https://cli.github.com, then `gh auth login`');
  }
  // Pulumi drives provisioning for every deploy mode (compose + k8s + HA).
  if (!which('pulumi')) {
    missing.push(
      'pulumi — install with `curl -fsSL https://get.pulumi.com | sh` (no sudo; drops binary in ~/.pulumi/bin)',
    );
  }
  // k8s modes need kubectl on the host to interact with the cluster.
  const needsKube = modes.some((m) => m === 'k8s' || m === 'k8s-ha');
  if (needsKube) {
    if (!which('kubectl'))
      missing.push('kubectl — install from https://kubernetes.io/docs/tasks/tools/');
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing host-side dependencies for selected scenarios:\n  - ${missing.join('\n  - ')}`,
    );
  }

  if (requiresGh && which('gh')) {
    try {
      execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
    } catch {
      throw new Error('`gh` is not authenticated. Run `gh auth login` and retry.');
    }
  }
}

/**
 * Run all (or filtered) e2e scenarios.
 * Called directly as a script (interactive) or from Vitest (batch).
 */
async function runE2E(overrides?: Partial<RunnerOptions>): Promise<RunnerResult> {
  const isBatch = overrides?.batch ?? batchMode;
  // Include/exclude tokens are `provider/mode` grammar (tests/e2e/selection.ts).
  // `overrides.scenarioFilter` accepts a bare string for back-compat with
  // the old single-value callers; normalize to an array before handing off
  // to resolveSelection.
  const rawInclude = overrides?.scenarioFilter ?? scenarioInclude;
  const include: string[] = Array.isArray(rawInclude) ? rawInclude : rawInclude ? [rawInclude] : [];
  const exclude: string[] = overrides?.scenarioExclude ?? scenarioExclude;
  const providers: string[] = overrides?.providers ?? providerArg;
  const featureOverride = overrides?.features ?? featuresOverride;
  const isExpanded = overrides?.expanded ?? expanded;

  // tests/.env.e2e (gitignored operator token file — see
  // tests/.env.e2e.example) was already folded into process.env by
  // setupE2EEnv() at module load, before any token below is read. Real env
  // wins: a key already exported in the shell or set by CI (GitHub
  // Environments) is left untouched. Missing file is a no-op — this replaced
  // the retired credentials.json e2e profile (A5/A6); every read below is
  // unchanged from before that loader existed.

  // Resolve API tokens from process.env — CI/CD sets these via GitHub
  // Environments; local runs export them in the shell (or tests/.env.e2e,
  // just folded in above).
  //
  // Resolved but not required yet — whether HETZNER_API_TOKEN is actually
  // needed depends on which scenarios end up selected (see the
  // registry-driven credential gate below); a DO-only run
  // (`--provider digitalocean`) has no Hetzner dependency.
  const hetznerToken = process.env.HETZNER_API_TOKEN || '';

  const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN || '';

  // DIGITALOCEAN_API_TOKEN — only required when a selected scenario's
  // provider is 'digitalocean' — see the registry-driven credential gate
  // below.
  const digitaloceanToken = process.env.DIGITALOCEAN_API_TOKEN || '';

  // LINODE_API_TOKEN — only required when a selected scenario's provider is
  // 'linode' (registry-driven gate below); threaded into the lifecycle for
  // its own API operations (verify-scale snapshots, firewall ops, sweep).
  const linodeToken = process.env.LINODE_API_TOKEN || '';

  // VULTR_API_TOKEN — only required when a selected scenario's provider is
  // 'vultr' (registry-driven gate below); threaded into the lifecycle for
  // its own API operations (verify-scale snapshots, firewall ops, sweep).
  const vultrToken = process.env.VULTR_API_TOKEN || '';

  // SCALEWAY_SECRET_KEY — only required when a selected scenario's provider is
  // 'scaleway' (registry-driven gate below; the gate also demands the
  // SCALEWAY_ACCESS_KEY/SCALEWAY_DEFAULT_PROJECT_ID companions from requiredEnv).
  const scalewayToken = process.env.SCALEWAY_SECRET_KEY || '';

  // Determine which scenarios to run. resolveSelection (tests/e2e/selection.ts)
  // is the single source of truth for provider/mode token parsing,
  // defaults, and validation — an invalid token (unknown provider, bare
  // mode, a scenario outside an explicit --provider pool, ...) throws a
  // SelectionError with an actionable message; print it and exit 2 rather
  // than let a raw stack trace reach the operator.
  const config = testConfig.e2e;
  let selected: SelectedScenario[];
  try {
    selected = resolveSelection({ providers, include, exclude });
  } catch (err) {
    if (err instanceof SelectionError) {
      console.error(`\n${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  // resolveSelection's `provider`/`dnsProvider` fields are typed as plain
  // `string` (the module is generic over the registry shape), but every
  // value it can ever produce is one of the registry's real
  // Provider/DnsProvider literals — this narrowing is a pure type-level
  // move, no runtime change, so the rest of the pipeline
  // (overrideDnsProvider, ScenarioConfig construction below) keeps its
  // existing literal-typed contracts. Mirrors the old (now-removed)
  // ScenarioSeed narrowing.
  type ResolvedSelection = Omit<SelectedScenario, 'dnsProvider' | 'provider'> & {
    // Every automated-DNS backend, i.e. DnsProvider minus 'manual'. The
    // registry can't produce 'manual' — a scenario always drives DNS through
    // an API — so excluding it here keeps the narrowing honest rather than
    // widening to the full union and forcing downstream `manual` handling
    // that could never run.
    dnsProvider: Exclude<DnsProvider, 'manual'>;
    provider: Provider;
  };
  const narrowedSelection = selected as unknown as ResolvedSelection[];

  // DNS-provider override (E2E_DNS_PROVIDER): perf-focused runs pin every
  // scenario to one provider so DNS variance stays out of the numbers and a
  // hetzner-only run needs no Cloudflare credential. Must apply before the
  // needsCloudflare gate below.
  const filteredScenarios = overrideDnsProvider(narrowedSelection, process.env.E2E_DNS_PROVIDER);
  if (process.env.E2E_DNS_PROVIDER) {
    console.log(`  DNS provider override (E2E_DNS_PROVIDER): ${process.env.E2E_DNS_PROVIDER}`);
  }
  if (process.env.E2E_DOMAIN) {
    console.log(`  Base domain override (E2E_DOMAIN): ${process.env.E2E_DOMAIN.trim()}`);
  }

  // Fail on a selection that resolved to zero scenarios (e.g. --except
  // cancels out every included scenario) BEFORE the credential-gating
  // checks below — an empty scenario list makes those vacuously pass,
  // which would otherwise mask "nothing to run" behind a misleading
  // "preflight passed trivially" detour. (Invalid tokens/providers/modes
  // already threw a SelectionError above — this only catches a
  // syntactically valid selection that nets to nothing.)
  if (filteredScenarios.length === 0) {
    const filterDesc = [
      providers.length > 0 ? `--provider=${providers.join(',')}` : '',
      include.length > 0 ? `--scenario=${include.join(',')}` : '',
      exclude.length > 0 ? `--except=${exclude.join(',')}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    throw new Error(`No scenarios match '${filterDesc || '(default selection)'}'.`);
  }

  // Registry-driven credential gating: every provider a selected scenario
  // belongs to names its required env vars in tests/config.ts
  // `e2e.providers[provider].requiredEnv`; union them across the selection
  // and abort loudly naming exactly what's missing. Adding a new provider
  // to the registry gets this check for free — no runner.ts edit needed.
  const providersRegistry = testConfig.e2e.providers as unknown as Record<
    string,
    { requiredEnv: readonly string[] }
  >;
  const requiredEnvVars = new Set<string>();
  for (const s of filteredScenarios) {
    for (const v of providersRegistry[s.provider].requiredEnv) requiredEnvVars.add(v);
  }

  // Same gate, DNS axis: each selected scenario's dnsProvider names its
  // credential in DNS_PROVIDERS (src/lib/dns-provider.js), the DNS-side twin
  // of the compute registry above. This replaced a hard-coded
  // `needsCloudflare && !CLOUDFLARE_API_TOKEN` check that knew about exactly
  // one backend — a scenario on DigitalOcean or Linode DNS sailed past it
  // and failed much later at record creation.
  //
  // A Set is doing real work here, not just tidiness: the compute-backed DNS
  // backends share their compute sibling's token (DNS_PROVIDERS.linode
  // .tokenEnv === LinodeProvider.TOKEN_ENV), so a Linode/Linode-DNS scenario
  // adds nothing to this set and needs no second credential. Only Cloudflare
  // — which has no compute sibling — ever contributes a genuinely new var.
  const { DNS_PROVIDERS } = (await import('../../src/lib/dns-provider.js')) as {
    DNS_PROVIDERS: Record<string, { tokenEnv: string }>;
  };
  const selectedDnsProviders = [...new Set(filteredScenarios.map((s) => s.dnsProvider))];
  for (const id of selectedDnsProviders) {
    const row = DNS_PROVIDERS[id];
    if (!row) {
      throw new Error(
        `Scenario selection names DNS provider '${id}', which has no DNS_PROVIDERS row ` +
          `(src/lib/dns-provider.js). Known: ${Object.keys(DNS_PROVIDERS).join(', ')}.`,
      );
    }
    requiredEnvVars.add(row.tokenEnv);
  }

  const missingEnvVars = [...requiredEnvVars].filter((v) => !process.env[v]);
  if (missingEnvVars.length > 0) {
    throw new Error(
      `Missing required credential(s) for the selected scenarios: ${missingEnvVars.join(', ')}. ` +
        'Set them in your shell env or tests/.env.e2e (copy tests/.env.e2e.example).',
    );
  }

  // Still needed below — which infra dependencies to health-ping at
  // preflight. The registry check above already hard-gated on the tokens
  // actually being present.
  const needsHetzner = filteredScenarios.some((s) => s.provider === 'hetzner');
  const needsDigitalOcean = filteredScenarios.some((s) => s.provider === 'digitalocean');
  const needsLinode = filteredScenarios.some((s) => s.provider === 'linode');
  const needsVultr = filteredScenarios.some((s) => s.provider === 'vultr');
  const needsScaleway = filteredScenarios.some((s) => s.provider === 'scaleway');

  // Verify host-side deps up front — deploy already fails the same way deep
  // inside a scenario, but we'd rather catch "helm missing" in <1s than after
  // a 10-minute k8s provision.
  checkLocalDependencies(
    // `mode` comes back from resolveSelection as plain `string` (see the
    // ResolvedSelection narrowing above) but is always one of DeployMode's
    // literals — the registry never produces anything else.
    filteredScenarios.map((s) => s.mode as DeployMode),
    !skipSteps.has('setup-repo'),
  );

  // Pre-matrix infra preflight: 30-second sanity ping of every external
  // dependency. Surfaces "today is a bad day at Hetzner/Cloudflare" before
  // we burn 30+ minutes per scenario discovering it. Skip with
  // E2E_PREFLIGHT=skip when re-running after a fix you trust.
  const needsCloudflare = selectedDnsProviders.includes('cloudflare');
  // One descriptor per DISTINCT dnsProvider in the selection — preflight
  // proves each backend's token actually lists zones AND that the zone the
  // scenarios will write into is visible to it. Resolving the base domain
  // here (not in preflight) keeps E2E_DOMAIN handling in exactly one place;
  // it throws for a dnsProvider with no domains-map entry, which is the
  // intended fail-fast (scenario-overrides.ts).
  const dnsChecks = selectedDnsProviders.map((id) => ({
    dnsProvider: id,
    token: process.env[DNS_PROVIDERS[id].tokenEnv] || '',
    baseDomain: resolveBaseDomain(config.domains, id, process.env.E2E_DOMAIN),
  }));
  if (process.env.E2E_PREFLIGHT !== 'skip') {
    const preflight = await runPreflight({
      hetznerToken,
      cloudflareToken,
      needsCloudflare,
      needsHetzner,
      digitaloceanToken,
      needsDigitalOcean,
      linodeToken,
      needsLinode,
      vultrToken,
      needsVultr,
      scalewayToken,
      needsScaleway,
      dnsChecks,
    });
    const proceed = logPreflight(preflight);
    if (!proceed) {
      // Hard fail before we provision anything. Returning 'fail' here keeps
      // exit codes meaningful for CI.
      throw new Error('Preflight failed — at least one infra dependency is down.');
    }
    // Hygiene, not a gate: delete machine-named scratch repos (vc-e2e-*)
    // whose last push is older than the kept-rig doctrine's useful life —
    // teardown-repo only deletes on green runs, and the failed/kept-run
    // leftovers had accumulated to 99 repos by the 2026-08-28 audit. Fails
    // open by contract (see scratch-repo-sweep.ts).
    await sweepStaleScratchRepos({});
  }

  // The effective feature set for this run — CLI override wins over the
  // baseline in tests/config.ts. An empty `--features=` is honored (no
  // optional services); omitting the flag keeps the baseline.
  const effectiveFeatures: readonly string[] = featureOverride ?? config.features;

  // (The hand-rolled `needsCloudflare && !cloudflareToken` throw that used to
  // sit here is gone — the registry-driven DNS credential gate above covers
  // Cloudflare along with every other backend, and covers it EARLIER, before
  // preflight rather than after.)

  // Capacity resolution: pick concrete (region, serverType, scaleToType) per
  // scenario from `capacityPreferences` so the matrix doesn't trip on Hetzner
  // per-DC capacity flux mid-run. HA scenarios get TWO distinct regions both
  // with the same type-pair (so primary/standby can't end up on different
  // arch families).
  const { resolveCapacity, resolveCapacityPair, overrideRegions } = await import(
    './utils/region-resolver.js'
  );
  // E2E_REGIONS (Hetzner location names) only ever applied to the Hetzner
  // block — same override this env var has always driven. The
  // DigitalOcean block has no override knob (DO scenarios are opt-in
  // reference runs, not the perf-tracked CI matrix E2E_REGIONS targets).
  const hetznerCapacityPrefs = overrideRegions(
    config.capacityPreferences.hetzner,
    process.env.E2E_REGIONS,
  );
  const digitaloceanCapacityPrefs = config.capacityPreferences.digitalocean;
  const linodeCapacityPrefs = config.capacityPreferences.linode;
  const vultrCapacityPrefs = config.capacityPreferences.vultr;
  const scalewayCapacityPrefs = config.capacityPreferences.scaleway;
  if (process.env.E2E_REGIONS) {
    console.log(`  Region override (E2E_REGIONS): ${hetznerCapacityPrefs.regions.join(', ')}`);
  }

  // Throw-on-unknown capacity/token registry. The previous shape here was a
  // binary `provider === 'digitalocean' ? … : hetzner…` ternary — the last
  // surviving default-else of the 2026-08-07 de-defaulting audit — which
  // silently handed an unknown provider id Hetzner's capacity preferences
  // AND Hetzner's token. Same pattern as region-resolver's
  // CAPACITY_RESOLVERS and _run-lifecycle's providerTokenFor: an
  // unregistered id fails loudly at the dispatch site.
  const capacityWiring: Record<
    string,
    {
      prefs: { regions: readonly string[]; typePairs: readonly (readonly [string, string])[] };
      token: string;
    }
  > = {
    hetzner: { prefs: hetznerCapacityPrefs, token: hetznerToken },
    digitalocean: { prefs: digitaloceanCapacityPrefs, token: digitaloceanToken },
    linode: { prefs: linodeCapacityPrefs, token: linodeToken },
    vultr: { prefs: vultrCapacityPrefs, token: vultrToken },
    scaleway: { prefs: scalewayCapacityPrefs, token: scalewayToken },
  };
  const capacityWiringFor = (provider: string) => {
    const entry = capacityWiring[provider];
    if (!entry) {
      throw new Error(
        `no capacity/token wiring for provider '${provider}' — add it to capacityWiring in runner.ts`,
      );
    }
    return entry;
  };
  // Namespace isolation (E2E_NAMESPACE): remap env prefixes so CI's DNS
  // records (ci1.* .. ci4.*) never collide with a concurrent local run's
  // (e1.* .. e4.*). Project names get the same treatment at scenario start.
  const namespacedScenarios = filteredScenarios.map((s) => ({
    ...s,
    envPrefix: remapEnvPrefix(s.envPrefix),
  }));
  // Anchored on namespacedScenarios (POST envPrefix remap): the remap widens
  // envPrefix to string, so the pre-remap literal types can never admit the
  // remapped values.
  type ResolvedScenario = (typeof namespacedScenarios)[number] & {
    serverType: string;
    region: string;
    secondaryRegion?: string;
    scaleToType: string;
  };
  const scenarios: ResolvedScenario[] = [];
  console.log('\n  Resolving capacity:');
  for (const s of namespacedScenarios) {
    // Selection always sets `provider` (registry-driven), and the wiring
    // registry throws on an unregistered id — no silent Hetzner fallback.
    const provider = s.provider;
    const { prefs: capacityPrefs, token } = capacityWiringFor(provider);
    const isHa = s.mode.endsWith('-ha');
    if (isHa) {
      const pair = await resolveCapacityPair(capacityPrefs, token, { provider });
      console.log(
        `    ${s.mode.padEnd(10)} (${provider}) → primary ${pair.primary.region}/${pair.primary.serverType}→${pair.primary.scaleToType}, ` +
          `standby ${pair.standby.region}/${pair.standby.serverType}→${pair.standby.scaleToType}`,
      );
      scenarios.push({
        ...s,
        serverType: pair.primary.serverType,
        region: pair.primary.region,
        secondaryRegion: pair.standby.region,
        scaleToType: pair.primary.scaleToType,
      });
    } else {
      const r = await resolveCapacity(capacityPrefs, token, { provider });
      console.log(
        `    ${s.mode.padEnd(10)} (${provider}) → ${r.region}/${r.serverType}→${r.scaleToType}`,
      );
      scenarios.push({
        ...s,
        serverType: r.serverType,
        region: r.region,
        scaleToType: r.scaleToType,
      });
    }
  }

  // Initialize DB and metrics
  const runId = randomUUID();
  const db = new E2EDb();
  const collector = new MetricsCollector(db);
  const git = getGitInfo();

  db.createRun({
    id: runId,
    gitSha: git.sha,
    gitBranch: git.branch,
    vibecarbonVersion: getVibecarbonVersion(),
    machineInfo: getMachineInfo(),
  });

  // Create temp directory for test projects
  const tempDir = join(tmpdir(), `vibecarbon-e2e-${runId}`);
  mkdirSync(tempDir, { recursive: true });

  // Set up interactive prompt (only used in interactive mode)
  const prompt = createPrompt();
  const onStepComplete = createStepHandler(
    isBatch ? { ask: async () => '', close: () => {} } : prompt,
  );

  // Print header
  console.log('\n=== Vibecarbon E2E Test Runner ===\n');
  console.log(`  Mode:       ${isBatch ? 'batch (unattended)' : 'interactive'}`);
  console.log(`  Scenarios:  ${scenarios.map((s) => s.mode).join(', ')}`);
  console.log(
    `  Features:   ${effectiveFeatures.length === 0 ? '(none)' : effectiveFeatures.join(', ')}`,
  );
  if (isExpanded) {
    console.log('  Tier:       expanded (k8s/k8s-ha get verify-autoscale)');
  }
  console.log('');

  if (!isBatch) {
    console.log('  After each step you can:');
    console.log('    [Enter] continue to next step');
    console.log('    [s]     skip remaining steps (runs cleanup)');
    console.log('    [q]     quit (runs cleanup)\n');
  }

  // Scenarios run serially — one full deploy→…→destroy lifecycle at a time.
  // Parallel batch execution was tried and pulled (2026-05/06): driving all
  // four scenarios at once from one operator host manufactured failures no
  // customer ever sees — shared Pulumi-on-S3 503 throttles, local-host
  // saturation that starved the frontend_render browser check, and fresh-cluster
  // cert-manager lag under concurrent provisions. The robustness hardening that
  // came out of that work (state-backend 503 retry in iac, frontend_render
  // hydration polling, cert-manager budgeted readiness poll) is kept because it
  // helps serial too; the parallel scheduling machinery was removed. Each
  // scenario still gets a unique project name, scenarioId, and projectDir;
  // [mode]-prefixed log lines keep a single scenario greppable.

  // Collect diff entries across all scenarios so the run summary can show
  // a "vs last green" footer in one place at the end. Declared up-front
  // (rather than below the closures that push to it) to avoid TDZ.
  const collectedDiffEntries: Array<{ mode: string } & DiffEntry> = [];

  /**
   * Run a single attempt of a scenario. Returns the ScenarioResult plus a
   * boolean signaling whether a retry should be considered. Pulled out as a
   * named helper so the retry-on-flake wrapper (below) can call it twice
   * with fresh project/scenario IDs without copying 80 lines.
   */
  const runScenarioOnce = async (
    scenario: (typeof scenarios)[number],
    attemptNumber: number,
  ): Promise<ScenarioResult> => {
    const { mode, dnsProvider, envPrefix, serverType, region, scaleToType } = scenario;
    const secondaryRegion = scenario.secondaryRegion;
    const provider = scenario.provider;
    const domain = `${envPrefix}.${resolveBaseDomain(config.domains, dnsProvider, process.env.E2E_DOMAIN)}`;
    // Unique per scenario — Date.now() collisions are rare, but the random
    // suffix is cheap insurance. Retries get a fresh timestamp + suffix so
    // the project dir / Hetzner names don't collide with the first attempt's
    // residue (sweep should have cleared, but cheap insurance).
    const timestamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const projectName = `${scratchNamePrefix()}${mode}-${timestamp}`;
    const projectDir = join(tempDir, projectName);
    const scenarioId = randomUUID();
    if (attemptNumber > 1) {
      console.log(
        `\n${'='.repeat(60)}\n  RETRY ${attemptNumber - 1}: ${mode} (was infra-flake)\n${'='.repeat(60)}\n`,
      );
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  Scenario: ${mode} on ${dnsProvider} (${domain})`);
    console.log(`${'='.repeat(60)}\n`);

    // Best-effort local resolver cache flush. The scenario's domain flips
    // between existing and NXDOMAIN across runs, and systemd-resolved
    // negative-caches NXDOMAIN for the zone's SOA minimum TTL (an hour on
    // Hetzner DNS) — a stale entry seeded by a prior run's teardown window
    // or failure diagnostics then breaks every system-resolver consumer
    // (browser checks, psql, openssl) for the whole scenario. The deploy's
    // own probe pins public DNS; the rest of the harness needs this flush.
    // `resolvectl flush-caches` works unprivileged; absent/failing (macOS,
    // no systemd) is fine — fail open.
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('resolvectl', ['flush-caches'], { stdio: 'ignore', timeout: 5_000 });
    } catch {
      /* no resolvectl or no systemd-resolved — nothing to flush */
    }

    const scenarioConfig: ScenarioConfig = {
      mode: mode as DeployMode,
      dnsProvider,
      envPrefix,
      serverType,
      region,
      ...(secondaryRegion && { secondaryRegion }),
      domain,
      features: effectiveFeatures,
      adminEmail: config.adminEmail,
      adminPassword: config.adminPassword,
      scaleToType,
      projectName,
      projectDir,
      provider,
    };

    db.createScenario({
      id: scenarioId,
      runId,
      mode,
      dnsProvider,
      domain,
      features: [...effectiveFeatures],
      // (project_name, env_prefix) tuple drives the cold/warm classifier in
      // db.classifyColdWarm — without these the scenario's steps default to
      // 'cold' regardless of run history.
      projectName,
      envPrefix,
      provider,
    });

    const isHa = mode.endsWith('-ha');
    let result: ScenarioResult;

    // Per-scenario live log file. cli-runner reads logPath/echo out of this
    // AsyncLocalStorage context so every subprocess's stdout/stderr is
    // tee'd to ${tempDir}/${provider}-${mode}-${dnsProvider}.log as it
    // arrives — live-tailable. Since scenarios run serially we always echo
    // to process.stdout.
    //
    // All three parts are load-bearing: provider because `--provider all`
    // runs hetzner/compose-ha and digitalocean/compose-ha in the same run
    // and cli-runner APPENDS, so a mode-only name interleaves two clouds'
    // output in one file; dnsProvider so same-mode scenarios on different
    // DNS providers stay separable if they're reintroduced.
    const scenarioLogPath = join(tempDir, `${provider}-${mode}-${dnsProvider}.log`);
    const scenarioCtx = {
      logPath: scenarioLogPath,
      echo: true,
    };

    try {
      result = await scenarioContext.run(scenarioCtx, () =>
        runLifecycle(scenarioConfig, scenarioId, db, collector, hetznerToken, {
          includeFailover: isHa,
          // Phase 9: only k8s/k8s-ha modes have a verify-autoscale body; the
          // lifecycle gates internally on mode + expanded.
          expanded: isExpanded,
          onStepComplete: isBatch ? undefined : onStepComplete,
          skipSteps: overrides?.skipSteps ?? skipSteps,
          digitaloceanToken,
          linodeToken,
          vultrToken,
          scalewayToken,
        }),
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      result = {
        provider,
        mode: mode as DeployMode,
        dnsProvider,
        domain,
        status: 'error',
        steps: [],
        errorMessage,
      };
    }

    db.updateScenarioStatus(scenarioId, result.status, result.errorMessage);

    // Diff against the last green run for this provider + mode + dnsProvider.
    // The diff can upgrade failureCategory to 'regression' if a step that
    // passed last time now fails, and surfaces meaningful perf drift in the
    // summary. No-op for first-time scenarios (no green prior). Provider is
    // part of the key or a DigitalOcean green would become the Hetzner
    // baseline for the same mode — see db.ts selectLastGreenScenario.
    const baselines = db.getLastGreenStepBaselines(provider, mode, dnsProvider, runId);
    const { scenario: diffed, entries } = applyDiffVsGreen(result, baselines);
    if (entries.length > 0) {
      console.log(`[${mode}] vs last green:`);
      for (const e of entries) {
        console.log(`[${mode}]   ${e.kind === 'regression' ? '⚠ ' : '↑ '}${e.message}`);
      }
      collectedDiffEntries.push(...entries.map((e) => ({ mode, ...e })));
    }
    if (diffed.failureCategory !== result.failureCategory) {
      // Re-persist the upgraded category so historical queries see the
      // 'regression' label, not the original 'unknown' from initial classify.
      db.updateScenarioStatus(scenarioId, diffed.status, diffed.errorMessage);
    }

    const totalMs = diffed.steps.reduce((sum, s) => sum + s.durationMs, 0);
    logScenarioSummary(mode, diffed.status, totalMs);
    return { ...diffed, attempts: attemptNumber };
  };

  /**
   * Retry-on-flake wrapper. When E2E_RETRY_FLAKES=1 (off by default —
   * retries double matrix wall-clock time, so opt-in), a scenario that fails
   * with `failureCategory === 'infra'` gets one more shot. If the retry
   * passes, status flips to 'pass_after_retry' and the category becomes
   * 'flake' — recording in the DB that we WERE flaky here so trends can
   * surface "scenario X has been flaky 3 of last 10 runs, fix the underlying
   * infra dependency."
   *
   * Only retries on infra category — never on 'unknown' (we don't know what
   * state was left behind) or 'regression' (re-running won't fix code).
   */
  const runScenario = async (scenario: (typeof scenarios)[number]): Promise<ScenarioResult> => {
    const first = await runScenarioOnce(scenario, 1);
    const retryEnabled = process.env.E2E_RETRY_FLAKES === '1';
    const shouldRetry =
      retryEnabled && first.status !== 'pass' && first.failureCategory === 'infra';
    if (!shouldRetry) return first;

    // A kept rig still owns the env prefix (server names, DNS, stacks) the
    // retry would redeploy into — retrying against it is a guaranteed
    // collision, not a second chance. Keep wins; say so loudly.
    // (Discovered live 2026-08-28: e4 retry armed with --keep-on-fail.)
    if (process.env.VC_KEEP_ON_FAILURE === '1' || process.env.VC_KEEP_ALWAYS === '1') {
      console.log(
        `\n[${scenario.mode}] E2E_RETRY_FLAKES retry SKIPPED: a keep flag preserved the failed ` +
          `rig, and a retry on the same env prefix would collide with it. Destroy the rig ` +
          `(scripts/iter-step.js ${scenario.provider}/${scenario.mode} destroy), then re-run.`,
      );
      return first;
    }

    console.log(
      `\n[${scenario.mode}] First attempt failed with infra-category — retrying once (E2E_RETRY_FLAKES=1).`,
    );
    const second = await runScenarioOnce(scenario, 2);
    if (second.status === 'pass') {
      // Retry succeeded — this WAS a flake. Override status + category so
      // the summary reads honestly: we passed, but only after a retry, and
      // the underlying infra was unstable enough to need the retry.
      return {
        ...second,
        status: 'pass_after_retry',
        failureCategory: 'flake',
        attempts: 2,
      };
    }
    // Retry also failed — this is a real persistent infra issue, not a flake.
    // Return the second result (most recent) but note both attempts.
    return { ...second, attempts: 2 };
  };

  const results: ScenarioResult[] = [];

  if (isBatch && scenarios.length > 1) {
    console.log(`\n>>> Running ${scenarios.length} scenarios serially\n`);
  }

  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    results.push(result);

    // In interactive mode, ask whether to continue to next scenario
    if (!isBatch && scenarios.indexOf(scenario) < scenarios.length - 1) {
      const answer = await prompt.ask('\n  Continue to next scenario? [Enter] yes  |  [q] quit → ');
      if (answer.trim().toLowerCase() === 'q') {
        console.log('\n  Stopping. Remaining scenarios will be skipped.\n');
        break;
      }
    }
  }

  // Finalize. pass_after_retry counts as pass (we did eventually succeed,
  // just needed a retry on a flaky infra step) — flake-tracking surfaces
  // separately via the failureCategory column in the summary.
  const hasFailure = results.some((r) => r.status !== 'pass' && r.status !== 'pass_after_retry');
  db.completeRun(runId, hasFailure ? 'fail' : 'pass');
  prompt.close();

  logRunSummary(
    results.map((r) => ({
      provider: r.provider,
      mode: r.mode,
      status: r.status,
      durationMs: r.steps.reduce((sum, s) => sum + s.durationMs, 0),
      failureCategory: r.failureCategory,
    })),
  );

  // Per-step × per-mode matrix with cell-level wall-clock durations. Lets
  // a quick scan show "deploy failed only on compose-ha" or "k8s scale
  // doubled vs k8s-ha" without dropping into the SQLite trends report.
  logStepMatrix(
    results.map((r) => ({
      provider: r.provider,
      mode: r.mode,
      steps: r.steps.map((s) => ({
        name: s.name,
        status: s.status,
        durationMs: s.durationMs,
      })),
    })),
  );

  // README perf-table refresh — per provider. Each provider's block only
  // updates when EVERY scenario of that provider present in THIS run is
  // green AND the run covers that provider's full registry scenario list;
  // partial coverage leaves that provider's block untouched (reported as
  // `skipped`, not an error). Inline headline markers
  // (`<!-- perf:<step>:<provider>/<mode> -->`) refresh independently per
  // green scenario+step. The runner writes the file; the user decides when
  // to commit — important so local matrix runs don't surprise you with a
  // dirty README diff (numbers policy is CI-measured only; the checked-in
  // README changes via the perf-table PR a green CI run opens, not via a
  // same-origin guard here). Catches errors loudly but doesn't fail the
  // run: the perf table is a reporting artifact, not part of the test
  // contract.
  try {
    // Footnote origin: which host class measured these numbers, and against
    // which locations. Distinguishes CI-measured tables (datacenter uplink)
    // from laptop-measured ones — a 2026-07 table was silently polluted by a
    // degraded home uplink and shipped 20-40x-inflated sideload-bearing
    // cells.
    const regionSet = new Set<string>();
    for (const sc of scenarios) {
      regionSet.add(sc.region);
      if (sc.secondaryRegion) regionSet.add(sc.secondaryRegion);
    }
    const originHost = process.env.GITHUB_ACTIONS ? 'GitHub-hosted runner' : `\`${hostname()}\``;
    const origin = `${originHost} → ${[...regionSet].sort().join('/')}`;
    const readmePath = join(PROJECT_ROOT, 'README.md');

    // Anomaly guard (Option A), scoped per provider: a fully-green provider
    // can still be anomalously slow (Hetzner slowdown, S3 throttle, noisy
    // neighbor) without failing any step. A provider with a flagged cell is
    // excluded from THIS pass — a clean sibling provider's block still
    // updates. `--force-perf-table` records anyway (use when a slowdown is
    // real and you want it captured).
    const forcePerfTable = args.includes('--force-perf-table');
    const anomalies = forcePerfTable ? [] : detectPerfAnomalies(db, runId);
    const anomalousProviders = [...new Set(anomalies.map((a) => a.provider))];
    if (anomalies.length > 0) {
      console.log(
        `\n${anomalies.length} cell(s) look anomalously slow vs the last ${PERF_ANOMALY_WINDOW} green runs of their provider (likely infra noise, not a real regression) — excluding from this pass: ${anomalousProviders.join(', ')}. The previously recorded fast numbers are kept:`,
      );
      for (const a of anomalies) {
        console.log(
          `  [${a.provider}] ${a.mode} ${a.header}: ${formatDuration(a.currentMs)} vs baseline median ${formatDuration(a.baselineMedianMs)} (${a.ratio.toFixed(2)}× over, n=${a.sampleCount})`,
        );
      }
      console.log(
        '  Re-run the matrix, or pass --force-perf-table to record these numbers anyway.',
      );
    }

    // CI-ONLY: laptop-measured numbers never enter the README table (the
    // 2026-08-08 numbers policy — a degraded local uplink once inflated
    // sideload-bearing cells 20-40x). The per-provider block patcher's
    // AUTO-CREATE path made this observable: a brand-new provider has no
    // recorded block whose origin could mismatch, so the first local green
    // run of vultr/compose seeded the table with laptop numbers. Gate the
    // entire pass on CI instead of relying on per-block origin checks.
    if (!process.env.GITHUB_ACTIONS) {
      console.log(
        '\nPerformance surfaces: skipped (CI-only policy — laptop-measured numbers never enter the published tables).',
      );
    } else {
      const dataPath = join(PROJECT_ROOT, 'docs', 'perf-data.json');
      const carbonDataPath = join(
        PROJECT_ROOT,
        'carbon',
        'src',
        'client',
        'components',
        'sections',
        'vendor-matrix-data.json',
      );
      const updateResult = updatePerfDataFromRun(dataPath, db, runId, {
        origin,
        excludeProviders: anomalousProviders,
      });
      if (updateResult.updated.length > 0) {
        console.log(
          `\ndocs/perf-data.json updated: ${updateResult.updated.join(', ')} — review the diff before committing.`,
        );
      }
      if (updateResult.skipped.length > 0) {
        console.log(
          `docs/perf-data.json: skipped (no full-green coverage this run, or anomaly-guarded): ${updateResult.skipped.join(', ')}`,
        );
      }

      // Every published surface re-renders from the (possibly unchanged)
      // data file, so a single-provider run refreshes the unified table
      // without touching any other provider's numbers.
      const data = loadPerfData(dataPath);
      const readmeChanged = patchReadmeUnifiedPerfTable(readmePath, data);
      const inlineUpdated = patchInlinePerfMarkers(readmePath, data);
      const carbonChanged = syncCarbonPerfData(carbonDataPath, data);
      if (readmeChanged) console.log('README.md unified performance table re-rendered.');
      if (inlineUpdated.length > 0) {
        console.log(`README.md inline perf markers updated: ${inlineUpdated.join(', ')}`);
      }
      if (carbonChanged) {
        console.log('carbon vendor-matrix-data.json refreshed from docs/perf-data.json.');
      }
    }
  } catch (err) {
    console.warn(
      `\nFailed to update README perf-table: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  db.close();

  // vs-last-green roll-up: regressions front and center, perf drift below.
  // Aggregated here (not per-scenario) so a 4-scenario run reads as one
  // section of "what's different" rather than 4 separate blocks.
  if (collectedDiffEntries.length > 0) {
    const regressions = collectedDiffEntries.filter((e) => e.kind === 'regression');
    const perf = collectedDiffEntries.filter((e) => e.kind === 'perf');
    console.log('');
    console.log('vs last green run:');
    for (const r of regressions) console.log(`  ⚠ [${r.mode}] ${r.message}`);
    for (const p of perf) console.log(`  ↑ [${p.mode}] ${p.message}`);
  }

  console.log(`\nRun ID: ${runId}`);
  console.log('Results saved to tests/results/e2e.db');
  console.log('View trends: pnpm test:e2e:report\n');

  return { runId, status: hasFailure ? 'fail' : 'pass', results };
}

// ---------------------------------------------------------------------------
// Script entry point — run when invoked directly via tsx
// ---------------------------------------------------------------------------

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  if (process.env.REAL_INFRA !== 'true') {
    console.error('Error: REAL_INFRA=true is required to run e2e tests.');
    console.error('This protects against accidentally provisioning cloud resources.\n');
    console.error('Usage: REAL_INFRA=true pnpm test:e2e');
    process.exit(1);
  }

  runE2E().then(
    (result) => process.exit(result.status === 'pass' ? 0 : 1),
    (err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    },
  );
}
