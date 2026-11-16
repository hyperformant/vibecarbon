/**
 * Vibecarbon Update Command
 *
 * `vibecarbon update <env>` installs the security updates waiting on each
 * server of an environment (and Docker updates on compose servers), then
 * restarts the servers that need it, one at a time. It shows the plan and
 * the downtime to expect first, and asks before it changes anything.
 *
 * Form rule: single-dash flags only.
 */

import { existsSync } from 'node:fs';
import * as p from '@clack/prompts';
import { resolveEnvContext } from './lib/cli/env-context.js';
import { exitCancelled, exitDeclined } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { writeJson } from './lib/cli/json-mode.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { AmbiguousPrimaryError } from './lib/cli/resolve-primary.js';
import { requireTTYOrFlags } from './lib/cli/tty-guard.js';
import { c } from './lib/colors.js';
import { ensureOperatorIpAccess } from './lib/operator-ip.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { providerIdFor, resolveProviderToken } from './lib/providers/index.js';
import { sshKeyPathFor } from './lib/ssh.js';
import { executeUpdatePlan, releaseLeftoverCordons } from './lib/update/execute.js';
import { inspectAll } from './lib/update/inspect.js';
import { listUpdateTargets } from './lib/update/inventory.js';
import { buildUpdatePlan, isNothingToDo } from './lib/update/plan.js';
import {
  allClearLine,
  confirmQuestion,
  formatPlan,
  formatTotal,
  noServersError,
  noServersHint,
  nothingToDoLine,
  recheckSkippedLine,
  releasedLine,
  releaseFailedLine,
  stillDueLine,
  summaryLine,
  unexpectedRestartYesLine,
} from './lib/update/text.js';

// ============================================================================
// COMMAND SPEC: single source of truth for argv parsing AND help output.
// ============================================================================

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'update',
  summary: 'Install system updates and restart servers when needed',
  description: [
    'Installs the security updates waiting on each server of an environment, and Docker updates on compose servers, then restarts the servers that need it, one at a time.',
    'Before it changes anything it shows the plan and the downtime to expect. Nothing restarts on its own: servers install security updates daily and wait for you to run this.',
    "Looking for vibecarbon upgrade? That one updates your project's infrastructure files from the template.",
  ].join('\n'),
  positional: [{ name: 'env', optional: true, description: 'Environment to update' }],
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
    { name: 'y', boolean: true, description: 'Skip the confirmation prompt' },
    {
      name: 'json',
      boolean: true,
      description: 'Print the plan and the result as JSON',
    },
    { name: 'env', value: '<name>', description: 'Environment seed (alternative to positional)' },
  ],
  examples: [
    { command: 'vibecarbon update', description: 'prompts for the environment' },
    { command: 'vibecarbon update prod', description: 'show the plan for prod, then ask' },
    { command: 'vibecarbon update prod -y', description: 'apply the plan without asking' },
    {
      command: 'vibecarbon update prod -json',
      description: 'print the plan as JSON, change nothing',
    },
  ],
};

// ============================================================================
// HELPERS
// ============================================================================

/** The operator-IP firewall refresh, as `backup` does it. */
async function refreshFirewall({ projectConfig, envName, envConfig, yes }) {
  const apiToken = resolveProviderToken(providerIdFor(envConfig));
  if (!apiToken) return;
  try {
    const isHA = envConfig.deployMode === 'compose-ha' || !!envConfig.ha?.enabled;
    const result = await ensureOperatorIpAccess({
      projectConfig,
      environment: envName,
      isHA,
      apiToken,
      yes,
      onMessage: (msg) => p.log.info(msg),
    });
    if (result.added) {
      p.log.success(`Firewall updated: SSH/k8s API now allow ${result.cidr}`);
    }
  } catch (err) {
    p.log.error(`Operator-IP check failed: ${err.message}`);
    process.exit(1);
  }
}

