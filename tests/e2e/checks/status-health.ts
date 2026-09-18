/**
 * verify-status: `vibecarbon status -json` must report every server of the
 * environment fully healthy — the public readiness probe ok, every
 * container/pod healthy (or a finished one-shot), every k8s platform
 * namespace full, every node Ready. `starting` rows are retried until
 * timeoutMs (a pod may still be rolling right after verify-deploy);
 * anything else fails on first sight. Non-perf step: excluded from the
 * reporter's totals (NON_PERF_STEPS) and never a PERF_TABLE_ROWS entry.
 */
import type { VerificationResult } from '../scenarios/types.js';
import { runCli as defaultRunCli } from '../utils/cli-runner.js';

type Row = { container: string; health: string; label: string; detail: string };
type ServerContainers = {
  kind: string;
  ip?: string;
  rows: Row[];
  platform?: Record<string, { healthy: number; total: number }>;
  nodes?: { ready: number; total: number };
  error?: string;
};

/**
 * A server that is legitimately not serving: after a compose-ha failover the
 * old primary keeps its app tier stopped by design (failoverComposeHA step 2
 * `docker stop`s it and nothing restarts it until a redeploy). The rows in
 * `allowedExited` may read `exited` there; `db` must still be healthy (the
 * wal-g demote recreates it), and anything else fails as on any server.
 */
export type RetiredServer = { serverName?: string; ip?: string; allowedExited: readonly string[] };

export type AssessOptions = { retired?: RetiredServer };

type Verdict = { ok: true } | { ok: false; retryable: boolean; problems: string[] };
// TS discriminated-union narrowing on `ok` needs strictNullChecks, which
// tsconfig.e2e.json has off — an explicit `Extract` cast below stands in for
// the narrowing the compiler won't do here.
type FailVerdict = Extract<Verdict, { ok: false }>;

export function assessStatusJson(
  json: unknown,
  envName: string,
  opts: AssessOptions = {},
): Verdict {
  const env = (
    json as {
      environments?: Record<string, { checks?: Record<string, unknown>; error?: string }>;
    }
  )?.environments?.[envName];
  if (!env)
    return {
      ok: false,
      retryable: false,
      problems: [`environment ${envName} missing from status -json`],
    };
  const checks = env.checks || {};
  // Containers data absence is checked first and short-circuits everything
  // else — it means status -json didn't even attempt the per-server probe
  // (stale CLI, malformed checks payload), which is a distinct failure mode
  // from "the probe ran and reported unhealthy".
  // When the env's checks callback rejected, status -json carries the reason
  // at `environments.<env>.error` with empty checks — surface it.
  const containers = checks.containers as Record<string, ServerContainers> | undefined;
  if (!containers)
    return {
      ok: false,
      retryable: false,
      problems: [`no containers data for ${envName}${env.error ? `: ${env.error}` : ''}`],
    };
  const problems: string[] = [];
  let retryable = true;
  const probe = checks.remoteHealth as
    | { ok?: boolean; status?: number; error?: string }
    | undefined;
  if (!probe?.ok) {
    problems.push(`readiness probe failed: ${probe?.error || `HTTP ${probe?.status}`}`);
    retryable = false;
  }
  for (const [server, sc] of Object.entries(containers)) {
    if (sc.error) {
      problems.push(`${server}: ${sc.error}`);
      retryable = false;
      continue;
    }
    const excused = isRetired(server, sc, opts.retired) ? opts.retired.allowedExited : [];
    for (const r of sc.rows) {
      if (r.health === 'healthy' || r.health === 'done') continue;
      // The retired node's db is never excused, whatever the list says.
      if (r.container !== 'db' && r.label === 'exited' && excused.includes(r.container)) continue;
      problems.push(`${server}: ${r.container} ${r.label}${r.detail ? ` ${r.detail}` : ''}`);
      if (r.health !== 'starting') retryable = false;
    }
    for (const [ns, n] of Object.entries(sc.platform || {})) {
      if (n.healthy !== n.total) {
        problems.push(`${server}: ${ns} ${n.healthy}/${n.total}`);
      }
    }
    if (sc.nodes && sc.nodes.ready !== sc.nodes.total) {
      problems.push(`${server}: nodes ${sc.nodes.ready}/${sc.nodes.total} ready`);
      retryable = false;
    }
  }
  if (problems.length === 0) return { ok: true };
  return { ok: false, retryable, problems };
}

function isRetired(
  server: string,
  sc: { ip?: string },
  retired: RetiredServer | undefined,
): boolean {
  if (!retired) return false;
  if (retired.serverName !== undefined && retired.serverName === server) return true;
  return retired.ip !== undefined && retired.ip === sc.ip;
}

export async function checkStatusHealth(opts: {
  projectDir: string;
  envName: string;
  timeoutMs: number;
  pollMs?: number;
  runCli?: typeof defaultRunCli;
  retired?: RetiredServer;
}): Promise<VerificationResult> {
  const runCli = opts.runCli ?? defaultRunCli;
  const pollMs = opts.pollMs ?? 10_000;
  const deadline = Date.now() + opts.timeoutMs;
  let last: string[] = [];
  for (;;) {
    const r = await runCli('status -json', { cwd: opts.projectDir, timeout: 120_000 });
    if (r.exitCode !== 0)
      return fail(`status exited ${r.exitCode}: ${(r.stderr || '').slice(-500)}`);
    let json: unknown;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      return fail(`status -json was not JSON: ${r.stdout.slice(0, 200)}`);
    }
    const verdict = assessStatusJson(json, opts.envName, { retired: opts.retired });
    if (verdict.ok) return { checkName: 'status-health', status: 'pass' };
    const failed = verdict as FailVerdict;
    last = failed.problems;
    if (!failed.retryable || Date.now() + pollMs > deadline) break;
    await new Promise((res) => setTimeout(res, pollMs));
  }
  return fail(last.join('; '));

  function fail(errorMessage: string): VerificationResult {
    return { checkName: 'status-health', status: 'fail', errorMessage };
  }
}
