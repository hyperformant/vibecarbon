import { describe, expect, it, vi } from 'vitest';

/**
 * getClientIp (src/server/lib/client-ip.ts): the trusted X-Forwarded-For
 * entry is trimmed, may be IPv6, and must look like an address; anything else
 * resolves to the shared 'unknown' bucket. The resolution rules themselves are
 * in client-ip.test.ts.
 */

vi.mock('@server/lib/env', () => ({ env: { NODE_ENV: 'production', TRUSTED_PROXY_HOPS: 1 } }));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { getClientIp } = await import('@server/lib/client-ip');

function fromXff(xff: string): string {
  return getClientIp({
    req: { header: (name: string) => (name === 'x-forwarded-for' ? xff : undefined) },
  });
}

describe('getClientIp: the trusted X-Forwarded-For entry', () => {
  it('is trimmed', () => {
    expect(fromXff('  198.51.100.7  ')).toBe('198.51.100.7');
  });

  it('may be a full IPv6 address', () => {
    expect(fromXff('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(
      '2001:0db8:85a3:0000:0000:8a2e:0370:7334'
    );
  });

  it('may be a compressed IPv6 address', () => {
    expect(fromXff('2001:db8::1')).toBe('2001:db8::1');
  });

  it.each([
    ['script content', 'javascript:alert(1)'],
    ['an SQL injection attempt', "1.2.3.4'; DROP TABLE users; --"],
    ['HTML', '<script>alert(1)</script>'],
  ])('resolves to unknown when it is %s', (_what, xff) => {
    expect(fromXff(xff)).toBe('unknown');
  });
});
