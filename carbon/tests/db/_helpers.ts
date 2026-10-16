import { randomUUID } from 'node:crypto';
import pg from 'pg';

/**
 * Real-Postgres test harness for the `db` vitest project.
 *
 * These tests talk to an actual database (the dev `db` container with
 * migrations applied), because RLS can only be proven against the engine
 * that enforces it. They are skipped unless TEST_DB_HOST is set; see
 * TESTING.md ("Database tier") for how to start one.
 *
 * Connection comes from discrete env vars, never a URL string, so the
 * password never needs URL-encoding:
 *   TEST_DB_HOST      required (e.g. localhost)
 *   TEST_DB_PORT      default 5432
 *   TEST_DB_USER      default postgres (the app's connection role, which
 *                     bypasses RLS and is a member of app_user)
 *   TEST_DB_PASSWORD  POSTGRES_PASSWORD from .env
 *   TEST_DB_NAME      default postgres
 */

export const dbTestsEnabled = Boolean(process.env.TEST_DB_HOST);

export async function connectTestDb(): Promise<pg.Client> {
  const client = new pg.Client({
    host: process.env.TEST_DB_HOST,
    port: Number(process.env.TEST_DB_PORT ?? 5432),
    user: process.env.TEST_DB_USER ?? 'postgres',
    password: process.env.TEST_DB_PASSWORD,
    database: process.env.TEST_DB_NAME ?? 'postgres',
  });
  await client.connect();
  return client;
}

/**
 * Run `fn` the way a user request will run: inside a transaction, as role
 * `app_user`, with `app.user_id` set by ONE parameterized set_config call.
 * `userId = null` is an anonymous request (app.user_id() is NULL).
 * Always rolls back, so tests can try writes without leaving rows behind.
 */
export async function asUser<T>(
  client: pg.Client,
  userId: string | null,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(
      "select set_config('role', 'app_user', true), set_config('app.user_id', $1, true)",
      [userId ?? ''],
    );
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
  }
}

export interface TestUser {
  id: string;
  email: string;
}

/**
 * Insert a user straight into public."user" (the connection role can; app_user
 * has no privileges on it). `role` is the server-controlled column
 * is_super_admin() reads.
 */
export async function createTestUser(
  client: pg.Client,
  opts: { role?: string } = {},
): Promise<TestUser> {
  const id = randomUUID();
  const email = `db-test-${id}@example.test`;
  await client.query(
    'insert into public."user" (id, name, email, role) values ($1, $2, $3, $4)',
    [id, 'DB Test', email, opts.role ?? null],
  );
  return { id, email };
}

/** Create an organization with `owner` as its OWNER. Returns the org id. */
export async function createOrgWithOwner(client: pg.Client, owner: TestUser): Promise<string> {
  const slug = `db-test-${randomUUID()}`;
  const { rows } = await client.query<{ id: string }>(
    'insert into public.organizations (name, slug) values ($1, $1) returning id',
    [slug],
  );
  const orgId = rows[0].id;
  await addMembership(client, orgId, owner, 'OWNER');
  return orgId;
}

export async function addMembership(
  client: pg.Client,
  orgId: string,
  user: TestUser,
  role: 'OWNER' | 'ADMIN' | 'MEMBER',
): Promise<void> {
  await client.query(
    'insert into public.memberships (organization_id, user_id, role) values ($1, $2, $3)',
    [orgId, user.id, role],
  );
}

/** Remove seeded rows. Deleting the users cascades their memberships. */
export async function cleanupTestData(
  client: pg.Client,
  data: { userIds: string[]; orgIds: string[] },
): Promise<void> {
  if (data.orgIds.length) {
    await client.query('delete from public.organizations where id = any($1::uuid[])', [
      data.orgIds,
    ]);
  }
  if (data.userIds.length) {
    await client.query('delete from public."user" where id = any($1::uuid[])', [data.userIds]);
  }
}
