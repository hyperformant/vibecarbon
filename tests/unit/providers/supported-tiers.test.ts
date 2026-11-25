import { describe, expect, it } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { assertTierSupported } from '../../../src/lib/providers/index.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';

// biome-ignore lint/complexity/noStaticOnlyClass: stands in for a provider class shape (statics only, per BaseProvider contract)
class StubProvider {
  static NAME = 'Stub';
  static SUPPORTED_TIERS = ['compose'];
}

describe('assertTierSupported', () => {
  it.each(['compose', 'compose-ha', 'k8s', 'k8s-ha'])('hetzner supports %s', (tier) => {
    expect(() => assertTierSupported(HetznerProvider, tier)).not.toThrow();
  });
  it('throws with tier + supported list for an unsupported tier', () => {
    expect(() => assertTierSupported(StubProvider, 'k8s')).toThrow(
      /does not support the 'k8s' deploy tier[\s\S]*compose/,
    );
  });

  it('names only offered tiers in the supported list (compose-ha works but is not offered)', () => {
    expect(() => assertTierSupported(VultrProvider, 'k8s')).toThrow(
      "Vultr does not support the 'k8s' deploy tier. Supported: compose. (k8s: Hetzner Cloud, DigitalOcean, Linode only)",
    );
    expect(() => assertTierSupported(VultrProvider, 'compose-ha')).not.toThrow();
  });
});
