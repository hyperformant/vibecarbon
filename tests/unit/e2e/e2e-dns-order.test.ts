/**
 * The e2e harness resolves IPv4 first, the same as the CLI (src/cli.js).
 *
 * The harness makes its own connections: health checks, API sweeps and the
 * bucket settle gate's parallel preflights. With Node's default order, on a
 * machine with no IPv6 route, a dual-stack host fails a share of parallel
 * connections with ETIMEDOUT. On 2026-11-04 that made a healthy Hetzner bucket
 * fail the settle gate after 25 minutes.
 */
import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('matches the order the CLI sets', () => {
    const cli = readFileSync(join(import.meta.dirname, '../../../src/cli.js'), 'utf-8');
    expect(cli).toContain("dns.setDefaultResultOrder('ipv4first')");
  });
});
