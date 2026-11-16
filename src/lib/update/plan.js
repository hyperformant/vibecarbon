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
 * @typedef {{ target: import('./inventory.js').UpdateTarget, state: import('./inspect.js').TargetState, install: number, docker: import('./inspect.js').TargetState['docker'], restart: 'due' | 'likely' | 'none', restartReason: string | null, effect: Effect }} PlanStep
 * @typedef {{ envName: string, tier: string, steps: PlanStep[], skipped: import('./inventory.js').Skipped[], total: [number, number] | null, outageServers: string[] }} UpdatePlan
 */

/** @returns {{ restart: 'due' | 'likely' | 'none', restartReason: string | null }} */
function decideRestart(state) {
  if (state.host?.rebootRequired)
    return { restart: 'due', restartReason: mainPackage(state.host.packages) };
  const trigger = state.ubuntu.find((p) => REBOOT_TRIGGER_PATTERNS.some((re) => re.test(p)));
  if (trigger) return { restart: 'likely', restartReason: trigger };
  return { restart: 'none', restartReason: null };
}

/** @returns {Effect} */
function decideEffect(target, install, hasDocker, restart) {
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
 * @param {{ envName: string, tier: string, inspected: Array<{ target: import('./inventory.js').UpdateTarget, state: import('./inspect.js').TargetState }>, skipped: import('./inventory.js').Skipped[] }} input
 * @returns {UpdatePlan}
 */
export function buildUpdatePlan({ envName, tier, inspected, skipped }) {
  const steps = inspected.map(({ target, state }) => {
    const install = state.ubuntu.length;
    const hasDocker = (state.docker?.packages.length ?? 0) > 0;
    const { restart, restartReason } = decideRestart(state);
    const effect = decideEffect(target, install, hasDocker, restart);
    return { target, state, install, docker: state.docker, restart, restartReason, effect };
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
    total,
    outageServers: outages.map((s) => s.target.name),
  };
}

/** @param {UpdatePlan} plan */
export function isNothingToDo(plan) {
  return plan.steps.every((s) => stepIsIdle(s));
}

/** @param {PlanStep} step */
export function stepIsIdle(step) {
  return step.install === 0 && !(step.docker?.packages.length > 0) && step.restart === 'none';
}
