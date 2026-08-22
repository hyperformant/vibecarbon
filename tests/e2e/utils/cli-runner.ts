/**
 * CLI runner utility for e2e tests.
 *
 * Wraps vibecarbon CLI command execution with timing, output capture,
 * and structured result objects for the e2e test suite.
 *
 * SECURITY: This module uses execSync with shell expansion intentionally.
 * All command arguments originate from trusted test fixtures (scenario configs),
 * never from external user input. The test runner needs synchronous execution
 * with full stdout/stderr capture and wall-clock timing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isLeakReportLine } from '../../../src/lib/destroy/leak-ledger.js';
import { logPerfBreakdown, parsePerfLines } from '../metrics/reporter.js';
import type { CliResult } from '../scenarios/types.js';
import { e2eCliEnv } from './e2e-env.js';

/**
 * Per-scenario defaults propagated via AsyncLocalStorage. Each scenario wraps
 * its work in `scenarioContext.run({ logPath, echo }, async () => { ... })`
 * so all downstream cli-runner calls inherit the log tee + echo setting
 * without every call site having to pass them explicitly.
 *
 * The lifecycle runner re-runs (nests) this context per step to inject
 * `recordPerfSubsteps` bound to the current step_id; cli-runner invokes it
 * after parsing [perf] lines so each CLI invocation's sub-stage timings get
 * persisted under the correct step.
 */
export const scenarioContext = new AsyncLocalStorage<{
  logPath?: string;
  echo?: boolean;
  recordPerfSubsteps?: (timings: Array<{ name: string; ms: number; note?: string }>) => void;
}>();

// Resolve the vibecarbon repo root from this file's location:
// tests/e2e/utils/cli-runner.ts -> repo root is 3 dirs up
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CLI_ENTRY = resolve(REPO_ROOT, 'src', 'cli.js');

const DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes

export interface RunOptions {
  cwd: string;
  timeout?: number;
  env?: Record<string, string>;
  /**
   * When set, every line of captured stdout+stderr is appended to this file
   * AS IT ARRIVES (not at exit). Per-scenario log paths go here so parallel
   * e2e runs get a dedicated log per mode. Absent = no side-channel
   * log; stdout/stderr are still captured in the returned CliResult.
   */
  logPath?: string;
  /**
   * When true, captured subprocess output is ALSO forwarded to this
   * process's stdout/stderr as it arrives. Default false — e2e
   * scenarios opt in per-scenario so interleaved output stays readable.
   */
  echo?: boolean;
}

/**
 * Run a vibecarbon CLI command and capture output + timing.
 *
 * Uses `spawn` (async) with piped stdio so:
 *   - stdout/stderr are collected into CliResult (back-compat)
 *   - AND every chunk can be tee'd live to options.logPath (per-scenario log)
 *   - AND/OR echoed to this process's stdout/stderr (options.echo)
 *
 * The previous spawnSync implementation buffered ~15 minutes of silent
 * deploy output in memory — now the per-scenario log file gets it line-by-
 * line, and you can `tail -f` it to watch a deploy live.
 *
 * @param args - CLI arguments (e.g. "up", "deploy --compose --ha")
 * @param options - Working directory, timeout, extra env vars, optional log tee
 * @returns Promise resolving to { stdout, stderr, exitCode, durationMs }
 */
export async function runCli(args: string, options: RunOptions): Promise<CliResult> {
  const ctx = scenarioContext.getStore();
  const logPath = options.logPath ?? ctx?.logPath;
  const echo = options.echo ?? ctx?.echo ?? true;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const cmd = `node ${CLI_ENTRY} ${args}`;
  const header = `[cli-runner] ${cmd} (cwd: ${options.cwd})\n`;
  if (echo) process.stdout.write(header);
  if (logPath) appendFileSync(logPath, header);

  // Child env comes from the shared builder (tests/e2e/utils/e2e-env.js) so
  // `scripts/iter-step.js` spawns the CLI with the identical environment —
  // iterating one step against a kept rig must not behave differently from
  // that step inside a full run.
  const env = e2eCliEnv(options.env);

  // Argv form = no local shell, no injection surface.
  const splitArgs = args.split(/\s+/).filter(Boolean);
  const start = performance.now();

  return spawnAndCapture('node', [CLI_ENTRY, ...splitArgs], {
    cwd: options.cwd,
    env,
    timeoutMs: timeout,
    logPath,
    echo,
    commandLabel: splitArgs[0] ?? 'cli',
    start,
  });
}

