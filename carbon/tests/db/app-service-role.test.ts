import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readEnvFiles } from '../../scripts/lib/dotenv.js';
import {
  cleanupTestData,
  connectTestDb,
  createOrgWithOwner,
  createTestUser,
  dbTestsEnabled,
  type TestUser,
} from './_helpers';

/**
 * The app's own database role, `app_service` (security plan 2026-10-20, R8),
 * proven against the real engine. The suite runs the migrate step itself (as
 * the owner, the way `app-migrate` and the k8s init container do), then
 * connects as `app_service` and checks what it can and cannot do: it reads
 * and writes the app's tables and calls the server-only functions, and it
 * can neither change the schema nor reach the superuser's powers.
 *
 * The password is the developer's own APP_DB_PASSWORD when .env.local has
 * one (so running the suite never breaks a local dev server), else
 * TEST_APP_DB_PASSWORD, else a random one for this run.
 */
const appPassword =
  process.env.TEST_APP_DB_PASSWORD ||
  readEnvFiles('.').APP_DB_PASSWORD ||
  randomBytes(24).toString('base64url');

const connection = (user: string, password: string | undefined) => ({
  host: process.env.TEST_DB_HOST,
  port: Number(process.env.TEST_DB_PORT ?? 5432),
  user,
  password,
  database: process.env.TEST_DB_NAME ?? 'postgres',
});

if (dbTestsEnabled) {
  // The migrate step, as the owner, before the server's DB module is loaded.
  const { runMigrations } = await import('@server/db/migrate');
  const { ensureAppServiceRole } = await import('@server/db/app-service-role');
  const owner = await connectTestDb();
  try {
    await runMigrations(owner);
    await ensureAppServiceRole(owner, appPassword);
  } finally {
    await owner.end();
  }
  // The server's DB module (adminDb, withUserDb) now connects as the app does.
  process.env.DB_USER = 'app_service';
  process.env.DB_PASSWORD = appPassword;
}

/** Every SECURITY DEFINER function the app server calls through adminDb. */
const ADMIN_DB_FUNCTIONS = [
  'admin_unlock_account',
  'check_account_lockout',
  'cleanup_old_login_attempts',
  'clear_failed_logins',
  'get_cron_jobs',
  'get_locked_accounts',
  'record_failed_login',
  'rollup_crawler_hits',
];

/** `select <fn>(` / `from <fn>(` names in the server's sql`...` templates. */
function sqlFunctionCallsInServer(): string[] {
  const root = join(__dirname, '..', '..', 'src', 'server');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts')) files.push(path);
    }
  };
  walk(root);
  const names = new Set<string>();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/sql`\s*select\b[^`]*?\b(?:select|from)\s+(?:public\.)?([a-z_]+)\(/g)) {
      names.add(m[1]);
    }
    for (const m of src.matchAll(/sql`\s*select\s+(?:public\.)?([a-z_]+)\(/g)) names.add(m[1]);
  }
  return [...names].sort();
}

describe.skipIf(!dbTestsEnabled)('app_service: the role the app connects as', () => {
  let app: pg.Client;
  let seed: pg.Client;
  let userA: TestUser;
  let userB: TestUser;
  let orgB: string;
  const pgCode = async (text: string) => {
    try {
      await app.query(text);
      return null;
    } catch (err) {
      return (err as { code?: string }).code ?? 'no-code';
    }
  };

  beforeAll(async () => {
    seed = await connectTestDb();
    userA = await createTestUser(seed);
    userB = await createTestUser(seed);
    orgB = await createOrgWithOwner(seed, userB);
    app = new pg.Client(connection('app_service', appPassword));
    await app.connect();
  });

  afterAll(async () => {
    await app?.end();
    await cleanupTestData(seed, { userIds: [userA.id, userB.id], orgIds: [orgB] });
    await seed.query('drop table if exists public.app_service_later_table');
    await seed?.end();
    const { pool } = await import('@server/db/client');
    await pool.end();
  });

  it('is no superuser and cannot create roles or databases', async () => {
    const { rows } = await app.query(
      'select current_user as role, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls from pg_roles where rolname = current_user'
    );
    expect(rows[0]).toEqual({
      role: 'app_service',
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: true,
    });
  });

  it('owns nothing, so it can neither alter nor drop a table', async () => {
    expect(await pgCode('alter table public.organizations add column x int')).toBe('42501');
    expect(await pgCode('drop table public.notifications')).toBe('42501');
  });

  it('cannot become postgres, run a server program, or create a table', async () => {
    expect(await pgCode('set role postgres')).toBe('42501');
    expect(await pgCode("copy (select 1) to program 'true'")).toBe('42501');
    expect(await pgCode('create table public.t (x int)')).toBe('42501');
  });

  it('withUserDb applies RLS; adminDb bypasses it, by design', async () => {
    const { adminDb, withUserDb } = await import('@server/db/client');
    const { organizations } = await import('@server/db/schema');
    const { eq } = await import('drizzle-orm');
    const asA = await withUserDb(userA.id, (tx) =>
      tx.select().from(organizations).where(eq(organizations.id, orgB))
    );
    expect(asA).toHaveLength(0);
    const asServer = await adminDb.select().from(organizations).where(eq(organizations.id, orgB));
    expect(asServer).toHaveLength(1);
  });

  it('passes the boot check in production: bypasses RLS, joins app_user, owns nothing', async () => {
    const { adminDb, assertBypassRole } = await import('@server/db/client');
    await expect(assertBypassRole(adminDb, { production: true })).resolves.toBeUndefined();
  });

  it('reads the Better Auth tables after the server-only revoke has run as postgres', async () => {
    await seed.query('select app.revoke_server_only_tables()');
    for (const table of ['"user"', 'session', 'account', 'verification', 'two_factor']) {
      expect(await pgCode(`select 1 from public.${table} limit 1`), table).toBeNull();
    }
  });

  it('calls every SECURITY DEFINER function the server calls through adminDb', async () => {
    const calledInServer = sqlFunctionCallsInServer();
    const { rows } = await seed.query<{ name: string }>(
      `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef and p.proname = any($1) order by 1`,
      [calledInServer]
    );
    expect(rows.map((r) => r.name)).toEqual(ADMIN_DB_FUNCTIONS);

    const email = `${userA.id}@example.test`;
    const calls = [
      'select admin_unlock_account($1)',
      "select check_account_lockout($1, '127.0.0.1'::inet)",
      'select public.cleanup_old_login_attempts(24)',
      "select clear_failed_logins($1, '127.0.0.1'::inet)",
      'select jobname from public.get_cron_jobs()',
      'select email from get_locked_accounts()',
      "select record_failed_login($1, '127.0.0.1'::inet)",
      'select public.rollup_crawler_hits(null::date)',
    ];
    expect(calls).toHaveLength(ADMIN_DB_FUNCTIONS.length);
    for (const text of calls) {
      await app.query(text, text.includes('$1') ? [email] : []);
    }
    await app.query('delete from public.failed_login_attempts where email = $1', [email]);
  });

  it('reads and writes a table a later migration creates as postgres', async () => {
    await seed.query(
      'create table public.app_service_later_table (id serial primary key, note text)'
    );
    await app.query("insert into public.app_service_later_table (note) values ('x')");
    const { rows } = await app.query('select count(*)::int as n from public.app_service_later_table');
    expect(rows[0].n).toBe(1);
  });
});