function planJson(plan, extra = {}) {
  return {
    env: plan.envName,
    tier: plan.tier,
    plan: plan.steps.map((s) => ({
      name: s.target.name,
      role: s.target.role,
      side: s.target.side,
      install: s.install,
      docker: s.docker?.packages ?? null,
      restart: s.restart,
      restartReason: s.restartReason,
      installReporter: s.installReporter,
      expectedSeconds: s.effect.seconds,
    })),
    skipped: plan.skipped,
    uncordon: plan.uncordon.map((u) => u.name),
    expectedDowntime: plan.total ? { min: plan.total[0], max: plan.total[1] } : null,
    outcomes: [],
    becameDue: [],
    stillDue: [],
    uncordonFailed: [],
    measuredDowntimeSeconds: null,
    recheckSkipped: [],
    ...extra,
  };
}

/** The sum of the measured outages, or null when none could be measured. */
function measuredDowntime(outcomes) {
  const measured = outcomes.map((o) => o.outageSeconds).filter((s) => typeof s === 'number');
  return measured.length ? measured.reduce((a, b) => a + b, 0) : null;
}

/** Whether each reached server reports no restart due now. */
async function restartsDue(plan, outcomes, envName) {
  const reached = new Set(outcomes.map((o) => o.name));
  const targets = plan.steps.map((s) => s.target).filter((t) => reached.has(t.name));
  const { inspected, skipped } = await inspectAll(targets, { envName });
  return {
    due: new Set(inspected.filter((r) => r.state.host?.rebootRequired).map((r) => r.target.name)),
    unread: skipped,
  };
}

function printSummary(outcomes) {
  for (const o of outcomes) {
    const docker = o.docker?.find((d) => d.name === 'docker-ce') ?? o.docker?.[0] ?? null;
    p.log.info(
      summaryLine({
        name: o.name,
        installed: o.installed,
        docker: docker ? { from: docker.from, to: docker.to } : null,
        restarted: o.restarted,
        offlineSeconds: o.outageSeconds > 0 ? o.outageSeconds : null,
      }),
    );
  }
}

// ============================================================================
// RUN
// ============================================================================

