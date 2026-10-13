import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Database access census: how the server reaches Postgres.
 *
 * All data goes through src/server/db/client.ts:
 *   - `withUserDb(userId, fn)` for anything done on behalf of a user or an
 *     anonymous visitor. RLS decides what `fn` sees.
 *   - `adminDb`, which bypasses RLS, only where the server acts for itself.
 *
 * Supabase clients remain for Auth (GoTrue) only. This census fails when:
 *   1. a file under src/server makes a data call through a Supabase client
 *      (`.from('table')`, `.rpc('fn')`, `.schema('x')`, storage), or builds
 *      its own Supabase client outside lib/supabase.ts;
 *   2. a file imports `adminDb` (or the raw `pool`) without being on the
 *      allowlist below.
 *
 * Adding a file to ADMIN_DB_ALLOWLIST is a security decision: `adminDb` sees
 * every row of every user. A new user-facing route belongs on `withUserDb`.
 * If you do need `adminDb` (a webhook, an admin tool, a job), add the file
 * with a one-line reason, and check authorization (super_admin, or org
 * membership via requireOrgRole) before every query that takes a
 * user-supplied id.
 */

const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'src', 'server');

/**
 * Files that may import `adminDb`. Each one used the service-role
 * `supabaseAdmin` for the same data before the move to Drizzle.
 */
const ADMIN_DB_ALLOWLIST: Record<string, string> = {
  'billing/records.ts': 'billing webhooks write customer and subscription rows (no user session)',
  'lib/docs-settings.ts': 'reads app_settings.api_docs_enabled for the public API-docs gate',
  'lib/mfa-settings.ts': 'reads app_settings.mfa_enabled for the MFA gate',
  'middleware/crawler-tracking.ts': 'records anonymous crawler hits',
  'middleware/requirePlan.ts': "reads the caller's subscription for plan gating",
  'routes/v1/admin/contact.ts': 'super-admin contact inbox',
  'routes/v1/admin/crawlers.ts': 'super-admin crawler analytics',
  'routes/v1/admin/jobs.ts': 'super-admin job list and manual job runs',
  'routes/v1/admin/newsletter.ts': 'super-admin newsletter export and send',
  'routes/v1/auth.ts': 'login lockout functions, called before the user is authenticated',
  'routes/v1/billing.ts': 'customer rows around billing-provider calls, after requireOrgRole',
  'routes/v1/contact.ts': 'anonymous contact form insert',
  'routes/v1/index.ts':
    'super-admin endpoints, account deletion, org creation and invites (user reads use withUserDb)',
  'routes/v1/newsletter.ts': 'anonymous subscribe, confirm and unsubscribe by token',
  'routes/v1/setup.ts': 'super-admin setup settings',
  'routes/v1/stats.ts': 'super-admin dashboard counts',
  'routes/v1/theme.ts': 'public theme read and super-admin theme write',
  'routes/webhooks/billing.ts': 'signature-verified billing webhook writes',
  'routes/webhooks/stripe.ts': 'signature-verified Stripe webhook writes',
};

/** Files that may import the raw pg `pool` (bypasses RLS like adminDb). */
const POOL_ALLOWLIST: Record<string, string> = {
  'index.ts': 'drains the pool on graceful shutdown',
};

function serverFiles(dir = SERVER): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...serverFiles(path));
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const files = serverFiles().map((path) => ({
  rel: relative(SERVER, path).split('\\').join('/'),
  text: readFileSync(path, 'utf8'),
}));

/** Names a file imports statically from db/client, or ['*'] for a dynamic import. */
function dbClientImports(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'[^']*db\/client'/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
      if (name) names.push(name);
    }
  }
  if (/import\(\s*['"][^'"]*db\/client['"]\s*\)/.test(text)) names.push('*');
  return names;
}

const inDbModule = (rel: string) => rel.startsWith('db/');

describe('db access census: no data through Supabase clients', () => {
  // `.from('table')` with a string is the supabase-js query builder; Drizzle's
  // `.from()` takes a table object, never a string literal.
  const SUPABASE_DATA_CALL =
    /(?<!\b(?:Array|Buffer|Object|Uint8Array))\.(from|rpc|schema)\(\s*['"`]|\.storage\s*\.\s*from\(/;

  it('no file under src/server calls .from()/.rpc()/.schema()/storage on a Supabase client', () => {
    const offenders = files
      .filter((f) => SUPABASE_DATA_CALL.test(f.text))
      .map((f) => `${f.rel}: ${f.text.match(SUPABASE_DATA_CALL)?.[0]}`);
    expect(
      offenders,
      'Data goes through db/client.ts: withUserDb for user requests, adminDb for ' +
        'server-side work. Supabase clients are for Auth only.'
    ).toEqual([]);
  });

  it('only lib/supabase.ts creates Supabase clients', () => {
    const offenders = files
      .filter((f) => f.rel !== 'lib/supabase.ts')
      .filter((f) => /from\s*'@supabase\/supabase-js'/.test(f.text))
      .filter((f) => /import\s*\{[^}]*\bcreateClient\b/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('lib/supabase.ts hands out auth-only clients', () => {
    const text = files.find((f) => f.rel === 'lib/supabase.ts')?.text ?? '';
    expect(text).toMatch(/export type AuthOnlyClient = Pick<SupabaseClient<Database>, 'auth'>/);
    // Every exported client is typed AuthOnlyClient, never a full SupabaseClient.
    expect(text).not.toMatch(/export (const \w+|function \w+\([^)]*\)): SupabaseClient/);
  });
});

describe('db access census: adminDb only where the server acts for itself', () => {
  it('every file that imports adminDb is on the allowlist', () => {
    const offenders = files
      .filter((f) => !inDbModule(f.rel))
      .filter((f) => {
        const names = dbClientImports(f.text);
        return names.includes('adminDb') || names.includes('*');
      })
      .filter((f) => !(f.rel in ADMIN_DB_ALLOWLIST))
      .map((f) => f.rel);
    expect(
      offenders,
      'adminDb bypasses RLS. Use withUserDb for anything done for a user; if this ' +
        'really is server-side work, add the file to ADMIN_DB_ALLOWLIST with a reason.'
    ).toEqual([]);
  });

  it('every allowlisted file exists and still imports adminDb (no stale entries)', () => {
    for (const rel of Object.keys(ADMIN_DB_ALLOWLIST)) {
      expect(existsSync(join(SERVER, rel)), rel).toBe(true);
      const text = readFileSync(join(SERVER, rel), 'utf8');
      expect(dbClientImports(text), rel).toContain('adminDb');
    }
  });

  it('every allowlist entry carries a reason', () => {
    for (const [rel, reason] of Object.entries({ ...ADMIN_DB_ALLOWLIST, ...POOL_ALLOWLIST })) {
      expect(reason.trim().length, rel).toBeGreaterThan(10);
    }
  });

  it('only the allowlisted files import the raw pool', () => {
    const offenders = files
      .filter((f) => !inDbModule(f.rel))
      .filter((f) => dbClientImports(f.text).includes('pool'))
      .filter((f) => !(f.rel in POOL_ALLOWLIST))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('the census sees the db/client imports it is meant to see (self-check)', () => {
    expect(dbClientImports("import { adminDb, type UserDb, withUserDb } from '../../db/client';"))
      .toEqual(['adminDb', 'UserDb', 'withUserDb']);
    expect(dbClientImports("const m = await import('../db/client');")).toEqual(['*']);
    expect(
      files.some((f) => dbClientImports(f.text).includes('withUserDb')),
      'no file imports withUserDb: the scan is broken'
    ).toBe(true);
  });
});
