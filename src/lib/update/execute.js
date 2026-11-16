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
 * Downtime is measured from this machine through the app's public readiness,
 * and only when one probe before the first step reaches it. Then a compose
 * server, and a restarted k8s master or db node, is healthy only once the
 * domain answers again too.
 *
 * The run never rejects: a prompt or a log line that throws ends it like a
 * failed step, with the outcomes so far.
 *
 * Every remote command has a timeout and a stdin that ends, so nothing can
 * wait on a prompt. Every wait runs on the injected `now` and `sleep`.
 * Copy lives in ./text.js.
 */
import { setTimeout as timerSleep } from 'node:timers/promises';
import {
  APT_DAILY_UNITS_WAIT_SECONDS,
  APT_LOCK_TIMEOUT_SECONDS,
  aptGet,
  aptQuietUpdate,
  aptWaitForDailyUnits,
} from '../deploy/apt.js';
import { waitForKubeletsRenewing } from '../deploy/k8s/kubelet-liveness.js';
import { fetchPublicDomain } from '../deploy/public-domain-probe.js';
import { hostReporterInstaller, hostReporterScript } from '../host-reporter.js';
import { mainPackage, parseHostState } from '../host-state.js';
import { DOCKER_PACKAGES, DOCKER_SOURCE_ONLY } from '../iac/docker-install.js';
import { pollUntil } from '../retry.js';
import { sshKubectl, sshRun, sshRunScript } from '../ssh.js';
import { describeSshError } from '../status/cluster-snapshot.js';
import { CORDON_MARK } from './inventory.js';
import {
  alreadyCordonedLine,
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
  noLongerDueLine,
  noRestartAfterAllLine,
  notMeasuredLine,
  rebootCallFailedLine,
  reporterFailedLine,
  restartingLine,
  retryHint,
  SEEN,
  SYSTEM_UPDATES,
  stepFailedError,
  stepLine,
  unexpectedRestartPrompt,
  unmarkFailedLine,
} from './text.js';

export { CORDON_MARK };

const REPORTER_TIMEOUT_MS = 60_000;
/** 1200 s: up to 300 s for the daily apt units to finish, then 900 s to install. */
const INSTALL_TIMEOUT_MS = (APT_DAILY_UNITS_WAIT_SECONDS + 900) * 1000;
/**
 * 900 s: up to 300 s for the daily apt units, apt's own 300 s wait for the
 * dpkg lock, then 300 s to refresh and install.
 */
const DOCKER_TIMEOUT_MS = (APT_DAILY_UNITS_WAIT_SECONDS + APT_LOCK_TIMEOUT_SECONDS + 300) * 1000;
/** From the reboot command to a new boot id over ssh. */
const COME_BACK_BUDGET_MS = 600_000;
/** Each wait after the server is back: the app, the API, the node, its lease, its pods. */
const HEALTHY_BUDGET_MS = 300_000;
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10_000;
/** OpenSSH's own exit status: ssh failed, whatever the remote command did (see ../ssh.js). */
const SSH_FAILED_STATUS = 255;
/** One short remote command: a check, a cordon, a mark. */
const QUICK_TIMEOUT_MS = 30_000;
/** kubectl drain bounds itself at 300 s (drainArgv); this is its ssh call's bound. */
const DRAIN_TIMEOUT_MS = 360_000;
const LIST_NODES_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 5000;
/** How often the compose health wait looks at the monitor's latest probe. */
const DOMAIN_CHECK_MS = 1000;
const LAST_LINES = 5;
/** stdin for every remote command: empty, closed at once, so nothing waits on it. */
const NO_STDIN = '';
const APP_READY_PATH = '/api/health/ready';

/**
 * Installs the security updates the daily job would, the same way it does,
 * once the daily apt units are done, so the two never run apt at once.
 */
export const UPGRADE_ARGV = [
  'env',
  'DEBIAN_FRONTEND=noninteractive',
  'sh',
  '-c',
  `${aptWaitForDailyUnits()}; unattended-upgrade --verbose`,
];
/**
 * The reboot starts 2 s after ssh returns, so the command itself never hangs.
 * --collect unloads the transient units even when they failed, so a later run
 * can schedule the reboot again under the same name. systemd-run already gives
 * its timers RemainAfterElapse=no; the flag only states it. It is a timer
 * setting (systemd.timer(5)), so it goes on the timer: with -p it would go to
 * the service, which refuses it.
 */
