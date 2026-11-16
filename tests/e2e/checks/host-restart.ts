/**
 * The `update` step: mark a restart due on one server, see every surface report
 * it, run `vibecarbon update`, see it clear, and hold the measured downtime to
 * the plan.
 *
 * The mark is Ubuntu's own flag file, /var/run/reboot-required, which the host
 * reporter watches. A systemd path unit (PathChanged on the flag and on its
 * package list) starts the reporter the moment either file is written, and the
 * reporter publishes at once: the node annotation on k8s, state.json on
 * compose. The app reads the nodes live on k8s and the file on compose, and
 * `status` reads the same sources, so a mark shows up within seconds. The 90 s
 * window is the slack for the reporter's kubectl call and for `status` itself
 * (one -json run takes several seconds), not a wait for a timer.
 *
 * Non-perf step: excluded from the reporter's totals (NON_PERF_STEPS).
 */

import { resolvePrimary } from '../../../src/lib/cli/resolve-primary.js';
import { WORKER_NODE_SELECTOR } from '../../../src/lib/deploy/k8s/node-roles.js';
import { hostStateFromNode } from '../../../src/lib/host-state.js';
import { sshKubectl as defaultSshKubectl, sshRun as defaultSshRun } from '../../../src/lib/ssh.js';
import type { VerificationResult } from '../scenarios/types.js';
import { runCli as defaultRunCli, runUpdate as defaultRunUpdate } from '../utils/cli-runner.js';
import { adminSignIn, apiHeaders, type CookieJar } from './app-functional.js';
import { dnsSafeFetch } from './health.js';

export const RESTART_DUE_WINDOW_MS = 90_000;
export const RESTART_CLEARED_WINDOW_MS = 120_000;
const POLL_MS = 10_000;
/** One poll interval of slack each side of the plan's own maximum. */
const DOWNTIME_SLACK_SECONDS = 30;

const MARK_COMMAND =
  "printf '*** System restart required ***\\n' > /var/run/reboot-required && " +
  "printf 'linux-image-e2e-test\\n' > /var/run/reboot-required.pkgs";

export interface RestartTarget {
  /** The name `status` and the admin endpoint report: the k8s node name, or the compose server name. */
  name: string;
  ip: string;
  /** The primary master: the only server with a kubeconfig, so every kubectl read goes through it. k8s only. */
  masterIp?: string;
  /** The name `vibecarbon update` plans the server under (src/lib/update/inventory.js). */
  planName: string;
}

type CliOut = { exitCode: number; stdout: string; stderr: string };

export interface HostRestartDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  runCli: (args: string, o: { cwd: string; timeout: number }) => Promise<CliOut>;
  runUpdate: (env: string, o: { cwd: string; timeout: number }) => Promise<CliOut>;
  signIn: (
    domain: string,
    email: string,
    password: string,
  ) => Promise<{ ok: boolean; jar?: CookieJar; error?: string }>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  sshRun: (ip: string, key: string, argv: string[], o?: { timeout?: number }) => Promise<string>;
  sshKubectl: (
    ip: string,
    key: string,
    argv: string[],
    o?: { timeout?: number },
  ) => Promise<string>;
}

const realDeps = (): HostRestartDeps => ({
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  runCli: defaultRunCli,
  runUpdate: (env, o) => defaultRunUpdate(env, o),
  signIn: async (domain, email, password) => {
    const { result, jar } = await adminSignIn(domain, email, password);
    return result.status === 'pass'
      ? { ok: true, jar }
      : { ok: false, error: result.errorMessage ?? 'admin sign-in failed' };
  },
  fetch: dnsSafeFetch,
  sshRun: defaultSshRun,
  sshKubectl: defaultSshKubectl,
});

const isK8s = (mode: string) => mode.startsWith('k8s');

/**
 * The server to mark. Compose and compose-ha: the primary. k8s and k8s-ha: the
 * first worker of the primary cluster, found by label.
 */
