/**
 * Regression guard for the compose super-admin provisioning escape bug
 * (RCA 2026-05-30).
 *
 * `vibecarbon create` writes ADMIN_PASSWORD to `.env` via `escapeDotenv`
 * (POSIX single-quoting) while ADMIN_EMAIL / SUPABASE_SERVICE_ROLE_KEY are
 * double-quoted. The compose `createAdminUser` path used to extract these with
 * a double-quote-only regex, so a single-quoted password arrived at GoTrue
 * wrapped in literal `'…'` — the deploy reported "Admin user created" but the
 * operator could never sign in (e2e `auth_admin_login` returned 400
 * invalid_credentials on compose + compose-ha).
 *
 * These tests pin the contract: credentials must round-trip through
 * escapeDotenv → readAdminCredentials back to their RAW values.
 */
import { describe, expect, it } from 'vitest';
import { readAdminCredentials } from '../../../src/lib/deploy/compose/index.js';
import { escapeDotenv } from '../../../src/lib/shell.js';

/** Build a `.env` body exactly the way create.js renders these three keys. */
function renderEnv(email: string, password: string, serviceKey: string): string {
  return [
    '# ADMIN CREDENTIALS',
    `ADMIN_EMAIL="${email}"`,
    `ADMIN_PASSWORD=${escapeDotenv(password)}`,
    `SUPABASE_SERVICE_ROLE_KEY="${serviceKey}"`,
    '',
  ].join('\n');
}

describe('readAdminCredentials', () => {
  it('round-trips the single-quoted password create.js writes (no quote leakage)', () => {
    const env = renderEnv('test@vibecarbon.dev', 'TestPassword123!', 'service-role-jwt');
    const creds = readAdminCredentials(env);

    expect(creds.adminEmail).toBe('test@vibecarbon.dev');
    // The bug: a double-quote-only regex returned "'TestPassword123!'".
    expect(creds.adminPassword).toBe('TestPassword123!');
    expect(creds.serviceRoleKey).toBe('service-role-jwt');
  });

  it('handles passwords containing the shell-significant characters escapeDotenv guards', () => {
    // Embedded single quote exercises escapeDotenv's '\'' close-reopen path.
    const tricky = "p@ss'w0rd!$x";
    const env = renderEnv('admin@example.com', tricky, 'svc');
    const creds = readAdminCredentials(env);

    expect(creds.adminPassword).toBe(tricky);
  });

  it('returns undefined fields when keys are absent (caller treats as missing creds)', () => {
    const creds = readAdminCredentials('# empty\nSITE_URL="http://localhost:5173"\n');
    expect(creds.adminEmail).toBeUndefined();
    expect(creds.adminPassword).toBeUndefined();
    expect(creds.serviceRoleKey).toBeUndefined();
  });
});

describe('createAdminUser gates on the database accepting connections first', () => {
  it('the pg_isready gate sits before the attempt machinery in source order', async () => {
    // Source-shape pin (no execution harness exists for compose
    // createAdminUser): the db-accepting gate must run BEFORE attemptOnce is
    // even defined, because the GoTrue 500s the attempt ladder absorbs are
    // db-driven — auth answers /health while its session pool is still
    // refused by a mid-lifecycle Postgres (mitigation-audit cluster 5).
    const { createAdminUser } = await import('../../../src/lib/deploy/compose/index.js');
    const source = createAdminUser.toString();
    const gateIdx = source.indexOf('pg_isready');
    const attemptIdx = source.indexOf('attemptOnce');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(attemptIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(attemptIdx);
  });
});
