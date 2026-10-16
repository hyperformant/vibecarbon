import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RLS boundary invariants (2026-07-23 security audit; app_user contract
 * 2026-10-13). User requests run as role app_user with app.user_id() set per
 * transaction, and RLS is the data-layer boundary: a single under-scoped
 * policy is a cross-tenant hole for every tenant on the stack. These static guards pin the audit's fixes so the bug
 * class cannot silently return in a future migration edit.
 */

// The template's baseline: two custom SQL files around the one drizzle-kit
// generates from carbon/src/server/db/schema.ts (policies are pgPolicy
// entries there), so the guards below read what actually reaches Postgres.
const MIGRATIONS_DIR = join(process.cwd(), 'carbon/db/migrations');

function allMigrationsSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'))
    .join('\n');
}

const sql = allMigrationsSql();

describe('RLS: every public table is protected', () => {
  it('every CREATE TABLE has a matching ENABLE ROW LEVEL SECURITY', () => {
    const created = new Set<string>();
    for (const m of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:public\.)?"?(\w+)"?/gi)) {
      created.add(m[1].toLowerCase());
    }
    const rlsEnabled = new Set<string>();
    for (const m of sql.matchAll(
      /ALTER TABLE\s+(?:public\.)?"?(\w+)"?\s+ENABLE ROW LEVEL SECURITY/gi,
    )) {
      rlsEnabled.add(m[1].toLowerCase());
    }
    expect(created.size).toBeGreaterThan(0);
    const unprotected = [...created].filter((t) => !rlsEnabled.has(t));
    expect(unprotected, `tables created without RLS: ${unprotected.join(', ')}`).toEqual([]);
  });
});

describe('RLS: UPDATE WITH CHECK mirrors the org scope of USING', () => {
  it('the memberships admin-UPDATE WITH CHECK carries the org-id scope, not just role', () => {
    // The audit CRITICAL: a WITH CHECK of only `role <> 'OWNER'` let an admin
    // rewrite a row's organization_id into an org they do not administer.
    const policy = sql.match(
      /CREATE POLICY "Admins can update non-owner memberships"[\s\S]*?WITH CHECK\s*\(([\s\S]*?)\);/i,
    );
    expect(policy, 'admin-UPDATE membership policy not found').not.toBeNull();
    const withCheck = policy?.[1] ?? '';
    expect(withCheck).toMatch(/get_user_admin_org_ids/);
  });

  it('the organizations UPDATE policy has an explicit org-scoped WITH CHECK', () => {
    const policy = sql.match(
      /CREATE POLICY "Owners and admins can update organizations"[\s\S]*?WITH CHECK\s*\(([\s\S]*?)\);/i,
    );
    expect(policy, 'organizations UPDATE WITH CHECK missing').not.toBeNull();
    expect(policy?.[1] ?? '').toMatch(/get_user_admin_org_ids/);
  });
});

describe('RLS: role checks read the server-controlled role column', () => {
  it('is_super_admin reads "user".role for app.user_id(), SECURITY DEFINER with an empty search_path', () => {
    const fn = sql.match(/FUNCTION\s+(?:public\.)?is_super_admin[\s\S]*?\$\$;/i);
    expect(fn, 'is_super_admin not found').not.toBeNull();
    const body = fn?.[0] ?? '';
    expect(body).toMatch(/\brole\s*=\s*'super_admin'/);
    expect(body).toMatch(/FROM\s+public\."user"/i);
    expect(body).toMatch(/app\.user_id\(\)/);
    expect(body).toMatch(/SECURITY DEFINER/i);
    expect(body).toMatch(/SET search_path = ''/i);
    expect(body).not.toMatch(/auth\.users|meta_?data/i);
  });
});