/**
 * Internal: spawn a process with piped stdio, tee chunks to file + stdout,
 * and resolve with a CliResult shape once the process exits.
 *
 * Spawned with `detached: true` so the child becomes a process-group leader;
 * timeout's SIGKILL is delivered to the entire group via `process.kill(-pid)`
 * so grandchildren (e.g. `pnpm install` spawned by `vibecarbon create`) are
 * also terminated. Resolves on `'exit'`, not `'close'` — `close` waits for
 * stdio FDs to drain, which an orphaned grandchild can hold open forever
 * (observed: pnpm install reparented to PID 1 kept stdout/stderr live for
 * 33 min on compose-ha after parent CLI was already gone). A short post-exit
 * drain window catches any final buffered chunks before we resolve.
 */
export async function spawnAndCapture(
  bin: string,
  argv: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    logPath?: string;
    echo?: boolean;
    commandLabel: string;
    start: number;
  },
): Promise<CliResult> {
  return new Promise((resolveFn) => {
    const child = spawn(bin, argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;
    const echo = opts.echo !== false;

    const onChunk = (stream: 'stdout' | 'stderr', buf: Buffer) => {
      const text = buf.toString('utf8');
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (opts.logPath) {
        try {
          appendFileSync(opts.logPath, text);
        } catch {
          /* log-write failure is never fatal to the test */
        }
      }
      if (echo) {
        (stream === 'stdout' ? process.stdout : process.stderr).write(text);
      }
    };

    child.stdout.on('data', (b: Buffer) => onChunk('stdout', b));
    child.stderr.on('data', (b: Buffer) => onChunk('stderr', b));

    const killGroup = (signal: NodeJS.Signals) => {
      // Negative pid targets the whole process group. Falls back to a
      // direct kill if the group ID lookup fails for any reason.
      if (typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          /* fall through */
        }
      }
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      killGroup('SIGKILL');
    }, opts.timeoutMs);

    const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - opts.start);
      const timings = parsePerfLines(`${stdout}\n${stderr}`);
      logPerfBreakdown('cli', `vibecarbon ${opts.commandLabel}`, timings);
      const ctx = scenarioContext.getStore();
      if (ctx?.recordPerfSubsteps && timings.length > 0) {
        try {
          ctx.recordPerfSubsteps(timings);
        } catch {
          /* never fail a CLI run because metrics persistence threw */
        }
      }
      resolveFn({
        stdout,
        stderr,
        durationMs,
        perfLines: timings,
        // null code + a signal = killed (timeout). Surface 1 so scenarios
        // treat it as failure.
        exitCode: code ?? (signal ? 1 : 1),
      });
    };

    // Process has exited. Give the pipes a brief window to flush any buffered
    // chunks, then resolve regardless — `close` may never fire if a grandchild
    // inherited stdout/stderr and outlived the direct child.
    child.on('exit', (code, signal) => {
      setTimeout(() => finalize(code, signal), 250);
    });
    // Happy path: stdio drained cleanly. Resolve immediately.
    child.on('close', (code, signal) => {
      finalize(code, signal);
    });
  });
}

/**
 * Run vibecarbon create command. Creates project in the parent of cwd.
 *
 * Passes admin credentials and -y for non-interactive execution.
 */
export function runCreate(
  projectName: string,
  options: RunOptions & {
    adminEmail: string;
    adminPassword: string;
  },
): Promise<CliResult> {
  const args = [
    'create',
    projectName,
    '-y',
    '-admin-email',
    options.adminEmail,
    '-admin-password',
    options.adminPassword,
  ].join(' ');

  return runCli(args, options);
}

/**
 * Run vibecarbon add with one or more features.
 *
 * Features are passed as space-separated arguments after `add`.
 */
export function runAddFeatures(features: string[], options: RunOptions): Promise<CliResult> {
  const args = ['add', ...features, '-y'].join(' ');
  return runCli(args, options);
}

/**
 * Run vibecarbon deploy.
 *
 * The PR-4/5/6 CLI sweep collapsed deploy's settable surface to four flags:
 * `-y`, `-mode <compose|compose-ha|k8s|k8s-ha>`, `-region <id>`, `-full`.
 * Everything else (domain, dnsProvider, serverType, secondaryRegion, build
 * mode, autoscale bounds) now lives in `.vibecarbon.json` envConfig and is
 * read by `gatherDeploymentConfig` under `-y`. We seed those here before
 * invoking the CLI so the deploy has every value it needs without prompting.
 *
 * Build mode (compose `direct`/`local`/`push`) is auto-detected by the new
 * `resolveBuildMode` based on `cicdEnabled` + docker availability. E2E
 * never runs `vibecarbon configure`, so cicdEnabled stays false and compose
 * resolves to 'local' (when docker is on the host) or 'direct' otherwise —
 * functionally equivalent to the old explicit `--direct`.
 *
 * Autoscale bounds (`minWorkers`/`maxWorkers`) are no longer part of any
 * deploy surface — only `--expanded` e2e runs need wider bounds and
 * that tier was retired from the new CLI. Passing them here is a no-op;
 * we throw if the caller actually requests expanded bounds so the gap is
 * visible rather than silently producing a meaningless verify-autoscale
 * test against the (1, 3) default.
 */
