import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Security invariants — the dev-time net.
 *
 * These assert the security properties that keep this app safe as you extend
 * it. They run under `npm test` and in CI, so a change that would introduce
 * the classic self-hosted-Supabase holes fails fast, with a clear message,
 * before it can ship. (The deploy also re-checks RLS against the live database
 * as a ground-truth backstop — this catches it earlier and explains why.)
 *
 * If a test here fails, DO NOT delete the assertion — fix the code. Each guards
 * a real, exploitable vulnerability, explained inline.
 */

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');
const exists = (rel: string) => existsSync(join(ROOT, rel));

function allMigrationsSql(): string {
  const dir = join(ROOT, 'supabase', 'migrations');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf-8'))
    .join('\n');
}

const sql = allMigrationsSql();

describe('RLS: every public table is protected', () => {
  // The browser queries PostgREST directly (/rest/v1). A `public` table without
  // RLS is readable AND writable by anyone on the internet.
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
    const unprotected = [...created].filter((t) => !rlsEnabled.has(t));
    expect(
      unprotected,
      `Tables created without RLS: ${unprotected.join(', ')}. Add ` +
        `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY + policies in the same migration.`,
    ).toEqual([]);
  });
});

describe('RLS: write policies are scoped correctly', () => {
  // Postgres evaluates a policy's USING (which rows are targetable) and
  // WITH CHECK (what the row may become) INDEPENDENTLY. An UPDATE/INSERT
  // policy with a USING but no WITH CHECK (or WITH CHECK (true)) lets a user
  // rewrite a row's owner/tenant column into someone else's — a takeover.
  it('every UPDATE/INSERT policy declares a WITH CHECK', () => {
    const offenders: string[] = [];
    for (const m of sql.matchAll(
      /CREATE POLICY\s+"([^"]+)"\s+ON\s+[\w."]+\s+FOR\s+(UPDATE|INSERT)([\s\S]*?);/gi,
    )) {
      const [, name, op, body] = m;
      if (!/WITH CHECK/i.test(body)) offenders.push(`${name} (${op})`);
    }
    expect(
      offenders,
      `Policies missing WITH CHECK: ${offenders.join('; ')}. A write policy ` +
        `without WITH CHECK lets a user move a row out of their own scope.`,
    ).toEqual([]);
  });

  it('no policy is gated on user_metadata (user-writable via GoTrue)', () => {
    // app_metadata is server/service-role controlled; user_metadata is set by
    // the user's own updateUser call. Gating on it is self-service escalation.
    const inPolicies = sql.match(/CREATE POLICY[\s\S]*?user_metadata/i);
    expect(inPolicies, 'A policy references user_metadata — use app_metadata.').toBeNull();
  });
});

describe('Routing: single public origin is preserved', () => {
  // Only the VERSIONED Supabase prefixes route to Kong; the SPA owns
  // /auth/callback. A bare /auth prefix sends the OAuth landing page to Kong
  // (404) and breaks login. There is no separate api.<domain> host.
  const composeProd = exists('docker-compose.prod.yml') ? read('docker-compose.prod.yml') : '';

  it.runIf(composeProd)('no bare /auth|/rest|/realtime|/storage Traefik prefix', () => {
    for (const bare of ['/auth', '/rest', '/realtime', '/storage']) {
      expect(
        composeProd.includes(`PathPrefix(\`${bare}\`)`),
        `Bare ${bare} prefix found — use the versioned form (${bare}/v1).`,
      ).toBe(false);
    }
  });

  it.runIf(composeProd)('Supabase is not re-exposed on an api.<domain> host', () => {
    expect(composeProd).not.toContain('Host(`api.');
  });
});

