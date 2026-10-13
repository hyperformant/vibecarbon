import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asUser,
  cleanupTestData,
  connectTestDb,
  createOrgWithOwner,
  createTestUser,
  dbTestsEnabled,
  type TestUser,
} from './_helpers';

/**
 * RLS against the real engine. Every user request runs as role `app_user`
 * with `app.user_id` set for the transaction; these tests prove the policies
 * scope rows by that id and nothing else.
 */
describe.skipIf(!dbTestsEnabled)('RLS policies (app_user + app.user_id())', () => {
  let db: pg.Client;
  let userA: TestUser;
  let userB: TestUser;
  let superAdmin: TestUser;
  let nearMiss: TestUser;
  let orgA: string;
  let orgB: string;
  const notificationIds: string[] = [];
  const privateSettingKey = `db_test_private_${randomUUID()}`;
  const stripeCustomerId = `cus_dbtest_${randomUUID()}`;

  beforeAll(async () => {
    db = await connectTestDb();
    userA = await createTestUser(db);
    userB = await createTestUser(db);
    superAdmin = await createTestUser(db, { role: 'super_admin' });
    nearMiss = await createTestUser(db, { role: 'admin' });
    orgA = await createOrgWithOwner(db, userA);
    orgB = await createOrgWithOwner(db, userB);

    await db.query('insert into public.customers (user_id, stripe_customer_id) values ($1, $2)', [
      userB.id,
      stripeCustomerId,
    ]);

    const seeds: Array<[string, string, string | null]> = [
      ['db-test authenticated-only', 'authenticated', null],
      ['db-test public-only', 'public', null],
      ['db-test org B', 'all', orgB],
    ];
    for (const [title, visibility, orgId] of seeds) {
      const { rows } = await db.query<{ id: string }>(
        'insert into public.notifications (title, visibility, organization_id) values ($1, $2, $3) returning id',
        [title, visibility, orgId],
      );
      notificationIds.push(rows[0].id);
    }

    // One dismissal, owned by A: the per-user dismissal policy has a row to hide.
    await db.query(
      'insert into public.notification_dismissals (notification_id, user_id) values ($1, $2)',
      [notificationIds[0], userA.id],
    );

    await db.query("insert into public.app_settings (key, value) values ($1, '{}'::jsonb)", [
      privateSettingKey,
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('delete from public.notifications where id = any($1::uuid[])', [
      notificationIds,
    ]);
    await db.query('delete from public.app_settings where key = $1', [privateSettingKey]);
    await db.query('delete from public.customers where stripe_customer_id = $1', [
      stripeCustomerId,
    ]);
    await cleanupTestData(db, {
      userIds: [userA, userB, superAdmin, nearMiss].filter(Boolean).map((u) => u.id),
      orgIds: [orgA, orgB].filter(Boolean),
    });
    await db.end();
  });

  const orgIds = async (c: pg.Client) =>
    (await c.query<{ id: string }>('select id from public.organizations')).rows.map((r) => r.id);
  const membershipOrgIds = async (c: pg.Client) =>
    (
      await c.query<{ organization_id: string }>('select organization_id from public.memberships')
    ).rows.map((r) => r.organization_id);
  const notificationTitles = async (c: pg.Client) =>
    (
      await c.query<{ title: string }>(
        "select title from public.notifications where title like 'db-test %'",
      )
    ).rows.map((r) => r.title);

  it('runs as app_user and app.user_id() returns the transaction id', async () => {
    const row = await asUser(db, userA.id, async (c) => {
      const { rows } = await c.query<{ who: string; uid: string | null }>(
        'select current_user as who, app.user_id() as uid',
      );
      return rows[0];
    });
    expect(row).toEqual({ who: 'app_user', uid: userA.id });
  });

  it("user A sees A's organization and memberships, never B's", async () => {
    await asUser(db, userA.id, async (c) => {
      const orgs = await orgIds(c);
      expect(orgs).toContain(orgA);
      expect(orgs).not.toContain(orgB);
      const memberships = await membershipOrgIds(c);
      expect(memberships).toContain(orgA);
      expect(memberships).not.toContain(orgB);
    });
  });

  it("user A cannot see B's customer record, B can", async () => {
    const sql = 'select 1 from public.customers where stripe_customer_id = $1';
    const asA = await asUser(db, userA.id, (c) => c.query(sql, [stripeCustomerId]));
    expect(asA.rowCount).toBe(0);
    const asB = await asUser(db, userB.id, (c) => c.query(sql, [stripeCustomerId]));
    expect(asB.rowCount).toBe(1);
  });

  it("user A cannot update or delete B's organization", async () => {
    await asUser(db, userA.id, async (c) => {
      const upd = await c.query("update public.organizations set name = 'pwned' where id = $1", [
        orgB,
      ]);
      expect(upd.rowCount).toBe(0);
      const del = await c.query('delete from public.organizations where id = $1', [orgB]);
      expect(del.rowCount).toBe(0);
    });
  });

  it('an anonymous request (empty id) sees no private rows', async () => {
    await asUser(db, null, async (c) => {
      const { rows } = await c.query('select app.user_id() as uid');
      expect(rows[0].uid).toBeNull();
      expect(await orgIds(c)).toEqual([]);
      expect(await membershipOrgIds(c)).toEqual([]);
      expect((await c.query('select 1 from public.customers')).rowCount).toBe(0);
      expect((await c.query('select 1 from public.notification_dismissals')).rowCount).toBe(0);
    });
  });

  it("notification dismissals are per user: A sees A's dismissal, B and anonymous see none", async () => {
    const dismissals = (c: pg.Client) =>
      c.query<{ user_id: string }>('select user_id from public.notification_dismissals');
    await asUser(db, userA.id, async (c) => {
      expect((await dismissals(c)).rows.map((r) => r.user_id)).toEqual([userA.id]);
    });
    await asUser(db, userB.id, async (c) => {
      expect((await dismissals(c)).rowCount).toBe(0);
    });
    await asUser(db, null, async (c) => {
      expect((await dismissals(c)).rowCount).toBe(0);
    });
  });

  it('an anonymous request cannot create an organization', async () => {
    await expect(
      asUser(db, null, (c) =>
        c.query("insert into public.organizations (name, slug) values ('x', $1)", [
          `db-test-${randomUUID()}`,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('whitelisted app settings are publicly readable, others are not', async () => {
    const keys = await asUser(db, null, async (c) =>
      (await c.query<{ key: string }>('select key from public.app_settings')).rows.map(
        (r) => r.key,
      ),
    );
    expect(keys).toContain('mfa_enabled');
    expect(keys).not.toContain(privateSettingKey);

    const asA = await asUser(db, userA.id, (c) =>
      c.query('select 1 from public.app_settings where key = $1', [privateSettingKey]),
    );
    expect(asA.rowCount).toBe(0);
  });

  it('super admin ("user".role) reads every setting; nobody else does', async () => {
    const asAdmin = await asUser(db, superAdmin.id, (c) =>
      c.query<{ is_admin: boolean }>(
        'select public.is_super_admin() as is_admin, (select count(*) from public.app_settings where key = $1)::int as n',
        [privateSettingKey],
      ),
    );
    expect(asAdmin.rows[0]).toMatchObject({ is_admin: true, n: 1 });

    const asA = await asUser(db, userA.id, (c) =>
      c.query<{ is_admin: boolean }>('select public.is_super_admin() as is_admin'),
    );
    expect(asA.rows[0].is_admin).toBe(false);

    const anon = await asUser(db, null, (c) =>
      c.query<{ is_admin: boolean }>('select public.is_super_admin() as is_admin'),
    );
    expect(anon.rows[0].is_admin).toBe(false);

    // Only the exact 'super_admin' role counts, not any admin-sounding one.
    const other = await asUser(db, nearMiss.id, (c) =>
      c.query<{ is_admin: boolean }>('select public.is_super_admin() as is_admin'),
    );
    expect(other.rows[0].is_admin).toBe(false);
  });

  it('super admin passes the is_super_admin()-gated notification write policies; a member does not', async () => {
    const insert = (c: pg.Client) =>
      c.query(
        "insert into public.notifications (title, visibility) values ('db-test admin write', 'all') returning id",
      );
    const asAdmin = await asUser(db, superAdmin.id, insert);
    expect(asAdmin.rowCount).toBe(1);
    await expect(asUser(db, userA.id, insert)).rejects.toThrow(/row-level security/);
  });

  it('app_user has no privileges on the auth tables, signed in or not', async () => {
    for (const table of ['"user"', 'session', 'account', 'verification', 'two_factor']) {
      for (const who of [superAdmin.id, userA.id, null]) {
        await expect(
          asUser(db, who, (c) => c.query(`select 1 from public.${table} limit 1`)),
          `${table} as ${who ?? 'anonymous'}`,
        ).rejects.toThrow(/permission denied/);
      }
    }
    await expect(
      asUser(db, userA.id, (c) =>
        c.query('update public."user" set role = \'super_admin\' where id = $1', [userA.id]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('notifications: anonymous sees public-only, signed-in sees authenticated-only, org-scoped stays in its org', async () => {
    const anon = await asUser(db, null, notificationTitles);
    expect(anon).toContain('db-test public-only');
    expect(anon).not.toContain('db-test authenticated-only');
    expect(anon).not.toContain('db-test org B');

    const a = await asUser(db, userA.id, notificationTitles);
    expect(a).toContain('db-test authenticated-only');
    expect(a).not.toContain('db-test public-only');
    expect(a).not.toContain('db-test org B');

    const b = await asUser(db, userB.id, notificationTitles);
    expect(b).toContain('db-test org B');
  });

  it('server-only SECURITY DEFINER functions are not executable by app_user', async () => {
    await expect(
      asUser(db, userA.id, (c) =>
        c.query("select public.record_failed_login('x@example.test', '127.0.0.1')"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, userA.id, (c) => c.query('select public.rollup_crawler_hits()')),
    ).rejects.toThrow(/permission denied/);
  });
});
