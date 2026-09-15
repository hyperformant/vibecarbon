/**
 * Pure entitlement evaluator: does a license entitle a project to provision
 * a given deploy tier?
 *
 * No I/O, no environment reads, no imports beyond tiers.js, no clock reads
 * (every date this module touches is a 'YYYY-MM-DD' string passed in by the
 * caller). Called from the provisioning gate in index.js (resolveVerdict)
 * and from upsell.js.
 *
 * The `license` shape this module reads is a contract with the per-project
 * license storage index.js's getLicense() returns:
 *   - active: boolean
 *   - tier: string (one of the TIERS keys in tiers.js)
 *   - format: 'v1' | 'v2'
 *   - isLifetime: boolean (true for a legacy v1 key, which covers every
 *     deploy tier, every project, forever)
 *   - projectId: string | null
 *   - paidThrough: 'YYYY-MM-DD' | null
 *   - storedProjectId: string | null (only ever set on an INACTIVE result:
 *     a valid v2 key sits on disk but belongs to another project)
 * A missing license, or one with `active: false`, is treated as no license.
 *
 * The deploy-time gate's contract lives in `evaluateDeployEntitlement`
 * below: given the stored license, the deploy tier, and the result of a
 * live/cached license check (a signed verdict from
 * validator.js's verifyVerdictToken, or null), it decides proceed / warn /
 * block with a 30-day grace after `periodEnd`. `coversRelease` and
 * `evaluateEntitlement` below are the release-date-based predecessor of
 * that contract. They stay exported and unchanged for now because
 * index.js's resolveVerdict still calls evaluateEntitlement; retired by
 * the deploy-time gate, removed in the same change that rewires index.js.
 */
import { compareTiers } from './tiers.js';

/** Deploy tier (from src/lib/deploy/tier-registry.js) -> the license tier that covers it. */
export const TIER_FOR_DEPLOY_TIER = {
  compose: 'graphite',
  k8s: 'graphene',
  'compose-ha': 'fullerene',
  'k8s-ha': 'fullerene',
};

/**
 * The license tier required to provision a deploy tier. Fails closed: an
 * unknown or missing deploy tier requires the highest tier, Fullerene.
 * @param {string} [deployTier]
 * @returns {string}
 */
export function requiredTierFor(deployTier) {
  return TIER_FOR_DEPLOY_TIER[deployTier] ?? 'fullerene';
}

/**
 * Whether a license tier is at or above a required tier. An unrecognized
 * license tier never satisfies anything.
 * @param {string} [licenseTier]
 * @param {string} requiredTier
 * @returns {boolean}
 */
export function tierSatisfies(licenseTier, requiredTier) {
  const known =
    licenseTier === 'graphite' || licenseTier === 'graphene' || licenseTier === 'fullerene';
  return known && compareTiers(licenseTier, requiredTier) >= 0;
}

// Retired by the deploy-time gate; removed in the same change that rewires index.js.
/**
 * Whether a license's paid-through date covers a given release date. A
 * lifetime license covers every release, forever. Otherwise this is a plain
 * string comparison of two 'YYYY-MM-DD' dates — inclusive of the boundary
 * day.
 * @param {{ isLifetime: boolean, paidThrough: string | null }} license
 * @param {string} releaseDate
 * @returns {boolean}
 */
export function coversRelease(license, releaseDate) {
  if (license.isLifetime) return true;
  if (!license.paidThrough) return false;
  return releaseDate <= license.paidThrough;
}

// Retired by the deploy-time gate; removed in the same change that rewires index.js.
/**
 * @param {{
 *   license: { active: boolean, tier: string, format: 'v1' | 'v2', isLifetime: boolean, projectId: string | null, paidThrough: string | null } | null | undefined,
 *   deployTier: string,
 *   projectId: string,
 *   releaseDate: string,
 * }} args
 * @returns {{ ok: true, requiredTier: string } | { ok: false, requiredTier: string, reason: 'no-license' | 'wrong-project' | 'tier-too-low' | 'lapsed', license: object | null }}
 */
