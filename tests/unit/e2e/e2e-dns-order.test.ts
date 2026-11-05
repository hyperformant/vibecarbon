/**
 * The e2e harness connects the way the CLI does (src/lib/net-defaults.js).
 *
 * The harness makes its own connections: health checks, API sweeps and the
 * bucket settle gate's parallel preflights.
 */
import dns from 'node:dns';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pinPublicDns } from '../../e2e/utils/e2e-env.js';

describe('pinPublicDns', () => {
  let order: ReturnType<typeof dns.getDefaultResultOrder>;
  let servers: string[];

  beforeEach(() => {
    order = dns.getDefaultResultOrder();
    servers = dns.getServers();
  });

  afterEach(() => {
    dns.setDefaultResultOrder(order);
    dns.setServers(servers);
  });

  it('resolves IPv4 first', () => {
    dns.setDefaultResultOrder('verbatim');
    pinPublicDns();
    expect(dns.getDefaultResultOrder()).toBe('ipv4first');
  });
});
