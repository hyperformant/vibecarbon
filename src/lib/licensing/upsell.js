/**
 * The one place license upsell and warning copy lives.
 *
 * Every price, tier name and tagline is read from tiers.js. Nothing here
 * hard-codes a number: a stale literal is how "$149 one-time" survived the
 * move to per-project subscriptions, and the CLI is the surface a customer
 * reads at the exact moment they decide whether to pay.
 *
 * The deploy-time gate (C2's evaluateDeployEntitlement, wired into index.js
 * by C5) is the current caller. `buildDeployUpsell` / `printDeployUpsell`
 * render a blocked verdict's `{ ok: false, requiredTier, reason, license,
 * verdict }`; `buildDeployWarning` / `printDeployWarning` render an ok
 * verdict's `warning: { kind, daysLeft?, periodEnd?, tier?, detail? }`. Each
 * message is benefits-first (what the tier IS, then what it costs), then
 * proof (which deploy mode triggered it, what stays free), then the one line
 * that explains THIS refusal, then how to act.
 *
 * `buildProvisionUpsell` / `printProvisionUpsell` are the release-date-based
 * predecessor of the deploy-time gate (evaluateEntitlement's verdict shape).
 * Retired by the deploy-time gate; removed when index.js is rewired in C5.
 * They stay exported and unchanged until then because index.js and
 * tests/unit/licensing/storage.test.ts still call them.
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

// Retired by the deploy-time gate; removed when index.js is rewired.
/** What a license tier covers, in deploy-mode words: "Kubernetes", "Compose". */
function coverageOf(licenseTierId) {
  const tier = getTier(licenseTierId);
  if (!tier?.deployTiers?.length) return 'no paid deploy modes';
  return tier.deployTiers.map(deployTierLabel).join(' and ');
}

/**
 * The single line that explains THIS refusal. `null` for 'no-license': the
 * headline already said the environment needs a subscription, and repeating
 * it would only push the call to action further down the screen.
 *
 * @param {{reason: string, requiredTier: string, license?: object|null}} verdict
 * @param {{deployTier?: string|null, projectId?: string|null, version: string, releaseDate: string}} ctx
 * @returns {string|null}
 */
function reasonLine(verdict, { deployTier, projectId, version, releaseDate }) {
  const license = verdict.license || {};
  const held = getTier(license.tier);
  const heldName = held?.name || license.tier || 'current';
  const requiredName = getTier(verdict.requiredTier)?.name || verdict.requiredTier;

  switch (verdict.reason) {
    case 'tier-too-low':
      return (
        `Your ${heldName} subscription for this project covers ${coverageOf(license.tier)}; ` +
        `${deployTierLabel(deployTier)} needs ${requiredName}.`
      );
    case 'wrong-project':
      // An ACTIVE license that fails the project check carries the id on
      // `projectId`; a key that only sits on disk (getLicense never activates
      // one for another project) carries it on `storedProjectId`.
      return (
        `The stored key is for project ${license.projectId ?? license.storedProjectId}; ` +
        `this project is ${projectId}. Each project has its own subscription.`
      );
    case 'lapsed':
      // The CLI knows only the release it IS, never the last release its
      // subscription covered — it cannot tell offline which past releases
      // would still be within paidThrough — so it can't name a version to
      // pin to. It can only point at the boundary date and where release
      // dates are published.
      return (
        `Your ${heldName} subscription for this project is paid through ${license.paidThrough}; ` +
        `vibecarbon v${version} was released ${releaseDate}. Renew, or install a release ` +
        `published on or before ${license.paidThrough}. npm view vibecarbon time lists release dates.`
      );
    default:
      return null;
  }
}

function subscribeUrl(projectId, requiredTier) {
  const params = new URLSearchParams();
  if (projectId) params.set('project', projectId);
  params.set('tier', requiredTier);
  return `${PRICING_URL}?${params}`;
}

/**
 * Render the upsell as plain lines, top to bottom. An empty string is a
 * blank line; the caller owns indentation and color.
 *
 * @param {object} options
 * @param {{ok?: boolean, requiredTier?: string, reason?: string, license?: object|null, refreshOffline?: boolean}} [options.verdict]
 *   The evaluateEntitlement() verdict that refused this provision.
 *   `refreshOffline` is set only by the refresh seam (index.js), only on a
 *   verdict that is STILL 'lapsed' after an unreachable-server refresh
 *   attempt.
 * @param {string|null} [options.deployTier] - The deploy tier being provisioned.
 *   Omitted by the command-wide gate, which has no deploy mode in play.
 * @param {string} [options.commandName] - Set only by the command-wide gate,
 *   which frames the requirement around the command instead of an environment.
 * @param {string} [options.projectName]
 * @param {string|null} [options.projectId]
 * @param {string} options.version - The running CLI's version.
 * @param {string} [options.releaseDate] - The running CLI's release date.
 * @returns {string[]}
 */