export async function run(args) {
  const { values, positional, handled } = parseFlagsOrExit(args, SPEC);
  if (handled) return;

  const projectConfig = assertInProjectDir();
  introCommand('update');

  const json = !!values.json;
  const yes = !!values.y;

  const { envName, envConfig } = await resolveEnvContext({
    actionVerb: 'update',
    envRequirement: 'name an environment to update',
    values,
    positional,
    projectConfig,
  });

  await refreshFirewall({ projectConfig, envName, envConfig, yes });

  const sshKeyPath = sshKeyPathFor(envName);
  if (!existsSync(sshKeyPath)) {
    p.log.error(`SSH key not found: ${sshKeyPath}`);
    p.log.info('The deployment key is created during deploy and is required to update servers.');
    process.exit(1);
  }

  // With unclear roles, guessing which server is primary could update the
  // wrong one, so an ambiguous primary stops the run.
  let listing;
  try {
    listing = await listUpdateTargets(envName, envConfig);
  } catch (err) {
    if (!(err instanceof AmbiguousPrimaryError)) throw err;
    p.log.error(err.message);
    process.exit(1);
  }
  const { tier, targets, skipped: unlisted, leftovers = [] } = listing;

  // Nothing recorded is not "up to date": there is nothing to check.
  if (targets.length === 0 && unlisted.length === 0) {
    p.log.error(noServersError(envName));
    p.log.info(noServersHint(envName));
    process.exit(1);
  }

  const { inspected, skipped: unread } = await inspectAll(targets, { envName });
  const plan = buildUpdatePlan({
    envName,
    tier,
    inspected,
    skipped: [...unlisted, ...unread],
    uncordon: leftovers,
  });

  if (isNothingToDo(plan)) {
    if (json) {
      writeJson(planJson(plan));
    } else if (plan.skipped.length > 0) {
      // Servers that could not be checked: say so rather than "up to date".
      p.log.info(formatPlan(plan).join('\n'));
    } else {
      p.log.success(nothingToDoLine(envName));
    }
    p.outro('');
    // A server that was never checked is not "up to date": the run did not finish its job.
    if (plan.skipped.length > 0) process.exit(1);
    return;
  }

  if (!json) {
    p.log.info(formatPlan(plan).join('\n'));
    p.log.info(formatTotal(plan));
  }

  // -json without -y is a dry run: the plan as JSON, nothing changed.
  if (json && !yes) {
    writeJson(planJson(plan));
    return;
  }

  if (!yes) {
    requireTTYOrFlags({
      requirements: [
        {
          flag: 'y',
          description: 'apply this plan without the confirmation prompt',
          satisfied: false,
        },
      ],
    });
    const answer = await p.confirm({ message: confirmQuestion(envName), initialValue: false });
    if (p.isCancel(answer)) exitCancelled();
    if (!answer) exitDeclined();
  }

  // Confirmed: the cluster changes from here on, starting with the nodes an
  // interrupted run left cordoned.
  const { released, failed: uncordonFailed } =
    plan.uncordon.length > 0
      ? await releaseLeftoverCordons(plan.uncordon, { sshKeyPath })
      : { released: [], failed: [] };
  if (!json) {
    if (released.length > 0) p.log.info(releasedLine(released));
    for (const f of uncordonFailed) p.log.warn(releaseFailedLine(f.name, f.reason));
  }

  const { outcomes, becameDue, stoppedAt } = await executeUpdatePlan(plan, {
    envName,
    sshKeyPath,
    domain: envConfig.domain || null,
    projectName: projectConfig.projectName || 'project',
    yes,
    confirm: async (message) => {
      const answer = await p.confirm({ message, initialValue: false });
      if (p.isCancel(answer)) throw new Error('cancelled');
      return answer === true;
    },
    log: {
      step: (m) => p.log.step(m),
      info: (m) => p.log.info(m),
      warn: (m) => p.log.warn(m),
    },
  });

  // A stopped run reads nothing back: the server that stopped it may be dead,
  // and waiting on it would delay the error.
  const { due, unread: recheckUnread } = stoppedAt
    ? { due: new Set(), unread: [] }
    : await restartsDue(plan, outcomes, envName);
  const recheckSkipped = recheckUnread.map((u) => ({ name: u.name, reason: u.reason }));
  const stillDue = [...due];

  if (json) {
    writeJson(
      planJson(plan, {
        outcomes,
        becameDue,
        stillDue,
        uncordonFailed,
        measuredDowntimeSeconds: measuredDowntime(outcomes),
        recheckSkipped,
      }),
    );
  } else {
    printSummary(outcomes);
    for (const d of becameDue) {
      p.log.info(unexpectedRestartYesLine({ envName, name: d.name, pkg: d.package }));
    }
    // A server the line above already named is not named twice.
    const unnamed = stillDue.filter((n) => !becameDue.some((d) => d.name === n));
    if (unnamed.length > 0) p.log.warn(stillDueLine({ envName, names: unnamed }));
    if (recheckSkipped.length > 0)
      p.log.warn(recheckSkippedLine(recheckSkipped.map((u) => u.name)));
    if (
      !stoppedAt &&
      plan.skipped.length === 0 &&
      becameDue.length === 0 &&
      stillDue.length === 0 &&
      recheckSkipped.length === 0
    ) {
      p.log.success(allClearLine());
    }
  }

  if (stoppedAt) {
    p.log.error(stoppedAt.error);
    if (stoppedAt.hint) p.log.info(c.dim(stoppedAt.hint));
    process.exit(1);
  }
  if (!json) p.outro(c.success('Done'));
  // Exit 0 means the environment is known to be current. A server skipped at
  // plan time was not updated, a restart still due is not done, and a node
  // left cordoned is still out of service.
  if (
    plan.skipped.length > 0 ||
    becameDue.length > 0 ||
    stillDue.length > 0 ||
    uncordonFailed.length > 0
  )
    process.exit(1);
}

// SPEC is exported for the arg-parser unit tests.
export { SPEC };
