import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { MIGRATIONS_LOCK_KEY } from './migrate';

/**
 * `app_service`: the one database role the app process connects as
 * (security plan 2026-10-20, R8). `postgres` stays the owner: it runs the
 * migrations, owns every table and SECURITY DEFINER function, and runs the
 * pg_cron jobs. The app holds only this role's password (APP_DB_PASSWORD).
 *
 * What the role is, and why:
 * - LOGIN, NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION: no `COPY ...
 *   TO PROGRAM`, no reading other roles' data beyond its grants, no new
 *   roles or databases, no replication stream.
 * - BYPASSRLS: `adminDb` is the app's documented server-side path (webhooks,
 *   admin tooling, jobs, the auth tables) and must not silently become
 *   RLS-scoped. User requests still run under RLS: `withUserDb` switches to
 *   `app_user`, which this role is a member of.
 * - SELECT, INSERT, UPDATE, DELETE on the app's tables and USAGE on their
 *   sequences, plus the same by default on whatever `postgres` creates in
 *   `public` later, so a table a later migration adds is reachable.
 * - EXECUTE on exactly the server-only SECURITY DEFINER functions the app
 *   calls through `adminDb` (APP_SERVICE_FUNCTIONS), which the baseline
 *   revokes from PUBLIC and `app_user`.
 * - Read access to drizzle's migration ledger, so the app can check that the
 *   migrate step has run (verifyMigrations).
 * - It owns nothing, so it can neither ALTER nor DROP a table.
 *
 * The role and its password are made here, in the migrate step, not in a
 * migration: migrations carry no secrets. The grants live here too because
 * they need the role to exist, and running them on every migrate step keeps
 * a database whose baseline predates this role correct as well.
 */
export const APP_SERVICE_ROLE = 'app_service';

/**
 * The server-only SECURITY DEFINER functions the app calls through `adminDb`
 * (the lockout and admin-unlock family, the admin Jobs page's schedule read
 * and manual runs), plus the cron history writer the Jobs page shares with
 * pg_cron. tests/db/app-service-role.test.ts checks this against the
 * server's own `sql` call sites.
 */
export const APP_SERVICE_FUNCTIONS = [
  'public.check_account_lockout(text, inet, integer, integer)',
  'public.record_failed_login(text, inet)',
  'public.clear_failed_logins(text, inet)',
  'public.admin_unlock_account(text)',
  'public.cleanup_old_login_attempts(integer)',
  'public.get_locked_accounts(integer, integer)',
  'public.get_cron_jobs()',
  'public.log_cron_job(text, text, text, text)',
  'public.rollup_crawler_hits(date)',
] as const;

/**
 * A SCRAM-SHA-256 verifier for `password`, in the form Postgres stores in
 * pg_authid (RFC 5802/7677, 4096 iterations, a fresh 16-byte salt). Setting
 * a role's password from a verifier is what psql's \password does: the
 * password itself never reaches the server, so it cannot surface in
 * pg_stat_activity, the server log or pg_stat_statements (docs/security.md).
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * Create or update `app_service` with `password`, and give it its grants.
 * Idempotent: run after every migration run on the primary, as the owner.
 * All of it is one transaction under the migrations advisory lock, so
 * replicas starting together never race on CREATE ROLE or a GRANT.
 *
 * The password reaches Postgres only as a SCRAM verifier
 * (scramSha256Verifier), never in plain text, and the transaction turns
 * statement logging off for itself in case a statement fails.
 */
export async function ensureAppServiceRole(client: pg.ClientBase, password: string): Promise<void> {
  if (!password) {
    throw new Error(
      'APP_DB_PASSWORD is empty, so the app database role cannot be set up. ' +
        'Run `vibecarbon upgrade` to generate it'
    );
  }
  const role = APP_SERVICE_ROLE;
  const statements = [
    `select pg_advisory_xact_lock(${MIGRATIONS_LOCK_KEY}::bigint)`,
    // The verifier is not the password, but there is no reason to record it
    // either: not in the server log, even for a failing or slow statement,
    // and not in pg_stat_statements.
    'set local log_min_error_statement = panic',
    'set local log_min_duration_statement = -1',
    'set local pg_stat_statements.track_utility = off',
    `do $$ begin
       if not exists (select from pg_catalog.pg_roles where rolname = '${role}') then
         create role ${role};
       end if;
     end $$`,
    `alter role ${role} with login nosuperuser nocreaterole nocreatedb noreplication bypassrls inherit password ${client.escapeLiteral(scramSha256Verifier(password))}`,
    `grant app_user to ${role}`,
    `grant usage on schema public to ${role}`,
    `grant select, insert, update, delete on all tables in schema public to ${role}`,
    `grant usage, select on all sequences in schema public to ${role}`,
    `alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to ${role}`,
    `alter default privileges for role postgres in schema public grant usage, select on sequences to ${role}`,
    `grant execute on function ${APP_SERVICE_FUNCTIONS.join(', ')} to ${role}`,
    `grant usage on schema drizzle to ${role}`,
    `grant select on drizzle.__drizzle_migrations to ${role}`,
  ];
  await client.query('begin');
  try {
    for (const text of statements) await client.query(text);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  }
}
