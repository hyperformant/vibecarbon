import { beforeEach, describe, expect, it, vi } from 'vitest';

// getClientIp imports env (which validates real env vars at import time) and
// logger. Mock both so this unit test is hermetic and can drive NODE_ENV /
// TRUSTED_PROXY_HOPS directly.
const { fakeEnv } = vi.hoisted(() => ({
  fakeEnv: { NODE_ENV: 'production', TRUSTED_PROXY_HOPS: 1 } as {
    NODE_ENV: string;
    TRUSTED_PROXY_HOPS: number;
  },
}));

vi.mock('@server/lib/env', () => ({ env: fakeEnv }));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { getClientIp } = await import('@server/lib/client-ip');

// Minimal context double: only needs req.header(name).
function ctx(headers: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { req: { header: (name: string) => lower[name.toLowerCase()] } };
}

beforeEach(() => {
  fakeEnv.NODE_ENV = 'production';
  fakeEnv.TRUSTED_PROXY_HOPS = 1;
});

describe('getClientIp — trusted-proxy-aware resolution', () => {
  it('returns the entry Traefik appended (rightmost) with a single trusted hop', () => {
    // Traefik appends the real client IP to the right of whatever the client sent.
    const ip = getClientIp(ctx({ 'x-forwarded-for': '203.0.113.9, 198.51.100.7' }));
    expect(ip).toBe('198.51.100.7');
  });

  it('SECURITY: a spoofed leftmost XFF cannot change the resolved identity', () => {
    // Same real client (rightmost), different attacker-supplied leftmost values.
    // If the resolver keyed off the leftmost, these would resolve differently and
    // let an attacker mint a fresh rate-limit / lockout bucket per request.
    const a = getClientIp(ctx({ 'x-forwarded-for': '1.1.1.1, 198.51.100.7' }));
    const b = getClientIp(ctx({ 'x-forwarded-for': '2.2.2.2, 198.51.100.7' }));
    const c = getClientIp(ctx({ 'x-forwarded-for': 'attacker-junk, 198.51.100.7' }));
    expect(a).toBe('198.51.100.7');
    expect(b).toBe('198.51.100.7');
    expect(c).toBe('198.51.100.7');
  });

  it('handles a single-entry XFF (direct client → Traefik)', () => {
    expect(getClientIp(ctx({ 'x-forwarded-for': '198.51.100.7' }))).toBe('198.51.100.7');
  });

  it('honours a deeper trusted-proxy hop count (counts from the right)', () => {
    fakeEnv.TRUSTED_PROXY_HOPS = 2;
    const ip = getClientIp(ctx({ 'x-forwarded-for': '1.1.1.1, 198.51.100.7, 203.0.113.1' }));
    expect(ip).toBe('198.51.100.7');
  });

  it('does NOT trust x-real-ip / cf-connecting-ip (Traefik does not set them)', () => {
    const ip = getClientIp(
      ctx({ 'x-real-ip': '6.6.6.6', 'cf-connecting-ip': '7.7.7.7' })
    );
    expect(ip).toBe('unknown');
  });

  it('fails closed to a shared sentinel when no trusted IP is derivable (prod)', () => {
    expect(getClientIp(ctx({}))).toBe('unknown');
  });

  it('falls back to localhost in development', () => {
    fakeEnv.NODE_ENV = 'development';
    expect(getClientIp(ctx({}))).toBe('localhost');
  });
});
