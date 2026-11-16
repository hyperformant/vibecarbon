/**
 * Runs an update plan, one server at a time, in the plan's order: install the
 * host reporter, install Ubuntu's security updates, update Docker on compose,
 * then restart when the server needs it. A restart on k8s cordons first
 * (drains a worker), reboots, waits for proof the server is back, then
 * uncordons. The run stops at the first step that fails and touches no later
 * server.
 *
 * Every wait is bounded and proves freshness instead of trusting what the
 * cluster API says: for about 40 s after a reboot the API still shows the node
 * and its pods Ready from before it (see kubelet-liveness.js). So a node counts
 * as back only when it reports the boot id the server itself gave over ssh,
 * and a pod only when its Ready condition turned True after the restart.
 *
 * Every remote command has a timeout and a stdin that ends, so nothing can
 * wait on a prompt. Every wait runs on the injected `now` and `sleep`.
 * Copy lives in ./text.js.
 */
import { setTimeout as timerSleep } from 'node:timers/promises';
import { APT_LOCK_TIMEOUT_SECONDS, aptGet, aptQuietUpdate } from '../deploy/apt.js';
import { waitForKubeletsRenewing } from '../deploy/k8s/kubelet-liveness.js';
import { fetchPublicDomain } from '../deploy/public-domain-probe.js';
import { hostReporterInstaller, hostReporterScript } from '../host-reporter.js';
import { mainPackage, parseHostState } from '../host-state.js';
import { DOCKER_PACKAGES, DOCKER_SOURCE_ONLY } from '../iac/docker-install.js';
import { pollUntil } from '../retry.js';
import { sshKubectl, sshRun, sshRunScript } from '../ssh.js';
import { describeSshError } from '../status/cluster-snapshot.js';
import {
  backLine,
  consoleHint,
  cordonedHint,
  cordonedLine,
  didNotError,
  dockerUpdatingLine,
  failureWhy,
  healthyLine,
  installHint,
  installingLine,
  noRestartAfterAllLine,
  reporterFailedLine,
  restartingLine,
  retryHint,
  SEEN,
  SYSTEM_UPDATES,
  stepFailedError,
  stepLine,
  unexpectedRestartPrompt,
  unmarkedCordonHint,
  unmarkFailedLine,
} from './text.js';

/** The annotation `update` puts on a node it cordons, so a later run can release it. */
export const CORDON_MARK = 'vibecarbon.dev/cordoned-by-update';

const REPORTER_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 1_200_000;
/** 600 s: apt's own 300 s wait for the dpkg lock, then 300 s to refresh and install. */
const DOCKER_TIMEOUT_MS = (APT_LOCK_TIMEOUT_SECONDS + 300) * 1000;
/** From the reboot command to a new boot id over ssh. */
const COME_BACK_BUDGET_MS = 600_000;
/** Each wait after the server is back: the app, the API, the node, its lease, its pods. */
const HEALTHY_BUDGET_MS = 300_000;
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10_000;
/** One short remote command: a check, a cordon, a mark. */
const QUICK_TIMEOUT_MS = 30_000;
/** kubectl drain bounds itself at 300 s (drainArgv); this is its ssh call's bound. */
const DRAIN_TIMEOUT_MS = 360_000;
const LIST_NODES_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 5000;
const LAST_LINES = 5;
/** stdin for every remote command: empty, closed at once, so nothing waits on it. */
const NO_STDIN = '';
const APP_READY_PATH = '/api/health/ready';

/** Installs the security updates the daily job would, the same way it does. */
export const UPGRADE_ARGV = [
  'env',
  'DEBIAN_FRONTEND=noninteractive',
  'unattended-upgrade',
  '--verbose',
];
/** The reboot starts 2 s after ssh returns, so the command itself never hangs. */
export const REBOOT_ARGV = [
  'systemd-run',
  '--on-active=2',
  '--unit=vibecarbon-update-reboot',
  'systemctl',
  'reboot',
];
/** The reporter in --print mode reads the restart state; its script is the input. */
const HOST_STATE_ARGV = ['sh', '-s', '--', '--print'];
/** Boot id, the server's clock and the boot's start, in seconds, from one call. */
const BOOT_ARGV = [
  'sh',
  '-c',
  "cat /proc/sys/kernel/random/boot_id && date -u +%s && sed -n 's/^btime //p' /proc/stat",
];

