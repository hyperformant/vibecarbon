import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { migrationsGate } from '@server/middleware/migrations-gate';

// Until the startup migrations are applied the app serves only /api/health
// (and its sub-routes): everything else is a 503 with Retry-After.
describe('migrationsGate', () => {
  const build = (applied: boolean) => {
    const app = new Hono();
    app.use('*', migrationsGate(() => applied));
    app.get('/api/health', (c) => c.text('health'));
    app.get('/api/health/ready', (c) => c.text('ready'));
    app.get('/api/v1/me', (c) => c.text('me'));
    app.get('/dashboard', (c) => c.text('spa'));
    app.get('/api/healthcheck-lookalike', (c) => c.text('nope'));
    return app;
  };

  it('answers 503 for every route but /api/health while migrations are not applied', async () => {
    const app = build(false);
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/health/ready')).status).toBe(200);
    for (const path of ['/api/v1/me', '/dashboard', '/api/healthcheck-lookalike']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
    }
  });

  it('passes everything through once they are', async () => {
    const app = build(true);
    expect(await (await app.request('/api/v1/me')).text()).toBe('me');
    expect(await (await app.request('/dashboard')).text()).toBe('spa');
  });
});