export const REBOOT_ARGV = [
  'systemd-run',
  '--on-active=2',
  '--collect',
  '--timer-property=RemainAfterElapse=no',
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
 * Both apt commands run noninteractive, after the daily apt units are done:
 * apt-get update takes the lists lock without waiting for it.
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
    `${aptWaitForDailyUnits()}; ${aptQuietUpdate(DOCKER_SOURCE_ONLY)} && ${install}`,
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
 * @typedef {{ name: string, installed: number, docker: Array<{ name: string, from: string, to: string }> | null, restarted: boolean, outageSeconds: number | null, error: string | null, hint: string | null }} StepOutcome
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

/**
 * Ready, and turned Ready at or after `sinceSeconds`. The kubelet stamps that
 * transition with the server's own clock, the same clock `sinceSeconds` was
 * read from.
 */
function readySince(pod, sinceSeconds) {
  const ready = pod?.status?.conditions?.find((c) => c.type === 'Ready');
  if (ready?.status !== 'True') return false;
  const at = Date.parse(ready.lastTransitionTime ?? '');
  return Number.isFinite(at) && at / 1000 >= sinceSeconds;
}

/**
 * When a pod's status last changed, in seconds: for a Failed pod, when it
 * failed. A pod that says nothing reads as changed long ago.
 */
function lastChangeSeconds(pod) {
  const stamps = [
    ...(pod?.status?.conditions ?? []).map((c) => c?.lastTransitionTime),
    ...(pod?.status?.containerStatuses ?? []).map((c) => c?.state?.terminated?.finishedAt),
  ]
    .map((t) => Date.parse(t ?? ''))
    .filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) / 1000 : Number.NEGATIVE_INFINITY;
}

const controllerOf = (pod) => pod?.metadata?.ownerReferences?.find((o) => o?.controller);
const controllerUid = (pod) => controllerOf(pod)?.uid;
const isJob = (ref) => ref?.kind === 'Job';
const podName = (pod) => `${pod?.metadata?.namespace}/${pod?.metadata?.name}`;

/**
 * Where a pod on the restarted node stands: 'back', 'waiting' for Ready, or
 * 'replace' when it turned Failed after the restart, which only a replacement
 * that is Ready can answer. A pod that Succeeded, or failed before the
 * restart, is not this restart's doing, and a Job's pod never counts.
 *
 * @returns {'back' | 'waiting' | 'replace'}
 */
function podState(pod, sinceSeconds) {
  // A Job's pod runs to an end: the Job retries it or gives up, and neither
  // says anything about the node.
  if (isJob(controllerOf(pod))) return 'back';
  const phase = pod?.status?.phase;
  if (phase === 'Succeeded') return 'back';
  if (phase === 'Failed') return lastChangeSeconds(pod) >= sinceSeconds ? 'replace' : 'back';
  return readySince(pod, sinceSeconds) ? 'back' : 'waiting';
}

/** A pod of the controller `uid` is Running and Ready since the restart. */
const hasPodBack = (uid, pods, sinceSeconds, except = null) =>
  pods.some(
    (p) =>
      (except === null || (p !== except && p?.metadata?.uid !== except.metadata?.uid)) &&
      controllerUid(p) === uid &&
      p?.status?.phase === 'Running' &&
      readySince(p, sinceSeconds),
  );

/**
 * The controllers of the pods running on a node, Jobs left out: each must
 * have a pod Ready again after the restart. A StatefulSet pod that failed is
 * deleted and recreated under the same name, and until it is bound it is on
 * no node's list, so the node's own pods alone cannot prove it came back.
 *
 * @param {object[]} pods the node's pods, read before the reboot
 * @returns {Array<{ uid: string, kind: string, name: string, namespace: string }>}
 */
