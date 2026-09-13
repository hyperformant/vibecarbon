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
 *   'paid'     — requires an active subscription regardless of deploy mode,
 *                gated in cli.js pre-dispatch (after the project guard).
 *                Currently unused: licensing moved from command-based to
 *                deploy-mode-based (single-server Compose is free;
 *                provisioning Kubernetes needs Graphene, and either HA mode
 *                needs Fullerene — see 'mode' below), but the
 *                classification and the cli.js chokepoint stay in place so a
 *                future command-wide paid feature has somewhere to plug in.
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
 *   'mode'     — the command gates PROVISIONING of a new environment
 *                in-flow, once its deploy-mode tier is known. Deploy mode is
 *                per-environment and, for `deploy`, not knowable
 *                pre-dispatch (the architecture can be chosen interactively
 *                mid-command), so the command calls
 *                requireProvisionEntitlement() in-flow right after resolving
 *                the tier. See src/lib/licensing/index.js.
 *
 * `deploy` is the only 'mode' command. backup, restore, failover and scale
 * act exclusively on an environment that already exists, and operating an
 * environment you already provisioned is free at every tier: a subscription
 * buys the ability to stand a paid deploy mode UP, never the right to keep
 * one running. Paywalling disaster recovery would be the worst possible
 * moment to ask someone for money.
 */

import { TIERS as DEPLOY_TIERS } from '../deploy/tier-registry.js';
import { requiredTierFor } from './entitlement.js';

/**
 * The license tier a deploy tier needs, re-exported from the entitlement
 * evaluator so gate consumers have one import for the whole taxonomy. Fails
 * closed: an unknown or missing deploy tier requires Fullerene.
 */
export { requiredTierFor };

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
  backup: 'free',
  restore: 'free',
  failover: 'free',
  scale: 'free',
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
 * Deploy-mode tiers (see src/lib/deploy/tier-registry.js) that need a paid
 * subscription to provision. Derived from the entitlement evaluator rather
 * than listed by hand, so the two can never disagree: a tier is paid exactly
 * when the license tier it requires is above Graphite.
 *
 * Read by tests/unit/docs/cli-docs-census.test.ts, which checks the User
 * Docs CLI reference names every paid deploy mode.
 */
export const PAID_TIERS = new Set(
  DEPLOY_TIERS.filter((tier) => requiredTierFor(tier) !== 'graphite'),
);

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