export async function selectRestartTarget(o: {
  mode: string;
  env: string;
  envConfig: object;
  key: string;
  sshKubectl?: HostRestartDeps['sshKubectl'];
}): Promise<RestartTarget> {
  const primary = resolvePrimary(o.envConfig, { env: o.env });
  if (!primary?.ip) throw new Error(`update: no primary server recorded for ${o.env}`);
  if (!isK8s(o.mode)) {
    const entry = primary.entry as { name?: string } | undefined;
    // inventory.js plans a compose server as `name ?? 'master'`; status names
    // it `name || ip`.
    return {
      name: entry?.name || primary.ip,
      ip: primary.ip,
      planName: entry?.name ?? 'master',
    };
  }
  const kubectl = o.sshKubectl ?? defaultSshKubectl;
  const out = await kubectl(
    primary.ip,
    o.key,
    ['get', 'nodes', '-l', WORKER_NODE_SELECTOR, '-o', 'json'],
    { timeout: 30_000 },
  );
  const items: Array<{
    metadata?: { name?: string };
    status?: { addresses?: Array<{ type: string; address: string }> };
  }> = JSON.parse(out).items ?? [];
  for (const n of items) {
    const ip = n.status?.addresses?.find((a) => a.type === 'ExternalIP')?.address;
    if (n.metadata?.name && ip) {
      return { name: n.metadata.name, ip, planName: n.metadata.name, masterIp: primary.ip };
    }
  }
  throw new Error(`update: no worker node with a public address on ${primary.ip}`);
}

/** The downtime check: measured against the plan's maximum, with one poll of slack. */
export function downtimeWithinPlan(
  measured: number | null,
  expected: { min: number; max: number } | null,
): VerificationResult {
  const checkName = 'downtime_within_plan';
  if (measured === null || measured === undefined) {
    return {
      checkName,
      status: 'fail',
      errorMessage:
        'downtime was not measured: update could not get a 2xx from the domain before its first step, ' +
        'though the app had just passed verify-status',
    };
  }
  const max = expected?.max ?? 0;
  const limit = max + DOWNTIME_SLACK_SECONDS;
  if (measured <= limit) return { checkName, status: 'pass', details: { measured, max } };
  return {
    checkName,
    status: 'fail',
    errorMessage: `measured downtime ${measured} s is over the plan's maximum of ${max} s plus ${DOWNTIME_SLACK_SECONDS} s of slack`,
  };
}