/**
 * Docker's own packages, upgraded from Docker's own source only (the refresh
 * reads docker.list alone), keeping any config file the operator changed.
 * Both apt commands run noninteractive.
 *
 * @returns {string[]}
 */
export function dockerUpdateArgv() {
  const install = aptGet(
    `install -y --only-upgrade -o Dpkg::Options::=--force-confold ${DOCKER_PACKAGES.join(' ')}`,
  );
  return [
    'env',
    'DEBIAN_FRONTEND=noninteractive',
    'sh',
    '-c',
    `${aptQuietUpdate(DOCKER_SOURCE_ONLY)} && ${install}`,
  ];
}

export const cordonArgv = (node) => ['cordon', node];
export const markArgv = (node) => ['annotate', 'node', node, `${CORDON_MARK}=true`, '--overwrite'];
export const drainArgv = (node) => [
  'drain',
  node,
  '--ignore-daemonsets',
  '--delete-emptydir-data',
  '--timeout=300s',
];
export const uncordonArgv = (node) => ['uncordon', node];
export const unmarkArgv = (node) => ['annotate', 'node', node, `${CORDON_MARK}-`];

/**
 * @typedef {{ name: string, installed: number, docker: Array<{ name: string, from: string, to: string }> | null, restarted: boolean, outageSeconds: number, error: string | null, hint: string | null }} StepOutcome
 * @typedef {{ envName: string, sshKeyPath: string, domain: string | null, projectName: string, yes: boolean, confirm: (message: string) => Promise<boolean>, log: { step: (m: string) => void, info: (m: string) => void, warn: (m: string) => void } }} ExecuteContext
 * @typedef {{ sshRun: Function, sshRunScript: Function, sshKubectl: Function, verifyAppHealth: Function, fetchPublicDomain: Function, now: () => number, sleep: (ms: number, signal?: AbortSignal) => Promise<unknown> }} ExecuteDeps
 */

/** @type {ExecuteDeps} */
const DEFAULT_DEPS = {
  sshRun,
  sshRunScript,
  sshKubectl,
  // Loaded on first use: the compose deploy module is large and only compose needs it.
  verifyAppHealth: async (...args) =>
    (await import('../deploy/compose/index.js')).verifyAppHealth(...args),
  fetchPublicDomain,
  now: Date.now,
  sleep: (ms, signal) => timerSleep(ms, undefined, signal ? { signal } : undefined),
};

/** One line saying why a remote call failed, never the ssh argv. */
function oneLine(err) {
  if (err instanceof SyntaxError) return SEEN.unreadable;
  const line = describeSshError(err);
  if (!line.startsWith('Command failed:')) return line;
  return failureWhy({ status: typeof err?.status === 'number' ? err.status : null });
}

/** Why a command failed, for stepFailedError. */
function whyFailed(err, budgetMs) {
  const status = typeof err?.status === 'number' ? err.status : null;
  if (err?.timedOut || status !== null)
    return failureWhy({ timedOut: err?.timedOut, status, budgetMs });
  return failureWhy({ detail: oneLine(err) });
}

