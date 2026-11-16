/**
 * Every line `vibecarbon update` prints about the plan. Pure strings; copy
 * follows the CLI voice rules (lowercase facts, no dashes).
 */
import { DOWNTIME, decideEffect, stepIsIdle } from './plan.js';

/**
 * @param {[number, number]} range seconds
 * @returns {string}
 */
export function formatDuration([min, max]) {
  if (min < 60) return `about ${min} to ${max} seconds`;
  const lo = Math.ceil(min / 60);
  const hi = Math.ceil(max / 60);
  return lo === hi ? `about ${lo} minutes` : `about ${lo} to ${hi} minutes`;
}

function noticeLine(step) {
  const { effect, target } = step;
  switch (effect.kind) {
    case 'no-traffic':
      return 'users notice: nothing, this side takes no traffic';
    case 'drained':
      return 'users notice: nothing, the node is drained first and the app keeps running elsewhere';
    case 'app-offline': {
      const d = formatDuration(effect.seconds);
      return target.role === 'master'
        ? `users notice: the app is offline for ${d}, Traefik runs only on the master`
        : `users notice: the app is offline for ${d}`;
    }
    case 'db-offline':
      return `users notice: requests that need the database fail for ${formatDuration(effect.seconds)}`;
    default:
      return 'users notice: nothing';
  }
}

function skippedLine(envName, s) {
  const head = `${s.name} (${s.ip ?? 'no address'}): skipped, ${s.reason}.`;
  let hint = `Check the server is running, then run vibecarbon update ${envName} again`;
  if (s.reason.startsWith('could not check for updates'))
    hint = `The daily security updates may be running, so try vibecarbon update ${envName} again in a few minutes`;
  else if (s.reason === 'no public address')
    hint =
      'vibecarbon reaches servers over their public address, so this one has to be updated by hand';
  return `${head} ${hint}`;
}

/**
 * @param {import('./plan.js').UpdatePlan} plan
 * @returns {string[]}
 */
