import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder, runMigrations } from '@server/db/migrate';
import { connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * A server-only table is one with RLS on and no policies (schema.ts): only
 * the server and SECURITY DEFINER functions reach it. RLS does not stop a
 * role that bypasses it (the add-on roles metabase and n8n), and the default
 * privileges hand such a role every new public table, so
 * app.revoke_server_only_tables() (0002_baseline_post.sql) takes them back,
 * deriving the set from the catalog, after every migration run
 * (src/server/db/migrate.ts).
 */
describe.skipIf(!dbTestsEnabled)('server-only tables', () => {
  let client: pg.Client;
  const role = `srv_test_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const secretTable = `srv_secret_${suffix}`;
  const openTable = `srv_open_${suffix}`;
  const root = mkdtempSync(join(tmpdir(), 'server-only-'));
  let addedWhen = 0;

  beforeAll(async () => {
    client = await connectTestDb();
  });

  afterAll(async () => {
    await client.query(`drop table if exists public.${secretTable}, public.${openTable}`);
    if (addedWhen) {
      await client.query('delete from drizzle.__drizzle_migrations where created_at = $1', [
        addedWhen,
      ]);
    }
    const { rows } = await client.query('select 1 from pg_roles where rolname = $1', [role]);
    if (rows.length) {
      // Its grants and default privileges, then the role.
      await client.query(`drop owned by ${role}`);
      await client.query(`drop role ${role}`);
    }
    await client.end();
    rmSync(root, { recursive: true, force: true });
  });

  it('no role but superusers and owners holds any privilege on a server-only table', async () => {
    const { rows: tables } = await client.query<{ tbl: string }>(
      `select c.relname as tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
          and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
        order by 1`,
    );
    // Not vacuous: the Better Auth tables and failed_login_attempts.
    expect(tables.map((t) => t.tbl)).toEqual(
      expect.arrayContaining([
        'user',
        'session',
        'account',
        'verification',
        'two_factor',
        'failed_login_attempts',
      ]),
    );
    const { rows } = await client.query(
      `select r.rolname, c.relname, p.priv
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join pg_roles r
         cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(priv)
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
          and not exists (select 1 from pg_policy pol where pol.polrelid = c.oid)
          and not r.rolsuper and r.oid <> c.relowner and r.rolname not like 'pg\\_%'
          and has_table_privilege(r.oid, c.oid, p.priv)`,
    );
    expect(rows).toEqual([]);
  });

  it('a later migration that adds a no-policy table leaves it unreadable to an RLS-bypass role', async () => {
    // An add-on-like role: bypasses RLS, and the default privileges hand it
    // every table postgres creates (what the add-on init scripts set up).
    await client.query(`create role ${role} nologin bypassrls`);
    await client.query(
      `alter default privileges in schema public grant select, insert, update, delete on tables to ${role}`,
    );
    // The project's own migrations plus one more, as `drizzle-kit generate` would add.
    const folder = join(root, 'migrations');
    cpSync(migrationsFolder(), folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const last = journal.entries[journal.entries.length - 1];
    addedWhen = last.when + 1;
    const tag = '0003_server_only_test';
    journal.entries.push({ ...last, idx: last.idx + 1, when: addedWhen, tag });
    writeFileSync(journalPath, JSON.stringify(journal));
    writeFileSync(
      join(folder, `${tag}.sql`),
      [
        `create table public.${secretTable} (id int, token text);`,
        `alter table public.${secretTable} enable row level security;`,
        `create table public.${openTable} (id int);`,
        `alter table public.${openTable} enable row level security;`,
        `create policy ${openTable}_read on public.${openTable} for select using (true);`,
      ].join('\n--> statement-breakpoint\n'),
    );

    expect(await runMigrations(client, folder)).toEqual({ kind: 'applied', newlyApplied: 1 });

    const can = async (table: string, priv: string) =>
      (
        await client.query('select has_table_privilege($1, $2, $3) as ok', [
          role,
          `public.${table}`,
          priv,
        ])
      ).rows[0].ok as boolean;
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(await can(secretTable, priv), `${priv} on the no-policy table`).toBe(false);
      expect(await can(openTable, priv), `${priv} on the table with a policy`).toBe(true);
    }
    expect(await can('session', 'SELECT')).toBe(false);
    expect(await can('failed_login_attempts', 'SELECT')).toBe(false);
  });

  it('is server-only itself: no end-user role may run it', async () => {
    const { rows } = await client.query(
      "select has_function_privilege('app_user', 'app.revoke_server_only_tables()', 'EXECUTE') as ok",
    );
    expect(rows[0].ok).toBe(false);
  });
});