/** The last non-empty lines a failed command printed, stdout then stderr. */
function lastLines(err) {
  return [err?.stdout, err?.stderr]
    .filter((s) => typeof s === 'string')
    .join('\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-LAST_LINES);
}

/** How many packages unattended-upgrade said it upgraded; the plan's count if it did not say. */
function countUpgraded(out, planned) {
  const text = String(out ?? '');
  const m = text.match(/^Packages that will be upgraded:[ \t]*(.*)$/m);
  if (m) return m[1].split(/\s+/).filter(Boolean).length;
  if (/No packages found that can be upgraded unattended/.test(text)) return 0;
  return planned;
}

/** @returns {{ bootId: string, clock: number, btime: number | null } | null} */
function parseBoot(out) {
  const [bootId = '', clock, btime] = String(out ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const at = Number(clock);
  if (!/^[0-9a-f-]{8,}$/i.test(bootId) || !Number.isFinite(at)) return null;
  const booted = Number(btime);
  return { bootId, clock: at, btime: Number.isFinite(booted) ? booted : null };
}

const isReady = (obj) =>
  obj?.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false;

/** Pods that finished never come back Ready; their controllers replace them. */
const FINISHED_PHASES = new Set(['Succeeded', 'Failed']);

/**
 * A pod is back when it is Ready and turned Ready at or after `sinceSeconds`.
 * The kubelet stamps that transition with the server's own clock, the same
 * clock `sinceSeconds` was read from.
 */
function podIsBack(pod, sinceSeconds) {
  if (FINISHED_PHASES.has(pod?.status?.phase)) return true;
  const ready = pod?.status?.conditions?.find((c) => c.type === 'Ready');
  if (ready?.status !== 'True') return false;
  const at = Date.parse(ready.lastTransitionTime ?? '');
  return Number.isFinite(at) && at / 1000 >= sinceSeconds;
}

/**
 * Poll `probe` every 5 s until it reports done or the budget runs out.
 *
 * @param {() => Promise<{ done: boolean, value?: unknown, seen?: string }>} probe
 * @param {number} budgetMs
 * @param {(err: unknown) => string} onError what a failed probe saw
 * @param {ExecuteDeps} deps
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, seen: string }>}
 */
async function waitFor(probe, budgetMs, onError, deps) {
  let seen = SEEN.noAnswer;
  let value;
  try {
    await pollUntil(
      async () => {
        try {
          const r = await probe();
          if (r.done) {
            value = r.value;
            return true;
          }
          seen = r.seen ?? seen;
        } catch (err) {
          seen = onError(err);
        }
        return false;
      },
      {
        budgetMs,
        initialDelayMs: POLL_INTERVAL_MS,
        maxDelayMs: POLL_INTERVAL_MS,
        backoffFactor: 1,
        now: deps.now,
        sleep: deps.sleep,
      },
    );
    return { ok: true, value };
  } catch {
    return { ok: false, seen };
  }
}

/**
 * Probe the app's public health every `intervalMs` until stopped. A failed
 * probe or a non-2xx answer opens an outage window at the time that probe
 * started; the next 2xx closes it.
 *
 * @param {{ url: string, probe: (url: string, signal: AbortSignal) => Promise<{ status: number }>, intervalMs?: number, now: () => number, sleep: (ms: number, signal?: AbortSignal) => Promise<unknown> }} options
 * @returns {{ stop(): { windows: Array<{ start: number, end: number }>, totalSeconds: number } }}
 */
export function startOutageMonitor({ url, probe, intervalMs = POLL_INTERVAL_MS, now, sleep }) {
  const controller = new AbortController();
  /** @type {Array<{ start: number, end: number }>} */
  const windows = [];
  let openedAt = null;
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      const at = now();
      let up = false;
      try {
        const res = await probe(url, controller.signal);
        up = typeof res?.status === 'number' && res.status >= 200 && res.status < 300;
      } catch {
        up = false;
      }
      if (stopped) return;
      if (!up && openedAt === null) openedAt = at;
      else if (up && openedAt !== null) {
        windows.push({ start: openedAt, end: at });
        openedAt = null;
      }
      try {
        await sleep(Math.max(0, at + intervalMs - now()), controller.signal);
      } catch {
        return;
      }
    }
  };
  loop().catch(() => {});
  return {
    stop() {
      if (!stopped) {
        stopped = true;
        controller.abort();
        if (openedAt !== null) {
          windows.push({ start: openedAt, end: now() });
          openedAt = null;
        }
      }
      const totalMs = windows.reduce((n, w) => n + (w.end - w.start), 0);
      return { windows: windows.map((w) => ({ ...w })), totalSeconds: totalMs / 1000 };
    },
  };
}

