import type { User } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { jsonPost } from '../../../_helpers/app';
import type { HonoVariables } from '@server/types';

vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: { from: () => ({ upsert: async () => ({ error: null }) }) },
}));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { themeRoutes } = await import('@server/routes/v1/theme');

function adminApp() {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected super admin
    c.set('user', { id: 'admin1', app_metadata: { role: 'super_admin' } } as Partial<User> as any);
    await next();
  });
  app.route('/api/v1/admin/theme', themeRoutes);
  return app;
}

function patch(theme: unknown) {
  return adminApp().request('/api/v1/admin/theme', {
    ...jsonPost(theme),
    method: 'PATCH',
  });
}

describe('PATCH /admin/theme color/radius validation (stored XSS / CSS injection)', () => {
  it('accepts valid oklch / hex colors and a unit radius', async () => {
    const res = await patch({
      light: { primary: 'oklch(0.52 0.124 192)', destructive: '#ff0000' },
      dark: { primary: 'oklch(0.82 0.14 192)' },
      radius: '0.625rem',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('SECURITY: rejects a CSS breakout payload in a color field', async () => {
    const res = await patch({ light: { primary: 'red; } body { background: url(//evil) } .x {' } });
    expect(res.status).toBe(400);
  });

  it('SECURITY: rejects a non-color string (e.g. url / expression)', async () => {
    const res = await patch({ light: { warning: 'url(javascript:alert(1))' } });
    expect(res.status).toBe(400);
  });

  it('SECURITY: rejects a radius that smuggles extra declarations', async () => {
    const res = await patch({ radius: '1rem; } :root { --primary: red' });
    expect(res.status).toBe(400);
  });

  it('accepts rgb()/hsl() color forms', async () => {
    const res = await patch({
      light: { primary: 'rgb(12, 34, 56)', secondaryAccent: 'hsl(210, 50%, 40%)' },
    });
    expect(res.status).toBe(200);
  });
});
