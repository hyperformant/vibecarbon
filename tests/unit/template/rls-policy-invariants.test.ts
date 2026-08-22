import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RLS boundary invariants (2026-07-23 security audit). The browser queries
 * PostgREST directly through Kong (`/rest/v1`), so RLS is the ONLY data-layer
 * defense — a single under-scoped policy is a cross-tenant hole for every
 * tenant on the stack. These static guards pin the audit's fixes so the bug
 * class cannot silently return in a future migration edit.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'carbon/supabase/migrations');

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

describe('RLS: role checks read the server-controlled claim', () => {
  it('is_super_admin reads app_metadata, never the user-writable user_metadata', () => {
    const fn = sql.match(/FUNCTION\s+(?:public\.)?is_super_admin[\s\S]*?\$\$;/i);
    expect(fn, 'is_super_admin not found').not.toBeNull();
    const body = fn?.[0] ?? '';
    expect(body).toMatch(/app_metadata/);
    expect(body).not.toMatch(/user_metadata/);
  });
});

describe('RLS: SECURITY DEFINER RPC surface is locked down', () => {
  it('log_cron_job is revoked from public/anon/authenticated', () => {
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION\s+(?:public\.)?log_cron_job[^;]*FROM[^;]*\b(anon|PUBLIC)\b/i,
    );
  });

  it('the billing customers table has no client INSERT policy', () => {
    expect(sql).not.toMatch(/CREATE POLICY[^;]*ON\s+customers\s+FOR INSERT/i);
  });
});
