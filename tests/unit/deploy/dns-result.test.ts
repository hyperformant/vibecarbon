import { describe, expect, it } from 'vitest';
import { requireDnsSetup } from '../../../src/lib/deploy/dns-result.js';

describe('requireDnsSetup', () => {
  it('passes a successful result through', () => {
    const ok = { success: true, mode: 'simple' };
    expect(requireDnsSetup(ok, 'DNS A record for app.example.com')).toBe(ok);
  });

  it('throws one line naming what failed and why on a refused write', () => {
    expect(() =>
      requireDnsSetup(
        { success: false, error: 'Failed to create DNS record (HTTP 403): Authentication error' },
        'DNS A record for app.example.com',
      ),
    ).toThrow(
      'DNS A record for app.example.com was not set: Failed to create DNS record (HTTP 403): Authentication error',
    );
  });

  it('a result with no error text still names the refusal', () => {
    expect(() => requireDnsSetup({ success: false }, 'x')).toThrow(/refused the write/);
  });
});
