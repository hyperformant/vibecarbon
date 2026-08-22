import { describe, expect, it } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { providerFor } from '../../../src/lib/providers/index.js';

// providerFor() is THE single home of the `?? 'hetzner'` default for catalog
// call sites. No call site (scale.js, deploy/prompts.js,
// deploy/effects/k8s-ha.js) may re-implement this fallback.

describe('providerFor', () => {
  it('resolves HetznerProvider when envConfig has no provider field', () => {
    expect(providerFor({})).toBe(HetznerProvider);
  });

  it('resolves HetznerProvider when envConfig is undefined', () => {
    expect(providerFor(undefined)).toBe(HetznerProvider);
  });

  it('resolves HetznerProvider when envConfig is null', () => {
    // eslint-disable-next-line unicorn/no-null
    expect(providerFor(null)).toBe(HetznerProvider);
  });

  it('resolves the same class identity for an explicit provider: "hetzner"', () => {
    expect(providerFor({ provider: 'hetzner' })).toBe(HetznerProvider);
  });

  it('is case-insensitive, matching getProviderClass', () => {
    expect(providerFor({ provider: 'HETZNER' })).toBe(HetznerProvider);
  });

  it('throws for an unknown provider id', () => {
    expect(() => providerFor({ provider: 'not-a-cloud' })).toThrow('Unknown provider');
  });
});
