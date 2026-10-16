import type pg from 'pg';

/**
 * A deterministic dump of every schema object the migrations own, read from
 * pg_catalog: schemas, extensions, roles, tables and sequences (with RLS
 * flags and ACLs), columns, constraints, indexes, policies, functions (full
 * definitions and ACLs), triggers, default privileges, pg_cron jobs and the
 * app_settings keys the baseline seeds.
 *
 * tests/db/baseline-catalog.test.ts compares it with
 * tests/db/fixtures/baseline-catalog.json, which was first captured from a
 * database migrated by the old hand-written SQL files and is the contract the
 * drizzle-kit baseline has to reproduce.
 *
 * Left out by construction: the `drizzle` schema (the migration ledger, which
 * only the new runner creates), oids and job ids, and app_settings values
 * (other db suites write them). ACL entries are sorted, so only who holds
 * which privilege counts, not the order the grants ran in.
 */

const OWNED_SCHEMAS = ['public', 'app', 'cron'];

async function rows<T extends Record<string, unknown>>(
  client: pg.Client,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(text, values)).rows;
}

const sortedAcl = (column: string) =>
  `(select coalesce(array_agg(a::text order by a::text), '{}') from unnest(${column}) a)`;

export async function catalogSnapshot(client: pg.Client): Promise<Record<string, unknown>> {
  const schemas = await rows(
    client,
    `select n.nspname as name, pg_get_userbyid(n.nspowner) as owner, ${sortedAcl('n.nspacl')} as acl
       from pg_namespace n where n.nspname = any($1) order by 1`,
    [OWNED_SCHEMAS],
  );
  const extensions = await rows(
    client,
    `select e.extname as name, e.extversion as version, n.nspname as schema
       from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1`,
  );
  const roles = await rows(
    client,
    `select r.rolname as name, r.rolsuper as super, r.rolinherit as inherit,
            r.rolcreaterole as createrole, r.rolcreatedb as createdb, r.rolcanlogin as login,
            r.rolbypassrls as bypassrls,
            (select coalesce(array_agg(m.rolname order by m.rolname), '{}')
               from pg_auth_members am join pg_roles m on m.oid = am.member
              where am.roleid = r.oid) as members
       from pg_roles r where r.rolname not like 'pg\\_%' order by 1`,
  );
  const relations = await rows(
    client,
    `select n.nspname as schema, c.relname as name, c.relkind as kind,
            pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls,
            c.relforcerowsecurity as force_rls, ${sortedAcl('c.relacl')} as acl
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      order by 1, 2`,
    [OWNED_SCHEMAS],
  );
  const columns = await rows(
    client,
    `select n.nspname as schema, c.relname as table, a.attnum as position, a.attname as name,
            format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
            pg_get_expr(d.adbin, d.adrelid) as default, a.attidentity as identity,
            a.attgenerated as generated
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = any($1) and c.relkind in ('r', 'p', 'v', 'm')
        and a.attnum > 0 and not a.attisdropped
      order by 1, 2, 3`,
    [OWNED_SCHEMAS],
  );
  const constraints = await rows(
    client,
    `select n.nspname as schema, c.relname as table, k.conname as name, k.contype as type,
            pg_get_constraintdef(k.oid) as definition
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1)
      order by 1, 2, 3`,
    [OWNED_SCHEMAS],
  );
  const indexes = await rows(
    client,
    `select schemaname as schema, tablename as table, indexname as name, indexdef as definition
       from pg_indexes where schemaname = any($1) order by 1, 2, 3`,
    [OWNED_SCHEMAS],
  );
  const policies = await rows(
    client,
    `select schemaname as schema, tablename as table, policyname as name, permissive,
            roles::text[] as roles, cmd, qual as using, with_check
       from pg_policies where schemaname = any($1) order by 1, 2, 3`,
    [OWNED_SCHEMAS],
  );
  const functions = await rows(
    client,
    `select n.nspname as schema, p.oid::regprocedure::text as signature,
            pg_get_userbyid(p.proowner) as owner, ${sortedAcl('p.proacl')} as acl,
            pg_get_functiondef(p.oid) as definition
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any($1) and p.prokind in ('f', 'p')
        and not exists (select 1 from pg_depend dep
                         where dep.objid = p.oid and dep.deptype = 'e')
      order by 1, 2`,
    [OWNED_SCHEMAS],
  );
  const triggers = await rows(
    client,
    `select n.nspname as schema, c.relname as table, t.tgname as name, t.tgenabled as enabled,
            pg_get_triggerdef(t.oid) as definition
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and not t.tgisinternal
      order by 1, 2, 3`,
    [OWNED_SCHEMAS],
  );
  const defaultPrivileges = await rows(
    client,
    `select pg_get_userbyid(d.defaclrole) as role, n.nspname as schema, d.defaclobjtype as type,
            ${sortedAcl('d.defaclacl')} as acl
       from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
      order by 1, 2, 3`,
  );
  const cronJobs = await rows(
    client,
    `select jobname as name, schedule, command, database, username, active
       from cron.job order by 1`,
  );
  const seededSettings = (
    await rows<{ key: string }>(client, 'select key from public.app_settings order by 1')
  ).map((r) => r.key);

  return {
    schemas,
    extensions,
    roles,
    relations,
    columns,
    constraints,
    indexes,
    policies,
    functions,
    triggers,
    defaultPrivileges,
    cronJobs,
    seededSettings,
  };
}
