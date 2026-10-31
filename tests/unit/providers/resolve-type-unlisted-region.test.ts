/**
 * With the live catalog loaded, a location the catalog does not list stocks
 * nothing: resolveServerTypeForRegion answers null there (the standbyStandIn
 * answer for a location with nothing orderable), as cheapestRoleSet does,
 * never the requested type it cannot place. Offline, with no catalog, the
 * requested type is still assumed placeable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { seedCatalog } from '../helpers/catalog-fixtures.js';

const { getProviderClass } = await import('../../../src/lib/providers/index.js');
const { cheapestRoleSet } = await import('../../../src/lib/sizing.js');

const PROVIDERS = ['hetzner', 'digitalocean', 'vultr', 'linode', 'scaleway'] as const;
const UNLISTED = 'zz-nowhere-1';

describe.each(PROVIDERS)(
  '%s resolveServerTypeForRegion in a location the catalog does not list',
  (id) => {
    const Provider = getProviderClass(id);
    let restore: (() => void) | undefined;
    afterEach(() => {
      restore?.();
      restore = undefined;
    });

    it('live: null, agreeing with cheapestRoleSet', () => {
      restore = seedCatalog(Provider, `2026-10-22/${id}`);
      const type = Provider.DEFAULT_COMPOSE_TYPE;
      expect(cheapestRoleSet(Provider, UNLISTED, ['compose'])).toBeNull();
      expect(Provider.resolveServerTypeForRegion(type, UNLISTED, 'compose')).toBeNull();
    });

    it('offline: the requested type', () => {
      expect(Provider._locationTypes ?? null).toBeNull();
      const type = Provider.DEFAULT_COMPOSE_TYPE;
      expect(Provider.resolveServerTypeForRegion(type, UNLISTED, 'compose')).toBe(type);
    });
  },
);