export function runDeploy(
  env: string,
  options: RunOptions & {
    mode: string;
    domain: string;
    dnsProvider: string;
    serverType?: string;
    region?: string;
    secondaryRegion?: string;
    /**
     * Cloud provider to deploy against. Omitted (undefined) → 'hetzner',
     * same default `providerFor`/`resolveProvider` apply to an envConfig
     * with no `provider` field — the 4 release scenarios never pass this.
     */
    provider?: string;
    /**
     * Pre-PR-5: forced compose build-locally-push-to-server mode. Now a
     * no-op; resolveBuildMode auto-selects 'local' when docker exists,
     * 'direct' otherwise.
     */
    direct?: boolean;
    minWorkers?: number;
    maxWorkers?: number;
  },
): Promise<CliResult> {
  if (options.minWorkers != null || options.maxWorkers != null) {
    throw new Error(
      'runDeploy: minWorkers/maxWorkers were removed from the deploy CLI in PR 5; ' +
        '--expanded e2e is currently unsupported on this branch.',
    );
  }

  // Seed envConfig BEFORE invoking the CLI. Under -y, gatherDeploymentConfig
  // reads these from .vibecarbon.json and never prompts.
  seedDeployEnvConfig(options.cwd, env, {
    region: options.region,
    secondaryRegion: options.secondaryRegion,
    serverType: options.serverType,
    domain: options.domain,
    dnsProvider: options.dnsProvider,
    provider: options.provider,
  });

  const args = [
    'deploy',
    env,
    '-y',
    '-mode',
    options.mode,
    ...(options.region ? ['-region', options.region] : []),
  ].join(' ');

  return runCli(args, options);
}

/**
 * Write deploy-time settings into the project's `.vibecarbon.json` so the
 * new interactive-default deploy CLI has every value it would otherwise
 * prompt for. Idempotent — merges into any existing config rather than
 * overwriting (so the redeploy-after-restore step inherits the original
 * envConfig and additions made by the first deploy).
 *
 * Exported for tests/unit/e2e/seed-deploy-env-config.test.ts — pure
 * fs-in/fs-out, no CLI process involved.
 */
