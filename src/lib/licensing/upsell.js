/**
 * The one place license upsell and warning copy lives.
 *
 * Every price, tier name and tagline is read from tiers.js. Nothing here
 * hard-codes a number: a stale literal is how "$149 one-time" survived the
 * move to per-project subscriptions, and the CLI is the surface a customer
 * reads at the exact moment they decide whether to pay.
 *
 * The deploy gate (evaluateDeployEntitlement, called from index.js) is the
 * only caller. `buildDeployUpsell` / `printDeployUpsell` render a blocked
 * verdict's `{ ok: false, requiredTier, reason, license, verdict }`;
 * `buildDeployWarning` / `printDeployWarning` render an ok verdict's
 * `warning: { kind, daysLeft?, periodEnd?, tier?, detail? }`. Each message
 * is benefits-first (what the tier IS, then what it costs), then proof
 * (which deploy mode triggered it, what stays free), then the one line that
 * explains THIS refusal, then how to act.
 *
 * Style rules this file is held to by tests/unit/licensing/upsell.test.ts:
 * no em dash anywhere, no agency or client-work channel (retired), no
 * one-time price, no claim that operating an existing environment costs
 * anything, and "free" never sits next to "server" or "deploy".
 */

import { graceEndOf, LICENSE_GRACE_DAYS } from './entitlement.js';
import { getTier } from './tiers.js';

/** Deploy tier (src/lib/deploy/tier-registry.js) -> the name a customer reads. */
const DEPLOY_TIER_LABELS = {
  compose: 'Compose',
  'compose-ha': 'Compose HA',
  k8s: 'Kubernetes',
  'k8s-ha': 'Kubernetes HA',
};

const PRICING_URL = 'https://vibecarbon.com/pricing';
const LICENSE_URL = 'https://vibecarbon.com/license';

/** "Enterprise resiliency." -> "enterprise resiliency" */
function taglinePhrase(tier) {
  return (tier.tagline || '').toLowerCase().replace(/\.$/, '');
}

function deployTierLabel(deployTier) {
  return DEPLOY_TIER_LABELS[deployTier] || deployTier;
}

function subscribeUrl(requiredTier) {
  return `${PRICING_URL}?tier=${requiredTier}`;
}

const TERMS_LINE = 'Terms: TERMS.md or https://vibecarbon.com/terms';
const FREE_LINE =
  'Single-server Compose needs no key. Backing up, restoring, failing over, and scaling never require a license.';

const DEPLOY_HEADLINES = [
  'License required',
  'Plan switch required',
  'Payment required',
  'Subscription ended',
  'License not bound',
  'License bound elsewhere',
];

function projectLine(projectName, projectId) {
  return projectId ? `Project: ${projectName || 'this project'} (id ${projectId})` : null;
}

function tierName(id) {
  return getTier(id)?.name || id;
}

/**
 * Render the deploy-gate block message as plain lines, top to bottom. An
 * empty string is a blank line; the caller owns indentation and color.
 *
 * Consumes a blocked result from `evaluateDeployEntitlement` (C2):
 * `{ ok: false, requiredTier, reason, license, verdict }`, where `verdict`
 * is the signed `{ projectId, status, tier, periodEnd, issued }` for every
 * reason except 'no-license' (null there).
 *
 * @param {object} options
 * @param {{requiredTier: string, reason: string, license?: object|null, verdict?: object|null}} options.verdict
 * @param {string|null} [options.deployTier]
 * @param {string} [options.projectName]
 * @param {string|null} [options.projectId]
 * @returns {string[]}
 */
