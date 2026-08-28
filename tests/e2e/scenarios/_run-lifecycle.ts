/**
 * Shared lifecycle runner for e2e test scenarios.
 *
 * Executes the full deployment lifecycle (create -> deploy -> verify -> scale
 * -> backup -> destroy -> restore -> [failover] -> final-destroy) and records
 * every step's outcome, timing, and verification results in the e2e
 * database.
 *
 * All four scenario wrappers (compose, compose-ha, k8s, k8s-ha) delegate to
 * this single implementation, differing only in the `includeFailover` flag.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pauseImageRef } from '../../../src/lib/images.js';
import { getProvider } from '../../../src/lib/providers/index.js';
import { gitScrubbedEnv } from '../../_shared/git-env.js';
import { runAppApiChecks } from '../checks/app-api.js';
import { runAppFunctionalChecks } from '../checks/app-functional.js';
import { runBackupEvidenceChecks } from '../checks/backup-evidence.js';
import { runClientKeyAgreementCheck } from '../checks/client-key-agreement.js';
import { resolveComposeFirewallServers, runCloudFirewallChecks } from '../checks/cloud-firewall.js';
import {
  CONFIG_CANARY_SECRET,
  OAUTH_CANARY_CLIENT_ID,
  runConfigCanaryChecks,
} from '../checks/config-canary.js';
import { runDnsFailoverFlipCheck } from '../checks/dns-flip.js';
import { runEdgeFunctionChecks } from '../checks/feature-functions.js';
import { runObservabilityChecks } from '../checks/feature-observability.js';
import { runRedisChecks } from '../checks/feature-redis.js';
import { runFrontendSmokeChecks } from '../checks/frontend-smoke.js';
import {
  dnsSafeFetch,
  runHealthChecks,
  waitForAppServing,
  waitForDnsToPoint,
  waitForHealthy,
} from '../checks/health.js';
import { assertPilotLightStandby } from '../checks/pilot-light.js';
import {
  buildMarkerId,
  continuityTargetSameAsOriginMessage,
  isContinuityTargetSameAsMarkerOrigin,
  readSingleServerIp,
  resolveHaDbIps,
  runFailoverContinuityCheck,
  runReplicationChecks,
  writeReplicationMarker,
} from '../checks/replication.js';
import { runSupavisorPoolerChecks } from '../checks/supavisor-pooler.js';
import type { E2EDb, SweepBreakdown } from '../metrics/db.js';
import { classifyFailure, rollUpScenarioCategory } from '../utils/classify-failure.js';
import {
  DESTROY_EXIT_LEAKED,
  extractLeakReport,
  runAddFeatures,
  runBackup,
  runCreate,
  runDeploy,
  runDestroy,
  runFailover,
  runFinalDestroy,
  runGh,
  runRestore,
  runScale,
  scenarioContext,
} from '../utils/cli-runner.js';
import {
  buildClusterScopedDiagnostics,
  isClusterScopedStep,
} from '../utils/cluster-diagnostics.js';
import { type ResolutionPin, withResolutionPin } from '../utils/dns-pin.js';
import { extractDeployFailureDetail } from '../utils/extract-failure-detail.js';
import { sharedStateBucketName } from '../utils/namespace.js';
import { fetchServerTypes } from '../utils/server-types.js';
import {
  e2eSshOpts,
  extractRegistryMirrorAddress,
  getServerIps,
  getSshKeyPath,
} from '../utils/ssh.js';
import { noteHttpEvidence, resetSshReachability } from '../utils/ssh-reachability.js';
import { sweepOrphanedDigitalOceanResources } from '../utils/sweep-digitalocean.js';
import { sweepOrphanedLinodeResources } from '../utils/sweep-linode.js';
import { sweepOrphanedScalewayResources } from '../utils/sweep-scaleway.js';
import { sweepOrphanedVultrResources } from '../utils/sweep-vultr.js';
import {
  mutateAppHealthRoute,
  mutateConfigMapManifest,
  WARM_REDEPLOY_APP_FILE,
  WARM_REDEPLOY_CONFIGMAP_KEY,
  WARM_REDEPLOY_CONFIGMAP_NAME,
  WARM_REDEPLOY_MANIFEST_FILE,
  WARM_REDEPLOY_ROUTE_URL_PATH,
  warmRedeployMarker,
} from '../utils/warm-redeploy-mutations.js';
import type {
  ScenarioConfig,
  ScenarioResult,
  StepName,
  StepResult,
  VerificationResult,
} from './types.js';
import { summarizeVerifications } from './verification-summary.js';

// ---------------------------------------------------------------------------
// Metrics collector interface
// ---------------------------------------------------------------------------
// The MetricsCollector module (../metrics/collector.ts) is created by a
// separate task and may not exist yet. We define the subset of its API that
// this module needs so the code compiles independently. The main orchestrator
// passes a concrete instance at runtime.

export interface MetricsCollector {
  collectAll(params: {
    stepId: string;
    durationMs: number;
    domain: string;
    serverIps: string[];
    sshKeyPath: string | null;
    hetznerToken: string;
  }): Promise<void>;
  recordVerifications(stepId: string, results: VerificationResult[]): void;
  recordTiming(stepId: string, durationMs: number): void;
  recordPerfSubsteps(
    stepId: string,
    timings: Array<{ name: string; ms: number; note?: string }>,
  ): void;
}

// ---------------------------------------------------------------------------
// Timeouts for each step category
// ---------------------------------------------------------------------------

// Timeouts are sized against the single slowest scenario for each step.
// Cold-path k8s-ha (2026-04-26 batch run #2) breakdown — observed end-to-end:
//   sideload ~25 min (HA = 6 nodes × ~600MB image each, parallel SSH)
//   helm install supabase --wait ~6 min
//   migrations ~1 min
//   app rollout-status ~3 min
//   DNS update + cert-manager + public probe ~20 min budget
// Total ~55 min worst case. The 40-min cap (PR 1G) chopped the probe
// short of its 20-min window — observed at exactly 40m 0s on run #2 even
// though app rolled out in 3m 20s. 75 min covers the cold tail with
// margin; warm scenarios still finish in <10 min so this only matters
// on first deploys.
const TIMEOUTS: Record<string, number> = {
  // 15 min — `vibecarbon create` runs `pnpm install --lockfile-only` for the
  // generated project. Under a parallel e2e batch, all four scenarios
  // race the npm registry simultaneously; on a slow-registry day this push
  // per-package fetch waits to 30–45s and the lockfile gen past 5 min.
  // Matrix run 2026-05-14 hit k8s create FAIL at exactly 5m 0s (timeout)
  // while compose-ha took 2m 1s (was 10s baseline, +1058%) and squeaked under
  // the old cap. The runner SIGKILLs the whole process group on timeout, so
  // any room we add here goes straight to the pnpm install inside. 15 min
  // covers the worst observed slow-registry day with margin; warm cache runs
  // still finish in well under a minute, so this only relaxes a ceiling — it
  // doesn't mask real regressions.
  create: 900_000,
  'setup-repo': 60_000,
  'teardown-repo': 60_000,
  'add-features': 60_000,
  deploy: 4_500_000, // 75 min — cold k8s-ha = ~55 min, plus margin
  // Warm path: infra already exists, but image rebuild + rolling restart can
  // still take real time on a slow-Docker-Hub day. 30 min covers a worst-case
  // warm rebuild without masking real regressions; healthy warm deploys
  // complete in <5 min and we surface that in the README perf table.
  'warm-deploy': 1_800_000,
  // Same 30-min ceiling as warm-deploy, plus the post-deploy assertion polls
  // (image rebuild + rolling restart + one kubectl read + one HTTPS GET). This
  // step deliberately DOES rebuild — that is the thing it is proving — so it
  // sits at warm-deploy's worst-case budget rather than its typical one.
  'warm-redeploy-change': 1_800_000,
  'verify-deploy': 1_800_000, // 30 min — k8s tail (ACME + rollout) past 20 min
  // 10 parallel /api/health requests with a 15s per-request timeout. Allows
  // generous 2 min budget so a transient network blip during a single burst
  // doesn't fail the step — the assertion is "10/10 OK", not "burst finished
  // under N seconds".
  'verify-load': 120_000,
  // Phase 9: scale-up poll up to 12 min + scale-down poll up to 14 min, plus
  // load-gen Deployment apply + drain + cluster-autoscaler reconciliation
  // slack. Only invoked under --expanded.
  'verify-autoscale': 1_500_000, // 25 min — load+poll+drain+poll for CA scale-up + scale-down
  scale: 2_100_000, // 35 min — compose-ha scales primary then standby serially
  // (≈12-15 min per side via remote build + image pull + compose up); previous
  // green at 24m24s left no headroom and timed out at 25m exactly on the next
  // slow-Docker-Hub day (k8s e2e fanout5 2026-05-01). 35 min covers
  // both serial halves plus margin without masking real regressions.
  'verify-scale': 600_000,
  backup: 900_000,
  // 20 min — the S3 bucket teardown carries deliberate consistency-retry
  // ladders (DeleteBucket BucketNotEmpty ~4.5 min/bucket across app + state +
  // backup buckets, plus empty passes; see hetzner-s3.js deleteBucket) that
  // can legitimately stack past the old 10 min budget when Hetzner Object
  // Storage lags (live-hit 2026-07-07: destroy killed at 600.0s mid-ladder,
  // harness-classified infra/S3-transient). The budget must exceed the
  // worst-case ladder we intentionally ship, or the timeout re-creates the
  // exact leak the ladder prevents.
  destroy: 1_200_000,
  restore: 4_500_000, // 75 min — restore re-deploys then restores
  'verify-restore': 600_000,
  // 30 min — the pilot-light failover step now includes REAL standby worker
  // provisioning (IaC converge 0→N + k3s join/Ready, +3–5 min) followed by an
  // app-tier scale-up and a readiness gate (rollout-status on the scaled
  // deployments, now run in parallel, then the public-API probe). The old 10-min
  // budget predates provisioning. Generous on purpose; real e2e perf rows will
  // calibrate it down.
  failover: 1_800_000,
  'verify-failover': 600_000,
  // k8s-ha only. Same 75-min budget as the initial cold `deploy`: this
  // redeploy converges ONE cluster's role (app tier + workers to zero) but
  // still pays a full serial pg_basebackup reseed of that cluster's
  // postgres off the new primary — the same order of magnitude as the
  // initial dual-cluster provisioning + sideload, so it gets the same
  // generous budget rather than warm-deploy's 30-min one (which only times
  // a no-op convergence, not a reseed).
  'reconverge-deploy': 4_500_000,
  'final-destroy': 1_200_000, // same S3 teardown ladders as destroy
};

/**
 * Verification checks that are KNOWN to fail for a given (mode, step) combo
 * because of an underlying architectural limitation that hasn't been fixed
 * yet. The lifecycle treats these as "expected fail" — they're still recorded
 * in the verifications table, but they don't fail the step. ANY OTHER check
 * failing in the same step still fails the step (so we don't lose signal on
 * unrelated regressions).
 *
 * Each entry MUST cite the underlying issue so we know when to remove it.
 * If you find yourself adding a new entry here, prefer fixing the root cause.
 *
 * Currently empty. Previously held k8s-ha verify-failover entries, but the
 * set of failing checks varied run-to-run (auth_signup one run, auth_protected
 * the next, db_* sometimes), all caused by k8s-ha replication never streaming
 * data cross-cluster (project_replication_broken.md). A whitelist couldn't
 * keep up; we now skip verify-failover entirely for k8s-ha at the step-list
 * build site below.
 */
const EXPECTED_VERIFY_FAILURES: Record<string, Partial<Record<StepName, string[]>>> = {};

// ---------------------------------------------------------------------------
// .env.local key parser
// ---------------------------------------------------------------------------

interface SupabaseKeys {
  anonKey: string;
  serviceRoleKey: string;
  /** Admin credentials for the auth_admin_login check; absent on older bundles. */
  adminEmail?: string;
  adminPassword?: string;
}

/**
 * Read Supabase keys from the project's .env.local file.
 * Looks for VITE_SUPABASE_ANON_KEY and SERVICE_ROLE_KEY (or SUPABASE_SERVICE_ROLE_KEY),
 * plus ADMIN_EMAIL/ADMIN_PASSWORD so the functional checks can verify the
 * operator can actually log into their deployed app as the super-admin.
 */