/** Seconds of the windows that fall between start and end. */
function overlapSeconds(windows, start, end) {
  const ms = windows.reduce(
    (n, w) => n + Math.max(0, Math.min(w.end, end) - Math.max(w.start, start)),
    0,
  );
  return ms / 1000;
}

/**
 * Uncordon the Ready nodes an earlier, interrupted `update` left cordoned
 * (they carry CORDON_MARK), and remove the mark. A node that is not Ready
 * stays cordoned for a later run. A cluster that cannot be read is left for
 * the plan to report, and a node whose release fails is tried again next run.
 *
 * @param {string[]} masterIps
 * @param {{ sshKubectl?: Function, sshKeyPath: string }} deps
 * @returns {Promise<string[]>} the names released
 */
export async function releaseLeftoverCordons(masterIps, deps) {
  const kubectl = deps.sshKubectl ?? sshKubectl;
  const key = deps.sshKeyPath;
  const opts = { timeout: QUICK_TIMEOUT_MS, input: NO_STDIN };
  const released = [];
  for (const ip of new Set(masterIps.filter(Boolean))) {
    let nodes;
    try {
      const out = await kubectl(ip, key, ['get', 'nodes', '-o', 'json'], {
        ...opts,
        timeout: LIST_NODES_TIMEOUT_MS,
      });
      nodes = JSON.parse(out).items ?? [];
    } catch {
      continue;
    }
    for (const node of nodes) {
      const name = node?.metadata?.name;
      if (!name || !(CORDON_MARK in (node.metadata.annotations ?? {})) || !isReady(node)) continue;
      try {
        await kubectl(ip, key, uncordonArgv(name), opts);
        await kubectl(ip, key, unmarkArgv(name), opts);
        released.push(name);
      } catch {
        // Still marked, so the next run tries again.
      }
    }
  }
  return released;
}

function fail(outcome, error, hint) {
  outcome.error = error;
  outcome.hint = hint;
  return outcome;
}

/**
 * @param {import('./plan.js').UpdatePlan} plan
 * @param {ExecuteContext} ctx
 * @param {Partial<ExecuteDeps>} [deps]
 * @returns {Promise<{ outcomes: StepOutcome[], becameDue: Array<{ name: string, package: string }>, stoppedAt: StepOutcome | null }>}
 */
export async function executeUpdatePlan(plan, ctx, deps = {}) {
  /** @type {ExecuteDeps} */
  const d = { ...DEFAULT_DEPS, ...deps };
  /** @type {StepOutcome[]} */
  const outcomes = [];
  const becameDue = [];
  const spans = [];
  let stoppedAt = null;
  // The app's public readiness, as its users reach it.
  const readyUrl = ctx.domain ? `https://${ctx.domain}/api/health/ready` : null;
  const monitor = readyUrl
    ? startOutageMonitor({
        url: readyUrl,
        probe: (url, signal) =>
          d.fetchPublicDomain(url, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
          }),
        now: d.now,
        sleep: d.sleep,
      })
    : null;
  try {
    for (const [i, step] of plan.steps.entries()) {
      const { name } = step.target;
      ctx.log.step(stepLine({ name, index: i + 1, total: plan.steps.length }));
      /** @type {StepOutcome} */
      const outcome = {
        name,
        installed: 0,
        docker: null,
        restarted: false,
        outageSeconds: 0,
        error: null,
        hint: null,
      };
      outcomes.push(outcome);
      const start = d.now();
      try {
        await runStep(step, outcome, { ctx, deps: d, becameDue });
      } finally {
        spans.push({ outcome, start, end: d.now() });
      }
      if (outcome.error) {
        stoppedAt = outcome;
        break;
      }
    }
  } finally {
    const windows = monitor ? monitor.stop().windows : [];
    for (const { outcome, start, end } of spans) {
      outcome.outageSeconds = overlapSeconds(windows, start, end);
    }
  }
  return { outcomes, becameDue, stoppedAt };
}

/**
 * One server: reporter, Ubuntu updates, Docker, the restart check, then the
 * restart or the health wait a Docker update needs.
 */
