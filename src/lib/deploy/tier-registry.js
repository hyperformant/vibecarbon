/**
 * Canonical tier taxonomy. Config persists deployMode ('compose' | 'compose-ha'
 * | 'kubernetes') plus an ha flag ('kubernetes-ha' is normalized away at
 * prompt time, see prompts.js). Everything downstream should dispatch on the
 * tier id returned here instead of re-deriving mode+ha combinations.
 */
export const TIERS = ['compose', 'compose-ha', 'k8s', 'k8s-ha'];

/**
 * The tiers offered to a NEW environment: the deploy picker, `-mode` help and
 * its error, the failover hints and the user docs name these and no others
 * (tests/unit/docs/unoffered-tier-surface-census.test.ts). compose-ha is not
 * shipping right now (2026-11-25) but stays a working tier: `-mode compose-ha`
 * still deploys one, and an existing compose-ha environment keeps deploying,
 * scaling, failing over and restoring as before.
 */
export const OFFERED_TIERS = TIERS.filter((tier) => tier !== 'compose-ha');

export function resolveTier(envConfig = {}) {
  const { deployMode, ha } = envConfig;
  const haEnabled = typeof ha === 'object' ? !!ha?.enabled : !!ha;
  switch (deployMode) {
    case 'compose':
      return 'compose';
    case 'compose-ha':
      return 'compose-ha';
    case 'kubernetes':
      return haEnabled ? 'k8s-ha' : 'k8s';
    default:
      throw new Error(`Unknown deployMode: ${JSON.stringify(deployMode)}`);
  }
}

export const isHATier = (tier) => tier === 'compose-ha' || tier === 'k8s-ha';
export const isComposeTier = (tier) => tier === 'compose' || tier === 'compose-ha';
export const isK8sTier = (tier) => tier === 'k8s' || tier === 'k8s-ha';

export function pulumiStackEnvs(tier, environment) {
  // BOTH HA tiers are two-stack: compose-ha's provision fan-out calls
  // upStack(`${environment}-primary`) / upStack(`${environment}-standby`)
  // (lib/deploy/effects/compose-ha.js) exactly like k8s-ha's per-cluster
  // converge. The old "only k8s-ha" answer left compose-ha's second stack
  // invisible to every consumer — harmless while nothing walked compose
  // stacks at destroy, load-bearing since remove-stack-state does.
  return isHATier(tier) ? [`${environment}-primary`, `${environment}-standby`] : [environment];
}
