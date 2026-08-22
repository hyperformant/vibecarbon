import { describe, expect, it } from 'vitest';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import {
  getProvider,
  getProviderClass,
  hasProvider,
  listProviders,
  PROVIDERS,
  validateProviderConfig,
} from '../../../src/lib/providers/index.js';
// Source of truth for "which providers are implemented so far" — the same
// shared table provider-contract.test.ts pins its per-provider assertions
// against, reused (not replicated) here so this file's registration-count
// assertion derives instead of needing a hand-edited magic number every
// time a provider is added.
import { EXPECTED } from '../../_shared/provider-expected.js';

describe('Provider Registry', () => {
  describe('PROVIDERS constant', () => {
    it('includes Hetzner provider', () => {
      expect(PROVIDERS.hetzner).toBe(HetznerProvider);
    });

    it('includes DigitalOcean provider (Phase B)', () => {
      expect(PROVIDERS.digitalocean).toBe(DigitalOceanProvider);
    });

    // Derived from provider-contract.test.ts's EXPECTED table rather than a
    // hardcoded count: EXPECTED gains a row the moment a provider gets a
    // real contract test (a prerequisite for registering it at all), so
    // this assertion tracks that table instead of needing its own edit —
    // same invariant provider-contract.test.ts's own "EXPECTED covers
    // exactly the registered providers" test guards, checked here too so a
    // registry-only regression (PROVIDERS drifting from EXPECTED) still
    // fails loudly in this file.
    it('includes exactly the providers implemented so far (see provider-contract.test.ts EXPECTED)', () => {
      expect(Object.keys(PROVIDERS).sort()).toEqual(Object.keys(EXPECTED).sort());
    });
  });

  describe('getProvider', () => {
    it('returns Hetzner provider instance', () => {
      const provider = getProvider('hetzner', 'test-token');

      expect(provider).toBeInstanceOf(HetznerProvider);
      expect(provider.apiToken).toBe('test-token');
    });

    it('handles case-insensitive provider name', () => {
      const provider1 = getProvider('HETZNER', 'token');
      const provider2 = getProvider('Hetzner', 'token');

      expect(provider1).toBeInstanceOf(HetznerProvider);
      expect(provider2).toBeInstanceOf(HetznerProvider);
    });

    it('throws for unknown provider', () => {
      expect(() => getProvider('not-a-cloud', 'token')).toThrow('Unknown provider');
      expect(() => getProvider('invalid', 'token')).toThrow('Available providers');
    });
  });

  describe('getProviderClass', () => {
    it('returns HetznerProvider class', () => {
      const ProviderClass = getProviderClass('hetzner');
      expect(ProviderClass).toBe(HetznerProvider);
    });

    it('throws for unknown provider', () => {
      expect(() => getProviderClass('unknown')).toThrow('Unknown provider');
    });

    // Phase B tripwire flip (sanctioned — task B2): 'digitalocean' is now
    // registered (see PROVIDERS in lib/providers/index.js). This replaces
    // the old "not yet registered" tripwire, which existed solely to force
    // this exact edit the moment DigitalOceanProvider landed.
    it('"digitalocean" is now registered (Phase B)', () => {
      expect(getProviderClass('digitalocean')).toBe(DigitalOceanProvider);
    });
  });

  describe('listProviders', () => {
    it('returns array of provider info', () => {
      const providers = listProviders();

      // Derived from EXPECTED (not a literal) so registering provider N+1
      // extends this test instead of tripping a stale hand-count.
      expect(providers).toHaveLength(Object.keys(EXPECTED).length);
      const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
      expect(byId.hetzner.name).toBe('Hetzner Cloud');
      expect(byId.hetzner.regions).toBeDefined();
      expect(byId.hetzner.serverTypes).toBeDefined();
      expect(byId.digitalocean.name).toBe('DigitalOcean');
      expect(byId.digitalocean.regions).toBeDefined();
      expect(byId.digitalocean.serverTypes).toBeDefined();
    });

    it('includes defaultType and haRegions', () => {
      const providers = listProviders();
      const byId = Object.fromEntries(providers.map((p) => [p.id, p]));

      expect(byId.hetzner.defaultType).toBe('cpx22');
      expect(byId.hetzner.haRegions).toEqual(['fsn1', 'hel1']);
      expect(byId.digitalocean.defaultType).toBe('s-2vcpu-4gb');
      expect(byId.digitalocean.haRegions).toEqual(['nyc3', 'sfo3']);
    });
  });

  describe('hasProvider', () => {
    it('returns true for existing provider', () => {
      expect(hasProvider('hetzner')).toBe(true);
      expect(hasProvider('HETZNER')).toBe(true);
    });

    it('returns false for non-existing provider', () => {
      expect(hasProvider('not-a-cloud')).toBe(false);
      expect(hasProvider('aws')).toBe(false);
      expect(hasProvider('')).toBe(false);
    });
  });

  describe('validateProviderConfig', () => {
    it('returns valid for correct config', () => {
      const result = validateProviderConfig('hetzner', {
        region: 'fsn1',
        serverType: 'cpx11',
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns errors for invalid region', () => {
      const result = validateProviderConfig('hetzner', {
        region: 'invalid-region',
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid region');
    });

    it('returns errors for invalid server type', () => {
      const result = validateProviderConfig('hetzner', {
        serverType: 'invalid-type',
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid server type');
    });

    it('returns multiple errors', () => {
      const result = validateProviderConfig('hetzner', {
        region: 'invalid',
        serverType: 'also-invalid',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });

    it('returns error for unknown provider', () => {
      const result = validateProviderConfig('unknown', {});

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Unknown provider');
    });

    it('validates partial config', () => {
      const result = validateProviderConfig('hetzner', {
        region: 'fsn1',
        // serverType not provided
      });

      expect(result.valid).toBe(true);
    });
  });
});
