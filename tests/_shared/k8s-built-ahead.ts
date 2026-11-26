/**
 * Providers whose k8s code is landing before their k8s tier is sold, so the
 * censuses that pick providers by `SUPPORTED_TIERS.includes('k8s')` walk that
 * code the day it lands instead of the day the tier turns on. A census
 * switches to k8sCensusProviders() once the code it checks exists for every
 * entry here. The guard (tests/unit/providers/k8s-built-ahead.test.ts) fails
 * for an entry that is not a registered provider or already sells k8s, so the
 * list empties when the tier turns on.
 */
import { PROVIDERS } from '../../src/lib/providers/index.js';

export const K8S_BUILT_AHEAD: readonly string[] = ['vultr'];

type Entry = [string, (typeof PROVIDERS)[keyof typeof PROVIDERS]];

/**
 * The `[id, ProviderClass]` entries of PROVIDERS that sell k8s, then those in
 * K8S_BUILT_AHEAD, each group in registry order.
 */
export function k8sCensusProviders(): Entry[] {
  const entries = Object.entries(PROVIDERS) as Entry[];
  return [
    ...entries.filter(([, P]) => P.SUPPORTED_TIERS.includes('k8s')),
    ...entries.filter(([id]) => K8S_BUILT_AHEAD.includes(id)),
  ];
}
