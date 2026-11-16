/**
 * Every line `vibecarbon update` prints about the plan. Pure strings; copy
 * follows the CLI voice rules (lowercase facts, no dashes).
 */
import { DOWNTIME, stepIsIdle } from './plan.js';

/**
 * @param {[number, number]} range seconds
 * @returns {string}
 */
export function formatDuration([min, max]) {
  if (min < 60 && max < 60) return `about ${min} to ${max} seconds`;
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
    if (step.install > 0) lines.push(`  install ${step.install} security updates`);
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
export const unexpectedRestartPrompt = ({ name, pkg }) =>
  `${name} now needs a restart for ${pkg}, which the plan did not show. The app is offline for ${formatDuration(DOWNTIME.restart)} while it restarts. Restart it now?`;
export const unexpectedRestartYesLine = ({ envName, name, pkg }) =>
  `a restart became due on ${name} (${pkg}): run vibecarbon update ${envName} again to restart it`;
export const allClearLine = () => 'no reboot due on any server';

/**
 * @param {{ name: string, installed: number, docker: { from: string, to: string } | null, restarted: boolean, offlineSeconds: number | null }} r
 */
export function summaryLine({ name, installed, docker, restarted, offlineSeconds }) {
  let line = `${name}: installed ${installed} updates`;
  if (docker) line += `, Docker ${docker.from} to ${docker.to}`;
  if (restarted) line += ', restarted';
  if (offlineSeconds != null)
    line += `, app offline ${Math.floor(offlineSeconds / 60)}m ${Math.round(offlineSeconds % 60)}s`;
  return line;
}
