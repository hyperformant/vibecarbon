/**
 * Turns a Step or MenuItem (src/lib/next/steps.js) and a project state
 * (src/lib/next/state.js) into the lines `vibecarbon ?` prints.
 *
 * Pure formatting: reuses the same `formatExamples` renderer every other
 * command's help text uses, so a "next" example looks identical to a `-h`
 * example (gray `# comment`, cyan command name, trailing blank per group).
 * No clack, no process.exit; src/next.js does the printing.
 */

import { formatExamples } from '../cli/help.js';

/**
 * 'vibecarbon scale prod' for an envScoped command when envName is given;
 * '<name>' placeholders (e.g. deploy-another) are left as-is, never
 * substituted with envName.
 *
 * @param {string[]|null} command
 * @param {{ envName?: string|null, envScoped?: boolean }} [options]
 * @returns {string|null}
 */
export function displayCommand(command, { envName = null, envScoped = false } = {}) {
  if (!command) return null;
  const parts = envScoped && envName ? [...command, envName] : command;
  return ['vibecarbon', ...parts].join(' ');
}

/** Drop the single trailing blank line formatExamples always appends. */
function trimTrailingBlank(lines) {
  const out = [...lines];
  if (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * @param {{ any: boolean, features: string[], providers: boolean }} configured
 * @returns {string}
 */
function configuredLine({ any, features, providers }) {
  if (!any) return 'Configured services: none';
  const suffix = providers ? ' (provider credentials saved)' : '';
  const list = features.join(', ');
  return list ? `Configured: ${list}${suffix}` : `Configured:${suffix}`;
}

/**
 * 'today' / 'yesterday' / '<n> days ago', comparing calendar days so time-of-
 * day differences don't shift the bucket. A timestamp in the future (clock
 * skew, a hand-edited manifest) clamps to 'today' rather than reading
 * '-2 days ago', and an unparseable timestamp returns null so the caller can
 * drop the clause instead of printing 'NaN days ago'.
 *
 * @param {string} deployedAt
 * @param {Date} now
 * @returns {string|null}
 */
function relativeDate(deployedAt, now) {
  const deployed = new Date(deployedAt);
  if (Number.isNaN(deployed.getTime())) return null;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round(
    (startOfDay(now).getTime() - startOfDay(deployed).getTime()) / 86_400_000,
  );
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  return `${diffDays} days ago`;
}

/**
 * @param {{ name: string, deployMode: string|null, region: string|null,
 *   domain: string|null, deployedAt: string|null }} env
 * @param {Date} now
 * @returns {string}
 */
function deployedLine(env, now) {
  const parts = [env.deployMode, env.region, env.domain].filter((part) => part !== null);
  if (env.deployedAt) {
    const relative = relativeDate(env.deployedAt, now);
    if (relative) parts.push(`deployed ${relative}`);
  }
  return parts.length > 0 ? `Deployed: ${env.name} (${parts.join(', ')})` : `Deployed: ${env.name}`;
}

/**
 * @param {object} state
 * @param {{ now?: Date }} [options]
 * @returns {string[]}
 */
export function stateLines(state, { now = new Date() } = {}) {
  if (state.kind === 'no-project') {
    return ['Not in a Vibecarbon project (needs .vibecarbon.json and docker-compose.yml).'];
  }

  const { project, localDev, configured, environments } = state;
  const lines = [`Project: ${project.name}`];

  if (localDev.running.length > 0) {
    lines.push(`Local dev: running (${localDev.running.length} containers)`);
  } else if (!localDev.dockerAvailable) {
    lines.push('Docker: not running or not installed');
  } else {
    lines.push('Local dev: not running');
  }

  lines.push(configuredLine(configured));

  const deployed = environments.filter((env) => env.status === 'deployed');
  if (deployed.length === 0) {
    lines.push('Deployed: none');
  } else {
    for (const env of deployed) lines.push(deployedLine(env, now));
  }

  return lines;
}

/**
 * why, blank line, then formatExamples([{ description: step.title, commands:
 * [step.display] }]) with the trailing blank trimmed.
 *
 * Caller invariant: never called for the menu step, whose `display` is null.
 * src/next.js branches on `step.id === 'menu'` first, so every step reaching
 * here has a command.
 *
 * @param {import('./steps.js').Step} step
 * @returns {string[]}
 */
export function stepBlock(step) {
  const lines = [
    step.why,
    '',
    ...formatExamples([{ description: step.title, commands: [step.display] }]),
  ];
  return trimTrailingBlank(lines);
}

/**
 * One formatExamples group per item with a command: description = label,
 * command = displayCommand(...). Items with command null are skipped.
 * Trailing blank trimmed.
 *
 * @param {import('./steps.js').MenuItem[]} items
 * @param {{ envName?: string|null }} [options]
 * @returns {string[]}
 */
export function menuLines(items, { envName = null } = {}) {
  const groups = items
    .filter((item) => item.command !== null)
    .map((item) => ({
      description: item.label,
      commands: [displayCommand(item.command, { envName, envScoped: item.envScoped })],
    }));
  return trimTrailingBlank(formatExamples(groups));
}
