/**
 * Every line `vibecarbon update` prints about the plan. Pure strings; copy
 * follows the CLI voice rules (lowercase facts, no dashes).
 *
 * Names, addresses, packages, versions and error text come from the servers
 * and the cluster, and a hostile server could hide terminal escapes in them.
 * Every line that carries one goes through printable(); the CLI's own words
 * hold no control characters, so filtering the whole line changes only those.
 */
import { printable } from '../printable.js';
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

/** Reasons a k8s node's address is not trusted (inventory.js, inspect.js). */
const BORROWED_ADDRESS = [
  /^the server at /,
  /^two nodes report the address /,
  /^reports the master's address /,
];

function skippedLine(envName, s) {
  const head = `${s.name} (${s.ip ?? 'no address'}): skipped, ${s.reason}.`;
  let hint = `Check the server is running, then run vibecarbon update ${envName} again`;
  if (s.reason.startsWith('could not check for updates'))
    hint = `The daily security updates may be running, so try vibecarbon update ${envName} again in a few minutes`;
  else if (s.reason === 'no public address' || s.reason === 'reports no valid public address')
    hint =
      'vibecarbon reaches servers over their public address, so this one has to be updated by hand';
  else if (BORROWED_ADDRESS.some((re) => re.test(s.reason)))
    hint =
      'Check its address in your provider console, since vibecarbon updates a node only at an address it can confirm belongs to that node';
  else if (s.reason.startsWith('no recorded address'))
    hint = `Run vibecarbon deploy ${envName} to record it before you try again`;
  return `${head} ${hint}`;
}

/** A node an interrupted run left cordoned: released once the plan is confirmed. */
const uncordonPlanLine = (name) => `uncordon ${name}, left cordoned by an interrupted update`;

/**
 * @param {import('./plan.js').UpdatePlan} plan
 * @returns {string[]}
 */
