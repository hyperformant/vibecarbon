import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Real rate limiter + real trusted-IP resolver. No REDIS_URL in test env, so it
// uses the in-memory store. Freeze timers so the InMemoryStore's cleanup
// interval never fires and all requests land in the same window.
const { createRateLimiter } = await import('@server/lib/rate-limiter');

function appWithLimiter() {
  const app = new Hono();
  app.use('*', createRateLimiter({ windowMs: 60_000, max: 1 }));
  app.get('/x', (c) => c.text('ok'));
  return app;
}

function xffReq(xff: string) {
  return new Request('http://local.test/x', { headers: { 'x-forwarded-for': xff } });
}

beforeAll(() => {
  vi.useFakeTimers();
});
afterAll(() => {
  vi.useRealTimers();
});

describe('rate limiter buckets by the trusted client IP, not spoofable XFF', () => {
  it('SECURITY: rotating the spoofable leftmost XFF cannot mint a fresh bucket', async () => {
    const app = appWithLimiter();

    // First request from real client 198.51.100.7 (rightmost, Traefik-appended).
    const first = await app.request(xffReq('1.1.1.1, 198.51.100.7'));
    expect(first.status).toBe(200);

    // Second request: attacker rotates the leftmost value hoping for a new bucket.
    // Same real client → same bucket → limited (max: 1).
    const second = await app.request(xffReq('2.2.2.2, 198.51.100.7'));
    expect(second.status).toBe(429);

    // Control: a genuinely different real client (different rightmost) is a fresh bucket.
    const other = await app.request(xffReq('2.2.2.2, 203.0.113.42'));
    expect(other.status).toBe(200);
  });
});
