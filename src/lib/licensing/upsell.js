/**
 * The one place license upsell copy lives.
 *
 * Every price, tier name and tagline is read from tiers.js. Nothing here
 * hard-codes a number: a stale literal is how "$149 one-time" survived the
 * move to per-project subscriptions, and the CLI is the surface a customer
 * reads at the exact moment they decide whether to pay.
 *
 * The message is benefits-first (what the tier IS, then what it costs), then
 * proof (which deploy mode triggered it, what stays free), then the one line
 * that explains THIS refusal, then how to act. It is reason-driven: the
 * verdict from entitlement.js selects a single explanatory line rather than
 * the caller assembling prose.
 *
 * Style rules this file is held to by tests/unit/licensing/upsell.test.ts:
 * no em dash anywhere, no agency or client-work channel (retired), no
 * one-time price, and no claim that operating an existing environment costs
 * anything.
 */

import { getTier } from './tiers.js';

/** Deploy tier (src/lib/deploy/tier-registry.js) -> the name a customer reads. */
const DEPLOY_TIER_LABELS = {
  compose: 'Compose',
  'compose-ha': 'Compose HA',
  k8s: 'Kubernetes',
  'k8s-ha': 'Kubernetes HA',
};

const PRICING_URL = 'https://vibecarbon.com/pricing';

/** "Enterprise resiliency." -> "enterprise resiliency" */
function taglinePhrase(tier) {
  return (tier.tagline || '').toLowerCase().replace(/\.$/, '');
}

function deployTierLabel(deployTier) {
  return DEPLOY_TIER_LABELS[deployTier] || deployTier;
}

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
    'Single-server Compose is free. Redeploying, backing up, restoring, failing over, ' +
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