/** Polls until `probe` returns null (satisfied) or the window ends; returns the last problem. */
async function pollWindow(
  deps: HostRestartDeps,
  windowMs: number,
  probe: () => Promise<string | null>,
): Promise<string | null> {
  const deadline = deps.now() + windowMs;
  let last: string | null = null;
  for (;;) {
    try {
      last = await probe();
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (last === null) return null;
    if (deps.now() + POLL_MS > deadline) return last;
    await deps.sleep(POLL_MS);
  }
}

const verdict = (checkName: string, problem: string | null, start: number): VerificationResult =>
  problem === null
    ? { checkName, status: 'pass', responseTimeMs: Date.now() - start }
    : { checkName, status: 'fail', responseTimeMs: Date.now() - start, errorMessage: problem };

export interface HostRestartStepOptions {
  env: string;
  mode: string;
  domain: string;
  projectDir: string;
  key: string;
  target: RestartTarget;
  adminEmail?: string;
  adminPassword?: string;
  timeouts?: { updateMs?: number };
  deps?: Partial<HostRestartDeps>;
}

export async function runHostRestartStep(o: HostRestartStepOptions): Promise<VerificationResult[]> {
  const deps = { ...realDeps(), ...o.deps };
  const k8s = isK8s(o.mode);
  const t = o.target;
  const out: VerificationResult[] = [];
  const cwd = o.projectDir;

  const statusProbe =
    (want: 'due' | 'cleared'): (() => Promise<string | null>) =>
    async () => {
      const r = await deps.runCli('status -json', { cwd, timeout: 120_000 });
      if (r.exitCode !== 0) return `status exited ${r.exitCode}: ${(r.stderr || '').slice(-300)}`;
      let json: {
        environments?: Record<string, { checks?: { hostState?: unknown[] } }>;
      };
      try {
        json = JSON.parse(r.stdout);
      } catch {
        return `status -json was not JSON: ${r.stdout.slice(0, 200)}`;
      }
      const hosts = (json.environments?.[o.env]?.checks?.hostState ?? []) as Array<{
        name: string;
        reporting: boolean;
        error?: string;
        state: { rebootRequired: boolean } | null;
      }>;
      const h = hosts.find((x) => x.name === t.name);
      if (!h) return `status lists no host state for ${t.name}`;
      if (!h.reporting || !h.state)
        return `${t.name} is not reporting${h.error ? `: ${h.error}` : ''}`;
      if (want === 'due')
        return h.state.rebootRequired ? null : `status shows ${t.name} with no restart due`;
      return h.state.rebootRequired ? `status still shows ${t.name} due a restart` : null;
    };

  const adminProbe =
    (want: 'due' | 'cleared', jar: CookieJar): (() => Promise<string | null>) =>
    async () => {
      const res = await deps.fetch(`https://${o.domain}/api/v1/admin/host-maintenance`, {
        headers: apiHeaders(o.domain, jar),
      });
      if (res.status !== 200) return `GET /api/v1/admin/host-maintenance returned ${res.status}`;
      const body = (await res.json()) as {
        rebootRequired?: boolean;
        servers?: Array<{ name: string; reporting?: boolean; rebootRequired: boolean }>;
      };
      const servers = body.servers ?? [];
      // k8s names the node; compose reports one server per host, and the one
      // marked is the target.
      const due = k8s
        ? servers.find((s) => s.name === t.name)?.rebootRequired === true
        : servers.filter((s) => s.rebootRequired).length === 1 && body.rebootRequired === true;
      const anyDue = servers.some((s) => s.rebootRequired);
      if (want === 'due')
        return due ? null : `the endpoint does not list ${t.name} as due a restart`;
      if (k8s ? due : anyDue) return `the endpoint still lists ${t.name} as due a restart`;
      // Not due is not enough: a reboot wipes the compose state file, and the
      // app then lists the server as not reporting and not due. Cleared means
      // the reporter came back and says so.
      const mine = k8s
        ? servers.find((s) => s.name === t.name)
        : servers.length === 1
          ? servers[0]
          : undefined;
      if (!mine) return `the endpoint does not list ${t.name}`;
      return mine.reporting === true ? null : `${t.name} is not reporting to the endpoint yet`;
    };

  const annotationProbe =
    (want: 'due' | 'cleared'): (() => Promise<string | null>) =>
    async () => {
      const text = await deps.sshKubectl(
        t.masterIp ?? t.ip,
        o.key,
        ['get', 'node', t.name, '-o', 'json'],
        {
          timeout: 30_000,
        },
      );
      const h = hostStateFromNode(JSON.parse(text));
      if (!h.reporting || !h.state)
        return `node ${t.name} carries no readable host-state annotation`;
      if (want === 'due')
        return h.state.rebootRequired ? null : `the annotation on ${t.name} shows no restart due`;
      return h.state.rebootRequired
        ? `the annotation on ${t.name} still shows a restart due`
        : null;
    };

  const readyProbe = async (): Promise<string | null> => {
    const res = await deps.fetch(`https://${o.domain}/api/health/ready`);
    return res.status >= 200 && res.status < 300
      ? null
      : `https://${o.domain}/api/health/ready answered ${res.status}`;
  };

  const adminSession = async (): Promise<{ jar?: CookieJar; error?: string }> => {
    if (!o.adminEmail || !o.adminPassword)
      return { error: 'no admin session: ADMIN_EMAIL/ADMIN_PASSWORD not found in .env.local' };
    const r = await deps.signIn(o.domain, o.adminEmail, o.adminPassword);
    return r.ok ? { jar: r.jar } : { error: `no admin session: ${r.error}` };
  };

  // 1. Sign in before the mark, so a sign-in problem is not read as a missing report.
  const before = await adminSession();

  // 2. Mark the restart due.
  await deps.sshRun(t.ip, o.key, ['sh', '-c', MARK_COMMAND], { timeout: 30_000 });

  // 3. Every surface shows it within 90 s.
  const dueStart = Date.now();
  const checks = await Promise.all([
    pollWindow(deps, RESTART_DUE_WINDOW_MS, statusProbe('due')),
    before.jar
      ? pollWindow(deps, RESTART_DUE_WINDOW_MS, adminProbe('due', before.jar))
      : Promise.resolve(before.error as string),
    k8s ? pollWindow(deps, RESTART_DUE_WINDOW_MS, annotationProbe('due')) : Promise.resolve(null),
  ]);
  out.push(verdict('restart_due_status', checks[0], dueStart));
  out.push(verdict('restart_due_admin', checks[1], dueStart));
  if (k8s) out.push(verdict('restart_due_annotation', checks[2], dueStart));

  // 4. Run the update. It runs even when a surface missed the mark: it is what
  // takes the mark away again.
  const upStart = Date.now();
  const up = await deps.runUpdate(o.env, { cwd, timeout: o.timeouts?.updateMs ?? 45 * 60_000 });
  let plan: {
    plan?: Array<{ name: string; restart: string }>;
    skipped?: unknown[];
    expectedDowntime?: { min: number; max: number } | null;
    measuredDowntimeSeconds?: number | null;
    error?: string;
    hint?: string;
  } | null = null;
  try {
    plan = JSON.parse(up.stdout);
  } catch {
    plan = null;
  }
  let ranProblem: string | null = null;
  if (up.exitCode !== 0) {
    ranProblem = `update exited ${up.exitCode}${plan?.error ? `: ${plan.error}` : ''}${plan?.hint ? ` (${plan.hint})` : ''}${plan ? '' : `: ${(up.stderr || up.stdout).slice(-300)}`}`;
  } else if (!plan) {
    ranProblem = `update -json was not JSON: ${up.stdout.slice(0, 200)}`;
  } else if ((plan.skipped ?? []).length > 0) {
    ranProblem = `update skipped ${(plan.skipped ?? []).length} server(s): ${JSON.stringify(plan.skipped).slice(0, 300)}`;
  } else {
    const entry = plan.plan?.find((e) => e.name === t.planName);
    if (!entry) ranProblem = `the update plan has no entry for ${t.planName}`;
    else if (entry.restart !== 'due')
      ranProblem = `the update plan shows ${t.planName} restart "${entry.restart}", not "due"`;
  }
  out.push(verdict('update_ran', ranProblem, upStart));

  // 5. Every surface shows it cleared within 120 s, and the app is back.
  const after = await adminSession();
  const clearStart = Date.now();
  const cleared = await Promise.all([
    pollWindow(deps, RESTART_CLEARED_WINDOW_MS, statusProbe('cleared')),
    after.jar
      ? pollWindow(deps, RESTART_CLEARED_WINDOW_MS, adminProbe('cleared', after.jar))
      : Promise.resolve(after.error as string),
    k8s
      ? pollWindow(deps, RESTART_CLEARED_WINDOW_MS, annotationProbe('cleared'))
      : Promise.resolve(null),
    pollWindow(deps, RESTART_CLEARED_WINDOW_MS, readyProbe),
  ]);
  const labelled: Array<[string, string | null]> = [
    ['status', cleared[0]],
    ['admin', cleared[1]],
    ['annotation', cleared[2]],
    ['ready', cleared[3]],
  ];
  const problems = labelled
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([name, p]) => `${name}: ${p}`);
  out.push(verdict('restart_cleared', problems.length ? problems.join('; ') : null, clearStart));

  // 6. Downtime against the plan.
  out.push(
    plan
      ? downtimeWithinPlan(plan.measuredDowntimeSeconds ?? null, plan.expectedDowntime ?? null)
      : {
          checkName: 'downtime_within_plan',
          status: 'fail',
          errorMessage: 'update produced no result, so downtime was not measured',
        },
  );
  return out;
}
