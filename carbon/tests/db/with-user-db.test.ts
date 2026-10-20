import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminDb,
  assertBypassRole,
  DbRoleError,
  pingDb,
  pool,
  withUserDb,
} from '@server/db/client';
import { organizations } from '@server/db/schema';
import {
  cleanupTestData,
  connectTestDb,
  createOrgWithOwner,
  createTestUser,
  dbTestsEnabled,
  type TestUser,
} from './_helpers';

/**
 * The server's DB module against the real engine: `withUserDb` runs a
 * callback as `app_user` with `app.user_id` set for one transaction, and
 * nothing about that transaction may outlive it.
 */
describe.skipIf(!dbTestsEnabled)('db client: withUserDb / adminDb', () => {
  let seed: pg.Client;
  let userA: TestUser;
  let userB: TestUser;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    seed = await connectTestDb();
    userA = await createTestUser(seed);
    userB = await createTestUser(seed);
    orgA = await createOrgWithOwner(seed, userA);
    orgB = await createOrgWithOwner(seed, userB);
  });

  afterAll(async () => {
    if (seed) {
      await cleanupTestData(seed, {
        userIds: [userA, userB].filter(Boolean).map((u) => u.id),
        orgIds: [orgA, orgB].filter(Boolean),
      });
      await seed.end();
    }
    await pool.end();
  });

  const whoAmI = async (db: { execute: typeof adminDb.execute }) => {
    const { rows } = await db.execute<{ role: string; uid: string | null }>(
      sql`select current_user as role, nullif(current_setting('app.user_id', true), '') as uid`,
    );
    return rows[0];
  };

  it("scopes rows by the user's id through RLS", async () => {
    const ids = await withUserDb(userA.id, (tx) =>
      tx.select({ id: organizations.id }).from(organizations),
    );
    expect(ids.map((r) => r.id)).toEqual([orgA]);

    const asAdmin = await adminDb
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgB));
    expect(asAdmin).toHaveLength(1);
  });

  it('runs as app_user with app.user_id set, inside the transaction', async () => {
    const who = await withUserDb(userA.id, (tx) => whoAmI(tx));
    expect(who).toEqual({ role: 'app_user', uid: userA.id });
  });

  // Review Focus 3: no session means app.user_id() is NULL, so user-scoped
  // policies match nothing. Empty results, never an error.
  it('anonymous (null) sees no private rows and gets no error', async () => {
    const result = await withUserDb(null, async (tx) => {
      const { rows } = await tx.execute<{ uid: string | null }>(sql`select app.user_id() as uid`);
      const orgs = await tx.select().from(organizations);
      return { uid: rows[0].uid, orgs };
    });
    expect(result.uid).toBeNull();
    expect(result.orgs).toEqual([]);
  });

  it('passes the user id as a bind parameter, never as SQL text', async () => {
    const hostile = "x', true); select set_config('role', 'postgres', false); --";
    const stored = await withUserDb(hostile, async (tx) => {
      const { rows } = await tx.execute<{ v: string }>(
        sql`select current_setting('app.user_id', true) as v`,
      );
      return rows[0].v;
    });
    expect(stored).toBe(hostile);
  });

  // Review Focus 4: set_config(..., true) is transaction-local, so neither
  // the role nor the id may leak to the next request on a pooled connection.
  it('role and user id do not leak to the next query on a pooled connection', async () => {
    await withUserDb(userA.id, (tx) => whoAmI(tx));
    expect(await whoAmI(adminDb)).toEqual({ role: 'app_service', uid: null });

    // Every connection in the pool, not just the one the last call reused.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withUserDb(userB.id, async (tx) => {
          await tx.execute(sql`select pg_sleep(0.05)`);
        }),
      ),
    );
    const after = await Promise.all(
      Array.from({ length: 10 }, () =>
        adminDb.transaction(async (tx) => {
          const who = await whoAmI(tx);
          await tx.execute(sql`select pg_sleep(0.05)`);
          return who;
        }),
      ),
    );
    for (const who of after) expect(who).toEqual({ role: 'app_service', uid: null });
  });

  // Review Focus 2: a throwing callback rolls back and gives the connection
  // back. More failures than the pool has connections would hang the next
  // call if any were leaked.
  it('rolls back and releases the connection when the callback throws', async () => {
    const slug = `db-test-rollback-${randomUUID()}`;
    for (let i = 0; i < 15; i++) {
      await expect(
        withUserDb(userA.id, async (tx) => {
          // Back to the connection role (app_service, which bypasses RLS):
          // the write lands, then the throw must roll it back.
          await tx.execute(sql`select set_config('role', 'app_service', true)`);
          await tx.insert(organizations).values({ name: slug, slug: `${slug}-${i}` });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    }

    const left = await adminDb
      .select({ id: organizations.id })
      .from(organizations)
      .where(sql`${organizations.slug} like ${`${slug}%`}`);
    expect(left).toEqual([]);
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount);
    expect(await pingDb()).toMatchObject({ ok: true });
  });

  it('rolls back and releases the connection when SQL inside the callback fails', async () => {
    for (let i = 0; i < 12; i++) {
      await expect(
        withUserDb(userA.id, (tx) => tx.execute(sql`select * from no_such_table`)),
      ).rejects.toThrow();
    }
    expect(pool.waitingCount).toBe(0);
    expect(await whoAmI(adminDb)).toEqual({ role: 'app_service', uid: null });
  });

  it('assertBypassRole accepts the connection role', async () => {
    await expect(assertBypassRole()).resolves.toBeUndefined();
  });

  it('assertBypassRole refuses a role that RLS would scope', async () => {
    await expect(
      adminDb.transaction(async (tx) => {
        await tx.execute(sql`set local role app_user`);
        await assertBypassRole(tx);
      }),
    ).rejects.toBeInstanceOf(DbRoleError);
  });

  // A role that bypasses RLS but is not a member of app_user would pass the
  // bypass check and then fail every withUserDb call at `set role app_user`.
  it('withUserDb cannot climb to the owner: app_service is no member of postgres', async () => {
    await expect(
      withUserDb(userA.id, (tx) => tx.execute(sql`select set_config('role', 'postgres', true)`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('assertBypassRole refuses a bypass role that is not a member of app_user', async () => {
    // Making a probe role takes the owner; the app role cannot create roles.
    const owner = drizzle({ client: seed });
    const err = await owner
      .transaction(async (tx) => {
        await tx.execute(sql`create role t6_bypass_no_member nologin bypassrls`);
        await tx.execute(sql`grant t6_bypass_no_member to current_user`);
        await tx.execute(sql`set local role t6_bypass_no_member`);
        await assertBypassRole(tx);
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbRoleError);
    expect((err as Error).message).toMatch(/not a member of app_user/);
    // The transaction rolled back, so the probe role is gone.
    const { rows } = await owner.execute(
      sql`select 1 from pg_roles where rolname = 't6_bypass_no_member'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('pingDb reports a reachable database', async () => {
    expect(await pingDb()).toMatchObject({ ok: true });
  });

  // Review Focus 5: an unreachable database is `{ ok: false }`, never a
  // throw, and carries the cause so readiness can log why.
  it('pingDb reports an unreachable database as down without throwing', async () => {
    const dead = new pg.Pool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 2000 });
    try {
      const ping = await pingDb(dead);
      expect(ping.ok).toBe(false);
      expect(ping.ok ? undefined : (ping.error as { code?: string }).code).toBe('ECONNREFUSED');
    } finally {
      await dead.end();
    }
  });

  // A request Hono already timed out must not pin a pooled connection: the
  // server cancels long statements and ends idle-in-transaction sessions.
  it('every pooled session carries the statement and idle-in-transaction timeouts', async () => {
    const { rows } = await adminDb.execute<{ statement: string; idleTx: string }>(
      sql`select current_setting('statement_timeout') as statement,
        current_setting('idle_in_transaction_session_timeout') as "idleTx"`,
    );
    expect(rows[0]).toEqual({ statement: '30s', idleTx: '30s' });
    const inside = await withUserDb(null, (tx) =>
      tx.execute<{ statement: string }>(sql`select current_setting('statement_timeout') as statement`),
    );
    expect(inside.rows[0].statement).toBe('30s');
  });
});