function readSupabaseKeys(projectDir: string): SupabaseKeys | null {
  try {
    const envPath = join(projectDir, '.env.local');
    const content = readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');

    let anonKey = '';
    let serviceRoleKey = '';
    let adminEmail = '';
    let adminPassword = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;

      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.slice(0, eqIdx).trim();
      const raw = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes (single or double) from .env values
      const value = raw.replace(/^["']|["']$/g, '');

      if (key === 'VITE_SUPABASE_ANON_KEY') {
        anonKey = value;
      } else if (key === 'SERVICE_ROLE_KEY' || key === 'SUPABASE_SERVICE_ROLE_KEY') {
        serviceRoleKey = value;
      } else if (key === 'ADMIN_EMAIL') {
        adminEmail = value;
      } else if (key === 'ADMIN_PASSWORD') {
        adminPassword = value;
      }
    }

    if (!anonKey || !serviceRoleKey) return null;
    return {
      anonKey,
      serviceRoleKey,
      adminEmail: adminEmail || undefined,
      adminPassword: adminPassword || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Read POSTGRES_PASSWORD from the scaffolded project's `.env.local` — the
 * supavisor-pooler check needs it to authenticate as the tenant user
 * (postgres.<PROJECT_NAME>) through the pooler. Same parsing rules as
 * readSupabaseKeys above.
 */
function readPostgresPassword(projectDir: string): string | null {
  try {
    const content = readFileSync(join(projectDir, '.env.local'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (trimmed.slice(0, eqIdx).trim() !== 'POSTGRES_PASSWORD') continue;
      const value = trimmed
        .slice(eqIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (value) return value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read `.vibecarbon.json`'s `environments[env].ha.primary.stack` — the
 * Pulumi stack identity currently holding the PRIMARY role. Mirrors
 * resolveHaDbIps's (checks/replication.ts) read-and-fail-soft-null pattern;
 * kept local since it's a single field this file's reconverge-deploy step
 * needs and resolveHaDbIps only surfaces IPs, not stack names.
 */
function readHaPrimary(
  projectDir: string,
  env: string,
): { stack: string | null; region: string | null } {
  try {
    const configPath = join(projectDir, '.vibecarbon.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      environments?: Record<string, { ha?: { primary?: { stack?: string; region?: string } } }>;
    };
    const primary = config.environments?.[env]?.ha?.primary;
    return { stack: primary?.stack ?? null, region: primary?.region ?? null };
  } catch {
    return { stack: null, region: null };
  }
}

// ---------------------------------------------------------------------------
// Lifecycle options
// ---------------------------------------------------------------------------

export interface LifecycleOptions {
  includeFailover: boolean;
  /**
   * Phase 9: opt-in expanded e2e tier. When true AND mode is k8s or
   * k8s-ha, the lifecycle inserts a `verify-autoscale` step between
   * verify-deploy and scale that drives cluster-autoscaler end-to-end (load
   * → poll for scale-up → drain → TODO: poll for scale-down). For k8s-ha,
   * only the primary cluster is exercised — standby is structurally
   * identical, so a Hetzner CLI spot-check is sufficient if the operator
   * wants symmetric proof.
   *
   * Wired to `--expanded` in runner.ts. NOT used in the default e2e
   * suite — adding 25 min/scenario to PR CI was rejected per the plan.
   *
   * TODO (deferred from Phase 9):
   *   - verify-status / verify-diagnose steps (decoration, easy adds)
   *   - configure cicd add-on flow within the e2e harness — requires
   *     Flux reconciliation polling against the project's main branch and
   *     is a separate harness piece. Leaves PR #43's e2e debt open.
   */
  expanded?: boolean;
  /**
   * Optional callback invoked after each step completes.
   * Return 'continue' to proceed, 'skip' to skip remaining steps (still runs final-destroy),
   * or 'abort' to stop immediately (still runs final-destroy).
   * If not provided, all steps run automatically.
   */
  onStepComplete?: (step: StepResult) => Promise<'continue' | 'skip' | 'abort'>;
  /**
   * Steps to remove from the lifecycle entirely. Iteration accelerator —
   * when the failing step doesn't depend on what we're skipping, drop them
   * to shorten the cycle. Wired to `--skip-steps` / `--minimal` flags on
   * the runner. final-destroy + teardown-repo always run regardless (they
   * live in the `finally` block, not the step list).
   */
  skipSteps?: Set<string>;
  /**
   * DigitalOcean API token, passed as `DIGITALOCEAN_TOKEN` (the env var
   * `@pulumi/digitalocean` reads — never rename) into the deploy step's
   * child env alongside `HCLOUD_TOKEN`, but only when `config.provider ===
   * 'digitalocean'`. Undefined for every release scenario (they never set
   * `config.provider`), so their deploy env is byte-identical to before.
   */
  digitaloceanToken?: string;
  /**
   * Linode API token — used by the lifecycle's own API operations
   * (providerTokenFor: verify-scale type snapshots, firewall ops, the
   * teardown sweep) when `config.provider === 'linode'`. Deliberately NOT
   * injected into deploy children (B8-3 contract: buildEnv synthesizes the
   * provider CLI token env from the project's .env.local, so provider runs
   * prove the customer path).
   */
  linodeToken?: string;
  /**
   * Vultr API token — used by the lifecycle's own API operations
   * (providerTokenFor: verify-scale type snapshots, firewall ops, the
   * teardown sweep) when `config.provider === 'vultr'`. Same B8-3 contract
   * as `linodeToken` above: deliberately NOT injected into deploy children.
   */
  vultrToken?: string;
  /**
   * Scaleway secret key (SCALEWAY_SECRET_KEY) — used by the lifecycle's own API
   * operations (providerTokenFor: verify-scale type snapshots, firewall
   * ops, the teardown sweep) when `config.provider === 'scaleway'`. Same
   * B8-3 contract as its siblings: deliberately NOT injected into deploy
   * children (buildIacEnv synthesizes the full SCW_* triple from the
   * project's .env.local, so provider runs prove the customer path).
   */
  scalewayToken?: string;
}

// ---------------------------------------------------------------------------
// Universal diagnostic capture (any-step failure)
// ---------------------------------------------------------------------------

/**
 * Best-effort dump of the most useful "what's the system look like RIGHT NOW"
 * data on any step failure. Each step has its own targeted dump (probe-failure
 * captures kubectl + dig + curl; basebackup captures pg_basebackup output),
 * but those only fire when the step's specific failure path is hit. This
 * runs unconditionally on EVERY failure as a safety net so the next-iteration
 * fix doesn't have to be "re-run the test to see what happened."
 *
 * Output is appended to a per-scenario diagnostics file
 * (~/.vibecarbon/logs/<env>-failure-diagnostics-<step>-<ts>.log) so it
 * survives the test runner's log truncation and is grep-able later.
 *
 * Bounded by: 30s timeout per command, ~4KB per snippet, best-effort
 * everywhere. We're already failing — nothing here should make it worse.
 */
async function captureFailureDiagnostics(
  config: ScenarioConfig,
  stepName: StepName,
  tag: string,
): Promise<void> {
  const { existsSync, mkdirSync, appendFileSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');

  const logDir = join(homedir(), '.vibecarbon', 'logs');
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(logDir, `${config.envPrefix}-failure-${stepName}-${ts}.log`);

  // 10s default — failures are usually instant (DNS resolves or it doesn't,
  // kubectl returns or it can't reach the API). 30s was the old default;
  // padding ~5 commands × 30s added 2.5min to every failure-diagnostic
  // capture. Curl gets its own 10s --max-time arg already; safe to lower.
  const safeRun = (cmd: string, argv: readonly string[], timeoutMs = 10_000): string => {
    try {
      return execFileSync(cmd, argv, {
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
      })
        .toString()
        .trim()
        .slice(0, 4000);
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: Buffer; stderr?: Buffer };
      const stdout = e?.stdout?.toString?.()?.trim() ?? '';
      const stderr = e?.stderr?.toString?.()?.trim() ?? '';
      const tail = [stdout, stderr].filter(Boolean).join('\n').slice(0, 4000);
      const reason = e?.message?.split('\n')[0] || 'unknown';
      // Best-effort but LOUD: a capture that silently degrades to "(cmd
      // failed)" inside a file nobody opens is how a bundle ends up looking
      // complete while carrying nothing. One line on the console, always.
      console.error(`${tag} (diagnostic capture failed: ${cmd} — ${reason.slice(0, 200)})`);
      return `(${cmd} failed: ${reason})\n${tail}`;
    }
  };

  const sections: Array<[string, string]> = [];

  // 1. Process state — was vibecarbon hung? Did the CLI orphan a child?
  sections.push([
    'process tree (vibecarbon-related)',
    safeRun('bash', [
      '-c',
      "ps -ef | grep -E 'vibecarbon|tsx|kubectl|docker|pulumi' | grep -v grep || echo '(none)'",
    ]),
  ]);

  // 2. DNS state for the scenario's domain
  if (config.domain) {
    sections.push([
      `dig +short ${config.domain}`,
      safeRun('dig', ['+short', config.domain, '@1.1.1.1']),
    ]);
    // What does the public endpoint actually return?
    sections.push([
      `curl -skvI https://${config.domain}/api/health`,
      safeRun('curl', ['-skvI', '--max-time', '10', `https://${config.domain}/api/health`]),
    ]);
  }

  // 3. K8s state — both standalone and HA paths drop kubeconfig files in
  //    .vibecarbon/. Try standalone first, then HA primary, then HA standby.
  if (config.mode === 'k8s' || config.mode === 'k8s-ha') {
    const candidates = [
      join(config.projectDir, '.vibecarbon', `kubeconfig-${config.envPrefix}`),
      join(config.projectDir, '.vibecarbon', `kubeconfig-${config.envPrefix}-primary`),
      join(config.projectDir, '.vibecarbon', `kubeconfig-${config.envPrefix}-standby`),
    ];
    for (const kc of candidates) {
      if (!existsSync(kc)) continue;
      const label = kc.split('/').pop() || kc;
      sections.push([
        `${label}: pods (vibecarbon ns)`,
        safeRun('kubectl', ['--kubeconfig', kc, '-n', 'vibecarbon', 'get', 'pods', '-o', 'wide']),
      ]);
      // describe every pod that isn't Running/Ready. This is the most actionable
      // signal: image-pull errors land here with their failing registry URL,
      // mount errors name the missing Secret/ConfigMap, and scheduler events
      // explain Pending pods. Without describe, the operator has to ssh into
      // the cluster to root-cause — defeats the purpose of the diagnostic.
      sections.push([
        `${label}: describe non-Running pods (vibecarbon ns)`,
        safeRun('bash', [
          '-c',
          `set -o pipefail; bad=$(kubectl --kubeconfig ${kc} -n vibecarbon get pods --no-headers 2>&1 | awk '$3!="Running" && $3!="Completed" {print $1}'); if [ -z "$bad" ]; then echo '(all pods Running/Completed)'; else for p in $bad; do echo "=== $p ==="; kubectl --kubeconfig ${kc} -n vibecarbon describe pod "$p" 2>&1 | tail -40; done; fi`,
        ]),
      ]);
      // Crash-loop ROOT CAUSE: describe (above) shows WHAT — CrashLoopBackOff,
      // restart count, exit code — but not WHY. Capture the crashed container's
      // own output via --previous (the instance that died). Target ONLY pods
      // with RESTARTS>0 ($4): those are the crash-loopers whose --previous holds
      // the real reason. This deliberately skips 0-restart ImagePullBackOff pods
      // (their --previous is "not found" and their current logs can be huge) —
      // RCA 2026-06-23: an earlier version filtered on not-ready, so a noisy app
      // pod's logs blew safeRun's 10s budget BEFORE the loop reached the
      // crash-looping supabase-db, and its FATAL went uncaptured. Each logs call
      // is `timeout`-bounded so one slow pod can't starve the rest, and the
      // section gets a larger budget. --all-containers includes init containers
      // (walg-restore / init-db / init-pgsodium).
      sections.push([
        `${label}: logs from crash-looping pods (--previous, all containers)`,
        safeRun(
          'bash',
          [
            '-c',
            `set -o pipefail; bad=$(kubectl --kubeconfig ${kc} -n vibecarbon get pods --no-headers 2>&1 | awk '$4+0 > 0 {print $1}'); if [ -z "$bad" ]; then echo '(no crash-looping pods — see describe section above for not-ready pods)'; else for p in $bad; do echo "=== $p (--previous) ==="; timeout 12 kubectl --kubeconfig ${kc} -n vibecarbon logs "$p" --previous --all-containers --tail=100 2>&1 | tail -80 || true; done; fi`,
          ],
          60_000,
        ),
      ]);
      // CURRENT logs of crash-looping pods: --previous (above) shows the
      // instance that died, but the live attempt's failure can differ (e.g. a
      // component that crashed on ECONNREFUSED pre-db now failing read-only
      // against a seeded replica — the seeding e2e run 29472203674 was
      // undiagnosable because only --previous was captured). Same RESTARTS>0
      // targeting and per-pod timeout bounds as the --previous section.
      sections.push([
        `${label}: CURRENT logs from crash-looping pods (all containers)`,
        safeRun(
          'bash',
          [
            '-c',
            `set -o pipefail; bad=$(kubectl --kubeconfig ${kc} -n vibecarbon get pods --no-headers 2>&1 | awk '$4+0 > 0 {print $1}'); if [ -z "$bad" ]; then echo '(no crash-looping pods)'; else for p in $bad; do echo "=== $p (current) ==="; timeout 12 kubectl --kubeconfig ${kc} -n vibecarbon logs "$p" --all-containers --tail=60 2>&1 | tail -50 || true; done; fi`,
          ],
          60_000,
        ),
      ]);
      // Database ROLE: pg_is_in_recovery distinguishes a seeded/streaming
      // replica (t) from an independent writable primary (f) — decisive for
      // any standby-seeding or replication RCA, and cheap.
      sections.push([
        `${label}: supabase-db pg_is_in_recovery`,
        safeRun('bash', [
          '-c',
          `timeout 10 kubectl --kubeconfig ${kc} -n vibecarbon exec supabase-supabase-db-0 -c supabase-db -- psql -U supabase_admin -tAc 'SELECT pg_is_in_recovery()' 2>&1 || true`,
        ]),
      ]);
      // 100 events for k8s-ha (applyManifests on standby can emit 50+ in
      // its 130s window before failing); 30 elsewhere stays terse.
      const eventTail = config.mode === 'k8s-ha' ? 100 : 30;
      sections.push([
        `${label}: events (last ${eventTail}, vibecarbon ns)`,
        safeRun('bash', [
          '-c',
          `kubectl --kubeconfig ${kc} -n vibecarbon get events --sort-by=.lastTimestamp 2>&1 | tail -${eventTail}`,
        ]),
      ]);
      // All namespaces: the observability add-on issues its own grafana-tls
      // Certificate in vibecarbon-observability against the SAME
      // ClusterIssuer, so a vibecarbon-only dump cannot tell a lone failed
      // order apart from two Certificates racing one shared ACME order.
      // The 2026-08-11 e3 restore failure (403 orderNotReady "Order was
      // already processing") was diagnosed without that half of the picture.
      sections.push([
        `${label}: certificate state (all namespaces)`,
        // `--all-namespaces` is command-scoped and MUST follow the verb.
        // Before it, kubectl stops resolving a built-in command and fails
        // with "flags cannot be placed before plugin name: --kubeconfig" —
        // blaming a flag that is perfectly legal. See
        // tests/unit/e2e/kubectl-flag-order.test.ts.
        safeRun('kubectl', [
          '--kubeconfig',
          kc,
          'get',
          'certificate,certificaterequest,order,challenge',
          '--all-namespaces',
          '-o',
          'wide',
        ]),
      ]);
      // Cluster-scoped steps (deploy/scale/restore/failover) can fail on
      // anything in the cluster, so widen past the `vibecarbon` namespace:
      // all-namespace pods + events, and describe/logs for every NOT-READY
      // pod in kube-system and vibecarbon. Two blind RCAs bought this — the
      // 2026-07-31 e3 run died on a cluster-autoscaler (kube-system) rollout
      // timeout and the bundle held zero kube-system state. See
      // tests/e2e/utils/cluster-diagnostics.ts.
      if (isClusterScopedStep(stepName)) {
        for (const c of buildClusterScopedDiagnostics(kc, label)) {
          sections.push([c.label, safeRun(c.cmd, c.argv, c.timeoutMs)]);
        }
      }
    }
  }

  // 4. Compose state — config.serverIps[0] would be ideal, but we don't have
  //    direct access here. The deploy log (~/.vibecarbon/logs/<env>-<ts>.log)
  //    captures container output via the orchestrator; this is a hint.
  if (config.mode === 'compose' || config.mode === 'compose-ha') {
    sections.push([
      'hint',
      'compose container logs are captured in the matching ~/.vibecarbon/logs/<env>-<ts>.log file via the deploy logger',
    ]);
  }

  // Write all sections to the diagnostic file.
  const header = `# e2e failure diagnostics
# scenario: ${config.mode} (${config.dnsProvider})
# env: ${config.envPrefix}
# step: ${stepName}
# captured: ${new Date().toISOString()}
# project: ${config.projectName}

`;
  const body = sections.map(([label, output]) => `--- ${label} ---\n${output}\n`).join('\n');
  appendFileSync(logPath, header + body);
  console.log(`${tag} Failure diagnostics written to ${logPath}`);
}

// ---------------------------------------------------------------------------
// Post-destroy resource sweep
// ---------------------------------------------------------------------------

/**
 * Sweep for orphaned cloud resources that `vibecarbon destroy` may have missed.
 *
 * Catches three categories of leaks:
 * 1. Scale "-new" servers: created during blue-green migration, lost if scale fails
 *    before updating the config.
 * 2. K8s PVC volumes: Hetzner CSI volumes that outlive their cluster.
 * 3. S3 buckets: destroy intentionally skips these (to protect user data), but
 *    e2e test buckets should be cleaned up. Scanned across all three
 *    Hetzner S3 regions (nbg1/fsn1/hel1) — HA scenarios put standby buckets
 *    in a different region than the primary.
 *
 * All operations are best-effort — failures are logged but never propagate.
 *
 * Returns per-category counts so the lifecycle can flag destroy regressions.
 * Sweep is the safety net; non-zero counts mean destroy didn't actually free
 * those resource types and a destroy.js code path needs fixing (e.g. PR 1BD
 * fixed firewall destroy after a sweep regression went uncounted for 5+ runs).
 */
export async function sweepOrphanedHetznerResources(
  tag: string,
  projectName: string,
  hetznerToken: string,
): Promise<{ counts: SweepBreakdown; enumFailed: boolean }> {
  console.log(`${tag} Sweeping orphaned Hetzner resources for ${projectName}...`);
  const counts: SweepBreakdown = {
    servers: 0,
    volumes: 0,
    placementGroups: 0,
    firewalls: 0,
    floatingIps: 0,
    networks: 0,
    s3Buckets: 0,
    sshKeys: 0,
  };

  // Hetzner's API sporadically returns `fetch failed` under concurrent load from
  // multiple parallel scenarios; retry 3× with 3s backoff before giving up.
  // Defined up-front so the server cleanup below can use it (until 2026-04-27
  // it ran with raw fetch and silently leaked 6 servers when a single fetch
  // blipped — the matrix then hit Hetzner's project quota cap).
  const sweepFetch = async (url: string, init?: RequestInit): Promise<Response | null> => {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        return await fetch(url, init);
      } catch (err) {
        last = err;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    console.warn(
      `${tag} [sweep] ${url} failed after 3 attempts: ${last instanceof Error ? last.message : last}`,
    );
    return null;
  };

  // Every listing below walks pagination via the shared walker
  // (src/lib/providers/hetzner-pagination.js — the same one the provider's
  // destroy sweeps and scripts/sweep-hetzner.js use). The old single GETs
  // asked for `per_page=100`, which exceeds the documented max of 50
  // (Hetzner Cloud OpenAPI spec, pagination: "The default value is 25, the
  // maximum value is 50 except otherwise specified") — out-of-contract, so
  // at most one bounded page was ever served — and this sweep filters
  // CLIENT-side by name prefix, so residue past the last-served page wasn't
  // "missed for now", it was unmatchable and the sweep confidently counted
  // zero (the exact truncated-listing shape that let six orphaned CSI
  // volumes survive a GREEN run's audit, 2026-07-30; SSH keys have exceeded
  // 50 on this shared account before — see the 2026-04-27 uniqueness_error
  // incident in the ssh-key block).
  // The adapter turns sweepFetch's retries-exhausted `null` into a non-ok
  // page so the walker reports `complete: false` — an unreadable listing
  // must degrade the sweep banner, never pose as a clean empty page.
  const sweepFetchImpl = (async (url: string, init?: RequestInit) =>
    (await sweepFetch(url, init)) ??
    ({ ok: false, status: 0, json: async () => ({}) } as Response)) as typeof fetch;
  const listSweepPages = async <T>(
    path: string,
    key: string,
    query = '',
  ): Promise<{ items: T[]; complete: boolean }> => {
    const { listHetznerPages } = (await import(
      '../../../src/lib/providers/hetzner-pagination.js'
    )) as unknown as {
      listHetznerPages: (args: {
        path: string;
        key: string;
        query?: string;
        token: string;
        fetchImpl?: typeof fetch;
      }) => Promise<{ items: unknown[]; complete: boolean }>;
    };
    const { items, complete } = await listHetznerPages({
      path,
      key,
      query,
      token: hetznerToken,
      fetchImpl: sweepFetchImpl,
    });
    return { items: items as T[], complete };
  };

  // Sticky flag set whenever a sweep step couldn't even enumerate the resource
  // type after retries. Without this, "fetch failed → catch → moved on" silently
  // produces a green sweep banner ("No orphans found") when in reality we just
  // couldn't check. The regression banner reads this flag and surfaces an
  // explicit "could not enumerate" line so subagents don't trust a clean sweep
  // that wasn't actually clean.
  let enumFailed = false;

  // Incomplete walks still delete what they DID enumerate, but must flip the
  // sticky enumFailed flag so the banner says "could not (fully) enumerate"
  // instead of blessing a partial listing as clean.
  const markIncomplete = (what: string) => {
    enumFailed = true;
    console.warn(
      `${tag} [sweep] ${what} enumeration incomplete — residue past the last readable page cannot be ruled out`,
    );
  };

  // 1. Delete any servers whose name contains the project name
  // We collect the IDs we DELETE'd so we can confirm completion before
  // sweeping dependent resources. Hetzner server DELETE is async — the API
  // returns 200 immediately but the underlying action (detach FIPs, leave
  // firewalls, leave networks, leave placement groups) may take 5-30s to
  // complete. If the dependent-resource sweeps run before that completes,
  // they enumerate FIPs/firewalls/networks/PGs that are STILL ATTACHED to
  // a deleting server and skip them (`if (fip.server) continue;` etc.),
  // leaving stale residue. Today's matrix left 12 such resources that I
  // had to clean manually. Waiting for `GET /v1/servers/{id}` to return
  // 404 is the canonical "server is fully gone" signal.
  const deletedServerIds: number[] = [];
  try {
    const { items: orphanServers, complete: srvComplete } = await listSweepPages<{
      id: number;
      name: string;
    }>('/servers', 'servers', `label_selector=project%3D${encodeURIComponent(projectName)}`);
    if (!srvComplete) markIncomplete('server list');
    for (const srv of orphanServers) {
      console.log(`${tag} [sweep] Deleting orphaned server ${srv.id} (${srv.name})`);
      const delResp = await sweepFetch(`https://api.hetzner.cloud/v1/servers/${srv.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${hetznerToken}` },
      });
      // If the DELETE itself failed after retries, mark enumFailed so the
      // sweep banner surfaces the gap. Hetzner returns 200/204 on success.
      if (!delResp || (!delResp.ok && delResp.status !== 404)) {
        enumFailed = true;
        console.warn(
          `${tag} [sweep] Server ${srv.id} delete returned ${delResp?.status ?? 'no response'}`,
        );
      } else {
        counts.servers++;
        deletedServerIds.push(srv.id);
      }
    }
  } catch (e) {
    console.warn(`${tag} [sweep] Server cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 1b. Wait for server DELETEs to actually complete before sweeping dependents.
  // Per-server budget 90s (well above the typical 5-30s settlement); poll every
  // 3s. We poll all deleted servers in parallel — the bound is the slowest, not
  // the sum. A server still present after 90s is logged as enumFailed (so the
  // banner reflects the gap) but does not block the rest of the sweep.
  if (deletedServerIds.length > 0) {
    console.log(
      `${tag} [sweep] Waiting for ${deletedServerIds.length} server delete(s) to complete...`,
    );
    const SETTLE_BUDGET_MS = 90_000;
    const POLL_INTERVAL_MS = 3_000;
    await Promise.all(
      deletedServerIds.map(async (id) => {
        const start = Date.now();
        while (Date.now() - start < SETTLE_BUDGET_MS) {
          const r = await sweepFetch(`https://api.hetzner.cloud/v1/servers/${id}`, {
            headers: { Authorization: `Bearer ${hetznerToken}` },
          });
          // 404 = gone (the goal). Any 2xx = still present, keep polling.
          // sweepFetch returns null after 3 retries; treat as transient and
          // continue polling — the server may genuinely be mid-delete.
          if (r && r.status === 404) return;
          await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
        }
        // Server didn't disappear within budget. Surface as enumFailed so
        // the sweep banner doesn't falsely report a clean run.
        enumFailed = true;
        console.warn(
          `${tag} [sweep] Server ${id} still present after ${SETTLE_BUDGET_MS / 1000}s — dependent resources may be skipped`,
        );
      }),
    );
  }
  try {
    // Scope the listing to THIS project's volumes (the CSI controller stamps
    // `project=<name>` via HCLOUD_VOLUME_EXTRA_LABELS, set in master-init.sh).
    // pvc-* names carry no owner info, and "unattached" is NOT abandonment:
    // a pilot-light reconverge legitimately detaches the db's volumes while
    // the reseed scales it to zero — an unscoped sweep from a CONCURRENT run
    // (CI matrix vs laptop rig, 2026-07-18) deleted a live rig's data
    // volumes in exactly that window. Unlabeled volumes from pre-label
    // clusters are invisible here; the standalone scripts/sweep-hetzner.js
    // (only ever run with NOTHING live) still collects them.
    const { items: orphanVolumes, complete: volComplete } = await listSweepPages<{
      id: number;
      name: string;
      server: number | null;
    }>('/volumes', 'volumes', `label_selector=${encodeURIComponent(`project=${projectName}`)}`);
    if (!volComplete) markIncomplete('volume list');
    for (const vol of orphanVolumes) {
      // Only delete unattached PVC volumes (K8s leftovers)
      if (vol.server === null && vol.name.startsWith('pvc-')) {
        console.log(`${tag} [sweep] Deleting orphaned volume ${vol.id} (${vol.name})`);
        await sweepFetch(`https://api.hetzner.cloud/v1/volumes/${vol.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${hetznerToken}` },
        });
        counts.volumes++;
      }
    }
  } catch (e) {
    console.warn(`${tag} [sweep] Volume cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 2a. Delete placement groups whose name matches this test project. Hetzner
  // caps a project at 50 placement groups — runs #1..N accumulate these fast
  // and the 51st run hits `placement_group limit exceeded` on Pulumi up,
  // destroying the VM stack before any workload can be scheduled.
  try {
    // Don't use `?name=<projectName>` — Hetzner's name filter is exact-match,
    // so it never returns the suffixed `<projectName>-<env>-<role>-pg` names
    // we actually create. List every page and prefix-match in code,
    // matching the firewall/FIP sweep pattern below.
    const { items: pgs, complete: pgComplete } = await listSweepPages<{
      id: number;
      name: string;
      servers?: number[];
    }>('/placement_groups', 'placement_groups');
    if (!pgComplete) markIncomplete('placement-group list');
    const deletedSet = new Set(deletedServerIds);
    // Treat references to servers we just DELETE'd as released — Hetzner's
    // attachment fields lag the server's 404 by a few seconds (PR 1BX waits
    // for 404, but FIP/firewall/network/PG reconciliation can take longer
    // and the sweep would otherwise skip these as "still attached" even
    // though the server is gone). Filter the servers array against deleted
    // IDs before checking length.
    const liveRefs = (servers: number[] | undefined) =>
      (servers ?? []).filter((sid) => !deletedSet.has(sid));
    // Also grab any trailing `-primary-` / `-standby-` style prefixes that
    // start with the project name — Hetzner's name filter is prefix-match.
    for (const pg of pgs) {
      if (!pg.name.startsWith(projectName)) continue;
      if (liveRefs(pg.servers).length > 0) continue; // still referenced by a live server
      console.log(`${tag} [sweep] Deleting orphaned placement-group ${pg.id} (${pg.name})`);
      await sweepFetch(`https://api.hetzner.cloud/v1/placement_groups/${pg.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${hetznerToken}` },
      });
      counts.placementGroups++;
    }
  } catch (e) {
    console.warn(
      `${tag} [sweep] Placement-group cleanup failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  // 2b. Delete firewalls whose name matches this test project. Same 50-cap
  // story as placement groups — every e2e run creates a fresh
  // `testapp-<mode>-<ts>-<id>-firewall`, and the 51st run hits
  // `firewall limit exceeded`.
  //
  // Don't use `?name=<projectName>` — Hetzner's name filter is exact-match,
  // so it never returns the suffixed `<projectName>-<env>-firewall` we want.
  // List every page and filter by `startsWith(projectName)`,
  // matching the FIP/network sweep pattern below.
  try {
    const { items: firewalls, complete: fwComplete } = await listSweepPages<{
      id: number;
      name: string;
      applied_to?: { type?: string; server?: { id?: number } }[];
    }>('/firewalls', 'firewalls');
    if (!fwComplete) markIncomplete('firewall list');
    for (const fw of firewalls) {
      if (!fw.name.startsWith(projectName)) continue;
      // Filter applied_to: a server-type entry whose server.id is in our
      // deleted set is effectively gone. Anything else (label_selector,
      // a server we did NOT delete) means the firewall is still in use.
      const liveAttachments = (fw.applied_to ?? []).filter((a) => {
        if (a.type !== 'server') return true; // label_selector etc — keep
        const sid = a.server?.id;
        return sid != null && !deletedServerIds.includes(sid);
      });
      if (liveAttachments.length > 0) continue;
      console.log(`${tag} [sweep] Deleting orphaned firewall ${fw.id} (${fw.name})`);
      await sweepFetch(`https://api.hetzner.cloud/v1/firewalls/${fw.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${hetznerToken}` },
      });
      counts.firewalls++;
    }
  } catch (e) {
    console.warn(`${tag} [sweep] Firewall cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 2b'. Delete SSH keys whose name starts with this project name.
  // Hetzner's `?name=` filter is exact-match — Pulumi names compose keys
  // `<project>-<env>-<region>-key`, k8s-ha keys `<project>-<env>-ha-key`.
  // Listing without a filter and prefix-matching is the simplest cover;
  // Hetzner caps at 50 keys per project before the create-key API errors
  // with `uniqueness_error 409` (observed 2026-04-27 morning matrix —
  // compose's destroy hit pagination, key fell off page 1, restore re-deploy
  // hit "SSH key not unique" because the key was actually still there).
  // Fix in destroy.js (PR 1BO) addresses the destroy path; this sweep is
  // the safety net for failed destroys + cross-test residue.
  try {
    const { items: sshKeys, complete: keyComplete } = await listSweepPages<{
      id: number;
      name: string;
    }>('/ssh_keys', 'ssh_keys');
    if (!keyComplete) markIncomplete('ssh-key list');
    for (const key of sshKeys) {
      if (!key.name?.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned SSH key ${key.id} (${key.name})`);
      await sweepFetch(`https://api.hetzner.cloud/v1/ssh_keys/${key.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${hetznerToken}` },
      });
      counts.sshKeys++;
    }
  } catch (e) {
    console.warn(`${tag} [sweep] SSH key cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 2c. Delete Floating IPs whose name matches this test project. Hetzner
  // caps a project at 10 floating IPs by default — exactly the number a
  // single matrix run consumes (1 k8s + 2 k8s-ha) over 3-4 runs. When
  // Pulumi destroy can't run (failed deploy → no env in .vibecarbon.json
  // → no s3Config in projectConfig → orphan-detection finds nothing,
  // observed 2026-04-26 matrix runs #2 + #3), the FIP outlives the
  // servers and the next deploy fails with `Floating IP limit exceeded`.
  try {
    const { items: floatingIps, complete: fipComplete } = await listSweepPages<{
      id: number;
      name: string;
      server: number | null;
    }>('/floating_ips', 'floating_ips');
    if (!fipComplete) markIncomplete('floating-IP list');
    for (const fip of floatingIps) {
      if (!fip.name?.startsWith(projectName)) continue;
      // fip.server is the attached server's id, or null. Treat references
      // to a server we just DELETE'd as released.
      if (fip.server != null && !deletedServerIds.includes(fip.server)) continue;
      console.log(`${tag} [sweep] Deleting orphaned floating IP ${fip.id} (${fip.name})`);
      await sweepFetch(`https://api.hetzner.cloud/v1/floating_ips/${fip.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${hetznerToken}` },
      });
      counts.floatingIps++;
    }
  } catch (e) {
    console.warn(
      `${tag} [sweep] Floating IP cleanup failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  // 2d. Delete networks whose name matches this test project. Networks
  // don't have a hard quota that breaks deploys, but accumulating them
  // is messy and they hold subnet/route allocations the next deploy
  // would otherwise reuse. Delete only when no servers are attached.
  try {
    // Same exact-match-name caveat as placement groups: list unfiltered and
    // prefix-match in code so suffixed names like `<projectName>-<env>-network`
    // are actually returned.
    const { items: networks, complete: netComplete } = await listSweepPages<{
      id: number;
      name: string;
      servers?: number[];
    }>('/networks', 'networks');
    if (!netComplete) markIncomplete('network list');
    for (const net of networks) {
      if (!net.name?.startsWith(projectName)) continue;
      // Treat references to servers we just DELETE'd as released.
      const liveServers = (net.servers ?? []).filter((sid) => !deletedServerIds.includes(sid));
      if (liveServers.length > 0) continue;
      console.log(`${tag} [sweep] Deleting orphaned network ${net.id} (${net.name})`);
      await sweepFetch(`https://api.hetzner.cloud/v1/networks/${net.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${hetznerToken}` },
      });
      counts.networks++;
    }
  } catch (e) {
    console.warn(`${tag} [sweep] Network cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 3. Delete S3 buckets created by this test project.
  // Each bucket is wrapped in its own try/catch so one failure (e.g.,
  // BucketNotEmpty from versioning or a stuck multipart upload) doesn't
  // strand buckets in the remaining regions. Emptying is delegated to
  // HetznerS3Provider.emptyAndDeleteBucket so we get version + multipart
  // handling for free instead of re-implementing it inline.
  try {
    // Env-only (the credentials.json profiles fallback this used to have was
    // retired — A5). runner.ts's loadE2EEnvFile() pre-populates process.env
    // from tests/.env.e2e before this runs (A6).
    const s3Creds = {
      accessKey: process.env.HETZNER_ACCESS_KEY,
      secretKey: process.env.HETZNER_SECRET_KEY,
    };
    if (!s3Creds?.accessKey || !s3Creds?.secretKey) throw new Error('No S3 credentials');

    const { S3Client, ListBucketsCommand } = await import('@aws-sdk/client-s3');
    // biome-ignore lint/suspicious/noExplicitAny: JS module interop
    const { HetznerS3Provider } = (await import('../../../src/lib/providers/hetzner-s3.js')) as any;

    // Hetzner Object Storage has three regions — deploy may use any of them
    // (nbg1 for primary e2e scenarios, hel1 as secondaryRegion for HA
    // scenarios). Scan all three so we don't strand standby-region buckets.
    for (const region of ['nbg1', 'fsn1', 'hel1']) {
      try {
        const s3 = new S3Client({
          endpoint: `https://${region}.your-objectstorage.com`,
          region,
          credentials: { accessKeyId: s3Creds.accessKey, secretAccessKey: s3Creds.secretKey },
          forcePathStyle: true,
        });

        const resp = await s3.send(new ListBucketsCommand({}));
        const matching = (resp.Buckets ?? []).filter(
          (b): b is typeof b & { Name: string } => !!b.Name?.startsWith(projectName),
        );
        for (const bucket of matching) {
          const name = bucket.Name;
          console.log(`${tag} [sweep] Deleting S3 bucket ${name} (${region})`);
          try {
            const provider = new HetznerS3Provider(s3Creds.accessKey, s3Creds.secretKey, region);
            const { objectsRemoved } = await provider.emptyAndDeleteBucket(name);
            console.log(`${tag} [sweep]   deleted ${name} (${objectsRemoved} obj)`);
            counts.s3Buckets++;
          } catch (bucketErr) {
            console.warn(
              `${tag} [sweep]   FAILED ${name}: ${bucketErr instanceof Error ? bucketErr.message : String(bucketErr)}`,
            );
          }
        }
      } catch (regionErr) {
        console.warn(
          `${tag} [sweep] S3 region ${region} failed: ${regionErr instanceof Error ? regionErr.message : String(regionErr)}`,
        );
      }
    }
  } catch (e) {
    console.warn(`${tag} [sweep] S3 cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // Regression banner. Sweep is the safety net behind `vibecarbon destroy`;
  // every non-zero category is destroy silently no-op'ing on that resource
  // type (PR 1BD shipped after this signal stayed buried for 5+ runs).
  // Single warn-level line so subagents grepping `grep -E '\[sweep\] REGRESSION'`
  // or `WHERE orphans_swept > 0` can find the regressions deterministically.
  const totalOrphans =
    counts.servers +
    counts.volumes +
    counts.placementGroups +
    counts.firewalls +
    counts.floatingIps +
    counts.networks +
    counts.s3Buckets +
    counts.sshKeys;
  if (totalOrphans > 0) {
    const breakdown = [
      `servers=${counts.servers}`,
      `volumes=${counts.volumes}`,
      `placement-groups=${counts.placementGroups}`,
      `firewalls=${counts.firewalls}`,
      `fips=${counts.floatingIps}`,
      `networks=${counts.networks}`,
      `s3-buckets=${counts.s3Buckets}`,
      `ssh-keys=${counts.sshKeys}`,
    ].join(', ');
    console.warn(
      `${tag} [sweep] REGRESSION: destroy left ${totalOrphans} orphan resource(s) (${breakdown}). vibecarbon destroy did not free these — fix the corresponding destroy code path.`,
    );
  } else if (enumFailed) {
    // counts==0 but enumeration failed at least once — we did NOT verify.
    // Surfacing this explicitly is the difference between "destroy worked"
    // (a load-bearing claim the matrix relies on) and "we couldn't tell"
    // (the actual state when sweepFetch returns null after retries).
    console.warn(
      `${tag} [sweep] REGRESSION: could not enumerate one or more resource types after retries — orphan check is incomplete, treat as a destroy regression.`,
    );
  } else {
    // Name the cloud that was actually verified — until 2026-08-07 this line
    // printed after DO runs too, blessing a sweep of the WRONG cloud as clean.
    console.log(`${tag} [sweep] No Hetzner orphans found — destroy worked cleanly.`);
  }

  // Aligned with the DO/Linode/Vultr sweeps' return shape so the lifecycle
  // can gate the scenario verdict on sweep cleanliness (2026-08-09: round-A
  // v1 counted PASS while two leaked instances sat behind an enum-incomplete
  // banner nothing consumed).
  return { counts, enumFailed };
}

/**
 * Reap operator-side Docker images and volumes left behind by THIS scenario's
 * local builds. The provider orphan sweeps handle the CLOUD side; this handles
 * the LOCAL machine, where each deploy accumulates artifacts that nothing else
 * removes:
 *
 *   - k8s / k8s-ha build `10.0.1.1:5000/<projectName>:<sha>-<ts>` locally
 *     (buildLocalImage in src/lib/deploy/image.js) to sideload + push. Only the
 *     transient `localhost:<port>/…` push aliases get reaped (pushImageToLocalRegistry);
 *     the original registry-prefixed tag is kept for the Deployment and never
 *     removed. Iterating a kept rig mints a fresh timestamped tag every rebuild,
 *     so these pile up unbounded → `docker builder prune` / `docker system df`
 *     showed hundreds of `testapp-k8s-*` images (60GB+ reclaimable).
 *   - compose local builds tag `<projectName>-app:local` / `vibecarbon-local/<projectName>`.
 *
 * projectName is per-run unique (`testapp-<mode>-<ts>-<suffix>`), so a substring
 * match on the image *repository* is safe and prefix-agnostic — it catches every
 * tag scheme without hardcoding registry prefixes. Best-effort throughout: this
 * runs during teardown (pass OR fail, but never when a rig is kept), and nothing
 * here may crash the run or slow it meaningfully. Skipped entirely when a rig is
 * preserved (VC_KEEP_*), because the kept images are what the operator iterates.
 */
async function reapLocalBuildArtifacts(tag: string, projectName: string): Promise<void> {
  const { execFileSync } = await import('node:child_process');

  // Best-effort docker call: capture stdout, swallow everything else. A missing
  // docker binary or a daemon hiccup must not derail cleanup.
  const docker = (argv: readonly string[], timeoutMs = 30_000): string => {
    try {
      return execFileSync('docker', argv, {
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 8 * 1024 * 1024,
      }).trim();
    } catch {
      return '';
    }
  };

  try {
    // Images: match on repository (the part before the last ':'), not the whole
    // ref, so a git-sha tag that happens to contain projectName-like text can't
    // widen the match. rmi by full ref (repo:tag) is unambiguous.
    const refs = docker(['images', '--format', '{{.Repository}}:{{.Tag}}'])
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)
      .filter((ref) => {
        const repo = ref.slice(0, ref.lastIndexOf(':'));
        return repo.includes(projectName);
      });
    if (refs.length > 0) {
      // -f: these images are no longer referenced by any running container
      // (the rig is being destroyed), but a lingering stopped container or a
      // second tag on the same image id would otherwise block plain rmi.
      docker(['rmi', '-f', ...refs]);
      console.log(`${tag} [reap] Removed ${refs.length} local build image(s) for ${projectName}`);
    }

    // Volumes: real-infra k8s volumes are PVC-backed on the (now-destroyed)
    // cluster and compose real-infra volumes live on the remote host, so this
    // is usually a no-op — but a local compose build leaves `<projectName>_*`
    // volumes, and reaping them here keeps the local volume pool from drifting.
    const vols = docker(['volume', 'ls', '--format', '{{.Name}}'])
      .split('\n')
      .map((v) => v.trim())
      .filter((name) => name.includes(projectName));
    if (vols.length > 0) {
      docker(['volume', 'rm', '-f', ...vols]);
      console.log(`${tag} [reap] Removed ${vols.length} local volume(s) for ${projectName}`);
    }
  } catch (e) {
    // Never fatal — teardown continues regardless.
    console.warn(
      `${tag} [reap] Local artifact reap failed (non-fatal): ${e instanceof Error ? e.message : e}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main lifecycle runner
// ---------------------------------------------------------------------------

export async function runLifecycle(
  config: ScenarioConfig,
  scenarioId: string,
  db: E2EDb,
  collector: MetricsCollector,
  hetznerToken: string,
  options: LifecycleOptions,
): Promise<ScenarioResult> {
  const tag = `[${config.mode}]`;
  const steps: StepResult[] = [];
  // Set by the teardown sweep when it finds orphans or cannot fully
  // enumerate — gates the scenario verdict (see the sweep block).
  let sweepRegression = false;
  let failed = false;
  let scenarioError: string | undefined;

  // Parent directory for `create` (create writes into parentDir/projectName)
  const parentDir = dirname(config.projectDir);

  // Per-scenario live log is provided by the runner via scenarioContext
  // (AsyncLocalStorage). Subprocess stdout/stderr is tee'd there as it
  // arrives — tail -f $TEMP_DIR/<provider>-<mode>-<dnsProvider>.log to watch
  // one scenario live without interleaving with the others in a parallel run.

  // Cache for values resolved after deploy
  let supabaseKeys: SupabaseKeys | null = null;
  let serverIps: string[] = [];
  let sshKeyPath: string | null = null;

  // The SSH-unreachability memo is process-wide; a parallel/kept-rig run must
  // not inherit a previous scenario's dead hosts (IPs get recycled).
  resetSshReachability();

  // verify-scale assertion bookkeeping. Populated by the scale step and
  // consumed by verify-scale to fail-loud when scale was a silent no-op
  // (caught silently before; see project_e2e_test_status.md). Kept
  // in closure scope so verify-scale doesn't have to re-derive them.
  let preScaleTypes: Record<string, string> | null = null;
  let postScaleTypes: Record<string, string> | null = null;
  let scaleStdout = '';
  let scaleStderr = '';

  // HA-only: marker row written on the CURRENT primary immediately before the
  // failover step, then asserted present on the PROMOTED primary in
  // verify-failover (see runFailoverContinuityCheck). Null until the failover
  // step writes it; a null marker makes the continuity check self-skip.
  let failoverContinuityMarkerId: string | null = null;
  // The node the continuity marker was WRITTEN to (the pre-failover primary).
  // Kept so verify-failover can prove it is not simply re-reading the marker
  // off its own origin node — see the false-green guard below.
  let failoverMarkerOriginIp: string | null = null;

  // Phase 9: when --expanded is set on a k8s/k8s-ha scenario, deploy with
  // --min-workers=1 / --max-workers=5 so verify-autoscale has headroom to
  // drive the cluster-autoscaler ceiling. Without these flags, deploy
  // defaults to (1, 3) and the test can only spawn 2 extra workers before
  // hitting MAX — not a meaningful end-to-end CA test. The (1, 5) shape
  // means baseline = 3 nodes (master + supabase + 1 worker) and a 6-pod
  // loadgen Deployment forces CA to spawn 4 extra workers + leave the 6th
  // replica Pending.
  const isK8sMode = config.mode === 'k8s' || config.mode === 'k8s-ha';
  const useExpandedAutoscaleBounds = options.expanded === true && isK8sMode;
  const expandedDeployBounds = useExpandedAutoscaleBounds ? { minWorkers: 1, maxWorkers: 5 } : {};

  // verify-scale type-snapshot capture (tests/e2e/utils/server-types.ts —
  // M3 Task 9e). Provider-aware: DO scenarios (config.provider ===
  // 'digitalocean') query DO's droplet API with the DO token instead of
  // Hetzner's; every existing (Hetzner) scenario resolves to the same
  // provider/token pair it always used. Resolved once here since both
  // scale-step call sites need the same pair.
  // Single home for provider→token resolution inside the lifecycle. Throws
  // on an unknown id so provider N+1 fails loudly here instead of silently
  // borrowing the Hetzner token (the pre-2026-08-07 default-else shape of
  // the two ternaries this replaced).
  const providerTokenFor = (providerId: string): string | undefined => {
    switch (providerId) {
      case 'hetzner':
        return hetznerToken;
      case 'digitalocean':
        return options.digitaloceanToken;
      case 'linode':
        return options.linodeToken;
      case 'vultr':
        return options.vultrToken;
      case 'scaleway':
        return options.scalewayToken;
      default:
        throw new Error(`no e2e token wiring for provider '${providerId}'`);
    }
  };
  const typeSnapshotProvider = config.provider ?? 'hetzner';
  const typeSnapshotToken = providerTokenFor(typeSnapshotProvider);

  // -------------------------------------------------------------------------
  // Step executor — wraps every lifecycle step with DB bookkeeping, timing,
  // error handling, and metric collection.
  // -------------------------------------------------------------------------

  async function executeStep(
    name: StepName,
    command: string,
    fn: (stepId: string) => Promise<void>,
  ): Promise<StepResult> {
    const stepId = randomUUID();
    const startedAt = new Date().toISOString();

    db.createStep({ id: stepId, scenarioId, name, command });
    db.startStep(stepId);

    console.log(`${tag} Starting step: ${name}`);
    const t0 = performance.now();

    try {
      // Nest the scenario context so cli-runner can persist [perf] substep
      // timings under this step's id. Falls back gracefully when the parent
      // context is undefined (e.g. tests that bypass scenarioContext.run).
      const parentCtx = scenarioContext.getStore() ?? {};
      const stepCtx = {
        ...parentCtx,
        recordPerfSubsteps: (timings: Array<{ name: string; ms: number; note?: string }>) =>
          collector.recordPerfSubsteps(stepId, timings),
      };
      await scenarioContext.run(stepCtx, () => fn(stepId));

      const durationMs = Math.round(performance.now() - t0);
      const finishedAt = new Date().toISOString();

      db.completeStep(stepId, 'pass', durationMs);
      collector.recordTiming(stepId, durationMs);

      console.log(`${tag} Step ${name} passed (${(durationMs / 1000).toFixed(1)}s)`);

      return {
        name,
        status: 'pass',
        startedAt,
        finishedAt,
        durationMs,
        command,
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - t0);
      const finishedAt = new Date().toISOString();
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack : undefined;

      // Categorize so the run summary can distinguish "infra had a bad day"
      // from "we shipped a regression". Pattern-based — see classify-failure.ts.
      // The classification can be overridden later by:
      //   - the retry path (-> 'flake' if the retry passes)
      //   - the diff-vs-green pass (-> 'regression' if this step passed in the
      //     last green run on this branch)
      const classification = classifyFailure({ errorMessage, errorStack });

      db.completeStep(stepId, 'fail', durationMs, errorMessage, errorStack);

      console.error(
        `${tag} Step ${name} FAILED (${(durationMs / 1000).toFixed(1)}s) [${classification.category}${classification.reason ? `: ${classification.reason}` : ''}]: ${errorMessage}`,
      );

      // Universal diagnostic dump on ANY step failure. Each step's own
      // capture (probe-failure, basebackup, etc.) gets the precise data
      // for that step; this is the broad-net safety capture so any new
      // failure mode self-documents enough that we don't have to re-run
      // the test to learn what went wrong. Best-effort + bounded —
      // we're already failing; nothing here should make it worse.
      try {
        await captureFailureDiagnostics(config, name, tag);
      } catch (diagErr) {
        console.error(
          `${tag} (diagnostic capture failed: ${diagErr instanceof Error ? diagErr.message : String(diagErr)})`,
        );
      }

      return {
        name,
        status: 'fail',
        startedAt,
        finishedAt,
        durationMs,
        command,
        errorMessage,
        errorStack,
        failureCategory: classification.category,
        attempts: 1,
      };
    }
  }

  /**
   * Create a skip result for steps that are bypassed due to a prior failure.
   */
  function skipStep(name: StepName, command: string): StepResult {
    const now = new Date().toISOString();

    // Record the skip in the DB
    const stepId = randomUUID();
    db.createStep({ id: stepId, scenarioId, name, command });
    db.startStep(stepId);
    db.completeStep(stepId, 'skip', 0, 'Skipped due to prior failure');

    console.log(`${tag} Skipping step: ${name} (prior failure)`);

    return {
      name,
      status: 'skip',
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      command,
      errorMessage: 'Skipped due to prior failure',
    };
  }

  // -------------------------------------------------------------------------
  // Verification helper — runs all health, functional, and feature checks
  // and records results via the collector.
  // -------------------------------------------------------------------------

  async function runVerificationChecks(stepName: StepName): Promise<StepResult> {
    const command = `verify:${config.domain}`;

    // ── Post-failover resolution pin (compose-ha verify-failover ONLY) ──
    //
    // compose-ha failover repoints the environment by rewriting the apex +
    // wildcard A records. DNS-based failover inherently leaves clients on the
    // OLD address until their cached record expires — docs/rto-rpo.md bounds
    // that tail by the 60s TTL the flip writes and counts it as part of the
    // published RTO, not as a deployment fault. The verifier used to inherit
    // that tail and grade the deployment on it: on 2026-08-11 the operator's
    // resolver chain held the retired address mid-TTL, so the battery SPLIT —
    // auth_health/auth_signup/rest_api reached the promoted node and passed
    // while spa_auth_callback, auth_signin, auth_admin_login, db_schema and
    // storage_upload hit the DEMOTED node (app tier deliberately stopped) and
    // failed. None of the failing request ids appeared in the promoted node's
    // Kong access log; everything healed at TTL expiry.
    //
    // Inside this pin every HTTP check dials the promoted node directly while
    // keeping the domain as Host + TLS SNI, so serving correctness (name-based
    // routing, certificate validity) is still fully asserted. Whether the flip
    // PUBLISHED is a separate assertion — `dns_failover_flip` below, against
    // the zone's authoritative nameservers. The verifier's job is those two
    // things, not measuring how long the operator's ISP cache holds a record.
    //
    // Scope is deliberately narrow: verify-deploy and friends stay on the
    // public-resolver path because that IS the customer cold path, and k8s-ha
    // failover moves a floating IP without ever rewriting the A record.
    let verifyPin: ResolutionPin | null = null;
    if (stepName === 'verify-failover' && config.mode === 'compose-ha') {
      const { primaryIp } = resolveHaDbIps(config.projectDir, config.envPrefix);
      if (primaryIp) {
        verifyPin = {
          domain: config.domain,
          ip: primaryIp,
          reason: `verify-failover: promoted primary for ${config.envPrefix}`,
        };
        console.log(
          `${tag} [verify-failover] pinning HTTP checks for ${config.domain} (and *.${config.domain}) ` +
            `to the promoted primary ${primaryIp} — Host/SNI stay ${config.domain}`,
        );
      } else {
        console.warn(
          `${tag} [verify-failover] no promoted primary IP in .vibecarbon.json — HTTP checks fall ` +
            'back to the public resolvers and may hit the retired node mid-TTL',
        );
      }
    }

    // verify-scale gets the SAME pin for the same reason (run 32013980356,
    // compose-ha): a blue-green compose scale rewrites the apex + wildcard A
    // records to the replacement primary and DESTROYS the old servers, then
    // verify-scale rendered the frontend seconds into the 60s TTL — the
    // operator resolver chain handed it the retired address and the page
    // "rendered 0 chars" against a dead server. Compose modes only: k8s scale
    // is a Pulumi in-place resize and never rewrites the record. Whether the
    // flip PUBLISHED is asserted separately by `dns_scale_flip` below.
    if (stepName === 'verify-scale' && config.mode.startsWith('compose')) {
      const { primaryIp } = resolveHaDbIps(config.projectDir, config.envPrefix);
      const postScaleIp =
        primaryIp ?? readSingleServerIp(config.projectDir, config.envPrefix) ?? null;
      if (postScaleIp) {
        verifyPin = {
          domain: config.domain,
          ip: postScaleIp,
          reason: `verify-scale: post-scale serving IP for ${config.envPrefix}`,
        };
        console.log(
          `${tag} [verify-scale] pinning HTTP checks for ${config.domain} (and *.${config.domain}) ` +
            `to the post-scale server ${postScaleIp} — Host/SNI stay ${config.domain}`,
        );
      } else {
        console.warn(
          `${tag} [verify-scale] no post-scale server IP in .vibecarbon.json — HTTP checks fall ` +
            'back to the public resolvers and may hit a destroyed pre-scale server mid-TTL',
        );
      }
    }

    return withResolutionPin(verifyPin, () =>
      executeStep(stepName, command, async (stepId) => {
        // Wait for the service to become healthy before running detailed checks
        console.log(`${tag} Waiting for ${config.domain} to become healthy...`);
        const healthy = await waitForHealthy(config.domain, TIMEOUTS[stepName], 10_000);
        if (!healthy) {
          // Before throwing, dump on-cluster diagnostics so the next iteration
          // has something to fix. Without this, a waitForHealthy timeout gives
          // us nothing to act on — we just know the domain never answered.
          try {
            if (config.mode.startsWith('k8s') && serverIps.length > 0 && sshKeyPath) {
              const { execFileSync } = await import('node:child_process');
              // In HA mode dump diag from BOTH clusters. Previously we only
              // looked at serverIps[0] (primary master) and were blind to what
              // the standby cluster was doing — which matters because HA failure
              // modes can be asymmetric (one cluster healthy, the other not).
              //
              // getServerIps returns
              //   [primary_master, primary_supabase, standby_master, standby_supabase]
              // for k8s-ha (see tests/e2e/utils/ssh.ts). We want the two
              // master IPs (k3s API server runs there); slice(0,2) was picking
              // [primary_master, primary_supabase] and the standby kubectl was
              // hitting a node with no API server → "connection refused: dial
              // tcp [::1]:8080" floods (k8s-ha matrix #7 verify-failover, PR 1BF).
              const clusterIps =
                config.mode === 'k8s-ha' ? [serverIps[0], serverIps[2]] : [serverIps[0]];
              const clusterLabels = config.mode === 'k8s-ha' ? ['primary', 'standby'] : ['cluster'];
              for (let i = 0; i < clusterIps.length; i++) {
                const ip = clusterIps[i];
                const label = clusterLabels[i];
                const sshOpts = [...e2eSshOpts(10), '-i', sshKeyPath, `root@${ip}`];
                const ssh = (cmd: string) => {
                  try {
                    return execFileSync('ssh', [...sshOpts, cmd], {
                      encoding: 'utf-8',
                      timeout: 15_000,
                      stdio: 'pipe',
                    }).trim();
                  } catch (sshErr) {
                    return `(ssh to ${ip} failed: ${sshErr instanceof Error ? sshErr.message.split('\n')[0] : String(sshErr)})`;
                  }
                };
                console.log(`${tag} [diag] === cluster ${label} (${ip}) ===`);
                const pods = ssh(
                  `kubectl get pods -A --no-headers 2>&1 | awk '$4 != "Running" && $4 != "Completed"' | head -20 || echo "(kubectl unavailable)"`,
                );
                console.log(
                  `${tag} [diag][${label}] non-Running pods: ${pods ? `\n${pods}` : '(all Running)'}`,
                );
                // Unambiguous image attribution: jsonpath of the actual image in
                // deployment/app.spec.template.spec.containers[0].image. This is
                // the single source of truth for what pods will pull.
                const appImage = ssh(
                  `kubectl get deployment/app -n vibecarbon -o jsonpath='{.spec.template.spec.containers[0].image}' 2>&1 || echo "(no app deployment)"`,
                );
                console.log(`${tag} [diag][${label}] deployment/app.image=${appImage}`);
                // Full deployment+statefulset image table for kong/postgres/etc.
                const deployments = ssh(
                  `kubectl get deployments,statefulsets -n vibecarbon -o wide 2>&1 | head -25 || echo "(no deployments)"`,
                );
                console.log(`${tag} [diag][${label}] deployment image tags:\n${deployments}`);
                // Cluster-wide warning events — catches Docker Hub rate-limit
                // 429s, DNS resolution failures, authorization errors. These
                // appear as Warning events but don't always show in per-pod
                // describe (e.g., a pod may have been deleted and recreated).
                const warnEvents = ssh(
                  `kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp 2>&1 | tail -25 || echo "(no events)"`,
                );
                console.log(`${tag} [diag][${label}] warning events tail:\n${warnEvents}`);
                // For each non-Running pod, dump its describe Events tail — this
                // is where "ImagePullBackOff", "CreateContainerConfigError", and
                // "CrashLoopBackOff" reveal their actual cause (registry URL,
                // missing secret/configmap key, crash stack). For CrashLoop pods
                // also grab the previous container's log tail.
                if (pods && !pods.includes('all Running')) {
                  const podLines = pods.split('\n').filter((l) => l.trim());
                  for (const line of podLines.slice(0, 15)) {
                    const parts = line.split(/\s+/);
                    const ns = parts[0];
                    const name = parts[1];
                    const status = parts[3] || '';
                    if (!ns || !name) continue;
                    const describe = ssh(
                      `kubectl describe pod -n ${ns} ${name} 2>&1 | awk '/^Events:/,/^$/' | tail -15 || echo "(describe failed)"`,
                    );
                    console.log(`${tag} [diag][${label}] pod ${ns}/${name} events:\n${describe}`);
                    if (status === 'CrashLoopBackOff' || status === 'Error') {
                      const prevLog = ssh(
                        `kubectl logs -n ${ns} ${name} --previous --tail=30 2>&1 | tail -30 || echo "(no previous log)"`,
                      );
                      console.log(
                        `${tag} [diag][${label}] pod ${ns}/${name} previous log:\n${prevLog}`,
                      );
                    }
                  }
                }
                const cert = ssh(
                  `kubectl get certificate,certificaterequest -n vibecarbon -o wide 2>&1 | head -10 || echo "(no certificates)"`,
                );
                console.log(`${tag} [diag][${label}] certs:\n${cert}`);
                const tlsSecret = ssh(
                  `kubectl get secret vibecarbon-tls -n vibecarbon 2>&1 | head -5 || echo "(no tls secret)"`,
                );
                console.log(`${tag} [diag][${label}] vibecarbon-tls secret: ${tlsSecret}`);
                const traefikLogs = ssh(
                  `kubectl logs -n vibecarbon -l app=vibecarbon-traefik --tail=10 2>&1 | tail -10 || echo "(no traefik logs)"`,
                );
                console.log(`${tag} [diag][${label}] traefik tail:\n${traefikLogs}`);
                const ingressRoutes = ssh(
                  `kubectl get ingressroute -n vibecarbon -o wide 2>&1 | head -10 || echo "(no ingressroutes)"`,
                );
                console.log(`${tag} [diag][${label}] ingressroutes:\n${ingressRoutes}`);
                const configMaps = ssh(
                  `kubectl get configmap,secret -n vibecarbon --no-headers 2>&1 | head -20 || echo "(none)"`,
                );
                console.log(`${tag} [diag][${label}] configmaps/secrets:\n${configMaps}`);
                // Registry check: is the local-registry running on this cluster
                // and did the app image actually land in it? Without this we
                // can't tell whether the image push succeeded.
                const registryPod = ssh(
                  `kubectl get pods -n vibecarbon -l app=vibecarbon-registry -o wide 2>&1 | head -5 || echo "(no registry)"`,
                );
                console.log(`${tag} [diag][${label}] local-registry pod:\n${registryPod}`);
                // The mirror address isn't a fixed literal across providers —
                // see extractRegistryMirrorAddress's doc — so read it off the
                // node's own registries.yaml instead of hardcoding Hetzner's
                // static 10.0.1.1 (which would probe a dead address on DO's
                // dynamically-assigned VPC IPs).
                const registriesYaml = ssh(
                  `cat /etc/rancher/k3s/registries.yaml 2>/dev/null || echo "(no registries.yaml)"`,
                );
                const mirrorAddr = extractRegistryMirrorAddress(registriesYaml);
                const registryCatalog = mirrorAddr
                  ? ssh(
                      `curl -sf http://${mirrorAddr}/v2/_catalog --max-time 5 2>&1 || echo "(registry unreachable)"`,
                    )
                  : `(registry mirror address unknown: ${registriesYaml})`;
                console.log(`${tag} [diag][${label}] registry catalog: ${registryCatalog}`);
                const curlDirect = ssh(
                  `curl -sk -o /dev/null -w 'http=%{http_code} ct=%{content_type}' https://${config.domain}/api/health --max-time 10 || echo "curl-failed"`,
                );
                console.log(`${tag} [diag][${label}] curl from master: ${curlDirect}`);
              }
            }
          } catch (diagErr) {
            console.log(
              `${tag} [diag] capture failed: ${diagErr instanceof Error ? diagErr.message : String(diagErr)}`,
            );
          }
          throw new Error(`Domain ${config.domain} did not become healthy within timeout`);
        }

        // Resolve keys if not already cached
        if (!supabaseKeys) {
          supabaseKeys = readSupabaseKeys(config.projectDir);
        }
        if (!supabaseKeys) {
          throw new Error('Could not read Supabase keys from .env.local');
        }

        // Run all check groups
        const allResults: VerificationResult[] = [];

        // Single public origin in every mode: Traefik path-routes the versioned
        // Supabase prefixes (/auth/v1, /rest/v1, /realtime/v1, /storage/v1) on
        // the apex to Kong — there is no api. subdomain. Optional add-ons
        // (grafana/n8n/...) still use subdomains on compose, hence isCompose.
        const isCompose = config.mode.startsWith('compose');
        const apiDomain = config.domain;

        // Post-failover topology for SSH-based checks. BOTH HA modes promote the
        // FORMER STANDBY and retire the old primary — k8s-ha scales its services
        // to 0, compose-ha stops its containers outright (6affb594). Each mode
        // records the new roles differently: k8s-ha swaps ha.primary/ha.standby
        // wholesale (swapHaRoles' terminal write), compose-ha flips the `role`
        // field on each servers[] entry in place (failoverComposeHA). Neither
        // reorders servers[], so serverIps[0] keeps naming the OLD primary.
        // resolveHaDbIps() understands both shapes, so anchor sshCheckMasterIp to
        // it on every HA mode — this guard used to read `=== 'k8s-ha'` while its
        // own comment claimed both, and compose-ha spent two nights (2026-08-10,
        // -11) running every SSH/exec check against the decommissioned node.
        // Lazily backfill the SSH handles if the step that would have set them
        // has not run yet. Both accessors are pure reads of the project dir
        // (.vibecarbon.json / .vibecarbon/deploy_key_<env>) and return
        // empty/null rather than throwing, so this costs nothing when they are
        // already populated.
        //
        // Why it is needed: on the k8s tiers `serverIps` is not populated until
        // a later step, so at verify-deploy EVERY ssh-based check silently
        // self-skipped with "no serverIp/sshKeyPath" — config_secret_propagation,
        // config_oauth_gotrue_propagation and the wal-g backup evidence pair.
        // The k8s runs showed 18 passed / 8 skipped against compose's 27 / 4,
        // and the two config canaries never ran on k8s AT ALL, at any phase, on
        // any provider. They exist specifically to cover a k8s gap
        // (valueFrom secretKeyRef, silently missing until 2026-07-15), so the
        // check that was written for k8s was the one k8s never got.
        //
        // A self-skip is the right behaviour for a check with no way in; the
        // bug was handing it no way in when one was available all along.
        if (serverIps.length === 0) {
          serverIps = getServerIps(config.projectDir, config.envPrefix);
        }
        if (!sshKeyPath) {
          sshKeyPath = getSshKeyPath(config.projectDir, config.envPrefix);
        }
        let sshCheckMasterIp: string | undefined = serverIps[0];
        if (stepName === 'verify-failover' && config.mode.endsWith('-ha')) {
          const { primaryIp } = resolveHaDbIps(config.projectDir, config.envPrefix);
          if (primaryIp) sshCheckMasterIp = primaryIp;
        }

        // DNS-propagation gate for verify-failover: a fast failover (71.6s
        // post apikey-fix, run 2 2026-07-09) can finish before the A-record
        // flip reaches the pinned resolvers — the checks then hit the OLD
        // scaled-down primary (Kong 502 upstream, "missing" tables) and fail
        // spuriously. Wait (bounded) until the domain resolves to the promoted
        // IP; both modes rewrite .vibecarbon.json on failover (compose-ha in
        // failoverComposeHA, k8s-ha via swapHaRoles' terminal write), so a
        // fresh resolveHaDbIps().primaryIp is the promoted master on both —
        // that's what sshCheckMasterIp already resolves to above.
        if (stepName === 'verify-failover') {
          const promotedIp = sshCheckMasterIp;
          if (promotedIp) {
            console.log(
              `${tag} Waiting for ${config.domain} to resolve to promoted IP ${promotedIp}...`,
            );
            // 360s ceiling: the A record's TTL is 60s (hetzner-dns.js HA_TTL /
            // failover.js flip writes ttl:60), so a resolver that cached the old
            // IP just before the flip serves it for at most ~60s. This is an
            // early-exit poll — it returns the instant a pinned resolver serves
            // the promoted IP (typically well under 120s), so the generous
            // ceiling costs ~0 on a passing run and only bounds the failure path.
            //
            // The 60s premise is per-DNS-BACKEND, and one backend breaks it.
            // Hetzner and Cloudflare write ttl:60 directly; DigitalOcean's floor
            // is 30s so it carries 60 verbatim (digitalocean-dns.js header) —
            // all three leave ~300s of headroom under this ceiling. Linode does
            // NOT: `ttl_sec` is an enum whose floor is 300, and linode-dns.js
            // nearestTtlSec() rounds our requested 60 up to it, so a stale
            // resolver can legitimately serve the old IP for ~300s — only ~60s
            // of headroom left. No Linode scenario reaches this gate today (l1
            // is compose-only, no failover step), so nothing is at risk now;
            // raise this ceiling when a Linode HA tier lands, rather than
            // debugging it as a flake.
            const pointed = await waitForDnsToPoint(config.domain, promotedIp, {
              budgetMs: 360_000,
            });
            if (!pointed) {
              console.warn(
                `${tag} ${config.domain} still not resolving to ${promotedIp} after 360s — the ` +
                  'operator resolver chain is still inside the record TTL. Advisory only since ' +
                  '2026-08-12: the checks below are pinned to the promoted node, and whether the ' +
                  'flip published is asserted by dns_failover_flip against the authoritative NS.',
              );
            }
          }

          // Customer-honest half of the failover assertion, kept SEPARATE from
          // serving correctness: the pinned checks below prove the promoted node
          // serves; this proves the A record actually moved. It queries the
          // zone's AUTHORITATIVE nameservers (never the OS resolver, never a
          // cache), so it reports the published truth rather than wherever the
          // operator's resolver chain happens to sit inside the 60s TTL.
          allResults.push(
            await runDnsFailoverFlipCheck({
              domain: config.domain,
              // k8s-ha failover moves a floating IP between nodes and never
              // rewrites the A record, so there is no flip to assert — and
              // comparing the record against a node IP there would fail a
              // perfectly healthy failover.
              expectedIp: config.mode === 'compose-ha' ? (sshCheckMasterIp ?? null) : null,
              skipReason:
                config.mode === 'compose-ha'
                  ? null
                  : `${config.mode} failover repoints the A record at the promoted cluster's own ingress IP (floating/reserved) — the harness doesn't track that IP, and the serving checks already prove the domain resolves to the promoted cluster end-to-end`,
            }),
          );
        }

        // Publish-half of the verify-scale assertion (mirrors the failover
        // shape above): the pinned checks below prove the post-scale server
        // SERVES; this proves the scale's A-record rewrite actually reached
        // the zone's authoritative nameservers. Gated on the pin because the
        // pin is only computed for the record-flipping (compose) scales.
        if (stepName === 'verify-scale' && verifyPin) {
          allResults.push(
            await runDnsFailoverFlipCheck({
              domain: config.domain,
              expectedIp: verifyPin.ip,
              checkName: 'dns_scale_flip',
            }),
          );
        }

        // Wait for the Supabase gateway (apex /auth/v1 path → Kong) before the
        // functional checks — the app router can come up before Kong does.
        console.log(`${tag} Waiting for ${apiDomain}/auth/v1/health to become ready...`);
        const apiHealthy = await waitForHealthy(
          apiDomain,
          Math.min(TIMEOUTS[stepName], 120_000),
          5_000,
          '/auth/v1/health',
        );
        if (!apiHealthy) {
          console.warn(
            `${tag} Supabase gateway on ${apiDomain} did not become healthy within 120s — functional checks may fail`,
          );
        }

        // Infrastructure health checks (app endpoint, always on main domain)
        const healthResults = await runHealthChecks(config.domain, supabaseKeys.anonKey);
        allResults.push(...healthResults);

        // Evidence for any SSH-unreachability diagnosis raised later in this
        // phase: a deployment serving HTTP while its :22 is black-holed is the
        // signature of stale operator ACCESS, not a downed node. Recorded here,
        // before the first SSH-gated check, so the diagnosis can earn its
        // firewall headline instead of assuming it.
        noteHttpEvidence(
          healthResults.length > 0 && healthResults.every((r) => r.status === 'pass'),
        );

        // App functional checks (auth, real-schema assertion, DB write
        // round-trip, storage, realtime via Kong path-routed on the apex)
        const appResults = await runAppFunctionalChecks(
          apiDomain,
          supabaseKeys.anonKey,
          supabaseKeys.serviceRoleKey,
          supabaseKeys.adminEmail,
          supabaseKeys.adminPassword,
          config.domain,
        );
        allResults.push(...appResults);

        // App API-layer checks — the app's own /api/v1/* Hono routes on the MAIN
        // domain (distinct from the Kong/api-subdomain surface above). Catches a
        // broken app backend that 500s while the platform stays green.
        const appApiResults = await runAppApiChecks(config.domain);
        allResults.push(...appApiResults);

        // Configure-key propagation canary: assert the billing secret seeded
        // into .env.local after `create` actually reached the running app
        // (compose container / k8s pod). Guards the envFrom/env_file wiring that
        // carries STRIPE_*/SMTP_*/OAuth from vibecarbon-secrets into the app.
        const canaryResults = await runConfigCanaryChecks(
          sshCheckMasterIp,
          sshKeyPath ?? undefined,
          config.projectName,
          isCompose,
        );
        allResults.push(...canaryResults);

        // Backup evidence — assert a WAL object actually LANDS in S3 (verify-deploy
        // only; verify-scale runs the same check itself, and restore/failover
        // verification has its own backup semantics). Everything else in the stack
        // proves wal-g *can* reach the bucket; nothing proved an object arrives,
        // because wal-archive.sh exits 0 on push failure by design and
        // pg_stat_archiver is therefore structurally blind. See the check's
        // docblock and docs/tests.md's class-3 countermeasure.
        //
        // sshCheckMasterIp is already resolved to the HA PRIMARY above — the
        // probe refuses to provoke a standby and reports that as a failure.
        if (stepName === 'verify-deploy') {
          const backupResults = await runBackupEvidenceChecks({
            masterIp: sshCheckMasterIp,
            sshKeyPath: sshKeyPath ?? undefined,
            projectDir: config.projectDir,
            projectName: config.projectName,
            envPrefix: config.envPrefix,
            isCompose,
            provider: config.provider,
            phase: stepName,
          });
          allResults.push(...backupResults);
        }

        // Frontend render smoke — loads the SPA in headless Chrome and asserts it
        // doesn't white-screen (React crash / ErrorBoundary). Self-skips (pass)
        // if no browser binary is available on the runner.
        const frontendResults = await runFrontendSmokeChecks(config.domain);
        allResults.push(...frontendResults);

        // Client/server key agreement — the anon key baked into the served
        // bundle must be the SAME key the auth checks above just passed.
        // Closes the vibecarbon.com 2026-08-22 blindspot where every auth
        // check was green (they use the harness's server-side key) while
        // every real browser 401'd on a stale baked key.
        allResults.push(await runClientKeyAgreementCheck(config.domain, supabaseKeys.anonKey));

        // Cloud-firewall presence — compose/compose-ha only, verify-deploy only
        // (RCA in checks/cloud-firewall.ts: an empirical experiment proved DO
        // firewalls DO get created/attached; this is the standing guard that
        // catches it if that ever regresses). Provider-neutral: both Hetzner
        // and DigitalOcean implement findFirewallByName. No skip path — a
        // deployed compose/compose-ha server with no cloud firewall is always
        // a real failure, never a legitimate shape.
        if (isCompose && stepName === 'verify-deploy') {
          const fwProviderName = config.provider ?? 'hetzner';
          const fwToken = providerTokenFor(fwProviderName);
          const fwProvider = fwToken ? getProvider(fwProviderName, fwToken) : null;
          const fwServers = resolveComposeFirewallServers(config.projectDir, config.envPrefix);
          const firewallResults = await runCloudFirewallChecks(fwProvider, fwServers);
          allResults.push(...firewallResults);
        }

        // Supavisor pooler — compose/compose-ha only (k8s ships no pooler),
        // verify-deploy only. Proves tenant routing through both pooler modes
        // from inside the rig AND external reachability through the
        // operator-scoped firewall rules (see checks/supavisor-pooler.ts).
        // Closes docs/security.md's "not yet covered by an automated
        // end-to-end test" caveat.
        if (isCompose && stepName === 'verify-deploy') {
          const postgresPassword = readPostgresPassword(config.projectDir);
          if (!postgresPassword) {
            allResults.push({
              checkName: 'supavisor_session_tenant_routing',
              status: 'fail',
              errorMessage: 'POSTGRES_PASSWORD not found in .env.local — cannot probe the pooler',
            });
          } else {
            const poolerResults = await runSupavisorPoolerChecks({
              domain: config.domain,
              masterIp: sshCheckMasterIp,
              sshKeyPath: sshKeyPath ?? undefined,
              projectName: config.projectName,
              postgresPassword,
              phase: stepName,
            });
            allResults.push(...poolerResults);
          }
        }

        // Edge-functions runtime health (compose only; SSH-based since :9000
        // isn't publicly routed). Catches a crash-looping edge-runtime container.
        // Edge functions are opt-in (off by default in both compose and k8s since
        // 2026-05-26). Only assert runtime health when a scenario actually enables
        // them via `--features=functions`; otherwise the container is intentionally
        // absent and the check self-skips.
        const edgeResults = await runEdgeFunctionChecks(
          sshCheckMasterIp,
          sshKeyPath ?? undefined,
          config.projectName,
          isCompose,
          config.features.includes('functions'),
        );
        allResults.push(...edgeResults);

        // Feature-specific checks (only if the feature is enabled)
        if (config.features.includes('observability')) {
          const grafanaDomain = isCompose ? `grafana.${config.domain}` : config.domain;
          const obsResults = await runObservabilityChecks(grafanaDomain, isCompose);
          allResults.push(...obsResults);
        }

        if (config.features.includes('redis')) {
          const firstIp = sshCheckMasterIp;
          const redisResults = await runRedisChecks(
            config.domain,
            firstIp,
            sshKeyPath ?? undefined,
            config.projectDir,
            isCompose,
          );
          allResults.push(...redisResults);
        }

        // Diagnostic: if subdomain checks failed, SSH into server and dump Traefik state
        const subdomainFails = allResults.filter(
          (r) =>
            r.status === 'fail' && ['grafana_health', 'prometheus_targets'].includes(r.checkName),
        );
        if (subdomainFails.length > 0 && serverIps[0] && sshKeyPath) {
          try {
            const { execFileSync } = await import('node:child_process');
            const ip = serverIps[0];
            const sshOpts = [...e2eSshOpts(10), '-i', sshKeyPath, `root@${ip}`];
            // SECURITY: All arguments are from trusted test config, not user input.
            const ssh = (cmd: string) =>
              execFileSync('ssh', [...sshOpts, cmd], {
                encoding: 'utf-8',
                timeout: 15_000,
                stdio: 'pipe',
              }).trim();
            const isK8s = config.mode.startsWith('k8s');
            const d = `/opt/${config.projectName}`;

            if (isK8s) {
              // K8s: use kubectl for diagnostics
              const pods = ssh(
                `kubectl get pods -A --no-headers 2>&1 | head -30 || echo "kubectl unavailable"`,
              );
              console.log(`${tag} [diag] pods:\n${pods || '(empty)'}`);

              const traefik = ssh(
                `kubectl logs -n traefik -l app.kubernetes.io/name=traefik --tail=15 2>&1 | grep -iE 'error|warn' | tail -5 || echo "(no traefik errors)"`,
              );
              if (traefik) console.log(`${tag} [diag] traefik errors:\n${traefik}`);

              const ingress = ssh(
                `kubectl get ingressroute -A --no-headers 2>&1 | head -20 || echo "no ingressroutes"`,
              );
              console.log(`${tag} [diag] ingress routes:\n${ingress}`);
            } else {
              // Compose: use docker compose for diagnostics
              const ps = ssh(
                `cd ${d} && docker compose ps --format '{{.Name}} {{.State}}' 2>&1 | head -30 || echo "ps-failed: dir=${d}"`,
              );
              console.log(`${tag} [diag] containers (${d}):\n${ps || '(empty)'}`);

              // Basic SSH test + container listing
              const hello = ssh('echo "ssh-ok" && docker ps 2>&1 | head -25');
              console.log(`${tag} [diag] ssh+docker:\n${hello || '(empty)'}`);

              const routers = ssh(
                `curl -s http://localhost:8080/api/http/routers 2>/dev/null | python3 -c "import sys,json;[print(r.get('name','?'),r.get('rule','?')[:60]) for r in json.load(sys.stdin)]" 2>/dev/null || echo "traefik API unavailable"`,
              );
              console.log(`${tag} [diag] traefik routers:\n${routers}`);

              const logs = ssh(
                `cd ${d} && docker compose logs traefik --tail 15 2>&1 | grep -iE 'error|warn' | tail -5`,
              );
              if (logs) console.log(`${tag} [diag] traefik errors:\n${logs}`);
            }

            const grafana = ssh(
              `curl -sk -o /dev/null -w '%{http_code}' https://grafana.${config.domain}/api/health 2>/dev/null || echo "fail"`,
            );
            console.log(`${tag} [diag] from server: grafana=${grafana}`);
          } catch (diagErr) {
            console.log(
              `${tag} [diag] failed: ${diagErr instanceof Error ? diagErr.message : String(diagErr)}`,
            );
          }
        }

        // Record all verification results
        collector.recordVerifications(stepId, allResults);

        // Collect infrastructure metrics (server resources, cost, latencies)
        try {
          await collector.collectAll({
            stepId,
            durationMs: 0, // Not meaningful for verification
            domain: config.domain,
            serverIps,
            sshKeyPath,
            hetznerToken,
          });
        } catch (metricsErr) {
          // Metric collection failure should not fail the verification step
          console.warn(
            `${tag} Metric collection warning: ${metricsErr instanceof Error ? metricsErr.message : String(metricsErr)}`,
          );
        }

        // Independent replication verification (HA modes only). The deploy CLI
        // already probes streaming replication and exits non-zero when it can't
        // establish it — these checks re-assert the invariant from the OUTSIDE
        // (SSH straight to both databases) so a green run PROVES replication
        // hardening rather than trusting the CLI's exit code.
        //
        // Placement is deliberate: these run SEQUENTIALLY, LAST — after the
        // app-level check fan-out and the SSH-based metric collection above.
        // First live k8s-ha run had replication_data_propagation fail with
        // "Connection timed out during banner exchange": the burst of concurrent
        // SSH sessions to the same hosts tripped sshd MaxStartups
        // (default 10:30:100), which drops/penalizes excess unauthenticated
        // connections. Replication itself was healthy. Running these after the
        // burst (plus the transient-SSH retry inside the checks) avoids the
        // saturation window entirely.
        //
        // - verify-deploy / verify-scale / verify-restore: assert streaming +
        //   data propagation primary→standby.
        // - verify-failover: streaming is intentionally gone (the old primary is
        //   scaled down by design, no reverse reseed), so we assert ONLY data
        //   CONTINUITY — the marker written on the old primary just before
        //   failover must survive onto the promoted primary. app-serves is
        //   covered by the shared health/app checks above.
        const isHaMode = config.mode === 'compose-ha' || config.mode === 'k8s-ha';
        if (isHaMode) {
          const { primaryIp, standbyIp } = resolveHaDbIps(config.projectDir, config.envPrefix);
          const replResults: VerificationResult[] = [];
          if (
            stepName === 'verify-failover' &&
            isContinuityTargetSameAsMarkerOrigin(primaryIp, failoverMarkerOriginIp)
          ) {
            // FALSE-GREEN GUARD — see isContinuityTargetSameAsMarkerOrigin for
            // why reading the marker off its own origin node proves nothing.
            replResults.push({
              checkName: 'replication_failover_continuity',
              status: 'fail',
              errorMessage: continuityTargetSameAsOriginMessage(String(primaryIp)),
            });
          } else if (stepName === 'verify-failover') {
            replResults.push(
              await runFailoverContinuityCheck({
                mode: config.mode,
                projectName: config.projectName,
                // The promoted primary is the FORMER STANDBY, but both modes now
                // rewrite .vibecarbon.json on failover with the roles swapped —
                // compose-ha in failoverComposeHA, k8s-ha via swapHaRoles' terminal
                // write (ha.primary/ha.standby swapped wholesale). So this fresh
                // resolveHaDbIps() read's `primaryIp` is already the promoted node
                // on BOTH modes; targeting `standbyIp` for k8s-ha would read a
                // fresh `standbyIp` = the OLD (scaled-down) primary, where the
                // marker was originally written — a trivial pass that proves
                // nothing about replication carrying it forward.
                newPrimaryIp: primaryIp,
                sshKeyPath,
                markerId: failoverContinuityMarkerId,
              }),
            );
          } else if (
            stepName === 'verify-deploy' ||
            stepName === 'verify-scale' ||
            stepName === 'verify-restore'
          ) {
            replResults.push(
              ...(await runReplicationChecks({
                mode: config.mode,
                projectName: config.projectName,
                primaryIp,
                standbyIp,
                sshKeyPath,
                markerId: buildMarkerId(scenarioId, stepName, Date.now()),
              })),
            );
            // Pilot-light standby shape (k8s-ha only — Deployments/
            // StatefulSets/cluster-autoscaler/worker nodes are k8s concepts
            // with no compose-ha equivalent). Only meaningful right after the
            // initial deploy: verify-scale/verify-restore don't change the
            // standby's pilot-light posture, and asserting it there too would
            // just be redundant SSH traffic against the same invariant.
            if (config.mode === 'k8s-ha' && stepName === 'verify-deploy') {
              replResults.push(
                ...(await assertPilotLightStandby(standbyIp, { sshKeyPath, label: 'standby' })),
              );
            }
          }
          if (replResults.length > 0) {
            // allResults was already recorded above — record the late-running
            // replication results separately, and merge them into allResults so
            // the pass/fail evaluation below covers them.
            collector.recordVerifications(stepId, replResults);
            allResults.push(...replResults);
          }
        }

        // Check for any failed verifications. Known-broken checks for this
        // (mode, step) combo are downgraded to warnings — the verifications
        // table still records them, but they don't fail the step. See
        // EXPECTED_VERIFY_FAILURES at the top of this file for entries.
        const expectedFailNames = EXPECTED_VERIFY_FAILURES[config.mode]?.[stepName] ?? [];
        const allFailures = allResults.filter((r) => r.status === 'fail');
        const expectedFailures = allFailures.filter((r) => expectedFailNames.includes(r.checkName));
        const unexpectedFailures = allFailures.filter(
          (r) => !expectedFailNames.includes(r.checkName),
        );

        // Skips are counted on their OWN axis — a check whose precondition was
        // missing (no SSH handle, feature off, unresolved standby IP) is neither
        // a green pass nor a red fail. Surface the count so a run that silently
        // skipped half its assertions can't masquerade as a clean pass.
        const tally = summarizeVerifications(allResults);
        if (tally.skipped > 0) {
          const skipNames = allResults
            .filter((r) => r.status === 'skip')
            .map((r) => r.checkName)
            .join(', ');
          console.log(
            `${tag} [verify] ${stepName}: ${tally.passed} passed, ${tally.failed} failed, ` +
              `${tally.skipped} skipped (precondition missing) — ${skipNames}`,
          );
        }

        // Log expected failures distinctly so they don't look like passes.
        for (const f of expectedFailures) {
          const detail = f.errorMessage || JSON.stringify(f.details || {});
          console.warn(
            `${tag} [expected-fail] ${f.checkName}: ${detail} ` +
              `(known limitation for ${config.mode}/${stepName} — see EXPECTED_VERIFY_FAILURES)`,
          );
        }

        if (unexpectedFailures.length > 0) {
          const failNames = unexpectedFailures.map((f) => f.checkName).join(', ');
          // Log error details for each failed check to help diagnose issues
          for (const f of unexpectedFailures) {
            const detail = f.errorMessage || JSON.stringify(f.details || {});
            console.error(`${tag} [fail] ${f.checkName}: ${detail}`);
          }
          throw new Error(`${unexpectedFailures.length} verification(s) failed: ${failNames}`);
        }
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Phase 9 verify-autoscale — drives cluster-autoscaler end-to-end.
  //
  // Pre-condition: cluster was deployed with --min-workers=1 / --max-workers=5
  // (the lifecycle's deploy step does this when options.expanded === true on
  // a k8s/k8s-ha scenario). Baseline node count is 3 — master + supabase + 1
  // worker. CA's MAX is therefore (5 - 1) = 4 extra workers; ceiling node
  // count is 7.
  //
  // Test flow:
  //   1. Apply a `pause` Deployment with hostname-spread podAntiAffinity so
  //      each replica forces onto a separate node.
  //   2. Scale to 6 replicas (one MORE than max-workers=5) — drives CA to
  //      spawn workers up to its ceiling, with the 6th replica left Pending
  //      to confirm CA respects the MAX bound.
  //   3. Poll `kubectl get nodes` for up to 12 min; assert the cluster grew
  //      from baseline (3) to ceiling (7) — i.e. 4 CA-spawned workers.
  //   4. Tear down: scale loadgen to 0 + delete the Deployment.
  //   5. (Scope: minimum-viable.) The plan also calls for polling node count
  //      to drop back to baseline within 14 min (CA's
  //      --scale-down-unneeded-time=10m + 4-min buffer). Implemented below
  //      but kept under a try/log-only path — scale-DOWN failures don't fail
  //      the step in this initial cut; scale-UP is the load-bearing
  //      assertion. TODO: hard-fail on scale-down regression once the
  //      timing has been observed across a few expanded runs.
  //   6. Final: assert cluster-autoscaler Deployment is 1/1 Ready in
  //      kube-system.
  //
  // For k8s-ha, only the PRIMARY cluster (serverIps[0]) is exercised — the
  // standby cluster is structurally identical and an hcloud-CLI spot-check
  // is sufficient if the operator wants symmetric proof. Doubling the run
  // time to test both was rejected per the plan.
  //
  // TODO (deferred from Phase 9, see LifecycleOptions docstring):
  //   - verify-status step (cheap — `vibecarbon status` non-zero output)
  //   - verify-diagnose step
  //   - configure cicd add-on flow within the harness (Flux poll)
  // -------------------------------------------------------------------------

  async function runVerifyAutoscale(): Promise<StepResult> {
    return executeStep('verify-autoscale', `kubectl loadgen → poll nodes`, async () => {
      if (!isK8sMode) {
        // Defensive — the step is only inserted when isK8sMode + expanded,
        // but skip rather than fail loud if something upstream changes.
        console.log(`${tag} [verify-autoscale] skip — mode ${config.mode} not k8s/k8s-ha`);
        return;
      }
      if (!sshKeyPath || serverIps.length === 0) {
        throw new Error(
          'verify-autoscale: no sshKeyPath or serverIps from deploy step — cannot reach primary cluster',
        );
      }

      // For k8s-ha, getServerIps returns
      //   [primary_master, primary_supabase, standby_master, standby_supabase]
      // Primary master = serverIps[0]. For k8s, serverIps[0] is also the
      // master. Either way we kubectl from there.
      const primaryMasterIp = serverIps[0];
      const { execFileSync } = await import('node:child_process');

      const sshOpts = [...e2eSshOpts(10), '-i', sshKeyPath, `root@${primaryMasterIp}`];

      // SECURITY: cmd values are constructed from trusted constants — no
      // user input reaches argv. SSH executed via execFileSync (no shell on
      // our side), and the remote shell receives the literal string.
      const sshExec = (
        cmd: string,
        opts?: { timeoutMs?: number; throwOnFail?: boolean },
      ): { stdout: string; ok: boolean } => {
        const timeoutMs = opts?.timeoutMs ?? 30_000;
        try {
          const out = execFileSync('ssh', [...sshOpts, cmd], {
            encoding: 'utf-8',
            timeout: timeoutMs,
            stdio: 'pipe',
          });
          return { stdout: out, ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (opts?.throwOnFail) {
            throw new Error(`ssh ${primaryMasterIp} '${cmd.slice(0, 80)}…' failed: ${msg}`);
          }
          return { stdout: msg, ok: false };
        }
      };

      // Helper: count Ready nodes from `kubectl get nodes -o json`.
      const countReadyNodes = (): number | null => {
        const r = sshExec(`kubectl get nodes -o json`, { timeoutMs: 30_000 });
        if (!r.ok) return null;
        try {
          const parsed = JSON.parse(r.stdout) as {
            items?: Array<{ status?: { conditions?: Array<{ type?: string; status?: string }> } }>;
          };
          return (parsed.items ?? []).filter((n) =>
            (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
          ).length;
        } catch {
          return null;
        }
      };

      // 1. Capture baseline. Expect 3 (master + supabase + 1 worker) on a
      //    k8s/k8s-ha primary cluster deployed with --min-workers=1.
      const baseline = countReadyNodes();
      if (baseline == null) {
        throw new Error('verify-autoscale: could not enumerate baseline nodes via kubectl');
      }
      console.log(`${tag} [verify-autoscale] baseline ready nodes = ${baseline}`);
      // Sanity: a baseline >= 5 means deploy already produced max workers,
      // so the ceiling test below has nowhere to grow. Surface this as an
      // env-shape problem so it's not silently mislabeled as "CA broken".
      if (baseline >= 5) {
        throw new Error(
          `verify-autoscale: baseline ready nodes = ${baseline} (>=5) — env was not deployed at the autoscaling baseline; expected ~3`,
        );
      }

      // 2. Apply a pause-image Deployment with hostname-spread anti-affinity
      //    so each replica forces onto a separate node. Using `kubectl
      //    apply -f -` with stdin-piped YAML rather than chained imperative
      //    `kubectl create + patch` so the manifest survives a transient
      //    restart cleanly.
      //
      //    pause is intentionally chosen — it's tiny (~700KB), pulls on the
      //    worker the moment CA brings it up (so this also exercises the new
      //    node's egress + image-pull path), and never crashes.
      //
      //    It pulls from our ghcr MIRROR, via the same constant the deploy
      //    path uses. That is the point: a brand-new worker fetching an image
      //    is exactly where the registry.k8s.io 403 roulette gets played (it
      //    cost a k8s-ha deploy on 2026-08-05 via the CSI sidecars), so this
      //    check would be testing the wrong registry if it hardcoded upstream.
      const loadgenManifest = `cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: loadgen
  namespace: vibecarbon
  labels:
    app: loadgen
spec:
  replicas: 0
  selector:
    matchLabels:
      app: loadgen
  template:
    metadata:
      labels:
        app: loadgen
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: loadgen
              topologyKey: kubernetes.io/hostname
      containers:
        - name: pause
          image: ${pauseImageRef()}
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
EOF`;
      const apply = sshExec(loadgenManifest, { timeoutMs: 60_000 });
      if (!apply.ok) {
        throw new Error(
          `verify-autoscale: kubectl apply loadgen failed: ${apply.stdout.slice(0, 500)}`,
        );
      }
      console.log(`${tag} [verify-autoscale] loadgen Deployment applied`);

      // 3. Drive the ceiling. Scale to 6 = (max-workers 5) + 1 — confirms
      //    CA spawns up to MAX and leaves the 6th replica Pending.
      const scaleUp = sshExec(`kubectl scale deploy/loadgen --replicas=6 -n vibecarbon`);
      if (!scaleUp.ok) {
        throw new Error(`verify-autoscale: scale-up failed: ${scaleUp.stdout.slice(0, 500)}`);
      }

      // 4. Poll for scale-up. Expected ceiling = 7 nodes (master + supabase +
      //    5 workers). Hetzner server-create + cloud-init + k3s-join is
      //    typically 2-4 min/node; 4 nodes serially is well within 12 min.
      const SCALE_UP_BUDGET_MS = 12 * 60_000;
      const POLL_INTERVAL_MS = 30_000;
      // Derive ceiling from the operator-supplied bound, not from `baseline`.
      // At ceiling: total nodes = master (1, Pulumi-fixed) + supabase (1,
      // Pulumi-fixed) + maxWorkers (CA at full pool size — `maxWorkers` is
      // the total worker count when CA tops out, not the number of CA-spawned
      // additions on top of the static floor). Coupling to `baseline` would
      // mis-target the ceiling if the static worker hadn't reached Ready at
      // the moment we counted (baseline = 2 → expected = 6 instead of 7),
      // producing a false scale-up failure. The `baseline >= 5` defensive
      // throw above still catches misconfigured deploys.
      const maxWorkers = 'maxWorkers' in expandedDeployBounds ? expandedDeployBounds.maxWorkers : 5;
      const expectedCeiling = maxWorkers + 2;
      const t0 = Date.now();
      let lastSeen = baseline;
      let reachedCeiling = false;
      console.log(
        `${tag} [verify-autoscale] polling for scale-up to ${expectedCeiling} nodes (budget ${SCALE_UP_BUDGET_MS / 60_000}m)`,
      );
      while (Date.now() - t0 < SCALE_UP_BUDGET_MS) {
        const c = countReadyNodes();
        if (c != null && c !== lastSeen) {
          console.log(
            `${tag} [verify-autoscale] node count: ${lastSeen} → ${c} (${Math.round((Date.now() - t0) / 1000)}s elapsed)`,
          );
          lastSeen = c;
        }
        if (c != null && c >= expectedCeiling) {
          reachedCeiling = true;
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      if (!reachedCeiling) {
        // Capture diag before throwing — what's CA actually doing? Pending
        // pods, CA logs, etc. Without this, a scale-up timeout gives us
        // nothing to act on.
        const caLogs = sshExec(
          `kubectl logs -n kube-system -l app=cluster-autoscaler --tail=80 2>&1 || echo "(no CA pod)"`,
          { timeoutMs: 15_000 },
        );
        const pending = sshExec(
          `kubectl get pods -n vibecarbon -l app=loadgen -o wide 2>&1 || echo "(no loadgen pods)"`,
          { timeoutMs: 15_000 },
        );
        const nodes = sshExec(`kubectl get nodes -o wide 2>&1 || echo "(nodes unavailable)"`, {
          timeoutMs: 15_000,
        });
        console.warn(`${tag} [verify-autoscale][diag] cluster-autoscaler tail:\n${caLogs.stdout}`);
        console.warn(`${tag} [verify-autoscale][diag] loadgen pods:\n${pending.stdout}`);
        console.warn(`${tag} [verify-autoscale][diag] nodes:\n${nodes.stdout}`);
        throw new Error(
          `verify-autoscale: scale-up did not reach ${expectedCeiling} nodes within ${SCALE_UP_BUDGET_MS / 60_000} min (last seen ${lastSeen})`,
        );
      }
      console.log(
        `${tag} [verify-autoscale] scale-up OK: reached ${lastSeen} nodes in ${Math.round((Date.now() - t0) / 1000)}s`,
      );

      // 5. Tear down loadgen — scale to 0 then delete the Deployment so
      //    nothing prevents CA from reaping the now-idle workers.
      const scaleDown = sshExec(`kubectl scale deploy/loadgen --replicas=0 -n vibecarbon`);
      if (!scaleDown.ok) {
        console.warn(
          `${tag} [verify-autoscale] scale-down failed (non-fatal): ${scaleDown.stdout.slice(0, 200)}`,
        );
      }
      const del = sshExec(`kubectl delete deploy/loadgen -n vibecarbon --ignore-not-found`);
      if (!del.ok) {
        console.warn(
          `${tag} [verify-autoscale] delete loadgen failed (non-fatal): ${del.stdout.slice(0, 200)}`,
        );
      }

      // 6. Poll for scale-DOWN. CA's --scale-down-unneeded-time defaults to
      //    10 min; serial reaping of 4 workers takes ~1 min/node = up to
      //    14 min total. NOT a hard failure in this initial cut — log-only.
      //    TODO: promote to hard-fail once timing has been observed across
      //    multiple expanded runs and the budget is well-calibrated.
      const SCALE_DOWN_BUDGET_MS = 14 * 60_000;
      const t1 = Date.now();
      let scaleDownLast = lastSeen;
      let returnedToBaseline = false;
      console.log(
        `${tag} [verify-autoscale] polling for scale-down to ${baseline} nodes (budget ${SCALE_DOWN_BUDGET_MS / 60_000}m, log-only this phase)`,
      );
      while (Date.now() - t1 < SCALE_DOWN_BUDGET_MS) {
        const c = countReadyNodes();
        if (c != null && c !== scaleDownLast) {
          console.log(
            `${tag} [verify-autoscale] node count: ${scaleDownLast} → ${c} (${Math.round((Date.now() - t1) / 1000)}s elapsed)`,
          );
          scaleDownLast = c;
        }
        if (c != null && c <= baseline) {
          returnedToBaseline = true;
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      if (returnedToBaseline) {
        console.log(
          `${tag} [verify-autoscale] scale-down OK: returned to ${scaleDownLast} nodes in ${Math.round((Date.now() - t1) / 1000)}s`,
        );
      } else {
        console.warn(
          `${tag} [verify-autoscale] scale-down did NOT return to baseline ${baseline} within ${SCALE_DOWN_BUDGET_MS / 60_000} min (last seen ${scaleDownLast}). Logging only — TODO: hard-fail in a follow-up phase once budget is calibrated.`,
        );
      }

      // 7. Final assertion: cluster-autoscaler Deployment is healthy.
      const caStatus = sshExec(
        `kubectl get deployment -n kube-system cluster-autoscaler -o jsonpath='{.status.readyReplicas}/{.status.replicas}'`,
        { timeoutMs: 15_000 },
      );
      if (!caStatus.ok) {
        throw new Error(
          `verify-autoscale: cluster-autoscaler readiness query failed: ${caStatus.stdout.slice(0, 200)}`,
        );
      }
      const trimmed = caStatus.stdout.trim();
      if (trimmed !== '1/1') {
        throw new Error(
          `verify-autoscale: cluster-autoscaler not 1/1 Ready (got '${trimmed}') — CA Deployment is unhealthy`,
        );
      }
      console.log(`${tag} [verify-autoscale] cluster-autoscaler Deployment 1/1 Ready`);
    });
  }

  // -------------------------------------------------------------------------
  // Ordered lifecycle steps
  // -------------------------------------------------------------------------

  /**
   * Build the ordered list of steps. HA modes include failover/verify-failover.
   */
  /**
   * Point this scratch project at the host's ONE long-lived Pulumi state bucket.
   *
   * Every e2e project is named `<prefix><mode>-<Date.now()>-<random>`, so without
   * this each scenario of each run derives a brand-new state bucket and performs
   * every Pulumi operation it ever makes against a bucket minutes old. That is
   * the worst window for the state-backend failure class — four of its eleven
   * documented spellings name a freshly created bucket as the trigger — and it is
   * an artifact of the harness, not something customers experience: a real
   * project's state bucket is warm long before it matters.
   *
   * Two things make one shared bucket safe here. Pulumi keys DIY state as
   * `.pulumi/stacks/<project>/<stack>.json` with our Pulumi project name held
   * constant, and scenario stack names are already unique (ci1..ci4), so nothing
   * collides. And the matrix runs serially, so scenarios never contend for it.
   *
   * The name deliberately does NOT start with `scratchNamePrefix()`: the orphan
   * sweeps collect that prefix, and a bucket we intend to keep must not be
   * reported as a destroy regression on every run. It follows the same `vc-`
   * convention as the standing DO Spaces anchor bucket.
   *
   * Cold start is still covered — deliberately, because a customer's FIRST deploy
   * really does run against a brand-new bucket. Set VC_E2E_STATE_BUCKET to a
   * per-account name (bucket names are global per provider) or to a throwaway
   * value to exercise that path.
   */
  function pinSharedStateBucket(projectDir: string): string | null {
    const stateBucket = sharedStateBucketName();
    const configPath = join(projectDir, '.vibecarbon.json');
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      config.stateBucket = stateBucket;
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      return stateBucket;
    } catch {
      // Non-fatal: without the pin the deploy derives a per-run bucket, which is
      // the old behaviour — slower and colder, but not broken.
      return null;
    }
  }

  type StepDef = { name: StepName; run: () => Promise<StepResult> };

  const stepDefs: StepDef[] = [
    // 1. Create the project
    {
      name: 'create',
      run: () =>
        executeStep('create', `vibecarbon create ${config.projectName}`, async () => {
          const result = await runCreate(config.projectName, {
            cwd: parentDir,
            timeout: TIMEOUTS.create,
            adminEmail: config.adminEmail,
            adminPassword: config.adminPassword,
          });
          if (result.exitCode !== 0) {
            throw new Error(
              `Create exited with code ${result.exitCode}.\n` +
                `STDERR: ${(result.stderr || '').slice(-1000) || '(empty)'}\n` +
                `STDOUT tail: ${(result.stdout || '').slice(-2000) || '(empty)'}`,
            );
          }
          const pinned = pinSharedStateBucket(config.projectDir);
          if (pinned) console.log(`[state] pinned Pulumi state bucket: ${pinned}`);

          const { setEnvVar } = await import('../../../src/lib/project.js');
          // Seed this scratch project's own .env.local with the scenario's
          // provider credentials (A6) — a real customer's project is
          // self-contained the same way (see e2e-must-mirror-customer), so
          // the e2e project must resolve its own tokens rather than relying
          // on the parent CLI process's env alone. Scenario-appropriate
          // only: Hetzner scenarios get HETZNER_API_TOKEN + the S3 pair,
          // DigitalOcean scenarios (d1/d2/d3, config.provider ===
          // 'digitalocean') get DIGITALOCEAN_API_TOKEN + the Spaces pair,
          // and every scenario additionally gets its DNS backend's token
          // (often the same one — see the DNS block below).
          // Docker Hub is deliberately NOT seeded —
          // it stays operator-shell-level only (see docker-hub.js). Values
          // come from process.env, already populated by runner.ts's
          // loadE2EEnvFile() (tests/.env.e2e) or the shell/CI at startup —
          // a key with no value anywhere is skipped, not written empty.
          // localOnly: true keeps these out of .env, the server-bundle env
          // baseline (bundle.js) — they must never ship to a deployed server.
          // Derived from the provider registry (TOKEN_ENV + OBJECT_STORAGE_ENV)
          // rather than a hand-listed ternary, so provider N+1's scenarios
          // seed the right credentials with no edit here (2026-08-07 audit).
          const { getProviderClass } = await import('../../../src/lib/providers/index.js');
          const ProviderClass = getProviderClass(config.provider ?? 'hetzner');
          const providerCredentialKeys: string[] = [
            ProviderClass.TOKEN_ENV,
            ...ProviderClass.OBJECT_STORAGE_ENV,
          ];
          // DNS axis, same treatment as the compute axis directly above: the
          // scenario's DNS backend names its credential in DNS_PROVIDERS
          // (src/lib/dns-provider.js), so provider N+1's DNS backend seeds
          // correctly with no edit here. This replaced a hand-listed
          // `dnsProvider === 'cloudflare' → CLOUDFLARE_API_TOKEN` branch —
          // the DNS-axis twin of the compute hand-list the 2026-08-07 audit
          // removed, and it failed the same way: a scenario on any other
          // native DNS backend wrote no DNS credential into .env.local, so
          // the scratch project fell back to the parent process env and the
          // "customer projects are self-contained" property (A6) quietly
          // stopped holding for the DNS half of the deploy.
          //
          // Deduped against the compute keys: a scenario whose DNS backend
          // is its own cloud (Linode compute + Linode DNS) shares one token,
          // and pushing it twice would rewrite the same .env.local line.
          const { DNS_PROVIDERS } = (await import('../../../src/lib/dns-provider.js')) as {
            DNS_PROVIDERS: Record<string, { tokenEnv: string }>;
          };
          const dnsRow = DNS_PROVIDERS[config.dnsProvider];
          if (!dnsRow) {
            throw new Error(
              `Scenario dnsProvider '${config.dnsProvider}' has no DNS_PROVIDERS row ` +
                `(src/lib/dns-provider.js) — cannot resolve which credential to seed. ` +
                `Known: ${Object.keys(DNS_PROVIDERS).join(', ')}.`,
            );
          }
          if (!providerCredentialKeys.includes(dnsRow.tokenEnv)) {
            providerCredentialKeys.push(dnsRow.tokenEnv);
          }
          for (const key of providerCredentialKeys) {
            const value = process.env[key];
            if (value) setEnvVar(key, value, config.projectDir, { localOnly: true });
          }
          // Seed a configure-managed billing secret so the verify step can
          // prove it reaches the running app (config_secret_propagation
          // canary). setEnvVar writes both .env.local and .env, so it flows
          // through every deploy path (compose env_file, k8s envFrom, CI
          // seeding). Done here — before setup-repo commits — so the CI path
          // picks it up too.
          setEnvVar('STRIPE_SECRET_KEY', CONFIG_CANARY_SECRET, config.projectDir);
          // OAuth canary: client id ONLY, never GOOGLE_ENABLED — a
          // half-configured enabled provider could fail GoTrue's boot
          // validation, while an unused client id on a disabled provider is
          // inert. Asserted inside the auth container by
          // config_oauth_gotrue_propagation (compose env interpolation /
          // k8s valueFrom secretKeyRef).
          setEnvVar('GOOGLE_CLIENT_ID', OAUTH_CANARY_CLIENT_ID, config.projectDir);
        }),
    },

    // 1.5. Create a throwaway public GitHub repo and push the project to it.
    // `vibecarbon deploy` calls `ensureCIImageReady`, which requires an origin
    // remote pointing at github.com — the test project needs somewhere real
    // for the workflow + ghcr image to live. Teardown deletes it in `finally`.
    //
    // `vibecarbon create` runs `git init` but doesn't commit; we commit here
    // so `gh repo create --source=. --push` has something to push.
    {
      name: 'setup-repo',
      run: () => {
        const slug = `vc-e2e-${config.mode}-${scenarioId.slice(0, 8)}`;
        config.testRepoSlug = slug;
        return executeStep('setup-repo', `gh repo create ${slug}`, async () => {
          // Every git spawn in this step scrubs hook-exported repo-targeting
          // vars (GIT_DIR & friends) so an inherited GIT_DIR can never make
          // these operate on the RUNNER's repo with the scratch project as
          // work tree — see tests/_shared/git-env.ts for the incident this
          // class caused. Transport vars are kept: the push below needs the
          // runner's ssh/askpass config.
          const gitEnv = gitScrubbedEnv();
          const gitAdd = spawnSync('git', ['add', '-A'], {
            cwd: config.projectDir,
            encoding: 'utf-8',
            env: gitEnv,
          });
          if (gitAdd.status !== 0) {
            throw new Error(`git add failed: ${gitAdd.stderr || gitAdd.stdout}`);
          }
          // No [skip ci] needed — vibecarbon create no longer ships workflow
          // files, so the throwaway repo has nothing to trigger.
          //
          // `vibecarbon create` now makes its own initial commit (a clean,
          // tracked starting point), so `git add -A` here usually stages
          // nothing — the only post-create change is the STRIPE_SECRET_KEY
          // canary, and .env/.env.local are gitignored. A "nothing to commit"
          // result is therefore expected and fine: create's commit is already
          // pushable. Only fail if the repo has NO commit at all (nothing to
          // push).
          const gitCommit = spawnSync('git', ['commit', '-m', 'Initial commit', '--no-verify'], {
            cwd: config.projectDir,
            encoding: 'utf-8',
            env: gitEnv,
          });
          if (gitCommit.status !== 0) {
            const combined = `${gitCommit.stdout || ''}${gitCommit.stderr || ''}`;
            const nothingToCommit = /nothing to commit|no changes added|working tree clean/i.test(
              combined,
            );
            const hasHead =
              spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
                cwd: config.projectDir,
                encoding: 'utf-8',
                env: gitEnv,
              }).status === 0;
            if (!(nothingToCommit && hasHead)) {
              throw new Error(`git commit failed: ${gitCommit.stderr || gitCommit.stdout}`);
            }
          }

          // Disable git hooks for this scratch repo. `vibecarbon create -git`
          // now installs a pre-push hook that runs `pnpm test:prepush`, but
          // the e2e flow uses `-skip-lockfile` so node_modules isn't
          // present at this point — biome/vitest aren't installed, the hook
          // would fail, and the push would never reach GitHub. E2E
          // tests deploy infra, not the customer's dev-time hook gate, so
          // skip them at the repo level (covers both `gh repo create --push`
          // and the fallback `git push` retry below).
          spawnSync('git', ['config', 'core.hooksPath', '/dev/null'], {
            cwd: config.projectDir,
            encoding: 'utf-8',
            env: gitEnv,
          });

          // `gh repo create --source=. --push` is a 3-step chain: (1) create
          // the empty repo, (2) add origin, (3) git push. Step 1 succeeds
          // early but GitHub takes a few seconds before the repo is
          // pushable; gh then reports the push error as the misleading
          // `Repository not found`. A naive retry loop re-invokes step 1
          // too, and the second attempt fails with
          // `GraphQL: Name already exists on this account` — leaving us
          // stuck with the repo existing but no code pushed.
          //
          // Strategy: attempt the full chain once; on ANY failure, check
          // if the repo was actually created, and if so skip straight to
          // `git push origin main` + add remote (retry that up to 3×).
          let lastErr: string | null = null;
          // --public (not --private): private repos on a free personal
          // account share the 2000-min/month Actions allowance, and once
          // it's exhausted, every dispatched workflow run fails in ~3-5s
          // with no runner allocated (observed 2026-04-26 batch run #3 —
          // both compose CI runs returned conclusion=failure with empty
          // steps and runner_name=""). Public repos get unlimited
          // Actions minutes on free accounts. Throwaway e2e repos
          // hold only the scaffolded template (no real secrets — the
          // .env.local that DOES carry secrets is .gitignored). They're
          // deleted within 90s of creation.
          const createResult = await runGh(
            ['repo', 'create', slug, '--public', '--source=.', '--push', '--remote=origin'],
            { cwd: config.projectDir, timeout: TIMEOUTS['setup-repo'] },
          );
          if (createResult.exitCode === 0) {
            console.log(`${tag} Created throwaway repo: ${slug}`);
          } else {
            lastErr = `exit=${createResult.exitCode}: ${createResult.stderr || createResult.stdout}`;
            // Check whether repo exists despite the failure.
            const viewResult = await runGh(['repo', 'view', slug, '--json', 'name'], {
              cwd: config.projectDir,
              timeout: 30_000,
            });
            const repoExists = viewResult.exitCode === 0;
            if (repoExists) {
              console.log(
                `${tag} gh repo create reported "${lastErr}" but repo ${slug} exists; finishing push separately`,
              );
              // Ensure origin remote is set — `gh repo create` may or may not have done it.
              spawnSync('git', ['remote', 'remove', 'origin'], {
                cwd: config.projectDir,
                encoding: 'utf-8',
                env: gitEnv,
              });
              const repoUrlRes = await runGh(
                ['repo', 'view', slug, '--json', 'sshUrl', '-q', '.sshUrl'],
                {
                  cwd: config.projectDir,
                  timeout: 30_000,
                },
              );
              const sshUrl = (repoUrlRes.stdout || '').trim();
              spawnSync('git', ['remote', 'add', 'origin', sshUrl], {
                cwd: config.projectDir,
                encoding: 'utf-8',
                env: gitEnv,
              });
              for (let attempt = 1; attempt <= 3; attempt++) {
                const push = spawnSync('git', ['push', '-u', 'origin', 'HEAD:main'], {
                  cwd: config.projectDir,
                  encoding: 'utf-8',
                  env: gitEnv,
                });
                if (push.status === 0) {
                  console.log(`${tag} Pushed to existing repo: ${slug}`);
                  lastErr = null;
                  break;
                }
                lastErr = `git push exit=${push.status}: ${push.stderr || push.stdout}`;
                if (attempt < 3) {
                  console.log(
                    `${tag} git push attempt ${attempt} failed, retrying in 5s: ${lastErr}`,
                  );
                  await new Promise((r) => setTimeout(r, 5000));
                }
              }
            }
          }
          if (lastErr) {
            throw new Error(`setup-repo ${slug} failed: ${lastErr}`);
          }
        });
      },
    },

    // 2. Add optional features
    {
      name: 'add-features',
      run: () =>
        executeStep(
          'add-features',
          `vibecarbon add ${[...config.features].join(' ')}`,
          async () => {
            if (config.features.length === 0) {
              console.log(`${tag} No features to add, skipping`);
              return;
            }
            const result = await runAddFeatures([...config.features], {
              cwd: config.projectDir,
              timeout: TIMEOUTS['add-features'],
            });
            if (result.exitCode !== 0) {
              throw new Error(
                `Add features exited with code ${result.exitCode}.\n` +
                  `STDERR: ${(result.stderr || '').slice(-1000) || '(empty)'}\n` +
                  `STDOUT tail: ${(result.stdout || '').slice(-2000) || '(empty)'}`,
              );
            }

            // Use Let's Encrypt staging CA to avoid rate limiting across test runs.
            // The staging CA has much higher limits (30k certs/week vs 50) and the
            // tests already skip strict cert validation (rejectUnauthorized: false).
            if (config.mode.startsWith('compose')) {
              const envPath = join(config.projectDir, '.env');
              appendFileSync(
                envPath,
                "\n# Use Let's Encrypt staging CA for e2e tests (avoids rate limiting)\nACME_CA_SERVER=https://acme-staging-v02.api.letsencrypt.org/directory\n",
              );
              console.log(`${tag} Configured ACME staging CA in .env`);
            }
          },
        ),
    },

    // 3. Deploy
    {
      name: 'deploy',
      run: () =>
        executeStep(
          'deploy',
          `vibecarbon deploy ${config.envPrefix} --${config.mode} --domain ${config.domain}`,
          async () => {
            // No --direct flag needed — direct is the default for compose
            // deploys (CI/CD is opt-in via `vibecarbon configure`). K8s ignores
            // the flag and uses its 'local' build path either way.
            const result = await runDeploy(config.envPrefix, {
              cwd: config.projectDir,
              timeout: TIMEOUTS.deploy,
              mode: config.mode,
              domain: config.domain,
              dnsProvider: config.dnsProvider,
              serverType: config.serverType,
              region: config.region,
              secondaryRegion: config.secondaryRegion,
              provider: config.provider,
              env: {
                HCLOUD_TOKEN: hetznerToken,
                // buildEnv synthesizes the provider CLI token env from the resolved provider (see final review B8-3); deploy children must NOT receive DIGITALOCEAN_TOKEN so DO runs prove the customer path.
              },
              ...expandedDeployBounds,
            });
            if (result.exitCode !== 0) {
              // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
              const stderrClean = (result.stderr || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
              // FAIL: line → Error: line (+ perf context) → (failed) perf
              // marker → raw tail. The structured tiers keep the thrown
              // message classifiable (classify-failure.ts) instead of a
              // noisy stream tail masking the real reason.
              const detail = extractDeployFailureDetail(result.stdout, result.stderr);
              // Extract all [k8s-deploy]/[k8s-ha] diag marker lines from the
              // ENTIRE stderr (not just the 1500-char tail) — on HA failures
              // the per-cluster status lines appear early in stderr and get
              // truncated off by the tail slice, hiding which cluster failed.
              const allDiagLines = stderrClean
                .split('\n')
                .filter((l: string) => /\[k8s-deploy\]|\[k8s-ha\]|\[deploy\]/.test(l))
                .map((l: string) => l.trim())
                .filter(Boolean);
              if (allDiagLines.length > 0) {
                console.warn(`${tag} deploy diag (all markers):\n  ${allDiagLines.join('\n  ')}`);
              }
              // ALWAYS dump stderr tail if present — cloud-init / apt-get
              // output lands here and is how we diagnose server bootstrap
              // failures (k3s install errors, etc).
              if (stderrClean) {
                console.warn(`${tag} deploy stderr tail: ${stderrClean.slice(-1500)}`);
              }
              throw new Error(`Deploy exited with code ${result.exitCode}: ${detail.slice(-1000)}`);
            }

            // On success, surface the [k8s-deploy] diag lines that the deploy emits
            // via console.error. Without this, image-resolution / set-image / skip
            // diagnostics get swallowed even though deploy "succeeded" while the
            // cluster is in fact broken (e.g., HA's ImagePullBackOff cascade where
            // set-image never ran but deploy still exits 0).
            // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
            const successStderr = (result.stderr || '').replace(/\x1b\[[0-9;]*m/g, '');
            const diagLines = successStderr
              .split('\n')
              .filter((l: string) => /\[k8s-deploy\]|\[k8s-ha\]|\[deploy\]/.test(l))
              .map((l: string) => l.trim())
              .filter(Boolean);
            if (diagLines.length > 0) {
              console.log(`${tag} deploy diag:\n  ${diagLines.join('\n  ')}`);
            }

            // Detect suspiciously fast deploys (real deploys take 60+ seconds)
            if (result.durationMs < 30_000) {
              // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
              const cleanOutput = (result.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
              console.warn(
                `${tag} WARNING: Deploy completed in ${(result.durationMs / 1000).toFixed(1)}s (suspiciously fast). Full output:\n${cleanOutput.slice(-2000)}`,
              );
            }

            // Log DNS-related output from deploy (helps diagnose connectivity issues)
            const dnsLines = (result.stdout || '')
              .split('\n')
              .filter((l: string) => /DNS|dns|Floating|floating|domain|configured/i.test(l))
              // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
              .map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
              .filter(Boolean);
            if (dnsLines.length > 0) {
              console.log(`${tag} DNS output: ${dnsLines.join(' | ')}`);
            }

            // Cache deployment info for subsequent steps
            serverIps = getServerIps(config.projectDir, config.envPrefix);
            sshKeyPath = getSshKeyPath(config.projectDir, config.envPrefix);
            supabaseKeys = readSupabaseKeys(config.projectDir);

            console.log(`${tag} Deploy complete. Server IPs: [${serverIps.join(', ')}]`);

            // Fail if no server IPs were found (deploy succeeded but didn't create servers)
            if (serverIps.length === 0) {
              throw new Error(
                'Deploy exited successfully but no server IPs found in .vibecarbon.json — deployment likely failed silently',
              );
            }
          },
        ),
    },

    // 4. Verify deploy
    {
      name: 'verify-deploy',
      run: () => runVerificationChecks('verify-deploy'),
    },

    // 4.1 Warm deploy — re-invoke `vibecarbon deploy` against the already-
    // provisioned env. Times the no-op convergence path (push-to-deploy
    // iteration loop a customer lives in after the initial cold deploy).
    // Inserted after verify-deploy so we know the env is healthy when we
    // measure, and before verify-load so the load probe runs against the
    // post-warm-deploy state.
    {
      name: 'warm-deploy',
      run: () =>
        executeStep(
          'warm-deploy',
          `vibecarbon deploy ${config.envPrefix} --${config.mode} (warm)`,
          async () => {
            const result = await runDeploy(config.envPrefix, {
              cwd: config.projectDir,
              timeout: TIMEOUTS['warm-deploy'],
              mode: config.mode,
              domain: config.domain,
              dnsProvider: config.dnsProvider,
              serverType: config.serverType,
              region: config.region,
              secondaryRegion: config.secondaryRegion,
              provider: config.provider,
              env: { HCLOUD_TOKEN: hetznerToken },
              ...expandedDeployBounds,
            });
            if (result.exitCode !== 0) {
              // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
              const stderrClean = (result.stderr || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
              throw new Error(
                `Warm deploy exited with code ${result.exitCode}: ${stderrClean.slice(-1000)}`,
              );
            }
          },
        ),
    },

    // 4.2 Warm redeploy WITH A CHANGE — k8s only (filtered out below for every
    // other mode). `warm-deploy` above proves a no-op redeploy converges and
    // times it; this step proves a redeploy that SHOULD change something
    // actually does. That is the escape class docs/tests.md calls "unexercised
    // state spaces": e2e almost always cold-deploys, so a step-skip gate that
    // wrongly skips on state-resumed input is invisible to a green matrix.
    // Two live bugs came out of it — #202 (k3s-apply's gate digested only the
    // project's k8s tree, never the CLI's bundled one) and #234 (unpinned
    // StorageClass put a resumed deploy's PGDATA on node-local local-path).
    //
    // Mode gating: `k8s` only, which covers BOTH providers (e3 Hetzner and the
    // opt-in d3 DigitalOcean twin) — the provider axis is exercised for free.
    // k8s-ha is excluded on purpose: it already runs `reconverge-deploy`, a
    // state-resumed deploy against an existing cluster, and adding a second
    // full redeploy to a ~60-minute scenario buys a duplicate signal.
    {
      name: 'warm-redeploy-change',
      run: () =>
        executeStep(
          'warm-redeploy-change',
          `vibecarbon deploy ${config.envPrefix} --${config.mode} (warm, with change)`,
          async () => {
            const marker = warmRedeployMarker(`${config.envPrefix}-${Date.now().toString(36)}`);

            // 1. Mutate a bundled manifest AND an app source file. Both
            //    mutators throw if their anchor is gone, so a template reshape
            //    fails HERE with a clear message instead of silently turning
            //    the whole step into a tautology.
            const manifestPath = join(config.projectDir, WARM_REDEPLOY_MANIFEST_FILE);
            const appPath = join(config.projectDir, WARM_REDEPLOY_APP_FILE);
            writeFileSync(
              manifestPath,
              mutateConfigMapManifest(readFileSync(manifestPath, 'utf-8'), marker),
            );
            writeFileSync(appPath, mutateAppHealthRoute(readFileSync(appPath, 'utf-8'), marker));
            console.log(
              `${tag} [warm-redeploy-change] marker=${marker} — mutated ${WARM_REDEPLOY_MANIFEST_FILE} + ${WARM_REDEPLOY_APP_FILE}`,
            );

            // 2. Redeploy against EXISTING state. Same invocation as
            //    warm-deploy — no -full, no state wipe; the step-skip gates
            //    are exactly what is under test.
            const result = await runDeploy(config.envPrefix, {
              cwd: config.projectDir,
              timeout: TIMEOUTS['warm-redeploy-change'],
              mode: config.mode,
              domain: config.domain,
              dnsProvider: config.dnsProvider,
              serverType: config.serverType,
              region: config.region,
              secondaryRegion: config.secondaryRegion,
              provider: config.provider,
              env: { HCLOUD_TOKEN: hetznerToken },
              ...expandedDeployBounds,
            });
            if (result.exitCode !== 0) {
              // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
              const stderrClean = (result.stderr || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
              throw new Error(
                `Warm redeploy (with change) exited with code ${result.exitCode}: ${stderrClean.slice(-1000)}`,
              );
            }

            // 3. Assert the MANIFEST change is live. Read straight off the
            //    apiserver with the kubeconfig the deploy itself fetched —
            //    same transport `applyK3sManifests` used, so a pass here means
            //    `kubectl apply -k` genuinely re-ran.
            const kubeconfig = join(
              config.projectDir,
              '.vibecarbon',
              `kubeconfig-${config.envPrefix}`,
            );
            const readConfigMapMarker = (): string => {
              const r = spawnSync(
                'kubectl',
                [
                  '--kubeconfig',
                  kubeconfig,
                  '-n',
                  'vibecarbon',
                  'get',
                  'configmap',
                  WARM_REDEPLOY_CONFIGMAP_NAME,
                  '-o',
                  `jsonpath={.data.${WARM_REDEPLOY_CONFIGMAP_KEY}}`,
                ],
                { encoding: 'utf-8', timeout: 30_000, env: gitScrubbedEnv() },
              );
              return (r.stdout || '').trim();
            };
            let liveMarker = '';
            for (let attempt = 0; attempt < 6; attempt++) {
              liveMarker = readConfigMapMarker();
              if (liveMarker === marker) break;
              await new Promise((r) => setTimeout(r, 5_000));
            }
            if (liveMarker !== marker) {
              throw new Error(
                `Manifest change did NOT reach the cluster on a state-resumed redeploy. ` +
                  `configmap/${WARM_REDEPLOY_CONFIGMAP_NAME}.data.${WARM_REDEPLOY_CONFIGMAP_KEY} = ` +
                  `${liveMarker ? `"${liveMarker}"` : '(absent)'}, expected "${marker}". ` +
                  'This is the #202 class: the k3s-apply step gate skipped an apply whose inputs ' +
                  'it could not see had changed. The manifest edit is inside ' +
                  `${WARM_REDEPLOY_MANIFEST_FILE}, which buildK3sApplyInputs covers via ` +
                  'digestDir(projectDir/k8s) — so a failure here is a REGRESSION of that ' +
                  'coverage, not a known gap. Inspect .vibecarbon/deploy-state-' +
                  `${config.envPrefix}.json (is k3s-apply listed as complete with a stale ` +
                  "digest?) and buildK3sApplyInputs' digest coverage.",
              );
            }
            console.log(`${tag} [warm-redeploy-change] manifest change is live (${marker})`);

            // 4. Assert the APP SOURCE change is live. One HTTPS GET against a
            //    route that did not exist before this step — no bundle
            //    parsing, no browser. A 404 here means the redeploy served a
            //    stale image: the build/sideload gates skipped even though the
            //    app source changed.
            const markerUrl = `https://${config.domain}${WARM_REDEPLOY_ROUTE_URL_PATH}`;
            let appBody = '';
            let appStatus = 0;
            for (let attempt = 0; attempt < 12; attempt++) {
              try {
                const res = await dnsSafeFetch(markerUrl, {
                  signal: AbortSignal.timeout(15_000),
                });
                appStatus = res.status;
                appBody = (await res.text()).trim();
                if (res.ok && appBody === marker) break;
              } catch {
                // Rolling restart window — keep polling until the budget ends.
              }
              await new Promise((r) => setTimeout(r, 10_000));
            }
            if (appBody !== marker) {
              throw new Error(
                `App source change did NOT reach the cluster on a state-resumed redeploy. ` +
                  `GET ${markerUrl} -> status=${appStatus || 'no response'} body=${
                    appBody ? `"${appBody.slice(0, 120)}"` : '(empty)'
                  }, expected "${marker}". The redeploy is serving a STALE app image. ` +
                  'This step is the live validation of #244: buildK3sBuildInputs folds ' +
                  'digestAppSource(projectDir) into the k3s-build gate, and the edit is in ' +
                  `${WARM_REDEPLOY_APP_FILE} — under \`src\`, which is in ` +
                  'APP_BUILD_CONTEXT_PATHS. So a failure here means that digest stopped ' +
                  'covering the change and the build/sideload/apply chain all skipped again. ' +
                  'Check (a) whether APP_BUILD_CONTEXT_PATHS still lists `src`, (b) whether ' +
                  'the project Dockerfile still COPYs it, and (c) .vibecarbon/deploy-state-' +
                  `${config.envPrefix}.json for a k3s-build entry that stayed complete.`,
              );
            }
            console.log(`${tag} [warm-redeploy-change] app source change is live (${marker})`);
          },
        ),
    },

    // 4.25 Verify load — concurrent-burst probe. Catches "deploy succeeded
    // and the single-request /api/health returned 200, but the app is
    // dead under any concurrency" (single-threaded misconfig, connection
    // pool too small, downstream Supabase timeouts under fan-out, etc.).
    // Stays well under the app's 100 req/min/IP rate limit (one burst,
    // immediately complete). Sustained load testing belongs in
    // `tests/loadtest/`, run by an operator against a dedicated env;
    // this step's job is the existence-of-load-tolerance check.
    {
      name: 'verify-load',
      run: () =>
        executeStep('verify-load', `loadtest-burst:${config.domain}`, async () => {
          const url = `https://${config.domain}/api/health`;
          const CONCURRENCY = 10;
          const REQUEST_TIMEOUT_MS = 15_000;

          const t0 = performance.now();
          const results = await Promise.all(
            Array.from({ length: CONCURRENCY }, async (_, i) => {
              const reqStart = performance.now();
              try {
                const res = await dnsSafeFetch(url, {
                  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
                // Drain body so the connection can return to the pool.
                await res.text().catch(() => '');
                return {
                  i,
                  ok: res.ok,
                  status: res.status,
                  latencyMs: Math.round(performance.now() - reqStart),
                };
              } catch (err) {
                return {
                  i,
                  ok: false,
                  status: 0,
                  latencyMs: Math.round(performance.now() - reqStart),
                  error: err instanceof Error ? err.message : String(err),
                };
              }
            }),
          );
          const totalMs = Math.round(performance.now() - t0);

          const failures = results.filter((r) => !r.ok);
          const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
          const min = latencies[0];
          const p50 = latencies[Math.floor(latencies.length * 0.5)];
          const p99 = latencies[latencies.length - 1];

          // [perf] lines so the SQLite metrics + Step Matrix expose burst
          // latency stats next to wall-clock duration.
          console.log(`[perf] verify-load.concurrent.total ${totalMs}ms`);
          console.log(`[perf] verify-load.min ${min}ms`);
          console.log(`[perf] verify-load.p50 ${p50}ms`);
          console.log(`[perf] verify-load.p99 ${p99}ms`);
          console.log(
            `${tag} [verify-load] ${CONCURRENCY - failures.length}/${CONCURRENCY} ok, ` +
              `min=${min}ms p50=${p50}ms p99=${p99}ms total=${totalMs}ms`,
          );

          if (failures.length > 0) {
            const detail = failures
              .slice(0, 3)
              .map((f) => {
                const errPart = 'error' in f && f.error ? ` err=${f.error.slice(0, 80)}` : '';
                return `req#${f.i}: status=${f.status}${errPart}`;
              })
              .join('; ');
            throw new Error(
              `verify-load: ${failures.length}/${CONCURRENCY} concurrent /api/health requests failed. ` +
                `Sample failures: ${detail}. Median ${p50}ms; p99 ${p99}ms.`,
            );
          }

          // Soft p99 guard — flag (don't fail) sluggish bursts. E2E
          // hits real Hetzner across the public internet so a hard SLO would
          // redden the matrix on transient jitter; investigate persistent
          // breaches via `tests/loadtest/` against a dedicated env.
          if (p99 > 5_000) {
            console.warn(
              `${tag} [verify-load] p99 ${p99}ms exceeds soft 5s threshold — investigate if persistent`,
            );
          }
        }),
    },

    // 4.5 Phase 9: Verify autoscale (expanded e2e tier only).
    // Inserted unconditionally into stepDefs, then filtered out below if
    // not (expanded && k8s/k8s-ha). Doing it here (rather than via an
    // imperative `if (...) stepDefs.push(...)`) keeps the step ordering
    // visible in one place.
    {
      name: 'verify-autoscale',
      run: () => runVerifyAutoscale(),
    },

    // 5. Scale
    {
      name: 'scale',
      run: () =>
        executeStep('scale', `vibecarbon scale ${config.envPrefix}`, async () => {
          // Snapshot server types BEFORE scale so verify-scale can assert
          // they actually changed. Without this, a silent no-op scale (CLI
          // exits 0 but Hetzner never resizes) goes undetected — observed
          // for weeks on every compose run before this guardrail landed.
          preScaleTypes = await fetchServerTypes(serverIps, typeSnapshotToken ?? '', {
            provider: typeSnapshotProvider,
            tag,
          });
          if (Object.keys(preScaleTypes).length === 0) {
            console.warn(
              `${tag} [scale] could not capture pre-scale types — verify-scale will fall back to stdout grep`,
            );
          }

          const result = await runScale(config.envPrefix, {
            cwd: config.projectDir,
            timeout: TIMEOUTS.scale,
            env: { HCLOUD_TOKEN: hetznerToken },
            scaleToType: config.scaleToType,
          });
          // Stash the scale CLI's output for verify-scale's grep-based fallback.
          // ANSI stripping happens inside the assertion (it's also useful to
          // surface raw output on failure for post-mortem).
          scaleStdout = result.stdout || '';
          scaleStderr = result.stderr || '';

          if (result.exitCode !== 0) {
            // Show BOTH stdout and stderr — `stderr || stdout` masked real
            // failures whenever the CLI emitted a benign stderr line (e.g.
            // NODE_TLS_REJECT_UNAUTHORIZED warning). Observed in
            // iter-validate5 k8s-ha scale: error string contained only
            // the TLS warning while the actual kubectl ETIMEDOUT context
            // sat in stdout where the runner never read it.
            throw new Error(
              `Scale exited with code ${result.exitCode}.\n` +
                `STDERR: ${(result.stderr || '').slice(-1000) || '(empty)'}\n` +
                `STDOUT tail: ${(result.stdout || '').slice(-2000) || '(empty)'}`,
            );
          }

          // Refresh server IPs after scale (IPs may change on resize) and
          // capture post-scale types in the same window. Doing this inside
          // the scale step (not verify-scale) means the post-snapshot is
          // taken as close as possible to scale's exit — minimises the
          // chance of a parallel scenario's destroy mutating Hetzner state
          // between samples.
          serverIps = getServerIps(config.projectDir, config.envPrefix);
          postScaleTypes = await fetchServerTypes(serverIps, typeSnapshotToken ?? '', {
            provider: typeSnapshotProvider,
            tag,
          });
        }),
    },

    // 6. Verify scale — real assertion: types must have changed (or, if the
    //    Hetzner API was unreachable, the CLI stdout must contain a positive
    //    confirmation token). Without this, silent scale no-ops slip past.
    {
      name: 'verify-scale',
      run: () =>
        executeStep('verify-scale', `assert scale changed types`, async (stepId) => {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
          const ansiRe = /\x1b\[[0-9;]*[a-zA-Z]/g;
          const stdoutClean = scaleStdout.replace(ansiRe, '');
          const stderrClean = scaleStderr.replace(ansiRe, '');
          const combined = `${stdoutClean}\n${stderrClean}`;

          // 1. Hard-fail tokens — these mean scale knew it was a no-op or
          //    refused to resize. Catch them regardless of which assertion
          //    path we take below.
          const hardFailRe =
            /Already using\s+\S+\s+— nothing to change|cannot be scaled through the API/;
          if (hardFailRe.test(combined)) {
            throw new Error(
              `Scale was a no-op — output contained: ${combined.match(hardFailRe)?.[0]}\n--- scale stdout tail ---\n${stdoutClean.slice(-500)}`,
            );
          }

          // 2. Type-comparison path (preferred). Both pre and post snapshots
          //    must be non-empty AND every node we observed must land on
          //    `config.scaleToType`.
          //
          //    Compose / compose-HA: every VPS gets blue-green-replaced to
          //    the target type (scale.js's compose path defaults to `both`
          //    under -y).
          //
          //    K8s / k8s-HA: scale.js's `--type X` widens to all roles
          //    (master + supabase + worker) — Hetzner server_type changes
          //    are in-place resizes, so the master-replace guard does not
          //    trip. Every persisted IP (master + supabase + each worker,
          //    plus standby for HA) MUST be on the target.
          //
          //    The previous "sorted-type-lists differ" heuristic passed
          //    matrix run #10's bug (1 of 3 nodes resized, 2 stale)
          //    because the sets happened to be unequal. The strict-target
          //    check below surfaces partial scales explicitly.
          if (
            preScaleTypes &&
            postScaleTypes &&
            Object.keys(preScaleTypes).length > 0 &&
            Object.keys(postScaleTypes).length > 0
          ) {
            const expectedType = config.scaleToType;
            const beforeTypes = Object.values(preScaleTypes);
            const afterEntries = Object.entries(postScaleTypes);

            // Sanity: pre-scale must NOT already be on the target —
            // otherwise we can't distinguish "scale worked" from "deploy
            // already produced the target shape" (misconfigured baseline).
            if (expectedType && beforeTypes.includes(expectedType)) {
              throw new Error(
                `verify-scale: pre-scale snapshot already on target ${expectedType} — env was not deployed at the lower baseline.\n` +
                  `  before: ${JSON.stringify(preScaleTypes)}\n` +
                  `  after:  ${JSON.stringify(postScaleTypes)}`,
              );
            }

            if (expectedType) {
              const stale = afterEntries.filter(([, t]) => t !== expectedType);
              if (stale.length > 0) {
                throw new Error(
                  `Scale did not reach target type ${expectedType} on every node (mode=${config.mode}).\n` +
                    `  before:           ${JSON.stringify(preScaleTypes)}\n` +
                    `  after:            ${JSON.stringify(postScaleTypes)}\n` +
                    `  stale (unchanged): ${stale.map(([ip, t]) => `${ip}=${t}`).join(', ')}\n` +
                    `--- scale stdout tail ---\n${stdoutClean.slice(-500)}`,
                );
              }
            } else {
              // Interactive scale path (no target supplied via --type):
              // fall back to "sorted type lists must differ" heuristic —
              // we can't enforce a specific target without one.
              const sortedBefore = [...beforeTypes].sort();
              const sortedAfter = afterEntries.map(([, t]) => t).sort();
              const sameType =
                sortedBefore.length === sortedAfter.length &&
                sortedBefore.every((t, i) => t === sortedAfter[i]);
              if (sameType) {
                throw new Error(
                  `Scale produced no type change.\n` +
                    `  before: ${JSON.stringify(preScaleTypes)}\n` +
                    `  after:  ${JSON.stringify(postScaleTypes)}\n` +
                    `--- scale stdout tail ---\n${stdoutClean.slice(-500)}`,
                );
              }
            }
            console.log(
              `${tag} [verify-scale] type-change confirmed: ${JSON.stringify(preScaleTypes)} -> ${JSON.stringify(postScaleTypes)}`,
            );
          } else {
            // 3. Fallback: grep stdout for positive-confirmation tokens that
            //    scale.js emits on a successful resize. Without these AND
            //    without type snapshots we have no way to tell apart "scaled"
            //    from "did nothing", so fail loud.
            //
            //    "Scale complete! <from> → <to>" is compose path's success
            //    line; "Resized server" / "New server type" / "Scaled to"
            //    are k8s path tokens. The arrow is encoded as the unicode
            //    `→` (U+2192) in chalk output but ASCII `->` after our ANSI
            //    strip on some terminals — match either.
            const positiveRe =
              /Resized\s+server|New server type:|Scaled to\s+\S+|Server (?:resized|scaled) successfully|Scale complete!.*(?:→|->)/;
            if (!positiveRe.test(combined)) {
              throw new Error(
                `verify-scale: no type snapshots and no positive confirmation in stdout — assume no-op.\n--- scale stdout tail ---\n${stdoutClean.slice(-500)}`,
              );
            }
            console.log(
              `${tag} [verify-scale] type snapshots unavailable; passed via stdout-grep on positive token`,
            );
          }

          // 4. Frontend render smoke AFTER scale. Scale blue-green-replaces the
          //    server and REBUILDS the app image; a rebuild that drops the
          //    VITE_* build args ships an empty VITE_SUPABASE_URL and the SPA
          //    white-screens with "Missing Supabase environment variables".
          //    verify-deploy catches this at deploy time, but without a check
          //    here a scale that breaks the bundle passes green (RCA 2026-06-22:
          //    scale.js called buildRemote with no build args). Self-skips
          //    (pass) when no Chrome/Chromium binary is available on the runner.
          //
          //    Serving gate first: scale reboots the serving path (k8s master
          //    resize restarts the control plane + every pod; compose blue-
          //    green-replaces the VPS), and the render check's single
          //    navigation cannot recover if it lands before the ingress
          //    serves again — its DOM poll would watch a dead about:blank for
          //    the full window (CI run 29180322032). Bounded wait for a
          //    200 + non-empty body; on timeout proceed anyway and let the
          //    render check fail with fresh context.
          const gate = await waitForAppServing(config.domain);
          console.log(
            gate.ok
              ? `${tag} [verify-scale] serving gate: 200 + body after ${Math.round(gate.elapsedMs / 1000)}s (${gate.attempts} attempt${gate.attempts === 1 ? '' : 's'})`
              : `${tag} [verify-scale] serving gate: still not serving after ${Math.round(gate.elapsedMs / 1000)}s (last status=${gate.lastStatus ?? 'none'}, last error=${gate.lastError ?? 'none'}) — running render check anyway`,
          );
          const frontendResults = await runFrontendSmokeChecks(config.domain);
          collector.recordVerifications(stepId, frontendResults);
          const frontendFails = frontendResults.filter((r) => r.status === 'fail');
          if (frontendFails.length > 0) {
            throw new Error(
              `verify-scale: frontend render failed after scale — ${frontendFails
                .map((f) => `${f.checkName}: ${f.errorMessage ?? 'failed'}`)
                .join('; ')}`,
            );
          }
          console.log(`${tag} [verify-scale] frontend render OK after scale`);

          // 5. Backup evidence AFTER scale. Scale is the step most likely to
          //    break archiving without breaking anything visible: compose
          //    blue-green-replaces the VPS (new container, freshly rendered
          //    .env — a dropped S3_* key leaves a healthy database with a dead
          //    archive path), and #223's RCA is literally a scale whose wal-g
          //    S3 traffic failed between the two hosts. `serverIps` was
          //    refreshed by the scale step above, so this probes the CURRENT
          //    primary, not the replaced one.
          const backupResults = await runBackupEvidenceChecks({
            masterIp: serverIps[0],
            sshKeyPath: sshKeyPath ?? undefined,
            projectDir: config.projectDir,
            projectName: config.projectName,
            envPrefix: config.envPrefix,
            isCompose: config.mode.startsWith('compose'),
            provider: config.provider,
            phase: 'verify-scale',
          });
          collector.recordVerifications(stepId, backupResults);
          const backupFails = backupResults.filter((r) => r.status === 'fail');
          if (backupFails.length > 0) {
            throw new Error(
              `verify-scale: backup evidence missing after scale — ${backupFails
                .map((f) => `${f.checkName}: ${f.errorMessage ?? 'failed'}`)
                .join('; ')}`,
            );
          }
          console.log(`${tag} [verify-scale] backup evidence OK after scale`);
        }),
    },

    // 7. Backup
    {
      name: 'backup',
      run: () =>
        executeStep('backup', `vibecarbon backup ${config.envPrefix}`, async () => {
          const result = await runBackup(config.envPrefix, {
            cwd: config.projectDir,
            timeout: TIMEOUTS.backup,
            env: { HCLOUD_TOKEN: hetznerToken },
          });
          if (result.exitCode !== 0) {
            throw new Error(
              `Backup exited with code ${result.exitCode}:\nSTDOUT: ${result.stdout?.slice(-2000)}\nSTDERR: ${result.stderr?.slice(-500)}`,
            );
          }

          // S3 upload is REQUIRED for restore-after-destroy. Previously this
          // was a soft warning, which let the lifecycle continue through
          // destroy → restore — failing at restore with the misleading
          // "No backups found in S3" message instead of at the actual
          // fault site (backup). The detail line in stderr from
          // src/backup.js (name=/code=/status=/bucket=/endpoint=/region=)
          // is captured here so the next iteration has the AWS SDK error
          // for RCA without a re-run.
          //
          // Case-insensitive match: compose path emits `Uploaded to S3`
          // (src/backup.js:511, capital U); k8s/k3s path emits
          // `Backup uploaded to S3` (src/backup.js:655, lowercase u).
          // Anchoring to the exact compose phrasing falsely failed every
          // k8s scenario whose backup actually succeeded.
          const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
          const s3UploadOk = /uploaded to s3/i.test(combined);
          const s3UploadFail = /s3 upload failed/i.test(combined);
          if (s3UploadFail || !s3UploadOk) {
            const detail = (result.stderr || '')
              .split('\n')
              .filter((l) => l.includes('[backup] S3 upload failed') || l.startsWith('    at '))
              .join('\n')
              .slice(-2000);
            throw new Error(
              `Backup S3 upload failed — restore-after-destroy cannot succeed.\n` +
                `STDERR detail:\n${detail || '(no [backup] line in stderr)'}\n` +
                `STDOUT tail: ${(result.stdout || '').slice(-500)}`,
            );
          }
        }),
    },

    // 8. Destroy (pre-restore teardown)
    {
      name: 'destroy',
      run: () =>
        executeStep('destroy', `vibecarbon destroy ${config.envPrefix}`, async () => {
          const result = await runDestroy(config.envPrefix, {
            cwd: config.projectDir,
            timeout: TIMEOUTS.destroy,
            env: { HCLOUD_TOKEN: hetznerToken },
          });
          // Exit 2 = the teardown COMPLETED but leaked (or could not verify a
          // class). That is a real defect and this step fails on it — but the
          // message must say WHAT leaked, or the next person triaging a red
          // matrix starts from "exit 2" and a 2000-char stdout tail. Exit 1 is
          // the other shape entirely: destroy never ran, so the DR chain that
          // follows (re-deploy → restore) is meaningless.
          if (result.exitCode === DESTROY_EXIT_LEAKED) {
            throw new Error(
              `Destroy completed but LEAKED resources (exit 2):\n${extractLeakReport(result)}`,
            );
          }
          if (result.exitCode !== 0) {
            throw new Error(
              `Destroy exited with code ${result.exitCode}.\n` +
                `STDERR: ${(result.stderr || '').slice(-1000) || '(empty)'}\n` +
                `STDOUT tail: ${(result.stdout || '').slice(-2000) || '(empty)'}`,
            );
          }
        }),
    },

    // 9. Re-deploy (restore requires running infrastructure)
    //    The destroy step removed the environment. Re-deploy to create fresh
    //    infrastructure, then restore the database backup onto it.
    {
      name: 'restore',
      run: () =>
        executeStep('restore', `vibecarbon deploy + restore ${config.envPrefix}`, async () => {
          // Re-deploy fresh infrastructure (same config as the initial deploy).
          // Direct-default applies — no flag needed.
          const deployResult = await runDeploy(config.envPrefix, {
            cwd: config.projectDir,
            timeout: TIMEOUTS.deploy,
            mode: config.mode,
            domain: config.domain,
            dnsProvider: config.dnsProvider,
            serverType: config.serverType,
            region: config.region,
            secondaryRegion: config.secondaryRegion,
            provider: config.provider,
            env: { HCLOUD_TOKEN: hetznerToken },
            ...expandedDeployBounds,
          });
          if (deployResult.exitCode !== 0) {
            // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
            const dStderr = (deployResult.stderr || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
            // Shared extraction (see extract-failure-detail.ts): FAIL: line →
            // Error: line (+ perf context) → (failed) perf marker → raw tail.
            // The Error: tier is load-bearing here — on 2026-07-08 the perf
            // marker alone won and a textbook infra failure ("k3s binary did
            // not appear … Connection timed out") classified as [unknown].
            const detail = extractDeployFailureDetail(deployResult.stdout, deployResult.stderr);
            if (dStderr) {
              console.warn(`${tag} restore re-deploy stderr tail: ${dStderr.slice(-1500)}`);
            }
            throw new Error(
              `Re-deploy before restore exited with code ${deployResult.exitCode}: ${detail.slice(-1000)}`,
            );
          }

          // Refresh server info after re-deploy
          serverIps = getServerIps(config.projectDir, config.envPrefix);
          sshKeyPath = getSshKeyPath(config.projectDir, config.envPrefix);

          if (serverIps.length === 0) {
            throw new Error('Re-deploy succeeded but no server IPs found');
          }

          console.log(`${tag} Re-deployed. Server IPs: [${serverIps.join(', ')}]`);

          // Now restore the database backup
          const restoreResult = await runRestore(config.envPrefix, {
            cwd: config.projectDir,
            timeout: TIMEOUTS.restore,
            env: { HCLOUD_TOKEN: hetznerToken },
          });
          if (restoreResult.exitCode !== 0) {
            const readable = (restoreResult.stdout || '')
              // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
              .replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?25[hl]/g, '')
              .replace(/[\r]/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            throw new Error(
              `Restore failed (exit ${restoreResult.exitCode}): ${readable.slice(-500) || '(no output)'}`,
            );
          }

          // Refresh server info after restore
          supabaseKeys = readSupabaseKeys(config.projectDir);
        }),
    },

    // 10. Verify restore
    {
      name: 'verify-restore',
      run: () => runVerificationChecks('verify-restore'),
    },
  ];

  // Conditionally include failover steps for HA modes
  if (options.includeFailover) {
    stepDefs.push(
      // 11. Failover
      {
        name: 'failover',
        run: () =>
          executeStep('failover', `vibecarbon failover ${config.envPrefix}`, async () => {
            // Data-continuity setup: write a marker row on the CURRENT primary
            // BEFORE failover promotes the standby. verify-failover then asserts
            // this exact row survived onto the promoted primary — proving the
            // pre-failover write was replicated, not just that the app serves.
            failoverContinuityMarkerId = buildMarkerId(
              scenarioId,
              'failover-continuity',
              Date.now(),
            );
            const preFailover = resolveHaDbIps(config.projectDir, config.envPrefix);
            if (preFailover.primaryIp && sshKeyPath) {
              const write = await writeReplicationMarker(
                {
                  ip: preFailover.primaryIp,
                  sshKeyPath,
                  mode: config.mode,
                  projectName: config.projectName,
                  label: 'pre-failover-primary',
                },
                failoverContinuityMarkerId,
              );
              if (write.ok) {
                failoverMarkerOriginIp = preFailover.primaryIp;
                console.log(
                  `${tag} [failover] wrote continuity marker ${failoverContinuityMarkerId} on primary ${preFailover.primaryIp}`,
                );
              } else {
                console.warn(
                  `${tag} [failover] could not write continuity marker (${write.error ?? 'unknown'}) — verify-failover continuity check will fail`,
                );
              }
            } else {
              console.warn(
                `${tag} [failover] no primary IP/ssh key to write continuity marker — continuity check will self-skip`,
              );
            }

            const result = await runFailover(config.envPrefix, {
              cwd: config.projectDir,
              timeout: TIMEOUTS.failover,
              env: { HCLOUD_TOKEN: hetznerToken },
            });
            if (result.exitCode !== 0) {
              throw new Error(
                `Failover exited with code ${result.exitCode}.\n` +
                  `STDERR: ${(result.stderr || '').slice(-1000) || '(empty)'}\n` +
                  `STDOUT tail: ${(result.stdout || '').slice(-2000) || '(empty)'}`,
              );
            }

            // Refresh server info after failover (primary/standby swap)
            serverIps = getServerIps(config.projectDir, config.envPrefix);
            sshKeyPath = getSshKeyPath(config.projectDir, config.envPrefix);
          }),
      },
    );

    // 12. Verify failover — runs for BOTH compose-ha and k8s-ha. The old
    // guard skipped k8s-ha because cross-cluster replication had "never
    // streamed data" — that's obsolete: the WireGuard replication transport +
    // pg_basebackup reseed fixes landed 2026-07-06 (commits 4fd0d88..13b46b5),
    // and compose-ha replication was verified green end-to-end (incl. failover)
    // per project_replication_broken.md.
    //
    // Post-failover verification asserts ONLY app-serves (the shared
    // health/app checks) + data CONTINUITY (replication_failover_continuity:
    // the marker written on the old primary before failover survived onto the
    // promoted primary). It deliberately does NOT assert streaming replication:
    // after promotion the old primary is scaled down by design and there is no
    // reverse reseed, so there is no standby streaming from the new primary.
    // The streaming/data-propagation checks are gated to verify-deploy/scale/
    // restore inside runVerificationChecks for exactly this reason.
    stepDefs.push({
      name: 'verify-failover',
      run: () => runVerificationChecks('verify-failover'),
    });

    // 13. Reconverge deploy (k8s-ha only) — re-invoke `vibecarbon deploy`
    // against the post-failover env exactly like the warm-deploy step does
    // (same runDeploy call shape, re-run against the ALREADY-provisioned
    // env — NOT the initial create/setup path). `deploy` is the role
    // reconciler: it reads ha.{primary,standby}.stack and converges
    // whichever cluster is CURRENTLY the standby (the recovered ex-primary,
    // per failover's terminal swapHaRoles write in src/failover.js) to
    // pilot-light — app tier + worker fleet to zero, then a full serial
    // reseed of that cluster's postgres as a streaming replica off the new
    // primary. This step is what actually proves the "DR posture is
    // restored after a failover" story: a customer who just failed over is
    // running degraded (no standby) until they redeploy, and this is that
    // redeploy, verified from the outside.
    //
    // k8s-ha only: the pilot-light role-reconciler architecture
    // (ha.{primary,standby}.stack, the haStacks derivation in
    // orchestrator.js, the standby-shaped k8s manifests) doesn't exist on
    // compose-ha — its HA model has no equivalent "reconverge" step.
    if (config.mode === 'k8s-ha') {
      stepDefs.push({
        name: 'reconverge-deploy',
        run: () =>
          executeStep(
            'reconverge-deploy',
            `vibecarbon deploy ${config.envPrefix} --${config.mode} (reconverge)`,
            async (stepId) => {
              // The ORIGINAL standby stack — failover's swapHaRoles swapped
              // ha.primary/ha.standby WHOLESALE as its terminal write, so by
              // the time this step runs ha.primary already IS this stack.
              // Stacks are born `${env}-primary` / `${env}-standby`
              // (src/lib/deploy/effects/k8s-ha.js) and keep that name for
              // life — only the ROLE pointing at them moves. Reading it from
              // config.envPrefix (this scenario's actual env prefix, e.g.
              // 'e4') rather than hardcoding avoids baking in one scenario's
              // naming.
              const originalStandbyStack = `${config.envPrefix}-standby`;

              // Data-survival setup: write a FRESH marker on the acting
              // primary BEFORE the reconverge deploy. The failover-time
              // marker cannot be reused — runFailoverContinuityCheck's pass
              // path DELETES it as cleanup (learned the hard way: matrix run
              // 2026-07-17 flagged phantom "data loss" because verify-failover
              // had already cleaned the row this guard then re-checked). The
              // survival assertion after the deploy proves the reconverge
              // reshapes roles without touching data (guards the
              // fresh-k3s-token full-cluster-replace class).
              const reconvergeMarkerId = buildMarkerId(
                scenarioId,
                'reconverge-survival',
                Date.now(),
              );
              let reconvergeMarkerWritten = false;
              const preReconverge = resolveHaDbIps(config.projectDir, config.envPrefix);
              if (preReconverge.primaryIp && sshKeyPath) {
                const write = await writeReplicationMarker(
                  {
                    ip: preReconverge.primaryIp,
                    sshKeyPath,
                    mode: config.mode,
                    projectName: config.projectName,
                    label: 'pre-reconverge-primary',
                  },
                  reconvergeMarkerId,
                );
                reconvergeMarkerWritten = write.ok;
                console.log(
                  reconvergeMarkerWritten
                    ? `${tag} [reconverge] wrote survival marker ${reconvergeMarkerId} on acting primary ${preReconverge.primaryIp}`
                    : `${tag} [reconverge] could not write survival marker (${write.error}) — survival assertion will be skipped`,
                );
              }

              const result = await runDeploy(config.envPrefix, {
                cwd: config.projectDir,
                // This redeploy re-seeds the recovered ex-primary's postgres
                // from scratch (full serial pg_basebackup reseed) — not the
                // no-op convergence check warm-deploy times — so it gets the
                // same generous budget as the initial cold deploy rather
                // than warm-deploy's 30-min one.
                timeout: TIMEOUTS['reconverge-deploy'],
                mode: config.mode,
                domain: config.domain,
                dnsProvider: config.dnsProvider,
                serverType: config.serverType,
                region: config.region,
                secondaryRegion: config.secondaryRegion,
                provider: config.provider,
                env: { HCLOUD_TOKEN: hetznerToken },
                ...expandedDeployBounds,
              });
              if (result.exitCode !== 0) {
                // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
                const stderrClean = (result.stderr || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
                throw new Error(
                  `Reconverge deploy exited with code ${result.exitCode}: ${stderrClean.slice(-1000)}`,
                );
              }

              // Refresh cached server info — the reconverged ex-primary's
              // supabase/worker topology changed shape (scaled to
              // pilot-light).
              serverIps = getServerIps(config.projectDir, config.envPrefix);
              sshKeyPath = getSshKeyPath(config.projectDir, config.envPrefix);

              // `deploy` is a role RECONCILER, not a role SWAPPER — it must
              // NOT flip ha.primary/ha.standby again. Assert that from the
              // re-read config: ha.primary.stack should still be the
              // ORIGINAL standby stack (the promotion failover already
              // made), proving this redeploy converged in place rather than
              // re-promoting the cluster it just reconverged to pilot-light.
              const currentPrimary = readHaPrimary(config.projectDir, config.envPrefix);
              if (currentPrimary.stack !== originalStandbyStack) {
                throw new Error(
                  `reconverge-deploy: expected ha.primary.stack to remain '${originalStandbyStack}' ` +
                    `(the post-failover promoted stack) after a role-reconciling redeploy, got ` +
                    `'${currentPrimary.stack}' — deploy appears to have re-swapped HA roles.`,
                );
              }
              // Region cross-wire guard: this redeploy passed the scenario's
              // ORIGINAL -region/-secondary-region flags, but post-swap the
              // acting primary lives in the original SECONDARY region. The
              // orchestrator must persist the per-side regions the fan-out
              // actually deployed to (deployResult), never the raw flag
              // values — a flag leak here would feed the wrong Pulumi
              // `location` to every later converge on this stack.
              if (currentPrimary.region !== config.secondaryRegion) {
                throw new Error(
                  `reconverge-deploy: expected ha.primary.region to be the original secondary ` +
                    `region '${config.secondaryRegion}' after the role swap, got ` +
                    `'${currentPrimary.region}' — deploy persisted flag regions, not deployed regions.`,
                );
              }

              // The NEW standby is the recovered ex-primary — assert it came
              // out of this redeploy in pilot-light shape.
              const { primaryIp: newPrimaryIp, standbyIp: newStandbyIp } = resolveHaDbIps(
                config.projectDir,
                config.envPrefix,
              );

              // DATA-SURVIVAL GUARD (RCA 2026-07-17 e4 run 4): a reconverge
              // deploy that fails to replay the stacks' k3s tokens makes
              // Pulumi REPLACE every server — destroying the promoted
              // primary's data — and the shape assertions below would still
              // pass on the freshly recreated clusters. The marker written
              // just before this redeploy must still be readable on the
              // acting primary, proving the reconverge touched roles, not
              // data. (Uses its OWN marker — the failover-time one is
              // deleted by verify-failover's pass-path cleanup.)
              if (reconvergeMarkerWritten) {
                const survival = await runFailoverContinuityCheck({
                  mode: config.mode,
                  projectName: config.projectName,
                  newPrimaryIp,
                  sshKeyPath,
                  markerId: reconvergeMarkerId,
                });
                collector.recordVerifications(stepId, [survival]);
                if (survival.status === 'fail') {
                  throw new Error(
                    `reconverge-deploy: survival marker ${reconvergeMarkerId} written just ` +
                      `before the redeploy is no longer readable on the acting primary ` +
                      `(${newPrimaryIp}) — the reconverge destroyed data it must only reshape.`,
                  );
                }
              }

              const pilotLightResults = await assertPilotLightStandby(newStandbyIp, {
                sshKeyPath,
                label: 'new-standby',
              });
              collector.recordVerifications(stepId, pilotLightResults);
              const failures = pilotLightResults.filter((r) => r.status === 'fail');
              if (failures.length > 0) {
                const names = failures.map((f) => f.checkName).join(', ');
                for (const f of failures) {
                  console.error(
                    `${tag} [fail] ${f.checkName}: ${f.errorMessage || JSON.stringify(f.details || {})}`,
                  );
                }
                throw new Error(`${failures.length} pilot-light verification(s) failed: ${names}`);
              }

              console.log(
                `${tag} [reconverge-deploy] ha.primary.stack=${currentPrimary.stack} ` +
                  `(new primary ${newPrimaryIp}, new standby ${newStandbyIp}) — pilot-light OK`,
              );
            },
          ),
      });
    }
  }

  // Phase 9: drop verify-autoscale unless we're in the expanded e2e
  // tier targeting a k8s/k8s-ha scenario. The default suite (compose,
  // compose-ha, and any non-expanded k8s run) should be UNCHANGED — running
  // `pnpm test:e2e:batch -- --scenario hetzner/k8s` must not trigger this.
  const includeVerifyAutoscale = options.expanded === true && isK8sMode;
  let filteredStepDefs = includeVerifyAutoscale
    ? stepDefs
    : stepDefs.filter((s) => s.name !== 'verify-autoscale');

  // warm-redeploy-change is k8s-single only. compose/compose-ha have no
  // k3s-apply gate to guard, and k8s-ha already state-resumes a deploy in
  // `reconverge-deploy` — see the step's own comment for the full rationale.
  if (config.mode !== 'k8s') {
    filteredStepDefs = filteredStepDefs.filter((s) => s.name !== 'warm-redeploy-change');
  }

  // Iteration accelerator — drop steps named in --skip-steps / --minimal.
  // The runner passes a Set of step names to remove from the lifecycle
  // entirely (NOT skipped-due-to-prior-failure; just not run). Cuts HA
  // scenarios from ~60min → ~25min when iterating on failover-class bugs.
  if (options.skipSteps && options.skipSteps.size > 0) {
    const before = filteredStepDefs.length;
    filteredStepDefs = filteredStepDefs.filter((s) => !options.skipSteps?.has(s.name));
    const removed = before - filteredStepDefs.length;
    if (removed > 0) {
      console.log(
        `${tag} --skip-steps: dropped ${removed} step(s) from lifecycle: ${[...options.skipSteps].join(', ')}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Execute steps in order, skipping on failure, always running final-destroy
  // -------------------------------------------------------------------------

  try {
    for (const stepDef of filteredStepDefs) {
      if (failed) {
        steps.push(skipStep(stepDef.name, `(skipped)`));
        continue;
      }

      const result = await stepDef.run();
      steps.push(result);

      if (result.status === 'fail' || result.status === 'error') {
        failed = true;
        scenarioError = result.errorMessage;
      }

      // Give the caller a chance to react (interactive mode, Claude Code, etc.)
      if (options.onStepComplete) {
        const action = await options.onStepComplete(result);
        if (action === 'skip' || action === 'abort') {
          console.log(`${tag} Operator requested ${action} — skipping remaining steps`);
          failed = true;
          scenarioError = scenarioError ?? `Operator requested ${action}`;
        }
      }
    }
  } finally {
    // VC_KEEP_ON_FAILURE=1 — operator escape hatch for debugging. Keeps
    // the cluster + GitHub repo + orphan resources alive past the test
    // so it can be poked at with `vibecarbon shell` / `vibecarbon
    // diagnose`. Honored only when the scenario actually failed; a
    // clean pass still tears down.
    //
    // VC_KEEP_ALWAYS=1 — same idea but kept regardless of pass/fail.
    // Pattern 2 use case: stand up a "test rig" (full deploy minus the
    // failing step) once, then iterate the failing step against it
    // many times via the CLI directly (`vibecarbon failover <env> -y`).
    //
    // The operator is responsible for running `vibecarbon destroy` +
    // `gh repo delete` themselves when done — the orphan sweep is also
    // skipped because it would delete the very cluster they want to debug.
    const failed = steps.some((s) => s.status === 'fail' || s.status === 'error');
    const keepAlways = process.env.VC_KEEP_ALWAYS === '1';
    const keepOnFailure = process.env.VC_KEEP_ON_FAILURE === '1' && failed;
    const keepRig = keepAlways || keepOnFailure;
    if (keepRig) {
      const why = keepAlways
        ? 'VC_KEEP_ALWAYS=1 set'
        : 'VC_KEEP_ON_FAILURE=1 set + scenario failed';
      console.log(
        `${tag} ⚠ ${why} — skipping final-destroy, teardown-repo, and orphan sweep.\n` +
          `${tag}   Test rig preserved:\n` +
          `${tag}     project dir:  ${config.projectDir}\n` +
          `${tag}     repo slug:    ${config.testRepoSlug ?? '(none)'}\n` +
          `${tag}     env:          ${config.envPrefix}\n` +
          `${tag}   Iterate a step against it:\n` +
          `${tag}     cd ${config.projectDir} && vibecarbon failover ${config.envPrefix} -y\n` +
          `${tag}     cd ${config.projectDir} && vibecarbon scale ${config.envPrefix} -y\n` +
          `${tag}     cd ${config.projectDir} && vibecarbon backup ${config.envPrefix} -y\n` +
          `${tag}   When done:\n` +
          `${tag}     cd ${config.projectDir} && vibecarbon destroy ${config.envPrefix} -y && gh repo delete ${config.testRepoSlug ?? '<slug>'} --yes`,
      );
      // Sentinel file so iter scripts can find the rig without grepping logs.
      // Layout: one file per scenario under
      // tests/results/.rig-<provider>-<mode>.json containing
      // { projectDir, projectName, envPrefix, repoSlug, provider, mode, createdAt }.
      //
      // Keyed by provider AND mode because scenario identity is provider/mode
      // everywhere else too: keyed by mode alone, a kept `digitalocean/k8s`
      // rig overwrote the sentinel of a live `hetzner/k8s` rig (observed
      // 2026-08-07), and losing a sentinel loses the only recorded
      // coordinates of running, billing infra.
      try {
        const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
        const { join } = await import('node:path');
        const rigDir = join(process.cwd(), 'tests', 'results');
        if (!existsSync(rigDir)) mkdirSync(rigDir, { recursive: true });
        const rigPath = join(rigDir, `.rig-${config.provider}-${config.mode}.json`);
        writeFileSync(
          rigPath,
          `${JSON.stringify(
            {
              mode: config.mode,
              dnsProvider: config.dnsProvider,
              envPrefix: config.envPrefix,
              projectName: config.projectName,
              projectDir: config.projectDir,
              repoSlug: config.testRepoSlug ?? null,
              domain: config.domain,
              // Always a real provider id ('hetzner' | 'digitalocean') —
              // ScenarioConfig.provider is mandatory since the selection
              // grammar (tests/e2e/selection.ts) started resolving it from
              // the registry for every scenario, including the release
              // matrix. scripts/iter-step.js reads this key when locating a
              // kept rig; a rig file missing it is a stale pre-registry
              // artifact, not an implicit 'hetzner'.
              provider: config.provider,
              createdAt: new Date().toISOString(),
              keptReason: keepAlways ? 'always' : 'on-fail',
            },
            null,
            2,
          )}\n`,
        );
        console.log(`${tag}   Sentinel written: ${rigPath}`);
      } catch (err) {
        // Non-fatal — the operator already has the info from the log.
        console.warn(
          `${tag}   (couldn't write rig sentinel: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    } else {
      // Final destroy always runs, even if earlier steps failed.
      // This is critical to avoid leaking cloud resources.
      console.log(`${tag} Running final-destroy (cleanup)...`);

      try {
        const finalResult = await executeStep(
          'final-destroy',
          `vibecarbon destroy ${config.envPrefix}`,
          async () => {
            // runFinalDestroy adds -purge so the backup S3 bucket is also
            // deleted at lifecycle end. The mid-flow destroy (line ~1474)
            // deliberately preserves it so the next step (restore) has
            // something to restore from. Mixing those up = "No backups found
            // in S3" on restore (PR 1BL fixes the regression from PR 1BI
            // which used -purge for both sites).
            const result = await runFinalDestroy(config.envPrefix, {
              cwd: config.projectDir,
              timeout: TIMEOUTS['final-destroy'],
              env: { HCLOUD_TOKEN: hetznerToken },
            });
            if (result.exitCode === 0) return;

            // THROWING here is what makes the old comment ("the step itself
            // records the failure") true. It never was: returning normally
            // sent executeStep down its SUCCESS branch, so a non-zero
            // final-destroy was written to the metrics DB as `pass`, skipped
            // classifyFailure and the diff-vs-green regression check, and was
            // invisible to `hasFailure`. The only trace was this console.warn
            // in a 40-minute log. Leaking cloud resources at teardown is
            // exactly what this scenario is supposed to catch.
            //
            // It still cannot crash the RUN: executeStep catches, records the
            // step as `fail`, and this whole block is inside the step loop's
            // `finally`, so the sweep and teardown after it still execute.
            if (result.exitCode === DESTROY_EXIT_LEAKED) {
              const report = extractLeakReport(result);
              console.warn(`${tag} final-destroy LEAKED resources:\n${report}`);
              throw new Error(`final-destroy completed but LEAKED resources (exit 2):\n${report}`);
            }
            throw new Error(
              `final-destroy exited with code ${result.exitCode}.\n` +
                `STDERR: ${(result.stderr || '').slice(-1000) || '(empty)'}\n` +
                `STDOUT tail: ${(result.stdout || '').slice(-2000) || '(empty)'}`,
            );
          },
        );
        steps.push(finalResult);
      } catch (cleanupErr) {
        // Absolute last resort — even executeStep threw. Record a synthetic step.
        const errMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        console.error(`${tag} final-destroy crashed: ${errMsg}`);

        const now = new Date().toISOString();
        steps.push({
          name: 'final-destroy',
          status: 'error',
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          command: `vibecarbon destroy ${config.envPrefix}`,
          errorMessage: errMsg,
          errorStack: cleanupErr instanceof Error ? cleanupErr.stack : undefined,
        });
      }

      // Delete the throwaway GitHub repo created in setup-repo. Non-fatal —
      // if the repo is already gone (prior cleanup) or `gh repo delete` is
      // disabled for the token scope, we log and move on. The sweep below
      // handles orphans from crashed runs.
      if (config.testRepoSlug) {
        try {
          const teardownResult = await executeStep(
            'teardown-repo',
            `gh repo delete ${config.testRepoSlug}`,
            async () => {
              const result = await runGh(
                ['repo', 'delete', config.testRepoSlug as string, '--yes'],
                {
                  cwd: config.projectDir,
                  timeout: TIMEOUTS['teardown-repo'],
                },
              );
              if (result.exitCode !== 0) {
                console.warn(
                  `${tag} teardown-repo exited with code ${result.exitCode} (non-fatal).\n` +
                    `STDERR: ${(result.stderr || '').slice(-1000) || '(empty)'}\n` +
                    `STDOUT tail: ${(result.stdout || '').slice(-2000) || '(empty)'}`,
                );
              }
            },
          );
          steps.push(teardownResult);
        } catch (teardownErr) {
          const errMsg = teardownErr instanceof Error ? teardownErr.message : String(teardownErr);
          console.warn(`${tag} teardown-repo crashed (non-fatal): ${errMsg}`);
        }
      }

      // Sweep for orphaned resources that destroy may have missed.
      // Scale creates "-new" servers that aren't in config if scale fails;
      // K8s creates PVC-backed volumes that outlive the cluster;
      // deploy creates S3 buckets that destroy intentionally skips.
      // Persist per-category counts so trend queries can spot destroy drift
      // (any non-zero count = destroy silently no-op'd that resource type).
      // Dispatched on the scenario's provider — until 2026-08-07 this called
      // the Hetzner sweep unconditionally, so DO runs enumerated the wrong
      // cloud and printed a false "destroy worked cleanly". An unknown
      // provider gets a loud REGRESSION line, never a silent zero-sweep.
      const sweepProviderId = config.provider ?? 'hetzner';
      let sweepCounts: SweepBreakdown;
      let sweepEnumFailed = false;
      switch (sweepProviderId) {
        case 'hetzner':
          ({ counts: sweepCounts, enumFailed: sweepEnumFailed } =
            await sweepOrphanedHetznerResources(tag, config.projectName, hetznerToken));
          break;
        case 'digitalocean':
          ({ counts: sweepCounts, enumFailed: sweepEnumFailed } =
            await sweepOrphanedDigitalOceanResources(tag, config.projectName, {
              token: options.digitaloceanToken ?? process.env.DIGITALOCEAN_API_TOKEN,
            }));
          break;
        case 'linode':
          ({ counts: sweepCounts, enumFailed: sweepEnumFailed } =
            await sweepOrphanedLinodeResources(tag, config.projectName, {
              token: options.linodeToken ?? process.env.LINODE_API_TOKEN,
            }));
          break;
        case 'vultr':
          // storageRegion is load-bearing, not a nicety: Vultr object-storage
          // keys are per-subscription (one subscription = one cluster), so
          // without the cluster the bucket half cannot authenticate anywhere
          // and reports itself incomplete instead of guessing.
          ({ counts: sweepCounts, enumFailed: sweepEnumFailed } = await sweepOrphanedVultrResources(
            tag,
            config.projectName,
            {
              token: options.vultrToken ?? process.env.VULTR_API_TOKEN,
              storageRegion: process.env.VULTR_STORAGE_REGION,
            },
          ));
          break;
        case 'scaleway':
          // The access key rides along for the bucket half (the SAME IAM
          // pair signs S3 — no separate storage credential exists); the
          // project id scopes the IAM ssh-key walk to the dedicated
          // Project the deploy targets.
          ({ counts: sweepCounts, enumFailed: sweepEnumFailed } =
            await sweepOrphanedScalewayResources(tag, config.projectName, {
              token: options.scalewayToken ?? process.env.SCALEWAY_SECRET_KEY,
              storageKey: process.env.SCALEWAY_ACCESS_KEY,
              projectId: process.env.SCALEWAY_DEFAULT_PROJECT_ID,
            }));
          break;
        default:
          console.warn(
            `${tag} [sweep] REGRESSION: no orphan sweep implemented for provider '${String(sweepProviderId)}' — nothing was checked; leaked resources cannot be ruled out.`,
          );
          sweepCounts = {
            servers: 0,
            volumes: 0,
            placementGroups: 0,
            firewalls: 0,
            floatingIps: 0,
            networks: 0,
            s3Buckets: 0,
            sshKeys: 0,
          };
          // Nothing was checked — that is the strongest form of "could not
          // enumerate", so it gates the verdict like any other enum failure.
          sweepEnumFailed = true;
      }
      // Verdict gate (2026-08-09, round-A v1): a scenario whose sweep found
      // orphans OR could not fully enumerate must NOT count as green — v1
      // passed its lifecycle while a Vultr API 500s window ate the destroy's
      // instance deletions AND blinded the in-run sweep, so the round read
      // "PASS" over two live leaked servers until the next quiescent sweep.
      const sweepOrphanTotal = Object.values(sweepCounts).reduce(
        (sum, n) => sum + (typeof n === 'number' ? n : 0),
        0,
      );
      if (sweepOrphanTotal > 0 || sweepEnumFailed) {
        sweepRegression = true;
      }
      try {
        db.recordOrphansSwept(scenarioId, sweepCounts);
      } catch (dbErr) {
        console.warn(
          `${tag} [sweep] Failed to persist orphan counts: ${dbErr instanceof Error ? dbErr.message : dbErr}`,
        );
      }

      // Local counterpart to the cloud sweep above: reap operator-side build
      // images/volumes for this run so `docker` disk usage doesn't creep across
      // the matrix. Skipped for kept rigs (handled by the keepRig branch, whose
      // images the operator is actively iterating).
      await reapLocalBuildArtifacts(tag, config.projectName);
    } // end of !keepOnFailure
  }

  // -------------------------------------------------------------------------
  // Determine overall scenario status
  // -------------------------------------------------------------------------

  const hasStepFailure = steps.some((s) => s.status === 'fail' || s.status === 'error');
  // Sweep cleanliness gates the verdict: "all steps passed" is not green if
  // destroy left orphans behind or the orphan check could not complete —
  // that combination is exactly how round-A v1 (2026-08-09) read PASS over
  // two live leaked Vultr instances.
  const hasFailure = hasStepFailure || sweepRegression;
  const status = hasFailure ? 'fail' : 'pass';
  const failureCategory = hasStepFailure
    ? rollUpScenarioCategory(steps.map((s) => s.failureCategory))
    : sweepRegression
      ? 'regression'
      : undefined;

  console.log(
    `${tag} Scenario finished: ${status}${failureCategory ? ` [${failureCategory}]` : ''}${
      sweepRegression && !hasStepFailure ? ' (sweep regression — see [sweep] REGRESSION above)' : ''
    }`,
  );

  return {
    provider: config.provider,
    mode: config.mode,
    dnsProvider: config.dnsProvider,
    domain: config.domain,
    status,
    steps,
    errorMessage: scenarioError,
    failureCategory,
  };
}
