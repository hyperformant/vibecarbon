/**
 * Deploy-time RLS audit — the ground-truth backstop.
 *
 * The browser queries PostgREST directly through Kong (`/rest/v1`), so any
 * table in the `public` schema without row-level security is world-readable
 * and -writable over the internet. Static tests (shipped in the generated
 * project) catch this at dev time, but they parse migration files — they can't
 * see a table added by hand in Studio, by a raw `psql`, or by a dependency's
 * migration. This audit queries the LIVE catalog after migrations apply and
 * FAILS the deploy if any public table has RLS disabled, so a missing policy
 * can never reach users regardless of how the table got there.
 *
 * Zero false positives by construction: extension-owned tables (tracked via
 * pg_depend deptype 'e', e.g. postgis `spatial_ref_sys`) are excluded, and
 * Supabase's own tables live in the `storage`/`auth`/`realtime` schemas, not
 * `public`. A healthy deploy returns an empty list.
 */

/**
 * SQL returning a comma-separated list of `public` tables with RLS DISABLED
 * (empty string when all are protected). Written for `psql -tAc` (tuples-only,
 * unaligned) so the raw stdout is either the list or empty.
 */
export const RLS_AUDIT_SQL =
  "SELECT COALESCE(string_agg(c.relname, ', ' ORDER BY c.relname), '') " +
  'FROM pg_class c ' +
  'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
  "WHERE n.nspname = 'public' " +
  "AND c.relkind = 'r' " +
  'AND NOT c.relrowsecurity ' +
  "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')";

/**
 * Build the operator-facing failure message for a non-empty audit result.
 * @param {string} tableList Comma-separated table names from RLS_AUDIT_SQL.
 * @returns {string}
 */
export function rlsAuditFailureMessage(tableList) {
  return (
    `SECURITY: ${tableList.split(',').length} table(s) in the public schema have ` +
    `row-level security DISABLED: ${tableList}. The browser reaches these directly ` +
    `through PostgREST (/rest/v1), so they are readable/writable by anyone. Add ` +
    `\`ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;\` plus policies (in the same ` +
    `migration) before deploying. Refusing to deploy an exposed schema.`
  );
}

/**
 * Single-line shell snippet that runs the audit via `docker compose exec db`
 * and exits 1 (with a loud stderr message) when any public table lacks RLS.
 * Embedded into the compose migration step's SSH command.
 * @returns {string}
 */
export function composeRlsAuditShell() {
  // -tAc: tuples-only, unaligned, single command → stdout is the list or empty.
  return (
    `UNPROTECTED=$(docker compose exec -T db psql -U supabase_admin -d postgres -tAc ` +
    `"${RLS_AUDIT_SQL}" 2>/dev/null | tr -d '[:space:]'); ` +
    `if [ -n "$UNPROTECTED" ]; then ` +
    `echo "[migrate] SECURITY: public tables without RLS: $UNPROTECTED, refusing to deploy an exposed schema" >&2; ` +
    `exit 1; fi; ` +
    `echo "[migrate] RLS audit passed (every public table is protected)"`
  );
}
