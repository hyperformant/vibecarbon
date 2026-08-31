/**
 * Central license gate — the single pre-dispatch chokepoint for
 * command-wide paid commands, plus the deploy-mode tier taxonomy consulted
 * by the in-flow gates.
 *
 * cli.js consults COMMAND_GATES before routing to a command module, so a
 * command-wide paid command can never ship unguarded: every command
 * registered in KNOWN_COMMANDS must have an explicit classification here
 * (enforced by tests/unit/licensing/command-gates.test.ts).
 *
 * Classifications:
 *   'paid'     — requires an active Fullerene license regardless of
 *                deploy mode, gated in cli.js pre-dispatch (after the
 *                project guard). Currently unused: licensing moved from
 *                command-based to deploy-mode-based (single-server Compose
 *                is free; Compose HA / Kubernetes / Kubernetes HA require a
 *                license — see 'mode' below), but the classification and
 *                the cli.js chokepoint stay in place so a future
 *                command-wide paid feature has somewhere to plug in.
 *   'free'     — never gated. destroy is deliberately free: teardown is
 *                never held hostage to a license. upgrade is a local
 *                template refresh — mode-agnostic, free for everyone.
 *   'internal' — the command gates a sub-flow itself. No command uses this
 *                today: `configure cicd` used to, until it became clear the
 *                gate was redundant. Its Flux stage only runs on k8s/k8s-ha
 *                environments, which already required Fullerene at deploy
 *                time, so the scenario gate had fired long before. Worse, the
 *                check ran before the deploy mode was known, so a Compose
 *                user asking for CI/CD saw a paywall for a feature that is
 *                free in every mode. Kept as a classification so a genuine
 *                sub-flow gate has a name if one ever appears.
 *   'mode'     — the command gates itself once its deploy-mode tier is
 *                known. Deploy mode is per-environment and, for `deploy`,
 *                not knowable pre-dispatch (the architecture can be chosen
 *                interactively mid-command), so these commands call
 *                requirePaidTier() in-flow right after resolving the tier
 *                — see src/lib/licensing/index.js.
 */

export const COMMAND_GATES = {
  create: 'free',
  add: 'free',
  remove: 'free',
  up: 'free',
  down: 'free',
  reset: 'free',
  deploy: 'mode',
  destroy: 'free',
  status: 'free',
  backup: 'mode',
  restore: 'mode',
  failover: 'mode',
  scale: 'mode',
  upgrade: 'free',
  configure: 'free',
  activate: 'free',
  deactivate: 'free',
  shell: 'free',
  diagnose: 'free',
  console: 'free',
  access: 'free',
  telemetry: 'free',
};

/**
 * Deploy-mode tiers (see src/lib/deploy/tier-registry.js) that require an
 * active Fullerene license. Single-server Compose is the only free
 * tier.
 */
export const PAID_TIERS = new Set(['compose-ha', 'k8s', 'k8s-ha']);

/**
 * Whether a resolved deploy-mode tier requires a paid license.
 * Fails closed: an unrecognized or missing tier is treated as paid, so a
 * corrupt `.vibecarbon.json` or a new tier added without updating this set
 * can never silently deploy for free.
 *
 * @param {string} tier - A tier id from src/lib/deploy/tier-registry.js
 * @returns {boolean}
 */
export function isPaidTier(tier) {
  // The only free tier is single-server Compose. Every tier in PAID_TIERS
  // requires a license, and so does anything else (unknown/missing/corrupt
  // deployMode) — fail closed rather than silently deploy for free.
  if (tier === 'compose') return false;
  return true;
}

/**
 * Whether this invocation must hold a paid license.
 * Help/version invocations are always free — every command handles -h/-v
 * before doing real work, and the upsell must never block reading docs.
 *
 * @param {string} command - The subcommand name
 * @param {string[]} args - The subcommand's argv (without the command itself)
 * @returns {boolean}
 */
export function shouldGate(command, args = []) {
  if (COMMAND_GATES[command] !== 'paid') return false;
  if (args.includes('-h') || args.includes('-v')) return false;
  return true;
}
