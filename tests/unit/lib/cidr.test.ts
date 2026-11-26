/**
 * canonicalCidr: one string per network, however the CIDR is spelled. A
 * Vultr firewall rule is matched on it (vultrRuleKey), so a rule Vultr
 * stores in another spelling than the one a push sends is still found.
 */
import { describe, expect, it } from 'vitest';
import { canonicalCidr } from '../../../src/lib/cidr.js';

describe('canonicalCidr', () => {
  it.each([
    // IPv4: host bits zeroed.
    ['203.0.113.5/24', '203.0.113.0/24'],
    ['203.0.113.5/32', '203.0.113.5/32'],
    ['203.0.113.255/25', '203.0.113.128/25'],
    ['255.255.255.255/1', '128.0.0.0/1'],
    ['198.51.100.9/0', '0.0.0.0/0'],
    ['0.0.0.0/0', '0.0.0.0/0'],
    // IPv6: lower case, no leading zeros, the longest zero run as `::`.
    ['2001:DB8:0:0:0:0:0:1/128', '2001:db8::1/128'],
    ['2001:0db8::0001/128', '2001:db8::1/128'],
    ['2001:db8:abcd:12::5/48', '2001:db8:abcd::/48'],
    ['::/0', '::/0'],
    ['2001:db8::1/0', '::/0'],
    ['::1/128', '::1/128'],
    ['fe80:0:0:0:0:0:0:0/10', 'fe80::/10'],
    // A tie compresses the first run; one zero group is never compressed.
    ['2001:db8:0:0:1:0:0:1/128', '2001:db8::1:0:0:1/128'],
    ['2001:db8:0:1:1:1:1:1/128', '2001:db8:0:1:1:1:1:1/128'],
    // The longer run wins over an earlier, shorter one.
    ['2001:0:0:1:0:0:0:1/128', '2001:0:0:1::1/128'],
  ])('%s is %s', (cidr, canonical) => {
    expect(canonicalCidr(cidr)).toBe(canonical);
  });

  it.each([
    '203.0.113.5',
    '203.0.113.5/33',
    '203.0.113.5/-1',
    '203.0.113.5/x',
    '203.0.113/24',
    '256.0.0.1/32',
    '2001:db8::1/129',
    '2001:db8:::1/128',
    '2001:db8::g/128',
    '1:2:3:4:5:6:7:8:9/128',
  ])('%s is not a CIDR', (cidr) => {
    expect(canonicalCidr(cidr)).toBeNull();
  });
});
