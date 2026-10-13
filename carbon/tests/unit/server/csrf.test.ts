import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { csrfProtection } from '@server/middleware/csrf';

const saved = {
  SITE_URL: process.env.SITE_URL,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
  NODE_ENV: process.env.NODE_ENV,
};

beforeEach(() => {
  process.env.SITE_URL = 'https://app.example.com';
  delete process.env.CORS_ORIGINS;
  process.env.NODE_ENV = 'production';
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function buildApp() {
  const app = new Hono();
  app.use('/api/*', csrfProtection());
  app.all('/api/*', (c) => c.text('ok'));
  return app;
}

const SAME = 'https://app.example.com';
const EVIL = 'https://evil.example';

function send(
  path: string,
  headers: Record<string, string>,
  { method = 'POST', cookie = true }: { method?: string; cookie?: boolean } = {}
) {
  return buildApp().request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie: 'better-auth.session_token=abc' } : {}),
      ...headers,
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
  });
}

describe('csrfProtection', () => {
  it('refuses a JSON POST from a foreign Origin that carries the session cookie', async () => {
    const res = await send('/api/v1/organizations', { origin: EVIL });
    expect(res.status).toBe(403);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('refuses a foreign-Origin %s too', async (method) => {
    expect((await send('/api/v1/x', { origin: EVIL }, { method })).status).toBe(403);
  });

  it('lets a JSON POST from our own Origin through', async () => {
    expect((await send('/api/v1/organizations', { origin: SAME })).status).toBe(200);
  });

  it('refuses the literal "null" Origin (sandboxed frames, opaque redirects)', async () => {
    expect((await send('/api/v1/x', { origin: 'null' })).status).toBe(403);
    expect(
      (await send('/api/v1/x', { origin: 'null', 'sec-fetch-site': 'same-origin' })).status
    ).toBe(403);
  });

  it('falls back to the Referer origin when Origin is absent', async () => {
    expect((await send('/api/v1/x', { referer: `${SAME}/dashboard?tab=1` })).status).toBe(200);
    expect((await send('/api/v1/x', { referer: `${EVIL}/page` })).status).toBe(403);
    expect((await send('/api/v1/x', { referer: 'not a url' })).status).toBe(403);
  });

  it('with neither Origin nor Referer, only Sec-Fetch-Site: same-origin passes', async () => {
    expect((await send('/api/v1/x', { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await send('/api/v1/x', { 'sec-fetch-site': 'none' })).status).toBe(403);
    expect((await send('/api/v1/x', { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await send('/api/v1/x', {})).status).toBe(403);
  });

  it('a foreign Origin wins over a same-origin Sec-Fetch-Site or Referer', async () => {
    expect(
      (await send('/api/v1/x', { origin: EVIL, 'sec-fetch-site': 'same-origin', referer: SAME }))
        .status
    ).toBe(403);
  });

  it('accepts our origin when SITE_URL carries a trailing slash or a default port', async () => {
    process.env.SITE_URL = 'https://app.example.com/';
    expect((await send('/api/v1/x', { origin: SAME })).status).toBe(200);
    process.env.SITE_URL = 'https://app.example.com:443';
    expect((await send('/api/v1/x', { origin: SAME })).status).toBe(200);
  });

  it('does not check requests without a Cookie header (no ambient session)', async () => {
    expect((await send('/api/v1/x', { origin: EVIL }, { cookie: false })).status).toBe(200);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('does not check %s', async (method) => {
    expect((await send('/api/v1/x', { origin: EVIL }, { method })).status).toBe(200);
  });

  it.each([
    '/api/auth/sign-out',
    '/api/webhooks/billing',
    '/api/_internal/services/status/restart',
  ])('leaves %s to its own checks', async (path) => {
    expect((await send(path, { origin: EVIL })).status).toBe(200);
  });
});
