import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';

// Mimics the RLS policy "Users can view memberships in their organizations":
// the caller can SELECT every membership row in orgs they belong to, including
// other members' rows. The handler must narrow to the caller's own rows.
const { visibleRows } = vi.hoisted(() => {
  // timestamptz in Drizzle 'string' mode: Postgres text form.
  const at = '2026-01-01 00:00:00+00';
  const org = { id: 'org-1', name: 'Acme', slug: 'acme', plan: 'free', createdAt: at, updatedAt: at };
  return {
    visibleRows: [
      { id: 'm-caller', role: 'MEMBER', userId: 'u1', organization: org },
      { id: 'm-other', role: 'OWNER', userId: 'u2', organization: org },
    ],
  };
});

// The rows this query returns under RLS, narrowed by the handler's own WHERE.
// The predicate is compiled to SQL so the double honors exactly what the
// handler asked for: a `memberships.user_id = $n` filter keeps that user's
// rows; no such filter returns every visible row, as RLS would.
function runAsRls(where: SQL | undefined) {
  if (!where) return visibleRows;
  const { sql, params } = new PgDialect().sqlToQuery(where);
  const match = /"memberships"\."user_id" = \$(\d+)/.exec(sql);
  if (!match) return visibleRows;
  const userId = params[Number(match[1]) - 1];
  return visibleRows.filter((r) => r.userId === userId);
}

function rlsTx() {
  let where: SQL | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: the chain stands in for the select builder
  const chain: any = new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve()
            .then(() => runAsRls(where).map(({ userId: _u, ...rest }) => rest))
            .then(resolve, reject);
      }
      if (prop === 'where') {
        return (cond: SQL) => {
          where = cond;
          return chain;
        };
      }
      return () => chain;
    },
  });
  return { select: () => chain };
}

vi.mock('@server/db/client', () => ({
  adminDb: {},
  withUserDb: (_userId: string | null, fn: (tx: unknown) => unknown) => fn(rlsTx()),
}));
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/lib/email', () => ({ sendEmail: vi.fn() }));

const { v1Routes } = await import('@server/routes/v1/index');

function app() {
  const a = new Hono<{ Variables: HonoVariables }>();
  a.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    c.set('user', { id: 'u1', email: 'u@test.com' } as any);
    await next();
  });
  a.route('/api/v1', v1Routes);
  return a;
}

describe('GET /me memberships', () => {
  it('the RLS double returns other members rows when the query is unfiltered', () => {
    expect(runAsRls(undefined).map((r) => r.id)).toEqual(['m-caller', 'm-other']);
  });

  it("SECURITY: returns only the caller's own memberships, not other members' rows", async () => {
    const res = await app().request('/api/v1/me');
    expect(res.status).toBe(200);
    const { memberships } = await res.json();
    expect(memberships).toEqual([
      {
        id: 'm-caller',
        role: 'MEMBER',
        organization: {
          id: 'org-1',
          name: 'Acme',
          slug: 'acme',
          plan: 'free',
          created_at: '2026-01-01T00:00:00+00:00',
          updated_at: '2026-01-01T00:00:00+00:00',
        },
      },
    ]);
  });
});
