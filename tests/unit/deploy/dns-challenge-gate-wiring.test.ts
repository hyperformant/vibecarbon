import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WIRING — `updateDns` must run the right DNS gate for the challenge type it
 * is about to hand to the ACME client.
 *
 * A unit test of `waitForZoneServed` alone would not have caught the bug this
 * guards: the gate existed nowhere, and the DNS-01 branch simply had no `else`.
 * The defect was at the CALL SITE, so the test has to drive the real effect.
 *
 *   HTTP-01 -> waitForDNSPropagation  (is the A record visible to resolvers?)
 *   DNS-01  -> waitForZoneServed      (do the zone's own nameservers answer?)
 *
 * Running the wrong one is silently useless: polling for an A record proves
 * nothing about whether ns1-5.linode.com will answer the TXT lookup, and vice
 * versa.
 */

const waitForDNSPropagation = vi.fn(async () => true);
const waitForZoneServed = vi.fn(async () => ({
  served: true,
  detail: 'example.com authoritative at ns1.linode.com',
  waitedMs: 12,
}));

vi.mock('../../../src/lib/dns-propagation.js', () => ({
  waitForDNSPropagation,
  waitForZoneServed,
  resolveNameservers: vi.fn(),
}));

const setupSimple = vi.fn(async () => {});
vi.mock('../../../src/lib/dns-provider.js', () => ({
  getDnsProvider: async () => ({ setupSimple }),
  DNS01_PROVIDERS: { linode: { tokenEnvVar: 'LINODE_TOKEN' } },
}));

vi.mock('@clack/prompts', () => {
  const mk = () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() });
  return {
    spinner: mk,
    // progress.js's stop() routes through log.success/log.error, so a partial
    // logger mock fails inside the wrapper rather than in the code under test.
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      step: vi.fn(),
      message: vi.fn(),
    },
  };
});

import { EFFECTS } from '../../../src/lib/deploy/effects/index.js';

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    domain: 'e1.example.com',
    serverIp: '203.0.113.10',
    dnsProvider: 'linode',
    dnsZoneId: 'zone-1',
    dnsToken: 'tok',
    dnsWarmupPromise: Promise.resolve(),
    state: { shouldSkip: () => false, startStep: vi.fn(), completeStep: vi.fn() },
    ...overrides,
  };
}

describe('updateDns challenge-type gate wiring', () => {
  beforeEach(() => {
    waitForDNSPropagation.mockClear();
    waitForZoneServed.mockClear();
    setupSimple.mockClear();
  });

  it('runs the zone-served poll on a DNS-01 deploy, not the A-record poll', async () => {
    await EFFECTS.updateDns(ctx({ dnsChallenge: true }));

    expect(waitForZoneServed).toHaveBeenCalledTimes(1);
    expect(waitForZoneServed).toHaveBeenCalledWith('e1.example.com', expect.any(Object));
    expect(waitForDNSPropagation).not.toHaveBeenCalled();
  });

  it('runs the A-record poll on an HTTP-01 deploy, not the zone-served poll', async () => {
    await EFFECTS.updateDns(ctx({ dnsChallenge: false }));

    expect(waitForDNSPropagation).toHaveBeenCalledTimes(1);
    expect(waitForDNSPropagation).toHaveBeenCalledWith('e1.example.com', '203.0.113.10', 120_000);
    expect(waitForZoneServed).not.toHaveBeenCalled();
  });

  it('proceeds when the zone never becomes served (fail-open)', async () => {
    waitForZoneServed.mockResolvedValueOnce({
      served: false,
      detail: 'ns1.linode.com returned REFUSED for example.com',
      waitedMs: 180_000,
    });

    // The assertion IS that this resolves rather than throwing: a zone that
    // never publishes must not be the reason a deploy fails.
    await expect(EFFECTS.updateDns(ctx({ dnsChallenge: true }))).resolves.toBeUndefined();
  });

  it('gives the zone poll a bounded budget', async () => {
    await EFFECTS.updateDns(ctx({ dnsChallenge: true }));

    const [, options] = waitForZoneServed.mock.calls[0] as [string, { timeoutMs: number }];
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(600_000);
  });
});