export function buildDeployUpsell({ verdict, deployTier = null, projectName, projectId = null }) {
  const requiredTier = verdict?.requiredTier || 'fullerene';
  const tier = getTier(requiredTier) || getTier('fullerene');
  const mode = deployTierLabel(deployTier);
  const needs = `This environment needs ${tier.name}: ${taglinePhrase(tier)}. $${tier.price} per project per month.`;
  const proj = projectLine(projectName, projectId);
  const held = verdict?.verdict?.tier;

  switch (verdict?.reason) {
    case 'tier-too-low':
      return [
        'Plan switch required',
        '',
        needs,
        `Deploy mode: ${mode}`,
        `This project is on ${tierName(held)}.`,
        '',
        ...(proj ? [proj] : []),
        `Switch plans: ${LICENSE_URL}`,
        TERMS_LINE,
      ];
    case 'past-due': {
      const graceEnd = graceEndOf(verdict.verdict.periodEnd);
      return [
        'Payment required',
        '',
        `Payment for this project's ${tierName(held)} subscription failed and the ${LICENSE_GRACE_DAYS}-day grace period ended on ${graceEnd}.`,
        `Update your card to deploy to ${mode} again.`,
        '',
        ...(proj ? [proj] : []),
        `Billing: ${LICENSE_URL}`,
        TERMS_LINE,
      ];
    }
    case 'canceled':
      return [
        'Subscription ended',
        '',
        `This project's ${tierName(held)} subscription ended on ${verdict.verdict.periodEnd} and the ${LICENSE_GRACE_DAYS}-day grace period is over.`,
        `Renew to deploy to ${mode} again.`,
        '',
        ...(proj ? [proj] : []),
        `Renew: ${subscribeUrl(requiredTier)}`,
        TERMS_LINE,
      ];
    case 'unbound':
      return [
        'License not bound',
        '',
        'This key is not bound to a project yet.',
        ...(proj ? [proj] : []),
        '',
        'Run this inside the project:',
        '  vibecarbon activate <key>',
        TERMS_LINE,
      ];
    case 'wrong-project':
      return [
        'License bound elsewhere',
        '',
        'This key is bound to a different project. Each project has its own subscription.',
        ...(proj ? [proj] : []),
        '',
        'Release it there first (vibecarbon deactivate in that project, or from',
        `${LICENSE_URL}), then run vibecarbon activate <key> here.`,
        TERMS_LINE,
      ];
    default: {
      const lines = ['License required', '', needs];
      if (deployTier) lines.push(`Deploy mode: ${mode}`);
      lines.push(FREE_LINE);
      lines.push('');
      if (proj) lines.push(proj);
      lines.push(
        `Subscribe: ${subscribeUrl(requiredTier)}`,
        'Activate:  vibecarbon activate <key>',
        TERMS_LINE,
      );
      return lines;
    }
  }
}

/**
 * Render the deploy-gate warning as plain lines. Used when
 * `evaluateDeployEntitlement` returns `ok: true` with a `warning`.
 *
 * @param {object} options
 * @param {{kind: string, daysLeft?: number, periodEnd?: string, tier?: string, detail?: string}} options.warning
 * @param {string|null} [options.requiredTier] - The tier the deploy actually
 *   needs (verdict.requiredTier from evaluateDeployEntitlement). Only the
 *   'canceled' renew link uses this: it must point at the tier this
 *   environment requires, not `warning.tier` (the tier the project HELD,
 *   which the canceled check runs before confirming is even sufficient).
 * @returns {string[]}
 */
export function buildDeployWarning({ warning, requiredTier = null }) {
  const days = warning.daysLeft === 0 ? 'through today' : `for ${warning.daysLeft} more days`;
  switch (warning.kind) {
    case 'past-due':
      return [
        `Payment for this project's ${tierName(warning.tier)} subscription failed. Deploys keep working ${days}.`,
        `Update your card: ${LICENSE_URL}`,
      ];
    case 'canceled':
      return [
        `This project's ${tierName(warning.tier)} subscription ended on ${warning.periodEnd}. Deploys keep working ${days}.`,
        `Renew: ${subscribeUrl(requiredTier ?? warning.tier)}`,
      ];
    case 'unverified':
      return [
        `Could not reach vibecarbon.com to verify this project's license (${warning.detail}). Deploying anyway; the next online deploy will check again.`,
      ];
    case 'stale':
      return [
        `Could not confirm this project's subscription renewed after ${warning.periodEnd}. Deploying anyway; the next online deploy will check again.`,
      ];
    case 'ending':
      return [
        `This project's ${tierName(warning.tier)} subscription is set to end on ${warning.periodEnd}. Deploys continue for ${LICENSE_GRACE_DAYS} days after that.`,
      ];
    default:
      return [];
  }
}

/**
 * Print {@link buildDeployUpsell}'s lines to stdout, indented, with the
 * headline and the labelled action lines colored.
 *
 * @param {Parameters<typeof buildDeployUpsell>[0]} options
 * @param {{c: object, log?: (line: string) => void}} io
 */
export function printDeployUpsell(options, { c, log = console.log }) {
  log('');
  for (const line of buildDeployUpsell(options)) {
    if (!line) {
      log('');
      continue;
    }
    if (DEPLOY_HEADLINES.includes(line)) {
      log(`  ${c.warning(line)}`);
      continue;
    }
    const labelled = /^(Subscribe:|Activate:|Switch plans:|Billing:|Renew:)(\s+)(.+)$/.exec(line);
    if (labelled) {
      log(`  ${c.dim(labelled[1])}${labelled[2]}${c.info(labelled[3])}`);
      continue;
    }
    log(`  ${c.dim(line)}`);
  }
  log('');
}

/**
 * Print {@link buildDeployWarning}'s lines to stdout, indented, with the
 * first line colored as a warning and any remaining line as info.
 *
 * @param {Parameters<typeof buildDeployWarning>[0]} options
 * @param {{c: object, log?: (line: string) => void}} io
 */
export function printDeployWarning(options, { c, log = console.log }) {
  const lines = buildDeployWarning(options);
  if (lines.length === 0) return;
  log('');
  log(`  ${c.warning(lines[0])}`);
  for (const line of lines.slice(1)) log(`  ${c.info(line)}`);
  log('');
}