async function runStep(step, outcome, run) {
  const { ctx, deps } = run;
  const { target } = step;
  const { name, ip } = target;
  const key = ctx.sshKeyPath;
  const ssh = (argv, opts) => deps.sshRun(ip, key, argv, { input: NO_STDIN, ...opts });

  try {
    await deps.sshRunScript(ip, key, hostReporterInstaller(), {
      timeout: REPORTER_TIMEOUT_MS,
      input: NO_STDIN,
    });
  } catch (err) {
    ctx.log.warn(reporterFailedLine(name, oneLine(err)));
  }

  if (step.install > 0) {
    ctx.log.step(installingLine(name, step.install));
    try {
      const out = await ssh(UPGRADE_ARGV, { timeout: INSTALL_TIMEOUT_MS });
      outcome.installed = countUpgraded(out, step.install);
    } catch (err) {
      const error = stepFailedError({
        action: 'install',
        name,
        why: whyFailed(err, INSTALL_TIMEOUT_MS),
        lines: lastLines(err),
      });
      return fail(outcome, error, installHint({ envName: ctx.envName, name }));
    }
  }

  const dockerPackages = step.docker?.packages ?? [];
  if (dockerPackages.length > 0) {
    ctx.log.step(dockerUpdatingLine(name));
    try {
      await ssh(dockerUpdateArgv(), { timeout: DOCKER_TIMEOUT_MS });
      outcome.docker = dockerPackages;
    } catch (err) {
      const error = stepFailedError({
        action: 'docker',
        name,
        why: whyFailed(err, DOCKER_TIMEOUT_MS),
        lines: lastLines(err),
      });
      return fail(outcome, error, installHint({ envName: ctx.envName, name }));
    }
  }

  let host;
  try {
    host = parseHostState(
      await ssh(HOST_STATE_ARGV, { input: hostReporterScript(), timeout: QUICK_TIMEOUT_MS }),
    );
  } catch (err) {
    const error = stepFailedError({
      action: 'check',
      name,
      why: whyFailed(err, QUICK_TIMEOUT_MS),
      lines: lastLines(err),
    });
    return fail(outcome, error, retryHint(ctx.envName));
  }
  if (!host) {
    const error = stepFailedError({ action: 'check', name, why: SEEN.unreadable });
    return fail(outcome, error, retryHint(ctx.envName));
  }

  if (await restartNow(step, host, run)) return restartServer(step, outcome, run);

  if (outcome.docker) {
    const app = await waitForApp(target, run);
    if (!app.ok) {
      const error = didNotError({
        name,
        what: 'become healthy',
        budgetMs: HEALTHY_BUDGET_MS,
        seen: app.seen,
      });
      return fail(outcome, error, consoleHint(ctx.envName));
    }
    ctx.log.step(healthyLine(name, false));
  }
  return outcome;
}

/**
 * Restart when the plan said due, or likely and it now is. A restart the plan
 * did not show is asked about, or with -y left for the next run.
 */
async function restartNow(step, host, run) {
  const { ctx, becameDue } = run;
  const { target } = step;
  if (step.restart === 'due') return true;
  if (step.restart === 'likely') {
    if (!host.rebootRequired) ctx.log.info(noRestartAfterAllLine(target.name));
    return host.rebootRequired;
  }
  if (!host.rebootRequired) return false;
  const pkg = mainPackage(host.packages) ?? SYSTEM_UPDATES;
  if (!ctx.yes && (await ctx.confirm(unexpectedRestartPrompt({ target, pkg })))) return true;
  becameDue.push({ name: target.name, package: pkg });
  return false;
}

/** compose: the app on the server answers its readiness check. */
async function waitForApp(target, run) {
  const { ctx, deps } = run;
  let res;
  try {
    res = await deps.verifyAppHealth(target.ip, ctx.sshKeyPath, ctx.projectName, {
      domain: ctx.domain,
      budgetMs: HEALTHY_BUDGET_MS,
      path: APP_READY_PATH,
    });
  } catch (err) {
    return { ok: false, seen: SEEN.sshFailed(oneLine(err)) };
  }
  if (res?.healthy) return { ok: true };
  return { ok: false, seen: SEEN.appUnhealthy(res?.status ?? 'none') };
}

