/**
 * K8S_BUILT_AHEAD names providers whose k8s code lands before their k8s tier
 * is sold, so the censuses walk that code the day it lands. This guard keeps
 * the list from rotting: an entry must be a registered provider that does not
 * sell k8s yet, and the day its tier turns on it leaves the list.
 */
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { K8S_BUILT_AHEAD, k8sCensusProviders } from '../../_shared/k8s-built-ahead.js';

const sellers = Object.entries(PROVIDERS)
  .filter(([, P]) => P.SUPPORTED_TIERS.includes('k8s'))
  .map(([id]) => id);

describe('K8S_BUILT_AHEAD', () => {
  it('every entry is a registered provider that does not sell k8s yet', () => {
    expect(new Set(K8S_BUILT_AHEAD).size).toBe(K8S_BUILT_AHEAD.length);
    for (const id of K8S_BUILT_AHEAD) {
      expect(Object.keys(PROVIDERS), id).toContain(id);
      expect(PROVIDERS[id as keyof typeof PROVIDERS].SUPPORTED_TIERS, id).not.toContain('k8s');
    }
  });

  it('k8sCensusProviders() is the k8s sellers then the built-ahead ones', () => {
    const ids = k8sCensusProviders().map(([id]) => id);
    const ahead = Object.keys(PROVIDERS).filter((id) => K8S_BUILT_AHEAD.includes(id));
    expect(ids).toEqual([...sellers, ...ahead]);
    expect(ids).toEqual(['hetzner', 'digitalocean', 'linode', 'vultr']);
    for (const [id, P] of k8sCensusProviders()) {
      expect(P).toBe(PROVIDERS[id as keyof typeof PROVIDERS]);
    }
  });
});
