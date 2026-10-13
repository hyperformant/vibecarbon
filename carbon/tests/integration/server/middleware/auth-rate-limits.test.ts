import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Real limiter (in-memory store: no REDIS_URL in tests) and the real wiring.
// Every test uses its own client IP, so buckets never leak between tests.
const { applyAuthRateLimits } = await import('@server/middleware/auth-rate-limits');
const { createRateLimiter } = await import('@server/lib/rate-limiter');

function app() {
  const a = new Hono();
  applyAuthRateLimits(a);
  a.all('/api/auth/*', (c) => c.text('ok'));
  return a;
}

const shared = app();

async function hit(path: string, ip: string, times: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < times; i++) {
    const res = await shared.request(path, {
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
    });
    statuses.push(res.status);
  }
  return statuses;
}

const allowedThenLimited = (allowed: number) => [
  ...Array(allowed).fill(200),
  429,
];

describe('auth endpoint rate limits (per trusted client IP)', () => {
  it('password sign-in: 10 per 15 minutes', async () => {
    expect(await hit('/api/auth/sign-in/email', '203.0.113.1', 11)).toEqual(allowedThenLimited(10));
  });

  it('social sign-in has its own looser cap, untouched by password attempts', async () => {
    const ip = '203.0.113.2';
    await hit('/api/auth/sign-in/email', ip, 11);
    expect(await hit('/api/auth/sign-in/social', ip, 11)).toEqual(allowedThenLimited(10));
  });

  it('magic link: 5 per minute', async () => {
    expect(await hit('/api/auth/sign-in/magic-link', '203.0.113.3', 6)).toEqual(
      allowedThenLimited(5),
    );
  });

  it('sign-up, change-password, change-email: 3 per 10 seconds', async () => {
    expect(await hit('/api/auth/sign-up/email', '203.0.113.4', 4)).toEqual(allowedThenLimited(3));
    expect(await hit('/api/auth/change-password', '203.0.113.4', 4)).toEqual(allowedThenLimited(3));
    expect(await hit('/api/auth/change-email', '203.0.113.4', 4)).toEqual(allowedThenLimited(3));
  });

  it('password reset and verification email: 3 per minute', async () => {
    expect(await hit('/api/auth/request-password-reset', '203.0.113.5', 4)).toEqual(
      allowedThenLimited(3),
    );
    expect(await hit('/api/auth/send-verification-email', '203.0.113.5', 4)).toEqual(
      allowedThenLimited(3),
    );
  });

  it('second factor: 3 per 10 seconds', async () => {
    expect(await hit('/api/auth/two-factor/verify-totp', '203.0.113.6', 4)).toEqual(
      allowedThenLimited(3),
    );
  });

  it('everything else under /api/auth: the general 100 per minute', async () => {
    const statuses = await hit('/api/auth/get-session', '203.0.113.7', 101);
    expect(statuses.slice(0, 100).every((s) => s === 200)).toBe(true);
    expect(statuses[100]).toBe(429);
  });
});

describe('two limiters on one path keep separate counts', () => {
  it('a general budget does not eat into a strict cap on the same path', async () => {
    const a = new Hono();
    a.use('/p', createRateLimiter({ windowMs: 60_000, max: 100 }));
    a.use('/p', createRateLimiter({ windowMs: 10_000, max: 3 }));
    a.post('/p', (c) => c.text('ok'));
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (await a.request('/p', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' } }))
          .status,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});
