import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Database access census: how the server reaches Postgres.
 *
 * All data goes through src/server/db/client.ts:
 *   - `withUserDb(userId, fn)` for anything done on behalf of a user or an
 *     anonymous visitor. RLS decides what `fn` sees.
 *   - `adminDb`, which bypasses RLS, only where the server acts for itself.
 *
 * The server uses no Supabase client at all (auth is in-process, data is
 * Drizzle). This census fails when:
 *   1. a file under src/server makes a data call through a Supabase client
 *      (`.from('table')`, `.rpc('fn')`, `.schema('x')`, storage), or imports
 *      @supabase/supabase-js at all;
 *   2. a file other than db/client.ts imports or names `adminDb` (or the raw
 *      `pool`) without being on the allowlist below (db/ helpers included);
 *   3. a file reaches db/client any way but a plain named import (namespace
 *      or default import, re-export, export-star, dynamic import, require),
 *      since the census cannot see what flows through those.
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

/** Files that may import `adminDb`, each with the reason it needs to bypass RLS. */
const ADMIN_DB_ALLOWLIST: Record<string, string> = {
  'auth/account-linking.ts':
    "social-link hook: removes an unverified account's password and sessions (auth tables are server-only)",
  'auth/assurance.ts':
    'marks a session two-factor verified and counts wrong step-up codes (auth tables are server-only)',
  'auth/forwardauth-token.ts':
    'mints and resolves the hashed ForwardAuth token and its bound session (auth tables are server-only)',
  'auth/impersonation.ts':
    "reads an impersonation target's role to refuse super admins (auth tables are server-only)",
  'auth/sign-in-record.ts':
    'stamps user.last_sign_in_at when a session is issued (auth tables are server-only)',
  'auth/bootstrap-admin.ts':
    'startup: finds or promotes the ADMIN_EMAIL account (no session; app_user cannot read "user")',
  'auth/index.ts':
    "Better Auth's drizzle adapter: the auth tables are server-only, app_user has no privileges",
  'auth/lockout.ts': 'sign-in lockout functions, called before the user is authenticated',
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
  'auth/bootstrap-admin.ts':
    'holds one dedicated client for the session advisory lock that serializes the super admin ' +
    'bootstrap across replicas; runs no queries on it besides pg_advisory_lock/unlock',
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

  it('no file under src/server imports a Supabase client', () => {
    const offenders = files
      .filter((f) => /from\s*['"]@supabase\/supabase-js['"]/.test(f.text))
      .map((f) => f.rel);
    expect(
      offenders,
      'The server has no Supabase client: auth is the in-process auth API ' +
        '(src/server/auth), data goes through db/client.ts.'
    ).toEqual([]);
  });
});


/** The module every database handle comes from. */
const DB_CLIENT = 'db/client.ts';
const DB_CLIENT_NO_EXT = join(SERVER, 'db', 'client');

/** Strip comments so prose that names `adminDb` is not counted as use. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1');
}

/** True when `spec`, imported from server file `rel`, is db/client (any suffix). */
function resolvesToDbClient(rel: string, spec: string): boolean {
  if (!spec.startsWith('.')) return false;
  const abs = resolve(dirname(join(SERVER, rel)), spec).replace(/\.(?:[cm]?js|ts)$/, '');
  return abs === DB_CLIENT_NO_EXT;
}

interface DbClientUse {
  /** Names imported with a plain named import (`import { a, type B } from`). */
  names: string[];
  /** Any other way of reaching db/client: namespace or default import,
   * re-export, export-star, dynamic import, require. The census cannot see
   * what flows through those, so they are refused outright. */
  opaque: string[];
  /** `adminDb` / `pool` appear as identifiers in the code (comments aside). */
  mentions: string[];
}

function dbClientUse(rel: string, text: string): DbClientUse {
  const code = stripComments(text);
  const use: DbClientUse = { names: [], opaque: [], mentions: [] };
  // Static import / export ... from '<spec>' (either quote style, multi-line).
  for (const m of code.matchAll(/\b(import|export)\s+([^;'"`]*?)\s*from\s*(['"])([^'"]+)\3/g)) {
    if (!resolvesToDbClient(rel, m[4])) continue;
    const named = m[1] === 'import' && /^(?:type\s+)?\{([^}]*)\}$/.exec(m[2].trim());
    if (!named) {
      use.opaque.push(`${m[1]} ${m[2].trim()} from ${m[4]}`);
      continue;
    }
    for (const part of named[1].split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0];
      if (name) use.names.push(name);
    }
  }
  // Side-effect import, dynamic import, require.
  for (const m of code.matchAll(
    /\bimport\s*(['"])([^'"]+)\1|\bimport\(\s*(['"`])([^'"`]+)\3\s*\)|\brequire\(\s*(['"])([^'"]+)\5\s*\)/g
  )) {
    const spec = m[2] ?? m[4] ?? m[6];
    if (resolvesToDbClient(rel, spec)) use.opaque.push(m[0]);
  }
  for (const id of ['adminDb', 'pool']) {
    if (new RegExp(`\\b${id}\\b`).test(code)) use.mentions.push(id);
  }
  return use;
}

const uses = files
  .filter((f) => f.rel !== DB_CLIENT)
  .map((f) => ({ rel: f.rel, use: dbClientUse(f.rel, f.text) }));

describe('db access census: adminDb only where the server acts for itself', () => {
  it('no file reaches db/client except through a plain named import', () => {
    const offenders = uses
      .filter((u) => u.use.opaque.length > 0)
      .map((u) => `${u.rel}: ${u.use.opaque.join('; ')}`);
    expect(
      offenders,
      'Import db/client with `import { withUserDb } from ...` only; namespace imports, ' +
        're-exports and dynamic imports hide adminDb from this census.'
    ).toEqual([]);
  });

  it('only allowlisted files import or name adminDb', () => {
    const offenders = uses
      .filter((u) => u.use.names.includes('adminDb') || u.use.mentions.includes('adminDb'))
      .filter((u) => !(u.rel in ADMIN_DB_ALLOWLIST))
      .map((u) => u.rel);
    expect(
      offenders,
      'adminDb bypasses RLS. Use withUserDb for anything done for a user; if this ' +
        'really is server-side work, add the file to ADMIN_DB_ALLOWLIST with a reason.'
    ).toEqual([]);
  });

  it('only allowlisted files import or name the raw pool', () => {
    const offenders = uses
      .filter((u) => u.use.names.includes('pool') || u.use.mentions.includes('pool'))
      .filter((u) => !(u.rel in POOL_ALLOWLIST))
      .map((u) => u.rel);
    expect(offenders).toEqual([]);
  });

  it('every allowlisted file exists and still imports adminDb (no stale entries)', () => {
    for (const rel of Object.keys(ADMIN_DB_ALLOWLIST)) {
      expect(existsSync(join(SERVER, rel)), rel).toBe(true);
      const text = readFileSync(join(SERVER, rel), 'utf8');
      expect(dbClientUse(rel, text).names, rel).toContain('adminDb');
    }
  });

  it('every allowlist entry carries a reason', () => {
    for (const [rel, reason] of Object.entries({ ...ADMIN_DB_ALLOWLIST, ...POOL_ALLOWLIST })) {
      expect(reason.trim().length, rel).toBeGreaterThan(10);
    }
  });

  describe('self-check: the census catches every way to reach adminDb', () => {
    const at = (rel: string, text: string) => dbClientUse(rel, text);
    const caught = (u: DbClientUse) =>
      u.opaque.length > 0 || u.names.includes('adminDb') || u.mentions.includes('adminDb');

    it.each([
      ['namespace import', 'lib/x.ts', "import * as db from '../db/client';"],
      ['re-export', 'lib/x.ts', "export { adminDb } from '../db/client';"],
      ['export star', 'lib/x.ts', "export * from '../db/client';"],
      ['double quotes', 'lib/x.ts', 'import { adminDb } from "../db/client";'],
      ['dynamic import with .js', 'lib/x.ts', "const m = await import('../db/client.js');"],
      ['named import with .js', 'lib/x.ts', "import { adminDb } from '../db/client.js';"],
      ['named import with .ts', 'lib/x.ts', "import { adminDb } from '../db/client.ts';"],
      ['default import', 'lib/x.ts', "import db from '../db/client';"],
      ['require', 'lib/x.ts', "const db = require('../db/client');"],
      [
        'a db/ helper wrapping adminDb',
        'db/helper.ts',
        "import { adminDb } from './client';\nexport const q = () => adminDb.select();",
      ],
      [
        'multi-line named import',
        'routes/v1/x.ts',
        "import {\n  type UserDb,\n  adminDb,\n} from '../../db/client';",
      ],
    ])('%s', (_name, rel, text) => {
      expect(caught(at(rel, text))).toBe(true);
    });

    it('a clean named import of withUserDb is not flagged', () => {
      const u = at('routes/v1/x.ts', "import { type UserDb, withUserDb } from '../../db/client';");
      expect(u).toEqual({ names: ['UserDb', 'withUserDb'], opaque: [], mentions: [] });
    });

    it('prose that names adminDb in a comment is not use', () => {
      expect(at('lib/x.ts', '// never the service-role adminDb\n/* pool */').mentions).toEqual([]);
    });

    it('the scan sees the real tree', () => {
      expect(uses.some((u) => u.use.names.includes('withUserDb'))).toBe(true);
      expect(uses.find((u) => u.rel === 'routes/v1/index.ts')?.use.names).toContain('adminDb');
    });
  });
});