function workloadsOf(pods) {
  const found = new Map();
  for (const pod of pods) {
    const phase = pod?.status?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    const ref = controllerOf(pod);
    if (!ref?.uid || isJob(ref)) continue;
    found.set(ref.uid, {
      uid: ref.uid,
      kind: ref.kind,
      name: ref.name,
      namespace: pod.metadata?.namespace,
    });
  }
  return [...found.values()];
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

/** What a failed probe ran into: the socket error's code, else the error's name. */
const probeFailure = (err) => err?.cause?.code ?? err?.code ?? err?.name ?? null;

/**
 * Probe the app's public health every `intervalMs` until stopped. A failed
 * probe or a non-2xx answer opens an outage window at the time that probe
 * started; the next 2xx closes it.
 *
 * @param {{ url: string, probe: (url: string, signal: AbortSignal) => Promise<{ status: number }>, intervalMs?: number, now: () => number, sleep: (ms: number, signal?: AbortSignal) => Promise<unknown> }} options
 * @returns {{
 *   ready: Promise<boolean>,
 *   upSince(at: number): boolean,
 *   last(): { at: number, up: boolean, status: number | null, detail: string | null } | null,
 *   stop(): { windows: Array<{ start: number, end: number }>, totalSeconds: number },
 * }}
 *   `ready` is whether the first probe answered 2xx; `upSince` whether a
 *   probe started at or after `at` did; `last` is the latest probe.
 */
export function startOutageMonitor({ url, probe, intervalMs = POLL_INTERVAL_MS, now, sleep }) {
  const controller = new AbortController();
  /** @type {Array<{ start: number, end: number }>} */
  const windows = [];
  let openedAt = null;
  let lastUpAt = null;
  /** @type {{ at: number, up: boolean, status: number | null, detail: string | null } | null} */
  let latest = null;
  let stopped = false;
  /** @type {(up: boolean) => void} */
  let settleReady = () => {};
  const ready = new Promise((resolve) => {
    settleReady = resolve;
  });
  const loop = async () => {
    while (!stopped) {
      const at = now();
      let status = null;
      let detail = null;
      try {
        const res = await probe(url, controller.signal);
        status = typeof res?.status === 'number' ? res.status : null;
      } catch (err) {
        detail = probeFailure(err);
      }
      if (stopped) return;
      const up = status !== null && status >= 200 && status < 300;
      latest = { at, up, status, detail };
      settleReady(up);
      if (up) lastUpAt = at;
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
    ready,
    upSince: (at) => lastUpAt !== null && lastUpAt >= at,
    last: () => (latest ? { ...latest } : null),
    stop() {
      if (!stopped) {
        stopped = true;
        controller.abort();
        settleReady(false);
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
 * Uncordon the nodes the confirmed plan listed as left cordoned by an earlier,
 * interrupted `update`, and remove the mark. Each cluster is read again first,
 * so only a node that still carries CORDON_MARK is touched, and one that is no
 * longer Ready stays cordoned. A failure leaves the node marked, so the next
 * run tries again.
 *
 * @param {import('./inventory.js').Leftover[]} leftovers
 * @param {{ sshKubectl?: Function, sshKeyPath: string }} deps
 * @returns {Promise<{ released: string[], failed: Array<{ name: string, reason: string }> }>}
 */
export async function releaseLeftoverCordons(leftovers, deps) {
  const kubectl = deps.sshKubectl ?? sshKubectl;
  const key = deps.sshKeyPath;
  const opts = { timeout: QUICK_TIMEOUT_MS, input: NO_STDIN };
  const released = [];
  const failed = [];
  const kubectlSaid = (err) =>
    err instanceof SyntaxError ? SEEN.unreadable : SEEN.kubectlFailed(oneLine(err));
  const byMaster = Map.groupBy(leftovers, (l) => l.masterIp);
  for (const [ip, planned] of byMaster) {
    let nodes;
    try {
      const out = await kubectl(ip, key, ['get', 'nodes', '-o', 'json'], {
        ...opts,
        timeout: LIST_NODES_TIMEOUT_MS,
      });
      nodes = JSON.parse(out).items ?? [];
    } catch (err) {
      for (const { name } of planned) failed.push({ name, reason: kubectlSaid(err) });
      continue;
    }
    for (const { name } of planned) {
      const node = nodes.find((n) => n?.metadata?.name === name);
      // Gone, or no longer marked: not this run's to release.
      if (!node || !(CORDON_MARK in (node.metadata?.annotations ?? {}))) continue;
      if (!isReady(node)) {
        failed.push({ name, reason: 'it is not Ready' });
        continue;
      }
      try {
        await kubectl(ip, key, uncordonArgv(name), opts);
      } catch (err) {
        failed.push({ name, reason: kubectlSaid(err) });
        continue;
      }
      released.push(name);
      try {
        await kubectl(ip, key, unmarkArgv(name), opts);
      } catch {
        // Uncordoned, still marked: the next run lists it and removes the mark.
      }
    }
  }
  return { released, failed };
}

function fail(outcome, error, hint) {
  outcome.error = error;
  outcome.hint = hint;
  return outcome;
}

/** @returns {StepOutcome} */
const newOutcome = (name) => ({
  name,
  installed: 0,
  docker: null,
  restarted: false,
  outageSeconds: null,
  error: null,
  hint: null,
});

const thrownMessage = (err) => (err instanceof Error ? err.message : String(err));

/**
 * @param {import('./plan.js').UpdatePlan} plan
 * @param {ExecuteContext} ctx
 * @param {Partial<ExecuteDeps>} [deps]
 * @returns {Promise<{ outcomes: StepOutcome[], becameDue: Array<{ name: string, package: string }>, stoppedAt: StepOutcome | null }>}
 *   Never rejects: a prompt or a log line that throws stops the run at that
 *   step, with the thrown message as its error.
 */
export async function executeUpdatePlan(plan, ctx, deps = {}) {
  /** @type {ExecuteDeps} */
  const d = { ...DEFAULT_DEPS, ...deps };
  /** @type {StepOutcome[]} */
  const outcomes = [];
  const becameDue = [];
  const spans = [];
  let stoppedAt = null;
  let measured = false;
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
    // The monitor's first probe is the baseline: when this machine cannot
    // reach the app before anything changed, a window would measure this
    // machine, not the update.
    if (monitor) {
      measured = await monitor.ready;
      if (!measured) {
        const first = monitor.last();
        monitor.stop();
        ctx.log.warn(notMeasuredLine(ctx.domain, first?.status ?? null));
      }
    }
    const watch = measured ? monitor : null;
    for (const [i, step] of plan.steps.entries()) {
      const { name } = step.target;
      const outcome = newOutcome(name);
      outcomes.push(outcome);
      // Whether this run holds a cordon on the node right now.
      const live = { cordoned: false };
      const start = d.now();
      try {
        ctx.log.step(stepLine({ name, index: i + 1, total: plan.steps.length }));
        await runStep(step, outcome, { ctx, deps: d, becameDue, monitor: watch, live });
      } catch (err) {
        // A prompt or a log line threw (a cancelled prompt, a closed stdout).
        const hint = live.cordoned ? cordonedHint(ctx.envName) : retryHint(ctx.envName);
        fail(outcome, thrownMessage(err), hint);
      } finally {
        spans.push({ outcome, start, end: d.now() });
      }
      if (outcome.error) {
        stoppedAt = outcome;
        break;
      }
    }
  } catch (err) {
    // Only the baseline's warning runs outside a step: it stops the first one.
    const next = plan.steps[outcomes.length];
    if (next) {
      stoppedAt = fail(newOutcome(next.target.name), thrownMessage(err), retryHint(ctx.envName));
      outcomes.push(stoppedAt);
    }
  } finally {
    const windows = monitor ? monitor.stop().windows : [];
    for (const { outcome, start, end } of spans) {
      outcome.outageSeconds = measured ? overlapSeconds(windows, start, end) : null;
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

  let host = null;
  let checkError = null;
  try {
    host = parseHostState(
      await ssh(HOST_STATE_ARGV, { input: hostReporterScript(), timeout: QUICK_TIMEOUT_MS }),
    );
    if (!host) checkError = stepFailedError({ action: 'check', name, why: SEEN.unreadable });
  } catch (err) {
    checkError = stepFailedError({
      action: 'check',
      name,
      why: whyFailed(err, QUICK_TIMEOUT_MS),
      lines: lastLines(err),
    });
  }
  if (checkError) {
    // Docker restarted every container: the app is waited on all the same.
    if (outcome.docker && !(await appIsBack(target, outcome, run))) return outcome;
    return fail(outcome, checkError, retryHint(ctx.envName));
  }

  if (await restartNow(step, host, run)) return restartServer(step, outcome, run);
  if (outcome.docker) await appIsBack(target, outcome, run);
  return outcome;
}

/**
 * Restart when the plan said due or likely and the server still says it needs
 * one (/var/run/reboot-required, read after the install). A restart the plan
 * did not show is asked about, or with -y left for the next run.
 */
async function restartNow(step, host, run) {
  const { ctx, becameDue } = run;
  const { target } = step;
  if (step.restart === 'due') {
    if (!host.rebootRequired) ctx.log.info(noLongerDueLine(target.name));
    return host.rebootRequired;
  }
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

/**
 * compose: the app on the server answers its readiness check, then, when
 * downtime is measured, the domain answers 2xx again, all in one budget. The
 * server's own check never passes through the proxy users reach the app by.
 */
async function waitForApp(target, run) {
  const { ctx, deps, monitor } = run;
  const start = deps.now();
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
  if (!res?.healthy) return { ok: false, seen: SEEN.appUnhealthy(res?.status ?? 'none') };
  if (!monitor) return { ok: true };
  return domainAnswers(run, start + HEALTHY_BUDGET_MS);
}

/**
 * Wait until a probe that started from now on found the domain up (2xx), or
 * until `deadline`. Only runs when downtime is measured: the baseline probe
 * reached the domain before anything changed.
 *
 * @returns {Promise<{ ok: true } | { ok: false, seen: string }>}
 */
async function domainAnswers(run, deadline) {
  const { ctx, deps, monitor } = run;
  const from = deps.now();
  while (!monitor.upSince(from)) {
    const left = deadline - deps.now();
    if (left <= 0) {
      const last = monitor.last();
      const down = last && !last.up ? last : { status: null, detail: null };
      return {
        ok: false,
        seen: SEEN.domainDown({ domain: ctx.domain, status: down.status, detail: down.detail }),
      };
    }
    await deps.sleep(Math.min(DOMAIN_CHECK_MS, left));
  }
  return { ok: true };
}

/** compose: wait for the app; false when it failed the step. */
async function appIsBack(target, outcome, run) {
  const { ctx } = run;
  const app = await waitForApp(target, run);
  if (!app.ok) {
    const error = didNotError({
      name: target.name,
      what: 'become healthy',
      budgetMs: HEALTHY_BUDGET_MS,
      seen: app.seen,
    });
    fail(outcome, error, consoleHint(ctx.envName));
    return false;
  }
  ctx.log.step(healthyLine(target.name, false));
  return true;
}

/**
 * Cordon (k8s), reboot, wait for a new boot id, then wait for the server to be
 * healthy: the app on compose; on k8s the API (master), the node with its new
 * boot id and its kubelet's lease, then its pods and the controllers that had
 * pods on it. A drained worker is uncordoned after its pods are back, the
 * master and the db node before (see the release below). A failure while the
 * cordon is held leaves the node cordoned and marked, so the next run releases
 * it. A node the operator cordoned is left to them: no mark, no uncordon.
 */
async function restartServer(step, outcome, run) {
  const { ctx, deps, live } = run;
  const { target } = step;
  const { name, ip } = target;
  const key = ctx.sshKeyPath;
  const k8s = target.kind === 'k8s';
  const node = target.nodeName ?? name;
  const drained = k8s && target.role === 'worker';
  /** @type {ReturnType<typeof workloadsOf>} */
  let workloads = [];
  const ssh = (argv, opts) => deps.sshRun(ip, key, argv, { input: NO_STDIN, ...opts });
  const kubectl = (argv, opts) =>
    deps.sshKubectl(target.masterIp, key, argv, {
      input: NO_STDIN,
      timeout: QUICK_TIMEOUT_MS,
      ...opts,
    });
  const failed = (action, err, budgetMs, hint) =>
    fail(
      outcome,
      stepFailedError({ action, name, why: whyFailed(err, budgetMs), lines: lastLines(err) }),
      hint,
    );
  // While this run holds the cordon, every failure says so: the next run releases it.
  const held = () => (live.cordoned ? cordonedHint(ctx.envName) : null);
  const beforeHint = () => held() ?? retryHint(ctx.envName);
  const afterHint = () => held() ?? consoleHint(ctx.envName);

  if (k8s) {
    let current;
    try {
      current = JSON.parse(await kubectl(['get', 'node', node, '-o', 'json']));
    } catch (err) {
      return failed('cordon', err, QUICK_TIMEOUT_MS, retryHint(ctx.envName));
    }
    // Cordoned without the mark is the operator's cordon. With the mark, an
    // earlier run left it, and this run takes it over and releases it.
    if (
      current?.spec?.unschedulable === true &&
      !(CORDON_MARK in (current.metadata?.annotations ?? {}))
    ) {
      ctx.log.info(alreadyCordonedLine(name));
    } else {
      // The mark goes first: a mark on a node that is not cordoned is released
      // as a no-op, a cordon without the mark would never be released.
      try {
        await kubectl(markArgv(node));
      } catch (err) {
        return failed('mark', err, QUICK_TIMEOUT_MS, retryHint(ctx.envName));
      }
      try {
        await kubectl(cordonArgv(node));
      } catch (err) {
        return failed('cordon', err, QUICK_TIMEOUT_MS, retryHint(ctx.envName));
      }
      live.cordoned = true;
    }
    ctx.log.step(cordonedLine(name, drained));
    if (drained) {
      try {
        await kubectl(drainArgv(node), { timeout: DRAIN_TIMEOUT_MS });
      } catch (err) {
        return failed('drain', err, DRAIN_TIMEOUT_MS, beforeHint());
      }
    }
    // What runs on the node now, after the drain, is what must come back.
    try {
      workloads = workloadsOf(JSON.parse(await kubectl(nodePodsArgv(node))).items ?? []);
    } catch (err) {
      return failed('restart', err, QUICK_TIMEOUT_MS, beforeHint());
    }
  }

  // The clock is read with the boot id: pods on k8s count only from here on.
  let before;
  try {
    before = parseBoot(await ssh(BOOT_ARGV, { timeout: QUICK_TIMEOUT_MS }));
  } catch (err) {
    return failed('restart', err, QUICK_TIMEOUT_MS, beforeHint());
  }
  if (!before) {
    const error = stepFailedError({ action: 'restart', name, why: SEEN.unreadable });
    return fail(outcome, error, beforeHint());
  }
  ctx.log.step(restartingLine(name));
  try {
    await ssh(REBOOT_ARGV, { timeout: QUICK_TIMEOUT_MS, transportRetry: false });
  } catch (err) {
    // A non-zero exit of the command's own is systemd-run refusing: nothing
    // was scheduled. When ssh itself failed or timed out, the reboot may have
    // been scheduled before the session died: only the boot id can say.
    const sshFailed = err?.status === SSH_FAILED_STATUS || Boolean(err?.timedOut);
    if (!sshFailed) return failed('restart', err, QUICK_TIMEOUT_MS, beforeHint());
    ctx.log.warn(rebootCallFailedLine(name, oneLine(err)));
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
    return fail(outcome, error, afterHint());
  }
  outcome.restarted = true;
  ctx.log.step(backLine(name));
  const after = /** @type {{ bootId: string, clock: number, btime: number | null }} */ (back.value);

  if (!k8s) {
    await appIsBack(target, outcome, run);
    return outcome;
  }

  const notHealthy = (seen) =>
    fail(
      outcome,
      didNotError({ name, what: 'become healthy', budgetMs: HEALTHY_BUDGET_MS, seen }),
      afterHint(),
    );
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
    if (!api.ok) return notHealthy(api.seen);
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
  if (!nodeBack.ok) return notHealthy(nodeBack.seen);

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
  if (!leases.settled) return notHealthy(SEEN.leaseNotRenewing);

  // Releases this run's cordon; a failed release returns the failed step.
  let released = false;
  const release = async () => {
    if (!live.cordoned) return null;
    try {
      await kubectl(uncordonArgv(node));
    } catch (err) {
      return failed('uncordon', err, QUICK_TIMEOUT_MS, afterHint());
    }
    live.cordoned = false;
    released = true;
    try {
      await kubectl(unmarkArgv(node));
    } catch (err) {
      ctx.log.warn(unmarkFailedLine(name, oneLine(err)));
    }
    return null;
  };

  // A node that was not drained has its pods restart in place, and some of
  // them (Traefik, repl-gateway, the db) do not tolerate the cordon: the
  // replacement for one that failed at boot could only start once the node is
  // uncordoned. So the master and the db node are released before their pods
  // are waited on; a drained worker only after.
  if (!drained) {
    const stopped = await release();
    if (stopped) return stopped;
  }

  const since = Math.max(before.clock, after.btime ?? 0);
  const pods = await waitFor(
    () =>
      podsBack({
        node,
        workloads,
        sinceSeconds: since,
        read: (argv) => kubectl(argv, poll),
      }),
    HEALTHY_BUDGET_MS,
    kubectlSeen,
    deps,
  );
  if (!pods.ok) return notHealthy(pods.seen);

  if (drained) {
    const stopped = await release();
    if (stopped) return stopped;
  }

  // Traefik runs only on the master, and every request that needs data goes
  // to the db node: before the next server, users reach the app again, as on
  // compose. Both were uncordoned before their pod wait.
  if (run.monitor && (target.role === 'master' || target.role === 'db')) {
    const app = await domainAnswers(run, deps.now() + HEALTHY_BUDGET_MS);
    if (!app.ok) return notHealthy(app.seen);
  }
  ctx.log.step(healthyLine(name, released));
  return outcome;
}

/** The node's pods, by the node they are bound to. */
const nodePodsArgv = (node) => [
  'get',
  'pods',
  '-A',
  '--field-selector',
  `spec.nodeName=${node}`,
  '-o',
  'json',
];

/**
 * One look at whether a restarted node's pods came back.
 *
 * A pod Ready from before the restart is the API's memory, not the pod, so a
 * pod counts only when it turned Ready at or after `sinceSeconds`. The boot's
 * own start time is later than the clock read before the reboot, so it also
 * rules out a pod that turned Ready in the 2 s before the reboot.
 *
 * Three checks, cheapest first: every pod on the node is Ready since the
 * restart; every pod that turned Failed since has a Ready replacement; and
 * every controller that had a pod on the node before the reboot (`workloads`)
 * has a pod Ready since, on any node. The namespace lists the last two need
 * are read only when the node's own pods do not already prove it.
 *
 * A drained worker keeps only DaemonSet pods: the provider's CSI node plugin
 * where it has one (servicelb is disabled, so there are no svclb pods). Where
 * it has none the list is empty, and the proof is the boot id, Ready and the
 * lease. On the master and the db node the pods restart in place.
 *
 * @param {{ node: string, workloads: ReturnType<typeof workloadsOf>, sinceSeconds: number, read: (argv: string[]) => Promise<string> }} input
 * @returns {Promise<{ done: boolean, seen?: string }>}
 */
async function podsBack({ node, workloads, sinceSeconds, read }) {
  const items = JSON.parse(await read(nodePodsArgv(node))).items ?? [];
  const waiting = items.filter((p) => podState(p, sinceSeconds) === 'waiting');
  if (waiting.length) return { done: false, seen: SEEN.podsNotReady(waiting.map(podName)) };

  const lists = new Map();
  const namespacePods = async (ns) => {
    if (!lists.has(ns))
      lists.set(ns, JSON.parse(await read(['get', 'pods', '-n', ns, '-o', 'json'])).items ?? []);
    return lists.get(ns);
  };

  const unreplaced = [];
  for (const pod of items.filter((p) => podState(p, sinceSeconds) === 'replace')) {
    const uid = controllerUid(pod);
    const ns = pod.metadata?.namespace;
    if (!uid || !hasPodBack(uid, await namespacePods(ns), sinceSeconds, pod)) unreplaced.push(pod);
  }
  if (unreplaced.length) return { done: false, seen: SEEN.podsNotReady(unreplaced.map(podName)) };

  const missing = [];
  for (const w of workloads) {
    if (hasPodBack(w.uid, items, sinceSeconds)) continue;
    if (!hasPodBack(w.uid, await namespacePods(w.namespace), sinceSeconds))
      missing.push(`${w.kind} ${w.namespace}/${w.name}`);
  }
  return missing.length ? { done: false, seen: SEEN.workloadsNotReady(missing) } : { done: true };
}
