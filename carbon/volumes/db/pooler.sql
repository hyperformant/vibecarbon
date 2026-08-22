-- Supavisor pooler plumbing (mirrors supabase/docker's self-hosted setup):
--
--  1. `_supavisor` schema — the pooler's own metadata home. Its
--     /app/bin/migrate runs with --prefix _supavisor and does NOT create
--     the schema itself; without this, migrate fails on first boot.
--     (Upstream keeps this in a separate `_supabase` database; this stack
--     keeps pooler metadata in `postgres`, same DATABASE_URL the overlay
--     already passes to supavisor.)
--
--  2. pgbouncer auth plumbing — the SECURITY DEFINER lookup Supavisor's
--     tenant `auth_query` uses to resolve ANY login role through the
--     pooler. supabase/postgres ships these in-image; created guarded here
--     so the template never silently depends on image internals. The
--     pgbouncer manager role's password is aligned with POSTGRES_PASSWORD
--     by zz-set-passwords.sh (env is unavailable in plain init SQL).

create schema if not exists _supavisor;
alter schema _supavisor owner to supabase_admin;

do $$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'pgbouncer') then
    create role pgbouncer login;
  end if;
end
$$;

create schema if not exists pgbouncer;

create or replace function pgbouncer.get_auth(p_usename text)
returns table (username text, password text)
language plpgsql security definer
as $fn$
begin
  raise debug 'PgBouncer auth request: %', p_usename;
  return query
  select
    rolname::text,
    case when rolvaliduntil < now() then null else rolpassword::text end
  from pg_authid
  where rolname = p_usename and rolcanlogin;
end;
$fn$;

grant execute on function pgbouncer.get_auth(p_usename text) to pgbouncer;