export function formatPlan(plan) {
  const lines = [`update plan for ${plan.envName} (${plan.tier})`];
  plan.steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.target.name} (${step.target.ip})`);
    if (stepIsIdle(step)) {
      lines.push('  nothing to do');
      return;
    }
    if (step.install > 0)
      lines.push(`  install ${step.install} security ${step.install === 1 ? 'update' : 'updates'}`);
    if (step.docker?.packages.length)
      lines.push(
        `  update Docker: ${step.docker.packages.map((p) => `${p.name} ${p.from} to ${p.to}`).join(', ')}`,
      );
    if (step.restart === 'due') lines.push(`  restart: due (${step.restartReason})`);
    else if (step.restart === 'likely')
      lines.push(`  restart: likely (${step.restartReason} is waiting to install)`);
    else lines.push('  no restart expected');
    lines.push(`  ${noticeLine(step)}`);
  });
  for (const s of plan.skipped) lines.push(skippedLine(plan.envName, s));
  return lines;
}

/** @param {import('./plan.js').UpdatePlan} plan */
export function formatTotal(plan) {
  if (!plan.total) return 'no downtime expected';
  return `expected downtime: ${formatDuration(plan.total)} in total, while ${plan.outageServers.join(', ')} restart`;
}

export const nothingToDoLine = (envName) => `everything on ${envName} is up to date, nothing to do`;
export const confirmQuestion = (envName) => `Update ${envName} now?`;
/**
 * @param {{ target: import('./inventory.js').UpdateTarget, pkg: string }} input
 */
export function unexpectedRestartPrompt({ target, pkg }) {
  const effect = decideEffect(target, 0, false, 'due');
  const d = formatDuration(DOWNTIME.restart);
  let cost = `The app is offline for ${d} while it restarts.`;
  if (effect.kind === 'no-traffic') cost = 'Users notice nothing: this side takes no traffic.';
  else if (effect.kind === 'drained')
    cost = 'Users notice nothing: the node is drained first and the app keeps running elsewhere.';
  else if (effect.kind === 'db-offline')
    cost = `Requests that need the database fail for ${d} while it restarts.`;
  else if (target.role === 'master')
    cost = `The app is offline for ${d} while it restarts, since Traefik runs only on the master.`;
  return `${target.name} now needs a restart for ${pkg}, which the plan did not show. ${cost} Restart it now?`;
}
export const unexpectedRestartYesLine = ({ envName, name, pkg }) =>
  `a restart became due on ${name} (${pkg}): run vibecarbon update ${envName} again to restart it`;
export const allClearLine = () => 'no reboot due on any server';

/**
 * @param {{ name: string, installed: number, docker: { from: string, to: string } | null, restarted: boolean, offlineSeconds: number | null }} r
 *   offlineSeconds is null when downtime was not measured; the line then leaves it out.
 */
export function summaryLine({ name, installed, docker, restarted, offlineSeconds }) {
  let line = `${name}: installed ${installed} updates`;
  if (docker) line += `, Docker ${docker.from} to ${docker.to}`;
  if (restarted) line += ', restarted';
  if (offlineSeconds != null)
    line += `, app offline ${Math.floor(Math.round(offlineSeconds) / 60)}m ${Math.round(offlineSeconds) % 60}s`;
  return line;
}

// Execution: progress lines, errors and hints for src/lib/update/execute.js.

/** The reason a restart names when the server listed no packages. */
export const SYSTEM_UPDATES = 'system updates';

/**
 * A wait's budget in words: whole minutes when it is one, else seconds.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatBudget(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60 || s % 60 !== 0) return `${s} seconds`;
  return s === 60 ? '1 minute' : `${s / 60} minutes`;
}

export const stepLine = ({ name, index, total }) => `${name} (${index} of ${total})`;
export const installingLine = (name, count) =>
  `${name}: installing ${count} security ${count === 1 ? 'update' : 'updates'}`;
export const dockerUpdatingLine = (name) => `${name}: updating Docker, every container restarts`;
export const cordonedLine = (name, draining) =>
  draining
    ? `${name}: cordoned, moving its pods to other nodes`
    : `${name}: cordoned, so no new pods start on it`;
export const restartingLine = (name) => `${name}: restarting`;
export const backLine = (name) => `${name}: back up, waiting until it is healthy`;
export const healthyLine = (name, uncordoned) =>
  uncordoned ? `${name}: healthy and uncordoned` : `${name}: healthy`;
export const noRestartAfterAllLine = (name) => `${name}: no restart needed after all`;
export const reporterFailedLine = (name, why) =>
  `could not install the restart reporter on ${name} (${why}), so vibecarbon status may not show when it needs a restart`;
export const unmarkFailedLine = (name, why) =>
  `${name} is uncordoned but kept its update mark (${why}), the next update removes it`;
/** @param {number | null} status the first probe's HTTP status, null when it got no answer */
export const notMeasuredLine = (domain, status) =>
  status != null
    ? `${domain} answered ${status} before the update, so downtime is not measured`
    : `could not reach ${domain} from this machine, so downtime is not measured`;
export const rebootCallFailedLine = (name, why) =>
  `${name}: the restart command failed (${why}), checking whether it restarts anyway`;
export const alreadyCordonedLine = (name) =>
  `${name}: already cordoned, it stays cordoned after the restart`;

const ACTIONS = {
  install: (name) => `install the security updates on ${name}`,
  docker: (name) => `update Docker on ${name}`,
  check: (name) => `check whether ${name} needs a restart`,
  cordon: (name) => `cordon ${name}`,
  mark: (name) => `mark ${name} as cordoned by vibecarbon update`,
  drain: (name) => `drain ${name}`,
  restart: (name) => `restart ${name}`,
  uncordon: (name) => `uncordon ${name}`,
};

/**
 * Why a remote command failed, in words.
 *
 * @param {{ timedOut?: boolean, status?: number | null, budgetMs?: number, detail?: string }} f
 */
export function failureWhy({ timedOut, status, budgetMs, detail }) {
  if (timedOut && budgetMs) return `it did not finish within ${formatBudget(budgetMs)}`;
  if (typeof status === 'number') return `it exited ${status}`;
  return detail || 'it failed';
}

/**
 * A step that failed outright: what it tried, why, and the last output lines.
 *
 * @param {{ action: keyof typeof ACTIONS, name: string, why: string, lines?: string[] }} f
 */
export function stepFailedError({ action, name, why, lines = [] }) {
  const head = `could not ${ACTIONS[action](name)}: ${why}`;
  return lines.length ? [head, ...lines.map((l) => `  ${l}`)].join('\n') : head;
}

/**
 * A wait that ran out.
 *
 * @param {{ name: string, what: 'come back' | 'become healthy', budgetMs: number, seen: string }} f
 */
export const didNotError = ({ name, what, budgetMs, seen }) =>
  `${name} did not ${what} within ${formatBudget(budgetMs)}: ${seen}`;

/** The first three names, then how many more. */
function shortList(names) {
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

/** The last thing each wait saw, for didNotError. */
export const SEEN = {
  oldBootId: 'it still had the boot id from before the restart',
  noAnswer: 'it never answered',
  unreadable: 'its answer could not be read',
  sshFailed: (detail) => `ssh said: ${detail}`,
  kubectlFailed: (detail) => `kubectl said: ${detail}`,
  apiNotReady: (answer) => `the cluster API answered ${answer}`,
  nodeFromBefore: 'the cluster still showed the node as it was before the restart',
  nodeNotReady: (reason) => `the node was not Ready (${reason})`,
  leaseNotRenewing: 'its kubelet did not renew its node lease',
  podsNotReady: (names) => `pods not Ready since the restart: ${shortList(names)}`,
  /** @param {string[]} names `<kind> <namespace>/<name>` of each controller */
  workloadsNotReady: (names) => `no pod Ready since the restart for ${shortList(names)}`,
  appUnhealthy: (status) => `its health check never passed (last result: ${status})`,
  /** @param {{ domain: string, status: number | null, detail: string | null }} last */
  domainDown: ({ domain, status, detail }) =>
    status != null
      ? `${domain} answered ${status}`
      : `${domain} did not answer${detail ? ` (${detail})` : ''}`,
};

export const installHint = ({ envName, name }) =>
  `run vibecarbon update ${envName} again once ${name} is reachable and apt is free`;
export const cordonedHint = (envName) =>
  `it is still cordoned, run vibecarbon update ${envName} again once it is Ready, which uncordons it`;
export const consoleHint = (envName) =>
  `check it in your provider console, then run vibecarbon status ${envName}`;
export const retryHint = (envName) => `run vibecarbon update ${envName} again`;
