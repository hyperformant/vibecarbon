import { describe, expect, it } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { providerDisplayName, resolveEnvProvider } from '../../../src/status.js';

// C8 — providerDisplayName pins the exact strings renderEnvironment's old
// inline ternary produced:
//   envConfig.provider === 'hetzner' ? 'Hetzner Cloud' : envConfig.provider || 'unknown'
// A falsy provider renders 'unknown'; a registered provider id renders its
// Provider.NAME; any other non-empty provider string renders as-is. The
// registry lookup is case-SENSITIVE (Object.hasOwn against PROVIDERS, not
// hasProvider(), which lowercases) — the old strict `=== 'hetzner'`
// comparison rendered a case-variant like 'Hetzner' as-is, and that must
// survive the refactor byte-identically. Deliberately NOT providerFor()
// alone — its `?? 'hetzner'` default would turn an undefined provider into
// 'Hetzner Cloud', which is wrong here.
describe('providerDisplayName', () => {
  it("renders the registered provider's display name", () => {
    expect(providerDisplayName({ provider: 'hetzner' })).toBe('Hetzner Cloud');
  });

  it('renders "unknown" for a config with no provider field', () => {
    expect(providerDisplayName({})).toBe('unknown');
  });

  it('renders "unknown" for an explicit undefined provider value', () => {
    expect(providerDisplayName({ provider: undefined })).toBe('unknown');
  });

  it('renders "unknown" when envConfig itself is undefined', () => {
    expect(providerDisplayName(undefined)).toBe('unknown');
  });

  it('renders an unrecognized provider string as-is', () => {
    expect(providerDisplayName({ provider: 'weird-cloud' })).toBe('weird-cloud');
  });

  it('renders a case-variant of a registered id as-is (old ternary was case-sensitive)', () => {
    expect(providerDisplayName({ provider: 'Hetzner' })).toBe('Hetzner');
  });
});

// resolveEnvProvider is the single guard both live-check sites (region
// display + server-info token gate/probe) resolve their Provider class
// through. For EVERY input, including an unregistered provider string, it
// must fall back to HetznerProvider — never throw (a bare providerFor()
// would throw inside the per-env Promise.allSettled callback, silently
// dropping that environment's entire checks entry).
describe('resolveEnvProvider', () => {
  it('resolves a registered provider id through the registry', () => {
    expect(resolveEnvProvider({ provider: 'hetzner' })).toBe(HetznerProvider);
  });

  it('falls back to HetznerProvider for an unregistered provider string (never throws)', () => {
    expect(resolveEnvProvider({ provider: 'weird-cloud' })).toBe(HetznerProvider);
  });

  it('falls back to HetznerProvider when provider is undefined', () => {
    expect(resolveEnvProvider({})).toBe(HetznerProvider);
  });

  it('falls back to HetznerProvider when envConfig itself is undefined', () => {
    expect(resolveEnvProvider(undefined)).toBe(HetznerProvider);
  });

  it('resolves a case-variant registered id through the registry (hasProvider lowercases; old code probed Hetzner regardless)', () => {
    expect(resolveEnvProvider({ provider: 'Hetzner' })).toBe(HetznerProvider);
  });
});
