/**
 * The update plan: what each server needs, whether it restarts, and what the
 * app's users notice. Pure; the text lives in ./text.js.
 */
import { mainPackage, REBOOT_TRIGGER_PATTERNS } from '../host-state.js';

/** Outage ranges in seconds. */
export const DOWNTIME = {
  restart: [60, 180],
  docker: [30, 60],
  dockerThenRestart: [60, 240],
};

const ROLE_ORDER = { server: 0, worker: 1, master: 2, db: 3 };

/**
 * @typedef {{ kind: 'none' | 'no-traffic' | 'drained' | 'app-offline' | 'db-offline', seconds: [number, number] | null }} Effect
 * @typedef {{ target: import('./inventory.js').UpdateTarget, state: import('./inspect.js').TargetState, install: number, docker: import('./inspect.js').TargetState['docker'], restart: 'due' | 'likely' | 'none', restartReason: string | null, installReporter: boolean, effect: Effect }} PlanStep
 * @typedef {{ envName: string, tier: string, steps: PlanStep[], skipped: import('./inventory.js').Skipped[], uncordon: import('./inventory.js').Leftover[], total: [number, number] | null, outageServers: string[] }} UpdatePlan
 */

/**
 * Whether the server lacks the restart reporter. k8s: its node carries no
 * readable host state, the same test status uses for "not reporting yet".
 * compose: the reporter's path unit is not on the server.
 */
function reporterMissing(target, state) {
  return target.kind === 'k8s' ? target.reporting === false : state.reporter === false;
}

/** @returns {{ restart: 'due' | 'likely' | 'none', restartReason: string | null }} */
function decideRestart(state) {
  if (state.host?.rebootRequired)
    return {
      restart: 'due',
      restartReason: mainPackage(state.host.packages) ?? 'system updates',
    };
  const trigger = [...state.ubuntu]
    .sort()
    .find((p) => REBOOT_TRIGGER_PATTERNS.some((re) => re.test(p)));
  if (trigger) return { restart: 'likely', restartReason: trigger };
  return { restart: 'none', restartReason: null };
}

/** @returns {Effect} */
export function decideEffect(target, install, hasDocker, restart) {
  const none = { kind: 'none', seconds: null };
  if (!hasDocker && restart === 'none' && install === 0) return none;
  if (target.side === 'standby') return { kind: 'no-traffic', seconds: null };
  const restarting = restart !== 'none';
  if (target.role === 'worker') return restarting ? { kind: 'drained', seconds: null } : none;
  if (target.kind === 'compose' && target.role === 'server') {
    if (hasDocker && restarting)
      return { kind: 'app-offline', seconds: DOWNTIME.dockerThenRestart };
    if (hasDocker) return { kind: 'app-offline', seconds: DOWNTIME.docker };
    if (restarting) return { kind: 'app-offline', seconds: DOWNTIME.restart };
    return none;
  }
  if (!restarting) return none;
  if (target.role === 'master') return { kind: 'app-offline', seconds: DOWNTIME.restart };
  if (target.role === 'db') return { kind: 'db-offline', seconds: DOWNTIME.restart };
  return none;
}

/**
 * @param {{ envName: string, tier: string, inspected: Array<{ target: import('./inventory.js').UpdateTarget, state: import('./inspect.js').TargetState }>, skipped: import('./inventory.js').Skipped[], uncordon?: import('./inventory.js').Leftover[] }} input
 * @returns {UpdatePlan}
 */
export function buildUpdatePlan({ envName, tier, inspected, skipped, uncordon = [] }) {
  const steps = inspected.map(({ target, state }) => {
    const install = state.ubuntu.length;
    const hasDocker = (state.docker?.packages.length ?? 0) > 0;
    const { restart, restartReason } = decideRestart(state);
    const effect = decideEffect(target, install, hasDocker, restart);
    return {
      target,
      state,
      install,
      docker: state.docker,
      restart,
      restartReason,
      installReporter: reporterMissing(target, state),
      effect,
    };
  });
  steps.sort(
    (a, b) =>
      (a.target.side === 'standby' ? 0 : 1) - (b.target.side === 'standby' ? 0 : 1) ||
      ROLE_ORDER[a.target.role] - ROLE_ORDER[b.target.role] ||
      (a.target.role === 'worker'
        ? a.target.name.localeCompare(b.target.name, 'en', { numeric: true })
        : 0),
  );
  const outages = steps.filter((s) => s.effect.seconds);
  const total = outages.length
    ? /** @type {[number, number]} */ ([
        outages.reduce((n, s) => n + s.effect.seconds[0], 0),
        outages.reduce((n, s) => n + s.effect.seconds[1], 0),
      ])
    : null;
  return {
    envName,
    tier,
    steps,
    skipped,
    uncordon,
    total,
    outageServers: outages.map((s) => s.target.name),
  };
}

/**
 * Nothing to do: every server is current and has its reporter, and no node
 * waits to be uncordoned.
 *
 * @param {UpdatePlan} plan
 */
export function isNothingToDo(plan) {
  return (plan.uncordon ?? []).length === 0 && plan.steps.every((s) => stepIsIdle(s));
}

/** @param {PlanStep} step */
export function stepIsIdle(step) {
  return (
    step.install === 0 &&
    !(step.docker?.packages.length > 0) &&
    step.restart === 'none' &&
    !step.installReporter
  );
}