describe('Auth config: GoTrue is not dangerously permissive', () => {
  // GOTRUE_URI_ALLOW_LIST must be origin-scoped. "*" lets an attacker point an
  // unauthenticated resetPasswordForEmail at their own domain and receive the
  // victim's recovery tokens in the redirect fragment = account takeover.
  const compose = exists('docker-compose.yml') ? read('docker-compose.yml') : '';
  const k8sValues = exists('k8s/values/supabase.values.yaml')
    ? read('k8s/values/supabase.values.yaml')
    : '';

  it.runIf(compose)('compose redirect allow-list is not a wildcard', () => {
    const m = compose.match(/GOTRUE_URI_ALLOW_LIST:\s*"?([^"\n]+)"?/);
    expect(m, 'GOTRUE_URI_ALLOW_LIST not found').not.toBeNull();
    expect(m?.[1]?.trim()).not.toBe('*');
  });

  it.runIf(k8sValues)('k8s redirect allow-list is not a wildcard', () => {
    // Value follows the `name: GOTRUE_URI_ALLOW_LIST` line.
    const m = k8sValues.match(/GOTRUE_URI_ALLOW_LIST\s*\n\s*value:\s*"?([^"\n]+)"?/);
    expect(m, 'GOTRUE_URI_ALLOW_LIST not found in k8s values').not.toBeNull();
    expect(m?.[1]?.trim()).not.toBe('*');
  });

  it.runIf(compose && k8sValues)('a password minimum length (>=8) is set on both edges', () => {
    for (const [label, cfg] of [
      ['compose', compose],
      ['k8s', k8sValues],
    ] as const) {
      const m = cfg.match(/GOTRUE_PASSWORD_MIN_LENGTH[":\s]+.*?(\d+)/);
      expect(m, `GOTRUE_PASSWORD_MIN_LENGTH missing (${label})`).not.toBeNull();
      expect(Number(m?.[1])).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('Rate limiting: abuse-prone routes are protected', () => {
  const srv = (rel: string) => (exists(`src/server/${rel}`) ? read(`src/server/${rel}`) : '');
  const index = srv('index.ts');
  const auth = srv('routes/v1/auth.ts');
  const billing = srv('routes/v1/billing.ts');

  it.runIf(index)('the readiness probe path is rate-limited (not just bare /api/health)', () => {
    // /api/health is an EXACT Hono match; the DB-hitting /ready needs the glob.
    expect(index).toContain("app.use('/api/health/*'");
  });

  it.runIf(auth)('login has a dedicated strict limiter', () => {
    expect(auth).toMatch(/authRoutes\.use\(\s*['"]\/login['"]\s*,\s*createRateLimiter/);
  });

  it.runIf(billing)('public license checkout is strictly limited', () => {
    expect(billing).toMatch(/\/license-checkout['"]\s*,\s*createRateLimiter/);
  });

  it.runIf(billing)('authed provider-cost routes (checkout/setup/portal) are limited', () => {
    // Registered together in a loop; assert the limiter + the path set are present.
    expect(billing).toContain('createRateLimiter');
    for (const p of ['/checkout', '/setup', '/portal']) {
      expect(billing).toContain(`'${p}'`);
    }
  });
});

describe('Session cookies: the split-cookie contract holds', () => {
  // Spec 2026-07-24-session-cookie-split. Two cookies, two jobs, never merged:
  //  - sb-auth-token: SPA session store, HOST-ONLY (holds the refresh token —
  //    a domain= attribute would send it to every admin subdomain where any
  //    bundled tool's XSS could read it).
  //  - vc-admin-token: ForwardAuth credential, HttpOnly, access token only.
  const clientSupabase = read('src/client/lib/supabase.ts');
  const verifyRole = read('src/server/routes/_internal/verify-role.ts');
  const forwardAuthCookie = read('src/server/routes/v1/forwardauth-cookie.ts');
  const impersonation = read('src/server/routes/v1/impersonation.ts');
  const authProvider = read('src/client/components/auth/AuthProvider.tsx');

  it('the SPA session cookie write is host-only (no domain attribute)', () => {
    // setItem's live write must not interpolate a domain. The only domain=
    // usage allowed in the adapter is the legacy-cookie expiry.
    const setItem = clientSupabase.match(/setItem[\s\S]*?document\.cookie = `[^`]*`/)?.[0] ?? '';
    expect(setItem, 'cookieStorage.setItem not found').not.toBe('');
    expect(
      setItem.includes('domain='),
      'cookieStorage.setItem writes a domain-scoped session cookie — the ' +
        'session (refresh token included) must stay host-only on the apex.',
    ).toBe(false);
  });

  it('verify-role does not accept the SPA session cookie as a ForwardAuth credential', () => {
    for (const legacy of ["'sb-auth-token'", "'sb-access-token'", "startsWith('sb-')"]) {
      expect(
        verifyRole.includes(legacy),
        `verify-role parses ${legacy} — possession of the JS-readable SPA ` +
          `session cookie must not gate admin infra; only vc-admin-token may.`,
      ).toBe(false);
    }
    expect(verifyRole).toContain("'vc-admin-token'");
  });

  it('both server-set auth cookies are HttpOnly', () => {
    for (const [label, src] of [
      ['forwardauth-cookie', forwardAuthCookie],
      ['impersonation', impersonation],
    ] as const) {
      expect(
        /httpOnly:\s*true/.test(src),
        `${label} sets a cookie without httpOnly: true — XSS could read it.`,
      ).toBe(true);
    }
  });

  it('the impersonation restore cookie is path-scoped and SameSite=Strict', () => {
    expect(impersonation).toContain("path: '/api/v1/admin/impersonate'");
    expect(impersonation).toMatch(/sameSite:\s*'Strict'/);
  });

  it('the client never stores a session in localStorage (impersonation stash regression)', () => {
    expect(
      authProvider.includes('impersonation_admin_session'),
      'The pre-split impersonation stash key is back — the admin session ' +
        'must be parked server-side in the HttpOnly restore cookie only.',
    ).toBe(false);
    expect(
      /localStorage\.setItem\([^)]*[sS]ession/.test(authProvider),
      'AuthProvider writes a session into localStorage — sessions must never ' +
        'be client-stored outside the supabase cookie adapter.',
    ).toBe(false);
  });
});
