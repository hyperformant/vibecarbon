import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appWithUser } from '../../../_helpers/app';
import { SUPER_ADMIN } from '../../../_helpers/factories';

// The admin lists page with LIMIT/OFFSET, so their ORDER BY must be total:
// rows that tie on the sort column (two orgs created in the same instant, two
// users with one name) need a tie-break, or a row can show on two pages and
// another on none. These tests read the ORDER BY each list hands Drizzle.

const { orderByCalls } = vi.hoisted(() => ({ orderByCalls: [] as SQL[][] }));

vi.mock('@server/db/client', () => {
  // A select chain that records its orderBy arguments. The list query (the
  // one with an ORDER BY) finds no rows; the count query counts zero.
  // biome-ignore lint/suspicious/noExplicitAny: the chain stands in for every builder type
  const chain = (): any => {
    let ordered = false;
    // biome-ignore lint/suspicious/noExplicitAny: Proxy over a callable target
    const proxy: any = new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => resolve(ordered ? [] : [{ value: 0 }]);
        }
        if (prop === 'orderBy') {
          return (...args: SQL[]) => {
            ordered = true;
            orderByCalls.push(args);
            return proxy;
          };
        }
        return () => proxy;
      },
    });
    return proxy;
  };
  return { adminDb: { select: chain } };
});
// Super-admin routes sit behind the aal2 gate; the MFA setting is not under test.
vi.mock('@server/lib/mfa-settings', () => ({ isMfaGloballyEnabled: async () => false }));
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/lib/email', () => ({ sendEmail: vi.fn() }));

const { v1Routes } = await import('@server/routes/v1/index');
const app = appWithUser(SUPER_ADMIN, '/api/v1', v1Routes);

const dialect = new PgDialect();

/** The ORDER BY of the one list query `path` ran, as SQL text. */
async function orderByFor(path: string): Promise<string> {
  orderByCalls.length = 0;
  const res = await app.request(path);
  expect(res.status).toBe(200);
  expect(orderByCalls).toHaveLength(1);
  const [args] = orderByCalls;
  return args.length ? dialect.sqlToQuery(sql.join(args, sql`, `)).sql : '';
}

beforeEach(() => {
  orderByCalls.length = 0;
});

describe('GET /api/v1/admin/organizations ordering', () => {
  it('breaks ties on the sort column by id, as the users list does', async () => {
    expect(await orderByFor('/api/v1/admin/organizations?sortBy=name&sortOrder=asc')).toBe(
      '"organizations"."name" asc, "organizations"."id" asc'
    );
  });

  it('sorts by created_at, newest first, by default', async () => {
    expect(await orderByFor('/api/v1/admin/organizations')).toBe(
      '"organizations"."created_at" desc, "organizations"."id" asc'
    );
  });

  it('falls back to created_at for sortBy=email, which organizations do not have', async () => {
    expect(await orderByFor('/api/v1/admin/organizations?sortBy=email&sortOrder=asc')).toBe(
      '"organizations"."created_at" asc, "organizations"."id" asc'
    );
  });
});

describe('GET /api/v1/admin/users ordering', () => {
  it('breaks ties on the sort column by id', async () => {
    expect(await orderByFor('/api/v1/admin/users?sortBy=name&sortOrder=desc')).toBe(
      '"user"."name" desc, "user"."id" asc'
    );
  });

  it('falls back to created_at for sortBy=slug, which users do not have', async () => {
    expect(await orderByFor('/api/v1/admin/users?sortBy=slug&sortOrder=asc')).toBe(
      '"user"."created_at" asc, "user"."id" asc'
    );
  });
});