describe('Auth tables are server-only', () => {
  // Password hashes, session tokens, OAuth tokens and TOTP secrets: only the
  // server (adminDb, BYPASSRLS) may touch them. RLS on with no policies, and
  // the request role's grants revoked, so neither a stray policy nor a
  // blanket GRANT alone can expose them.
  const AUTH_TABLES = ['"user"', 'session', 'account', 'verification', 'two_factor'];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  it('no migration references the old auth.users table', () => {
    expect(sql.replace(/--.*$/gm, '')).not.toMatch(/auth\.users/i);
  });

  it('enables RLS on every auth table and defines no policy on any', () => {
    for (const t of AUTH_TABLES) {
      // drizzle-kit quotes every identifier; hand-written SQL may not.
      const name = `"?${esc(t.replaceAll('"', ''))}"?`;
      expect(sql, `${t}: RLS not enabled`).toMatch(
        new RegExp(`ALTER TABLE\\s+(?:"?public"?\\.)?${name}\\s+ENABLE ROW LEVEL SECURITY`, 'i'),
      );
      expect(sql, `${t}: has a policy`).not.toMatch(
        new RegExp(`CREATE POLICY[^;]*\\bON\\s+(?:"?public"?\\.)?${name}[\\s;]`, 'i'),
      );
    }
  });

  it('revokes every auth table from PUBLIC and, per role, from every request role', () => {
    const tableList =
      'public."user", public.session, public.account, public.verification, public.two_factor';
    expect(sql).toContain(`REVOKE ALL ON TABLE ${tableList} FROM %I`);
    // Every role that is neither superuser nor RLS-bypass, so app_user,
    // metabase (default SELECT on public tables) and any role the image or an
    // optional service creates. A fixed list would miss a role it never named
    // and re-expose password hashes and session tokens to it.
    const loop = sql.match(
      /FOR r IN\s+SELECT rolname FROM pg_catalog\.pg_roles\s+WHERE ([^\n]*)/,
    )?.[1];
    expect(loop, 'auth-table revoke loop not found').toBeDefined();
    expect(loop).toMatch(/NOT rolsuper AND NOT rolbypassrls/);
    expect(sql).toContain(
      'REVOKE ALL ON TABLE "user", session, account, verification, two_factor FROM PUBLIC;',
    );
  });

  it('every former auth.users foreign key points at "user"(id)', () => {
    for (const [table, column, onDelete] of [
      ['memberships', 'user_id', 'CASCADE'],
      ['customers', 'user_id', 'CASCADE'],
      ['notifications', 'created_by', 'SET NULL'],
      ['notification_dismissals', 'user_id', 'CASCADE'],
      ['app_settings', 'updated_by', 'SET NULL'],
    ]) {
      // drizzle-kit adds every foreign key as its own ALTER TABLE.
      expect(sql, `${table}.${column}`).toMatch(
        new RegExp(
          `ALTER TABLE "${table}" ADD CONSTRAINT "\\w+" FOREIGN KEY \\("${column}"\\) ` +
            `REFERENCES "public"\\."user"\\("id"\\) ON DELETE ${onDelete}`,
          'i',
        ),
      );
    }
  });
});

describe('RLS: policies read the request identity from app.user_id()', () => {
  // User requests run as role app_user with app.user_id set per transaction.
  // auth.uid()/auth.jwt() are never set on that path: a policy or helper that
  // still reads them silently matches nothing (or, worse, something else if a
  // JWT claim setting ever leaked in).
  it('no migration calls auth.uid() or auth.jwt()', () => {
    const code = sql.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/auth\.uid\(\)/i);
    expect(code).not.toMatch(/auth\.jwt\(\)/i);
  });

  it('no grant, revoke or policy names a role that plain Postgres lacks', () => {
    // The migrations must apply on a stock postgres image, where only
    // postgres, app_user and the optional service roles exist. Comments,
    // quoted identifiers and string literals ('authenticated' is a
    // notification visibility value) are stripped before the check.
    const code = sql.replace(/--.*$/gm, '');
    const statements = [
      ...code.matchAll(/\b(?:GRANT|REVOKE|CREATE POLICY|ALTER DEFAULT PRIVILEGES)\b[^;]*;/gi),
    ].map((m) => m[0].replace(/'[^']*'|"[^"]*"/g, ''));
    const foreign = /\b(anon|authenticated|service_role|authenticator)\b/i;
    const bad = statements.filter((st) => foreign.test(st));
    expect(bad, `statements naming a missing role: ${bad.join(' | ')}`).toEqual([]);
  });

  it('defines app_user (NOLOGIN), app.user_id(), and grants app_user to the connection role', () => {
    expect(sql).toMatch(/CREATE ROLE app_user NOLOGIN/i);
    expect(sql).toMatch(/GRANT app_user TO postgres/i);
    const fn = sql.match(/FUNCTION\s+app\.user_id\(\)[\s\S]*?\$\$;/i);
    expect(fn, 'app.user_id() not found').not.toBeNull();
    expect(fn?.[0]).toMatch(/nullif\(current_setting\('app\.user_id', true\), ''\)::uuid/i);
    expect(fn?.[0]).toMatch(/\bSTABLE\b/i);
  });

  it('the notification read policies split on whether app.user_id() is set', () => {
    const authed = sql.match(
      /CREATE POLICY "Authenticated users can view relevant notifications"[\s\S]*?;/i,
    );
    const anon = sql.match(
      /CREATE POLICY "Anonymous users can view public notifications"[\s\S]*?;/i,
    );
    expect(authed?.[0]).toMatch(/app\.user_id\(\)\)\s+IS NOT NULL/i);
    expect(anon?.[0]).toMatch(/app\.user_id\(\)\)\s+IS NULL/i);
  });
});

describe('RLS: SECURITY DEFINER RPC surface is locked down', () => {
  it('log_cron_job is revoked from PUBLIC', () => {
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION\s+(?:public\.)?log_cron_job[^;]*FROM[^;]*\bPUBLIC\b/i,
    );
  });

  it('every REVOKE EXECUTE also revokes from app_user (functions default to app_user EXECUTE)', () => {
    const revokes = [...sql.matchAll(/REVOKE EXECUTE ON FUNCTION[^;]*;/gi)].map((m) => m[0]);
    expect(revokes.length).toBeGreaterThan(0);
    const missing = revokes.filter((r) => !/\bapp_user\b/.test(r));
    expect(missing, `REVOKEs missing app_user: ${missing.join(' | ')}`).toEqual([]);
  });

  it('the billing customers table has no client INSERT policy', () => {
    expect(sql).not.toMatch(/CREATE POLICY[^;]*ON\s+"?customers"?\s+(?:AS \w+\s+)?FOR INSERT/i);
  });
});
