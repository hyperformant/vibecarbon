import type { User } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';

const { orderMock } = vi.hoisted(() => ({ orderMock: vi.fn() }));

vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ order: orderMock }) }) }),
  },
}));
vi.mock('@server/lib/email', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/lib/env', () => ({ env: { SITE_URL: 'https://app.test' } }));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { adminNewsletterRoutes } = await import('@server/routes/v1/admin/newsletter');

function appWithUser(user: Partial<User> | null) {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    c.set('user', (user as any) ?? null);
    await next();
  });
  app.route('/api/v1/admin/newsletter', adminNewsletterRoutes);
  return app;
}

beforeEach(() => orderMock.mockReset());

describe('admin newsletter super-admin guard (requireSuperAdmin)', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await appWithUser(null).request('/api/v1/admin/newsletter/export');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-super-admin (guard no longer fails closed for admins)', async () => {
    const res = await appWithUser({ id: 'u1', app_metadata: { role: 'authenticated' } }).request(
      '/api/v1/admin/newsletter/export'
    );
    expect(res.status).toBe(403);
  });

  it('allows a super_admin through', async () => {
    orderMock.mockResolvedValue({ data: [], error: null });
    const res = await appWithUser({ id: 'u1', app_metadata: { role: 'super_admin' } }).request(
      '/api/v1/admin/newsletter/export'
    );
    expect(res.status).toBe(200);
  });
});

describe('newsletter CSV export escaping (formula/CSV injection)', () => {
  it('SECURITY: neutralizes a formula-triggering name and quotes fields', async () => {
    orderMock.mockResolvedValue({
      data: [
        {
          email: 'a@b.com',
          name: '=SUM(1+1)',
          status: 'active',
          subscribed_at: null,
          created_at: '2026-01-01',
        },
        {
          email: 'c@d.com',
          name: 'Ada, "The First"',
          status: 'active',
          subscribed_at: '2026-01-02',
          created_at: '2026-01-03',
        },
      ],
      error: null,
    });

    const res = await appWithUser({ id: 'u1', app_metadata: { role: 'super_admin' } }).request(
      '/api/v1/admin/newsletter/export'
    );
    expect(res.status).toBe(200);
    const csv = await res.text();

    // Formula neutralized with a leading apostrophe, and quoted.
    expect(csv).toContain('"\'=SUM(1+1)"');
    // No unescaped formula cell (would let a spreadsheet execute it).
    expect(csv).not.toContain(',=SUM(1+1),');
    // Field with comma + embedded quotes is quoted and quotes doubled.
    expect(csv).toContain('"Ada, ""The First"""');
    // Every field is quoted.
    expect(csv).toContain('"a@b.com"');
  });
});
