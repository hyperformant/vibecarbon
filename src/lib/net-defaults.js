/**
 * How every process we own connects: the CLI and the e2e harness.
 *
 * IPv4 first, because on a machine with broken IPv6 a dual-stack host can
 * otherwise hang fetch().
 *
 * The attempt timeout is the time Node gives each address but the last before
 * it drops that attempt and moves on. Its default of 250 ms is under one round
 * trip on a slow path, and Node aborts the attempt where RFC 8305 would race
 * it. So on a machine with no IPv6 route, a dual-stack host fails with
 * ETIMEDOUT whenever the IPv4 connect takes longer than that: the only address
 * left is one the machine cannot reach. S3 retries then spend 5 and 10 s
 * waiting, and any check that needs every request clean can never pass.
 *
 * Long enough for two lost SYNs (1 s, then 2 s) plus a slow round trip. A
 * machine whose IPv4 is truly dead pays this once per connection before it
 * falls through to IPv6.
 */

import dns from 'node:dns';
import net from 'node:net';

export const CONNECT_ATTEMPT_TIMEOUT_MS = 3_500;

export function applyNetworkDefaults() {
  dns.setDefaultResultOrder('ipv4first');
  net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
}
