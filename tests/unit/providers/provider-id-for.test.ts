import { describe, expect, it } from 'vitest';
import { providerIdFor } from '../../../src/lib/providers/index.js';

// A3 — providerIdFor() is the id-flavored twin of providerFor() (same single
// home of the `?? 'hetzner'` default). Command-level token lookups
// (resolveProviderToken('hetzner', ...) hardcodes, ×11) route through this
// instead of hand-rolling the fallback inline.

describe('providerIdFor', () => {
  it('resolves "hetzner" when envConfig has no provider field', () => {
    expect(providerIdFor({})).toBe('hetzner');
  });

  it('resolves "hetzner" when envConfig is undefined', () => {
    expect(providerIdFor(undefined)).toBe('hetzner');
  });

  it('resolves the explicit provider id when set', () => {
    expect(providerIdFor({ provider: 'digitalocean' })).toBe('digitalocean');
  });
});
