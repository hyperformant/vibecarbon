/**
 * Providers whose k8s code is landing before their k8s tier is sold, part by
 * part, so the censuses that pick providers by `SUPPORTED_TIERS.includes('k8s')`
 * walk each part the day it lands instead of the day the tier turns on. Every
 * census names the part it checks: one that runs a boot script takes 'boot',
 * a Pulumi program 'program', the CSI manifest or `k8sCloudSecrets` 'csi',
 * and destroy code 'destroy'. The guard
 * (tests/unit/providers/k8s-built-ahead.test.ts) fails for an entry that is
 * not a registered provider, already sells k8s or names an unknown part, and
 * for a census that names no part, so the table empties when the tier turns
 * on.
 */
import { PROVIDERS } from '../../src/lib/providers/index.js';

export const K8S_PARTS = ['boot', 'program', 'csi', 'destroy'] as const;
export type K8sPart = (typeof K8S_PARTS)[number];

// Empty since Scaleway's tiers turned on (Part C). A provider whose k8s code
// lands before its tier is sold goes back in, one entry, part by part.
export const K8S_BUILT_AHEAD: Readonly<Record<string, readonly K8sPart[]>> = {};

type Entry = [string, (typeof PROVIDERS)[keyof typeof PROVIDERS]];

/**
 * The `[id, ProviderClass]` entries of PROVIDERS that sell k8s, then those
 * built ahead whose parts hold `part`, each group in registry order. Throws
 * on a missing or unknown part: vitest does not type-check, so a census left
 * without one must fail loudly, never quietly walk the sellers alone.
 */
export function k8sCensusProviders(part: K8sPart): Entry[] {
  if (!(K8S_PARTS as readonly unknown[]).includes(part)) {
    throw new Error(
      `k8sCensusProviders: part must be one of ${K8S_PARTS.join(', ')}, not ${JSON.stringify(part)}`,
    );
  }
  const entries = Object.entries(PROVIDERS) as Entry[];
  return [
    ...entries.filter(([, P]) => P.SUPPORTED_TIERS.includes('k8s')),
    ...entries.filter(([id]) => (K8S_BUILT_AHEAD[id] ?? []).includes(part)),
  ];
}