export function formatPlan(plan) {
  const lines = [`update plan for ${plan.envName} (${plan.tier})`];
  for (const u of plan.uncordon ?? []) lines.push(uncordonPlanLine(u.name));
  plan.steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.target.name} (${step.target.ip})`);
    if (stepIsIdle(step)) {
      lines.push('  nothing to do');
      return;
    }
    if (step.installReporter) lines.push('  install the restart reporter');
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
  return lines.map(printable);
}

/** @param {import('./plan.js').UpdatePlan} plan */
export function formatTotal(plan) {
  if (!plan.total) return 'no downtime expected';
  return printable(
    `expected downtime: ${formatDuration(plan.total)} in total, while ${plan.outageServers.join(', ')} restart`,
  );
}

export const nothingToDoLine = (envName) => `everything on ${envName} is up to date, nothing to do`;
export const noServersError = (envName) => `could not find any servers for ${envName}`;
export const noServersHint = (envName) =>
  `Run vibecarbon deploy ${envName} to record them before you try again`;
export const releasedLine = (names) =>
  printable(`uncordoned ${names.join(', ')}, left from an earlier update`);
export const releaseFailedLine = (name, why) =>
  printable(`could not uncordon ${name} (${why}), so it stays cordoned until the next update`);
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
  return printable(
    `${target.name} now needs a restart for ${pkg}, which the plan did not show. ${cost} Restart it now?`,
  );
}
export const unexpectedRestartYesLine = ({ envName, name, pkg }) =>
  printable(
    `a restart became due on ${name} (${pkg}): run vibecarbon update ${envName} again to restart it`,
  );
export const recheckSkippedLine = (names) =>
  printable(
    `could not re-check ${names.join(', ')} after the update, so a restart may still be due`,
  );
export const allClearLine = () => 'no reboot due on any server';
/** @param {{ envName: string, names: string[] }} input */
export const stillDueLine = ({ envName, names }) =>
  printable(
    `a restart is still due on ${names.join(', ')}, so run vibecarbon update ${envName} again`,
  );

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
  return printable(line);
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

export const stepLine = ({ name, index, total }) => printable(`${name} (${index} of ${total})`);
export const installingLine = (name, count) =>
  printable(`${name}: installing ${count} security ${count === 1 ? 'update' : 'updates'}`);
export const dockerUpdatingLine = (name) =>
  printable(`${name}: updating Docker, every container restarts`);
export const cordonedLine = (name, draining) =>
  printable(
    draining
      ? `${name}: cordoned, moving its pods to other nodes`
      : `${name}: cordoned, so no new pods start on it`,
  );
export const restartingLine = (name) => printable(`${name}: restarting`);
export const backLine = (name) => printable(`${name}: back up, waiting until it is healthy`);
export const healthyLine = (name, uncordoned) =>
  printable(uncordoned ? `${name}: healthy and uncordoned` : `${name}: healthy`);
export const noRestartAfterAllLine = (name) => printable(`${name}: no restart needed after all`);
export const noLongerDueLine = (name) => printable(`${name} no longer needs a restart`);
export const reporterFailedLine = (name, why) =>
  printable(
    `could not install the restart reporter on ${name} (${why}), so vibecarbon status may not show when it needs a restart`,
  );
export const unmarkFailedLine = (name, why) =>
  printable(`${name} is uncordoned but kept its update mark (${why}), the next update removes it`);
/** @param {number | null} status the first probe's HTTP status, null when it got no answer */
export const notMeasuredLine = (domain, status) =>
  status != null
    ? `${domain} answered ${status} before the update, so downtime is not measured`
    : `could not reach ${domain} from this machine, so downtime is not measured`;
export const rebootCallFailedLine = (name, why) =>
  printable(`${name}: the restart command failed (${why}), checking whether it restarts anyway`);
export const alreadyCordonedLine = (name) =>
  printable(`${name}: already cordoned, it stays cordoned after the restart`);

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
  return detail ? printable(detail) : 'it failed';
}

/**
 * A step that failed outright: what it tried, why, and the last output lines.
 *
 * @param {{ action: keyof typeof ACTIONS, name: string, why: string, lines?: string[] }} f
 */
export function stepFailedError({ action, name, why, lines = [] }) {
  const head = `could not ${ACTIONS[action](name)}: ${why}`;
  return printable(lines.length ? [head, ...lines.map((l) => `  ${l}`)].join('\n') : head);
}

/**
 * A wait that ran out.
 *
 * @param {{ name: string, what: 'come back' | 'become healthy', budgetMs: number, seen: string }} f
 */
export const didNotError = ({ name, what, budgetMs, seen }) =>
  printable(`${name} did not ${what} within ${formatBudget(budgetMs)}: ${seen}`);

/** The first three names, then how many more. */
function shortList(names) {
  const shown = names.slice(0, 3).map(printable).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

/** The last thing each wait saw, for didNotError. */
export const SEEN = {
  oldBootId: 'it still had the boot id from before the restart',
  noAnswer: 'it never answered',
  unreadable: 'its answer could not be read',
  sshFailed: (detail) => printable(`ssh said: ${detail}`),
  kubectlFailed: (detail) => printable(`kubectl said: ${detail}`),
  /** @param {string} answer the /readyz line the master printed */
  apiNotReady: (answer) => printable(`the cluster API answered ${answer}`),
  nodeFromBefore: 'the cluster still showed the node as it was before the restart',
  /** @param {string} reason the kubelet's Ready condition reason */
  nodeNotReady: (reason) => printable(`the node was not Ready (${reason})`),
  leaseNotRenewing: 'its kubelet did not renew its node lease',
  podsNotReady: (names) => `pods not Ready since the restart: ${shortList(names)}`,
  /** @param {string[]} names `<kind> <namespace>/<name>` of each controller */
  workloadsNotReady: (names) => `no pod Ready since the restart for ${shortList(names)}`,
  appUnhealthy: (status) => printable(`its health check never passed (last result: ${status})`),
  /** @param {{ domain: string, status: number | null, detail: string | null }} last */
  domainDown: ({ domain, status, detail }) =>
    printable(
      status != null
        ? `${domain} answered ${status}`
        : `${domain} did not answer${detail ? ` (${detail})` : ''}`,
    ),
};

export const installHint = ({ envName, name }) =>
  printable(`run vibecarbon update ${envName} again once ${name} is reachable and apt is free`);
export const cordonedHint = (envName) =>
  `it is still cordoned, run vibecarbon update ${envName} again once it is Ready, which uncordons it`;
export const consoleHint = (envName) =>
  `check it in your provider console, then run vibecarbon status ${envName}`;
export const retryHint = (envName) => `run vibecarbon update ${envName} again`;