export function seedDeployEnvConfig(
  projectDir: string,
  envName: string,
  settings: {
    region?: string;
    secondaryRegion?: string;
    serverType?: string;
    domain: string;
    dnsProvider: string;
    provider?: string;
  },
): void {
  const configPath = join(projectDir, '.vibecarbon.json');
  type ProjectConfig = {
    projectName?: string;
    environments?: Record<string, Record<string, unknown>>;
    [k: string]: unknown;
  };
  const config: ProjectConfig = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf-8')) as ProjectConfig)
    : { environments: {} };
  config.environments = config.environments ?? {};
  config.environments[envName] = config.environments[envName] ?? {};
  const envCfg = config.environments[envName];
  if (settings.region) envCfg.region = settings.region;
  if (settings.secondaryRegion) envCfg.secondaryRegion = settings.secondaryRegion;
  if (settings.serverType) envCfg.serverType = settings.serverType;
  // Only written when explicitly set (mirrors region/serverType above) — the
  // 4 release scenarios never pass `provider`, so their seeded
  // .vibecarbon.json never gains this key. resolveProvider/providerFor
  // (src/lib/providers/index.js) both default a missing key to 'hetzner'.
  if (settings.provider) envCfg.provider = settings.provider;
  envCfg.domain = settings.domain;
  envCfg.dnsProvider = settings.dnsProvider;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Run vibecarbon scale.
 */
export function runScale(
  env: string,
  options: RunOptions & { scaleToType?: string },
): Promise<CliResult> {
  const typeArg = options.scaleToType ? ` -type ${options.scaleToType}` : '';
  return runCli(`scale ${env} -y${typeArg}`, options);
}

/**
 * Run vibecarbon backup. E2E always wants the create action; PR 2's
 * interactive-default backup CLI requires `-action <create|list|download>`
 * (or `-l`) under `-y` so the off-TTY guard can name exactly which flag
 * is missing.
 */
export function runBackup(env: string, options: RunOptions): Promise<CliResult> {
  return runCli(`backup ${env} -y -action create`, options);
}

/**
 * Run vibecarbon destroy — used MID-LIFECYCLE (between backup and restore)
 * to validate the disaster-recovery flow: backup → destroy → restore-from-S3.
 *
 * -orphans is safe in the e2e harness because each scenario runs
 * against a freshly-scaffolded test project — any orphan Pulumi stack in
 * this project's S3 bucket is necessarily from THIS run's failed/aborted
 * deploy (no other scenario shares the bucket). The flag is gated behind
 * an explicit opt-in for human users (PR 1S) to prevent cross-project
 * blast when a stale local file:// backend is shared. That risk doesn't
 * apply here, and without it the lifecycle's final-destroy can't clean up
 * after a deploy that failed before .vibecarbon.json was saved — leaving
 * Pulumi-managed FloatingIps + Networks to leak (observed 2026-04-26
 * matrix run #2).
 *
 * Critically does NOT pass -purge: the next step is restore, which needs
 * the backup bucket to still exist. Use runFinalDestroy for the
 * cleanup-everything destroy at the end of the lifecycle.
 */
export function runDestroy(env: string, options: RunOptions): Promise<CliResult> {
  return runCli(`destroy ${env} -y -orphans`, options);
}

/**
 * Run vibecarbon destroy as the LIFECYCLE'S FINAL CLEANUP STEP.
 *
 * Same as runDestroy, plus -purge so the backup S3 bucket is also deleted.
 * Production users want backups preserved across destroy/redeploy for
 * recovery, but e2e tests must fully clean up everything they
 * create — and after this point in the lifecycle there's nothing left to
 * restore. With this flag, sweep finding a `*-backups` bucket
 * post-final-destroy is a real regression in destroy's purge path.
 */
export function runFinalDestroy(env: string, options: RunOptions): Promise<CliResult> {
  return runCli(`destroy ${env} -y -orphans -purge`, options);
}

/**
 * `vibecarbon destroy` exit codes.
 *
 * 1 vs 2 is load-bearing for BOTH e2e destroy sites, which is why destroy
 * splits them rather than emitting a single non-zero:
 *   1 — the destroy could not run at all (bad flags, no API token, no such
 *       environment, an unhandled throw). Nothing was torn down, so the DR
 *       chain that follows the mid-lifecycle destroy is meaningless.
 *   2 — the teardown RAN TO COMPLETION but leaked, or could not verify a
 *       class (a delete that failed, a provider listing that came back
 *       incomplete). Real resources may still be billing.
 *
 * Re-exported from the CLI's own definition so the runner can never drift
 * from the codes destroy actually emits.
 */
export { DESTROY_EXIT_LEAKED } from '../../../src/lib/destroy/leak-ledger.js';

/**
 * Pull destroy's leak report out of a CLI result so a failing e2e step says
 * WHAT leaked instead of "exit 2".
 *
 * `isLeakReportLine` is imported rather than re-implemented here: the severity
 * token leads each rendered line precisely so this scrape can work, and a
 * format change that silently stopped matching would put the runner back to an
 * unexplained exit code. Clack writes the report to stdout with colour, hence
 * the ANSI strip.
 */
export function extractLeakReport(result: CliResult): string {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
    /\x1b\[[0-9;]*m/g,
    '',
  );
  const lines = text
    .split('\n')
    .filter((line) => isLeakReportLine(line))
    .map((line) => line.trim());
  return lines.length > 0 ? lines.join('\n') : '(no leak report lines captured)';
}

/**
 * Run vibecarbon restore. Restore's TTY guard insists on `-source` (or `-l`)
 * under `-y`; the lifecycle wants the most-recent S3 backup, so we pass the
 * `latest` sentinel which `pickInteractiveSource` resolves to the newest
 * upload.
 */
export function runRestore(env: string, options: RunOptions): Promise<CliResult> {
  return runCli(`restore ${env} -y -source latest`, options);
}

/**
 * Run vibecarbon failover.
 */
export function runFailover(env: string, options: RunOptions): Promise<CliResult> {
  return runCli(`failover ${env} -y`, options);
}

/**
 * Run the `gh` CLI with full stdout/stderr capture. Used by the e2e
 * lifecycle to bootstrap throwaway GitHub repos that `ensureCIImageReady`
 * relies on, and to delete them during teardown.
 *
 * Argv form — no local shell — so scenario-supplied slugs can't inject.
 */
export async function runGh(args: string[], options: RunOptions): Promise<CliResult> {
  const ctx = scenarioContext.getStore();
  const logPath = options.logPath ?? ctx?.logPath;
  const echo = options.echo ?? ctx?.echo ?? true;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const header = `[cli-runner] gh ${args.join(' ')} (cwd: ${options.cwd})\n`;
  if (echo) process.stdout.write(header);
  if (logPath) appendFileSync(logPath, header);

  const env = {
    ...process.env,
    ...options.env,
  };

  return spawnAndCapture('gh', args, {
    cwd: options.cwd,
    env,
    timeoutMs: timeout,
    logPath,
    echo,
    commandLabel: 'gh',
    start: performance.now(),
  });
}
