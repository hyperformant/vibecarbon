import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * createRateLimiter (src/server/lib/rate-limiter.ts) over its in-memory store
 * (no REDIS_URL in tests): the count per window, the window reset, and the
 * X-RateLimit headers and 429 body a client sees. The clock is fake so the
 * window is exact; each test uses its own client IP, so buckets never leak.
 */

vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { createRateLimiter } = await import('@server/lib/rate-limiter');

const WINDOW_MS = 60_000;
const START = new Date('2026-01-01T00:00:00.000Z').getTime();

function appWith(max: number, windowMs = WINDOW_MS) {
  const app = new Hono();
  app.use('*', createRateLimiter({ windowMs, max }));
  app.get('/x', (c) => c.text('ok'));
  return app;
}

function from(app: Hono, ip: string) {
  return app.request(new Request('http://local.test/x', { headers: { 'x-forwarded-for': ip } }));
}

function headers(res: Response) {
  return {
    limit: res.headers.get('X-RateLimit-Limit'),
    remaining: res.headers.get('X-RateLimit-Remaining'),
    reset: res.headers.get('X-RateLimit-Reset'),
  };
}

beforeAll(() => {
  vi.useFakeTimers();
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  vi.setSystemTime(START);
});

describe('rate limiter: the count in one window', () => {
  it('lets the first request through with max - 1 remaining', async () => {
    const res = await from(appWith(10), '198.51.100.1');
    expect(res.status).toBe(200);
    expect(headers(res)).toMatchObject({ limit: '10', remaining: '9' });
  });

  it('counts each further request', async () => {
    const app = appWith(10);
    await from(app, '198.51.100.2');
    const res = await from(app, '198.51.100.2');
    expect(res.status).toBe(200);
    expect(headers(res).remaining).toBe('8');
  });

  it('lets requests through up to the limit', async () => {
    const app = appWith(3);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await from(app, '198.51.100.3')).status);
    expect(statuses).toEqual([200, 200, 200]);
  });

  it('refuses the request over the limit with 429', async () => {
    const app = appWith(3);
    for (let i = 0; i < 3; i++) await from(app, '198.51.100.4');
    expect((await from(app, '198.51.100.4')).status).toBe(429);
  });

  it('keeps a separate count per client', async () => {
    const app = appWith(10);
    await from(app, '198.51.100.5');
    await from(app, '198.51.100.5');
    expect(headers(await from(app, '198.51.100.6')).remaining).toBe('9');
    expect(headers(await from(app, '198.51.100.5')).remaining).toBe('7');
  });

  it('keeps one reset time for the whole window', async () => {
    const app = appWith(10);
    const first = headers(await from(app, '198.51.100.7')).reset;
    vi.setSystemTime(START + 30_000);
    expect(headers(await from(app, '198.51.100.7')).reset).toBe(first);
  });

  it('starts a fresh count once the window has passed', async () => {
    const app = appWith(2, 100);
    await from(app, '198.51.100.8');
    await from(app, '198.51.100.8');
    vi.setSystemTime(START + 110);
    const res = await from(app, '198.51.100.8');
    expect(res.status).toBe(200);
    expect(headers(res).remaining).toBe('1');
  });
});

describe('rate limiter: what the client sees', () => {
  it('sends the reset time as Unix seconds', async () => {
    const res = await from(appWith(10), '198.51.100.9');
    expect(headers(res).reset).toBe(String(Math.ceil((START + WINDOW_MS) / 1000)));
  });

  it('sends all three headers on an allowed request, and the handler’s body', async () => {
    const res = await from(appWith(10), '198.51.100.10');
    expect(headers(res)).toEqual({
      limit: '10',
      remaining: '9',
      reset: String(Math.ceil((START + WINDOW_MS) / 1000)),
    });
    expect(await res.text()).toBe('ok');
  });

  it('sends all three headers on a refused request, remaining 0 and never negative', async () => {
    const app = appWith(1);
    await from(app, '198.51.100.11');
    await from(app, '198.51.100.11');
    const res = await from(app, '198.51.100.11');
    expect(res.status).toBe(429);
    expect(headers(res)).toEqual({
      limit: '1',
      remaining: '0',
      reset: String(Math.ceil((START + WINDOW_MS) / 1000)),
    });
  });

  it('answers 429 with the error and the seconds until the window resets', async () => {
    const app = appWith(1);
    await from(app, '198.51.100.12');
    vi.setSystemTime(START + 15_000);
    const res = await from(app, '198.51.100.12');
    expect(await res.json()).toEqual({ error: 'Too many requests', retryAfter: 45 });
  });

  it('rounds retryAfter up to the next whole second', async () => {
    const app = appWith(1);
    await from(app, '198.51.100.13');
    vi.setSystemTime(START + 14_500);
    const res = await from(app, '198.51.100.13');
    expect(((await res.json()) as { retryAfter: number }).retryAfter).toBe(46);
  });
});
