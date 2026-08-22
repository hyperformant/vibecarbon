import { describe, expect, it } from 'vitest';
import { cidrContainsIp, cidrFromIp, findMatchingCidr } from '../../../src/lib/operator-ip.js';

describe('cidrFromIp', () => {
  it('formats IPv4 as /32', () => {
    expect(cidrFromIp('1.2.3.4', 4)).toBe('1.2.3.4/32');
  });

  it('formats IPv6 as /128', () => {
    expect(cidrFromIp('2001:db8::1', 6)).toBe('2001:db8::1/128');
  });
});

describe('cidrContainsIp — IPv4', () => {
  it('matches an exact /32', () => {
    expect(cidrContainsIp('1.2.3.4/32', '1.2.3.4', 4)).toBe(true);
  });

  it('rejects a different IP at /32', () => {
    expect(cidrContainsIp('1.2.3.4/32', '1.2.3.5', 4)).toBe(false);
  });

  it('matches an IP within a /24', () => {
    expect(cidrContainsIp('1.2.3.0/24', '1.2.3.99', 4)).toBe(true);
  });

  it('rejects an IP outside a /24', () => {
    expect(cidrContainsIp('1.2.3.0/24', '1.2.4.1', 4)).toBe(false);
  });

  it('matches everything at /0', () => {
    expect(cidrContainsIp('0.0.0.0/0', '99.99.99.99', 4)).toBe(true);
  });

  it('rejects an IPv6 IP against an IPv4 CIDR', () => {
    expect(cidrContainsIp('1.2.3.0/24', '2001:db8::1', 6)).toBe(false);
  });

  it('rejects malformed CIDR (no slash)', () => {
    expect(cidrContainsIp('1.2.3.4', '1.2.3.4', 4)).toBe(false);
  });

  it('rejects negative or oversized prefix', () => {
    expect(cidrContainsIp('1.2.3.4/-1', '1.2.3.4', 4)).toBe(false);
    expect(cidrContainsIp('1.2.3.4/33', '1.2.3.4', 4)).toBe(false);
  });

  it('rejects a malformed IPv4 with out-of-range octet', () => {
    expect(cidrContainsIp('1.2.3.999/32', '1.2.3.4', 4)).toBe(false);
  });
});

describe('cidrContainsIp — IPv6', () => {
  it('matches an exact /128', () => {
    expect(cidrContainsIp('2001:db8::1/128', '2001:db8::1', 6)).toBe(true);
  });

  it('matches within a /64', () => {
    expect(cidrContainsIp('2001:db8::/64', '2001:db8::abcd', 6)).toBe(true);
  });

  it('rejects an IP outside a /64', () => {
    expect(cidrContainsIp('2001:db8::/64', '2001:db9::1', 6)).toBe(false);
  });

  it('matches everything at /0', () => {
    expect(cidrContainsIp('::/0', '2001:db8::1', 6)).toBe(true);
  });

  it('rejects an IPv4 IP against an IPv6 CIDR', () => {
    expect(cidrContainsIp('2001:db8::/64', '1.2.3.4', 4)).toBe(false);
  });

  it('handles double-colon shorthand on both sides', () => {
    expect(cidrContainsIp('2001:db8::/32', '2001:db8::1:2:3:4', 6)).toBe(true);
  });
});

describe('findMatchingCidr', () => {
  const list = [
    { cidr: '1.2.3.4/32', addedAt: '2026-04-01T00:00:00Z', lastUsedAt: '2026-04-01T00:00:00Z' },
    { cidr: '10.0.0.0/8', addedAt: '2026-04-02T00:00:00Z', lastUsedAt: '2026-04-02T00:00:00Z' },
    { cidr: '2001:db8::/64', addedAt: '2026-04-03T00:00:00Z', lastUsedAt: '2026-04-03T00:00:00Z' },
  ];

  it('matches an exact /32 entry', () => {
    expect(findMatchingCidr(list, '1.2.3.4', 4)?.cidr).toBe('1.2.3.4/32');
  });

  it('matches an IP covered by a broader CIDR', () => {
    expect(findMatchingCidr(list, '10.5.5.5', 4)?.cidr).toBe('10.0.0.0/8');
  });

  it('matches an IPv6 IP within an IPv6 CIDR', () => {
    expect(findMatchingCidr(list, '2001:db8::abcd', 6)?.cidr).toBe('2001:db8::/64');
  });

  it('returns null for an unmatched IP', () => {
    expect(findMatchingCidr(list, '99.99.99.99', 4)).toBeNull();
  });

  it('returns null for empty list', () => {
    expect(findMatchingCidr([], '1.2.3.4', 4)).toBeNull();
  });
});