// Retired by the deploy-time gate; removed when index.js is rewired.
export function buildProvisionUpsell({
  verdict,
  deployTier = null,
  commandName,
  projectName,
  projectId = null,
  version,
  releaseDate,
}) {
  const resolved = verdict || { reason: 'no-license', requiredTier: 'fullerene', license: null };
  const requiredTier = resolved.requiredTier || 'fullerene';
  const tier = getTier(requiredTier) || getTier('fullerene');

  const subject = commandName ? `The ${commandName} command` : 'This environment';
  const lines = [
    'License required',
    '',
    `${subject} needs ${tier.name}: ${taglinePhrase(tier)}. $${tier.price} per project per month.`,
  ];

  if (deployTier) lines.push(`Deploy mode: ${deployTierLabel(deployTier)}`);

  lines.push(
    'Single-server Compose needs no key. Redeploying, backing up, restoring, failing over, ' +
      'and scaling an existing environment never requires a license.',
  );

  const reason = reasonLine(resolved, { deployTier, projectId, version, releaseDate });
  if (reason) lines.push(reason);

  // Set by the refresh seam (src/lib/licensing/index.js) only when the
  // verdict is STILL 'lapsed' after an attempted refresh that failed to
  // reach the server. A key that refreshed clean, or one that refreshed and
  // still came back lapsed for a real reason (not-renewed / not-found),
  // never carries this — telling someone "you might already be fine" would
  // be wrong in both of those cases.
  if (resolved.reason === 'lapsed' && resolved.refreshOffline) {
    lines.push(
      'Could not reach vibecarbon.com. If you renewed, run vibecarbon activate <key> from your email.',
    );
  }

  lines.push('');
  if (projectId) lines.push(`Project: ${projectName || 'this project'} (id ${projectId})`);
  lines.push(`Subscribe: ${subscribeUrl(projectId, requiredTier)}`);
  lines.push('Activate:  vibecarbon activate <key>');
  lines.push('Terms: TERMS.md or https://vibecarbon.com/terms');

  return lines;
}

/**
 * Print {@link buildProvisionUpsell}'s lines to stdout, indented, with the
 * headline and the two action URLs colored. Color is applied here and never
 * inside the copy, so the copy stays assertable as plain text.
 *
 * @param {Parameters<typeof buildProvisionUpsell>[0]} options
 * @param {{c: object, log?: (line: string) => void}} io
 */
// Retired by the deploy-time gate; removed when index.js is rewired.
export function printProvisionUpsell(options, { c, log = console.log }) {
  log('');
  for (const line of buildProvisionUpsell(options)) {
    if (!line) {
      log('');
      continue;
    }
    if (line === 'License required') {
      log(`  ${c.warning(line)}`);
      continue;
    }
    const labelled = /^(Subscribe:|Activate:)(\s+)(.+)$/.exec(line);
    if (labelled) {
      log(`  ${c.dim(labelled[1])}${labelled[2]}${c.info(labelled[3])}`);
      continue;
    }
    log(`  ${c.dim(line)}`);
  }
  log('');
}

const TERMS_LINE = 'Terms: TERMS.md or https://vibecarbon.com/terms';
const FREE_LINE =
  'Single-server Compose needs no key. Backing up, restoring, failing over, and scaling never require a license.';

const DEPLOY_HEADLINES = [
  'License required',
  'Plan switch required',
  'Payment required',
  'Subscription ended',
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
 * reason except 'no-license' and 'wrong-project' (null there).
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
        `Renew: ${subscribeUrl(projectId, requiredTier)}`,
        TERMS_LINE,
      ];
    default: {
      const lines = ['License required', '', needs];
      if (deployTier) lines.push(`Deploy mode: ${mode}`);
      lines.push(FREE_LINE);
      if (verdict?.reason === 'wrong-project') {
        const other = verdict.license?.storedProjectId || verdict.license?.projectId;
        lines.push(
          `The stored key belongs to project ${other}. Each project has its own subscription.`,
        );
      }
      lines.push('');
      if (proj) lines.push(proj);
      lines.push(
        `Subscribe: ${subscribeUrl(projectId, requiredTier)}`,
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
 * @param {string|null} [options.projectId]
 * @returns {string[]}
 */
export function buildDeployWarning({ warning, projectId = null }) {
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
        `Renew: ${subscribeUrl(projectId, warning.tier)}`,
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
