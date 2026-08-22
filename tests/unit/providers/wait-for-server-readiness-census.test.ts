import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CENSUS — every registered provider's `waitForServer` must gate on that
 * provider's OPERATING-SYSTEM readiness field, never on a subscription /
 * billing / power field that goes "ready" before the machine boots.
 *
 * The class this guards against: a provider gate copied from a sibling because
 * the field SPELLS the same, while the provider's API gives it a different
 * meaning. Vultr shipped exactly that — `status === 'active'`, verbatim from
 * DigitalOcean, where `active` is genuinely the droplet's running state. On
 * Vultr `status` is the SUBSCRIPTION state and `server_status` is the OS. The
 * gate returned ~22s into a ~295s boot (CI run 31663154544), pushing the wait
 * onto waitForSSH, which spent 273s against an unroutable IP and nearly
 * exhausted its probe budget. Reading the Vultr provider next to its siblings
 * does not reveal this; only the wire semantics do.
 *
 * So this census is BEHAVIORAL, not textual. Each provider gets a wire-shaped
 * "provisioned but not yet booted" instance and a "booted" instance, both
 * grounded in that provider's own documented status vocabulary. A correct gate
 * keeps polling past the first and resolves on the second. A source-text pin
 * would only echo whatever the code says and could not catch the next
 * copy-by-analogy; this can.
 *
 * Completeness is asserted against the PROVIDERS registry, so adding a
 * provider without a readiness fixture fails here rather than silently
 * shipping an unguarded gate.
 */

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
}));

import { PROVIDERS } from '../../../src/lib/providers/index.js';

function resp(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

/**
 * Per-provider wire fixtures. `notBooted` is the shape the provider's API
 * actually returns while the machine is still being built; `booted` is the
 * shape once the OS is up and reachable. `wrap` mirrors how each API nests the
 * object in its GET response.
 *
 * Documented status vocabularies:
 *   hetzner       initializing|starting|running|stopping|off|deleting|...
 *   digitalocean  new|active|off|archive
 *   linode        provisioning|booting|running|shutting_down|...
 *   vultr         status: pending|active   server_status: none|locked|installingbooting|ok
 *   scaleway      state: stopped|starting|running|stopping
 */
const FIXTURES: Record<
  string,
  {
    wrap: (o: object) => object;
    notBooted: object;
    booted: object;
    why: string;
    /**
     * Optional provider-specific setup so that ONE poll costs exactly ONE
     * mocked fetch. Without this the call-count assertions below measure
     * incidental plumbing instead of the readiness gate.
     */
    prime?: (provider: Record<string, unknown>) => void;
  }
> = {
  hetzner: {
    wrap: (server) => ({ server }),
    why: 'status is initializing until the OS is up',
    notBooted: { status: 'initializing', public_net: { ipv4: { ip: '192.0.2.10' } } },
    booted: { status: 'running', public_net: { ipv4: { ip: '192.0.2.10' } } },
  },
  digitalocean: {
    wrap: (droplet) => ({ droplet }),
    why: 'new -> active is the droplet OS state on DO',
    notBooted: { status: 'new', networks: { v4: [{ type: 'public', ip_address: '192.0.2.20' }] } },
    booted: {
      status: 'active',
      networks: { v4: [{ type: 'public', ip_address: '192.0.2.20' }] },
    },
  },
  linode: {
    wrap: (instance) => instance,
    why: 'provisioning/booting precede running',
    notBooted: { status: 'provisioning', ipv4: ['192.0.2.30'] },
    booted: { status: 'running', ipv4: ['192.0.2.30'] },
  },
  vultr: {
    wrap: (instance) => ({ instance }),
    why: 'status flips to active while server_status is still installingbooting',
    notBooted: {
      status: 'active',
      power_status: 'running',
      server_status: 'installingbooting',
      main_ip: '192.0.2.40',
    },
    booted: {
      status: 'active',
      power_status: 'running',
      server_status: 'ok',
      main_ip: '192.0.2.40',
    },
  },
  scaleway: {
    wrap: (server) => ({ server }),
    why: 'starting precedes running',
    // getServer() resolves the server's zone first, which costs its own
    // fetch(es) per poll. Pre-seed the zone cache so each poll is one fetch and
    // the counts below measure the gate, not the zone probe.
    prime: (provider) => {
      provider._zoneCache = new Map([['srv-1', 'fr-par-1']]);
    },
    notBooted: {
      state: 'starting',
      public_ips: [{ family: 'inet', address: '192.0.2.50' }],
    },
    booted: {
      state: 'running',
      public_ips: [{ family: 'inet', address: '192.0.2.50' }],
    },
  },
};

describe('waitForServer OS-readiness census', () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('covers every provider in the PROVIDERS registry', () => {
    // A new provider must bring a readiness fixture with it.
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(PROVIDERS).sort());
  });

  for (const [name, fixture] of Object.entries(FIXTURES)) {
    describe(name, () => {
      it(`keeps polling while the OS is not up yet (${fixture.why})`, async () => {
        fetchWithRetryMock
          .mockResolvedValueOnce(resp(fixture.wrap(fixture.notBooted)))
          .mockResolvedValueOnce(resp(fixture.wrap(fixture.booted)));

        const provider = new PROVIDERS[name](`tok-${name}`);
        fixture.prime?.(provider);
        const pending = provider.waitForServer('srv-1', 600_000);
        await vi.advanceTimersByTimeAsync(6_000);
        await pending;

        // Two polls: the gate rejected the not-booted shape and went round again.
        expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
      });

      it('resolves on the first poll once the OS is up', async () => {
        fetchWithRetryMock.mockResolvedValueOnce(resp(fixture.wrap(fixture.booted)));

        const provider = new PROVIDERS[name](`tok-${name}`);
        fixture.prime?.(provider);
        const out = await provider.waitForServer('srv-1', 600_000);

        expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
        expect(out).toBeTruthy();
      });
    });
  }
});