/**
 * Cordon (k8s), reboot, wait for a new boot id, then wait for the server to be
 * healthy: the app on compose; on k8s the API (master), the node with its new
 * boot id, its kubelet's lease and its pods, then uncordon. A failure after the
 * cordon leaves the node cordoned and marked, so the next run releases it.
 */
async function restartServer(step, outcome, run) {
  const { ctx, deps } = run;
  const { target } = step;
  const { name, ip } = target;
  const key = ctx.sshKeyPath;
  const k8s = target.kind === 'k8s';
  const node = target.nodeName ?? name;
  const ssh = (argv, opts) => deps.sshRun(ip, key, argv, { input: NO_STDIN, ...opts });
  const kubectl = (argv, opts) =>
    deps.sshKubectl(target.masterIp, key, argv, {
      input: NO_STDIN,
      timeout: QUICK_TIMEOUT_MS,
      ...opts,
    });
  const stillCordoned = cordonedHint(ctx.envName);
  const failed = (action, err, budgetMs, hint) =>
    fail(
      outcome,
      stepFailedError({ action, name, why: whyFailed(err, budgetMs), lines: lastLines(err) }),
      hint,
    );

  if (k8s) {
    try {
      await kubectl(cordonArgv(node));
    } catch (err) {
      return failed('cordon', err, QUICK_TIMEOUT_MS, retryHint(ctx.envName));
    }
    try {
      await kubectl(markArgv(node));
    } catch (err) {
      // Unmarked, the next run would not release it, so release it now.
      let released = true;
      try {
        await kubectl(uncordonArgv(node));
      } catch {
        released = false;
      }
      return failed(
        'mark',
        err,
        QUICK_TIMEOUT_MS,
        released ? retryHint(ctx.envName) : unmarkedCordonHint(node),
      );
    }
    const draining = target.role === 'worker';
    ctx.log.step(cordonedLine(name, draining));
    if (draining) {
      try {
        await kubectl(drainArgv(node), { timeout: DRAIN_TIMEOUT_MS });
      } catch (err) {
        return failed('drain', err, DRAIN_TIMEOUT_MS, stillCordoned);
      }
    }
  }

  // The clock is read with the boot id: pods on k8s count only from here on.
  let before;
  try {
    before = parseBoot(await ssh(BOOT_ARGV, { timeout: QUICK_TIMEOUT_MS }));
  } catch (err) {
    return failed('restart', err, QUICK_TIMEOUT_MS, k8s ? stillCordoned : retryHint(ctx.envName));
  }
  if (!before) {
    const error = stepFailedError({ action: 'restart', name, why: SEEN.unreadable });
    return fail(outcome, error, k8s ? stillCordoned : retryHint(ctx.envName));
  }
  ctx.log.step(restartingLine(name));
  try {
    await ssh(REBOOT_ARGV, { timeout: QUICK_TIMEOUT_MS });
  } catch (err) {
    // ssh may have failed after the reboot was scheduled, so its state is unknown.
    return failed('restart', err, QUICK_TIMEOUT_MS, k8s ? stillCordoned : consoleHint(ctx.envName));
  }

  const back = await waitFor(
    async () => {
      const now = parseBoot(
        await ssh(BOOT_ARGV, { timeout: POLL_TIMEOUT_MS, transportRetry: false }),
      );
      if (!now) return { done: false, seen: SEEN.unreadable };
      if (now.bootId === before.bootId) return { done: false, seen: SEEN.oldBootId };
      return { done: true, value: now };
    },
    COME_BACK_BUDGET_MS,
    (err) => SEEN.sshFailed(oneLine(err)),
    deps,
  );
  if (!back.ok) {
    const error = didNotError({
      name,
      what: 'come back',
      budgetMs: COME_BACK_BUDGET_MS,
      seen: back.seen,
    });
    return fail(outcome, error, k8s ? stillCordoned : consoleHint(ctx.envName));
  }
  outcome.restarted = true;
  ctx.log.step(backLine(name));
  const after = /** @type {{ bootId: string, clock: number, btime: number | null }} */ (back.value);

  const notHealthy = (seen, hint) =>
    fail(
      outcome,
      didNotError({ name, what: 'become healthy', budgetMs: HEALTHY_BUDGET_MS, seen }),
      hint,
    );

  if (!k8s) {
    const app = await waitForApp(target, run);
    if (!app.ok) return notHealthy(app.seen, consoleHint(ctx.envName));
    ctx.log.step(healthyLine(name, false));
    return outcome;
  }

  const poll = { timeout: POLL_TIMEOUT_MS, transportRetry: false };
  const kubectlSeen = (err) =>
    err instanceof SyntaxError ? SEEN.unreadable : SEEN.kubectlFailed(oneLine(err));

  if (target.role === 'master') {
    const api = await waitFor(
      async () => {
        const out = String(await kubectl(['get', '--raw', '/readyz'], poll)).trim();
        return out === 'ok'
          ? { done: true }
          : { done: false, seen: SEEN.apiNotReady(out.split('\n')[0]) };
      },
      HEALTHY_BUDGET_MS,
      kubectlSeen,
      deps,
    );
    if (!api.ok) return notHealthy(api.seen, stillCordoned);
  }

  // Ready means nothing until the node reports the boot id the server gave.
  const nodeBack = await waitFor(
    async () => {
      const n = JSON.parse(await kubectl(['get', 'node', node, '-o', 'json'], poll));
      if (n?.status?.nodeInfo?.bootID !== after.bootId)
        return { done: false, seen: SEEN.nodeFromBefore };
      const ready = n.status.conditions?.find((c) => c.type === 'Ready');
      if (ready?.status !== 'True')
        return { done: false, seen: SEEN.nodeNotReady(ready?.reason || 'Unknown') };
      return { done: true };
    },
    HEALTHY_BUDGET_MS,
    kubectlSeen,
    deps,
  );
  if (!nodeBack.ok) return notHealthy(nodeBack.seen, stillCordoned);

  const leases = await waitForKubeletsRenewing({
    readLeases: () =>
      kubectl(
        [
          'get',
          'leases',
          '-n',
          'kube-node-lease',
          '--field-selector',
          `metadata.name=${node}`,
          '-o',
          'json',
        ],
        poll,
      ),
    budgetMs: HEALTHY_BUDGET_MS,
    now: deps.now,
    sleep: deps.sleep,
  });
  if (!leases.settled) return notHealthy(SEEN.leaseNotRenewing, stillCordoned);

  // A pod Ready from before the restart is the API's memory, not the pod. The
  // boot's own start time is later than the clock read before the reboot, so
  // it also rules out a pod that turned Ready in the 2 s before the reboot.
  const since = Math.max(before.clock, after.btime ?? 0);
  const pods = await waitFor(
    async () => {
      const out = await kubectl(
        ['get', 'pods', '-A', '--field-selector', `spec.nodeName=${node}`, '-o', 'json'],
        poll,
      );
      const waiting = (JSON.parse(out).items ?? [])
        .filter((p) => !podIsBack(p, since))
        .map((p) => `${p.metadata?.namespace}/${p.metadata?.name}`);
      return waiting.length ? { done: false, seen: SEEN.podsNotReady(waiting) } : { done: true };
    },
    HEALTHY_BUDGET_MS,
    kubectlSeen,
    deps,
  );
  if (!pods.ok) return notHealthy(pods.seen, stillCordoned);

  try {
    await kubectl(uncordonArgv(node));
  } catch (err) {
    return failed('uncordon', err, QUICK_TIMEOUT_MS, stillCordoned);
  }
  try {
    await kubectl(unmarkArgv(node));
  } catch (err) {
    ctx.log.warn(unmarkFailedLine(name, oneLine(err)));
  }
  ctx.log.step(healthyLine(name, true));
  return outcome;
}
