import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';

vi.mock('@server/lib/supabase', () => ({ supabaseAdmin: { from: vi.fn() } }));
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/lib/email', () => ({ sendEmail: vi.fn() }));

const { v1Routes } = await import('@server/routes/v1/index');

// Mimics the RLS policy "Users can view memberships in their organizations":
// the caller can SELECT every membership row in orgs they belong to, including
// other members' rows. The handler must narrow to the caller's own rows.
const ORG = { id: 'org-1', name: 'Acme', slug: 'acme' };
const visibleRows = [
  { id: 'm-caller', role: 'MEMBER', user_id: 'u1', organization: ORG },
  { id: 'm-other', role: 'OWNER', user_id: 'u2', organization: ORG },
];

function rlsMembershipsClient() {
  return {
    from: (table: string) => {
      expect(table).toBe('memberships');
      const filters: Array<[string, unknown]> = [];
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return chain;
        },
        // biome-ignore lint/suspicious/noThenProperty: PostgREST builders are thenable
        then: (resolve: (v: unknown) => unknown) =>
          resolve({
            data: visibleRows
              .filter((r) =>
                filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val)
              )
              .map(({ user_id: _u, ...rest }) => rest),
            error: null,
          }),
      };
      return chain;
    },
  };
}

function app() {
  const a = new Hono<{ Variables: HonoVariables }>();
  a.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    c.set('user', { id: 'u1', email: 'u@test.com', user_metadata: {}, app_metadata: {} } as any);
    // biome-ignore lint/suspicious/noExplicitAny: minimal RLS client double
    c.set('supabase', rlsMembershipsClient() as any);
    await next();
  });
  a.route('/api/v1', v1Routes);
  return a;
}

describe('GET /me memberships', () => {
  it("SECURITY: returns only the caller's own memberships, not other members' rows", async () => {
    const res = await app().request('/api/v1/me');
    expect(res.status).toBe(200);
    const { memberships } = await res.json();
    expect(memberships).toEqual([{ id: 'm-caller', role: 'MEMBER', organization: ORG }]);
  });
});
