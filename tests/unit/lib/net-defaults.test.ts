/**
 * Every process we own connects the same way: IPv4 first, with enough time
 * for a slow path to finish connecting.
 *
 * Node gives each address but the last 250 ms before it gives up on it. On a
 * machine with no IPv6 route, a dual-stack host then fails with ETIMEDOUT
 * whenever the IPv4 connect is slower than that, because the only address
 * left is one the machine cannot reach. On 2026-11-05, 9% of pings from the
 * operator's laptop to Hetzner object storage took over 250 ms, which failed
 * a healthy bucket's settle gate after 25 minutes.
 */
import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyNetworkDefaults, CONNECT_ATTEMPT_TIMEOUT_MS } from '../../../src/lib/net-defaults.js';

const repoFile = (rel: string) => readFileSync(join(import.meta.dirname, '../../..', rel), 'utf-8');

describe('applyNetworkDefaults', () => {
  let order: ReturnType<typeof dns.getDefaultResultOrder>;
  let attemptTimeout: number;

  beforeEach(() => {
    order = dns.getDefaultResultOrder();
    attemptTimeout = net.getDefaultAutoSelectFamilyAttemptTimeout();
  });

  afterEach(() => {
    dns.setDefaultResultOrder(order);
    net.setDefaultAutoSelectFamilyAttemptTimeout(attemptTimeout);
  });

  it('resolves IPv4 first', () => {
    dns.setDefaultResultOrder('verbatim');
    applyNetworkDefaults();
    expect(dns.getDefaultResultOrder()).toBe('ipv4first');
  });

  it("replaces Node's 250 ms connect budget", () => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(250);
    applyNetworkDefaults();
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_TIMEOUT_MS);
  });

  it('survives a dropped SYN on a slow path', () => {
    // A lost SYN comes back after 1 s, a second after 2 s more, plus the RTT.
    expect(CONNECT_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(3_000 + 300);
  });
});

describe('who applies them', () => {
  it('is the only place these defaults are set', () => {
    for (const file of ['src/cli.js', 'tests/e2e/utils/e2e-env.js']) {
      const source = repoFile(file);
      expect(source, file).toContain('applyNetworkDefaults()');
      expect(source, file).not.toContain('setDefaultResultOrder');
      expect(source, file).not.toContain('setDefaultAutoSelectFamily');
    }
  });
});
