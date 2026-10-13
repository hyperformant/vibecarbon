import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

const { apiCors } = await import('@server/middleware/cors');

function app() {
  const a = new Hono();
  a.use('/api/*', apiCors());
  a.post('/api/v1/echo', (c) => c.json({ ok: true }));
  return a;
}

const preflight = (origin: string) =>
  app().request('/api/v1/echo', {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });

describe('CORS preflight for cookie-authenticated JSON requests', () => {
  it('a foreign origin gets no Access-Control-Allow-Origin, so the browser never sends', async () => {
    const res = await preflight('https://evil.example');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('our own origin (SITE_URL) is allowed, with credentials', async () => {
    const site = process.env.SITE_URL as string;
    const res = await preflight(site);
    expect(res.headers.get('access-control-allow-origin')).toBe(site);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