export function evaluateEntitlement({ license, deployTier, projectId, releaseDate }) {
  const requiredTier = requiredTierFor(deployTier);

  if (requiredTier === 'graphite') {
    return { ok: true, requiredTier };
  }

  if (!license?.active) {
    // A valid key IS on disk, just for another project. Saying "no license"
    // here would send someone to buy a second subscription for a key they
    // already hold, so name the mismatch instead.
    const reason = license?.storedProjectId ? 'wrong-project' : 'no-license';
    return { ok: false, requiredTier, reason, license: license ?? null };
  }

  if (license.isLifetime) {
    return { ok: true, requiredTier };
  }

  if (license.projectId !== projectId) {
    return { ok: false, requiredTier, reason: 'wrong-project', license };
  }

  if (!tierSatisfies(license.tier, requiredTier)) {
    return { ok: false, requiredTier, reason: 'tier-too-low', license };
  }

  if (!coversRelease(license, releaseDate)) {
    return { ok: false, requiredTier, reason: 'lapsed', license };
  }

  return { ok: true, requiredTier };
}

export const LICENSE_GRACE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function ymdToUtcMs(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcMsToYmd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** periodEnd 'YYYY-MM-DD' -> the last day deploys still proceed, 'YYYY-MM-DD'. */
export function graceEndOf(periodEnd) {
  return utcMsToYmd(ymdToUtcMs(periodEnd) + LICENSE_GRACE_DAYS * DAY_MS);
}

/** Whole days from `now` to `graceEnd`, never negative. */
export function daysLeft(graceEnd, now) {
  return Math.max(0, Math.round((ymdToUtcMs(graceEnd) - ymdToUtcMs(now)) / DAY_MS));
}

/**
 * The deploy decision table. Pure: no I/O, no env, no clock reads (`now` is
 * 'YYYY-MM-DD', passed in). See the Notion Pricing Model page, Rules.
 *
 * @param {{
 *   license: object | null,
 *   deployTier: string,
 *   projectId: string,
 *   check: { source: 'live' | 'cache' | 'none' | 'rejected', verdict: object | null, unreachable?: string, cancelAtPeriodEnd?: boolean },
 *   now: string,
 * }} args
 */
export function evaluateDeployEntitlement({ license, deployTier, projectId, check, now }) {
  const requiredTier = requiredTierFor(deployTier);
  if (requiredTier === 'graphite') return { ok: true, requiredTier };

  if (!license?.active) {
    const reason = license?.storedProjectId ? 'wrong-project' : 'no-license';
    return { ok: false, requiredTier, reason, license: license ?? null, verdict: null };
  }
  if (license.isLifetime) return { ok: true, requiredTier };
  if (license.projectId !== projectId) {
    return { ok: false, requiredTier, reason: 'wrong-project', license, verdict: null };
  }

  const verdict = check?.verdict ?? null;
  if (check?.source === 'rejected' || (verdict && verdict.projectId !== projectId)) {
    return { ok: false, requiredTier, reason: 'no-license', license, verdict: null };
  }
  if (!verdict) {
    return {
      ok: true,
      requiredTier,
      warning: { kind: 'unverified', detail: check?.unreachable ?? 'unknown' },
    };
  }
  if (verdict.status === 'none') {
    return { ok: false, requiredTier, reason: 'no-license', license, verdict };
  }

  const graceEnd = graceEndOf(verdict.periodEnd);
  const inGrace = now <= graceEnd;
  const left = daysLeft(graceEnd, now);
  const base = { periodEnd: verdict.periodEnd, tier: verdict.tier };

  if (verdict.status === 'canceled') {
    return inGrace
      ? { ok: true, requiredTier, warning: { kind: 'canceled', daysLeft: left, ...base } }
      : { ok: false, requiredTier, reason: 'canceled', license, verdict };
  }

  if (!tierSatisfies(verdict.tier, requiredTier)) {
    return { ok: false, requiredTier, reason: 'tier-too-low', license, verdict };
  }

  if (verdict.status === 'past_due') {
    return inGrace
      ? { ok: true, requiredTier, warning: { kind: 'past-due', daysLeft: left, ...base } }
      : { ok: false, requiredTier, reason: 'past-due', license, verdict };
  }

  // active
  if (!inGrace) return { ok: true, requiredTier, warning: { kind: 'stale', ...base } };
  if (check?.cancelAtPeriodEnd)
    return { ok: true, requiredTier, warning: { kind: 'ending', ...base } };
  return { ok: true, requiredTier };
}
