import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServiceUrl } from '../../../src/client/lib/admin-services';
import type { AdminService } from '../../../src/client/lib/admin-services';

/**
 * Dev links must carry the traefik port on port-shifted stacks
 * (DEV_PORT_OFFSET / VITE_DEV_PORT_OFFSET, written by `vibecarbon up` when
 * another project holds the default ports). A port-less `studio.localhost`
 * link lands on whichever OTHER project owns :80 — RCA 2026-07-17: swim2's
 * admin panel linked into my-app's traefik and hit its Gateway Timeout.
 */
const studio = { subdomain: 'studio' } as AdminService;

function stubLocation(hostname: string) {
  vi.stubGlobal('window', {
    location: { protocol: 'http:', hostname, origin: `http://${hostname}` },
  });
}

describe('getServiceUrl on localhost', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('omits the port on an unshifted stack (offset 0 / unset)', () => {
    stubLocation('app.localhost');
    expect(getServiceUrl(studio)).toBe('http://studio.localhost');
  });

  it('appends the shifted traefik port when VITE_DEV_PORT_OFFSET is set', () => {
    stubLocation('app.localhost');
    vi.stubEnv('VITE_DEV_PORT_OFFSET', '100');
    expect(getServiceUrl(studio)).toBe('http://studio.localhost:180');
  });
});
