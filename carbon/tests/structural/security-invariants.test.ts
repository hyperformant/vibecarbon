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

  it('no policy is gated on user_metadata (user-writable profile data)', () => {
    // Roles live in the server-controlled "user".role, read through
    // is_super_admin(). Profile fields are set by the user's own update call;
    // gating on them is self-service escalation.
    const inPolicies = sql.match(/CREATE POLICY[\s\S]*?user_metadata/i);
    expect(inPolicies, 'A policy references user_metadata — use is_super_admin().').toBeNull();
  });

  it('policies and helpers read the caller from app.user_id(), never auth.uid()', () => {
    // User requests run as role app_user with app.user_id set for the
    // transaction. auth.uid() is never set on that path, so a policy reading
    // it matches nothing and the feature silently returns empty results.
    const code = sql.replace(/--.*$/gm, '');
    expect(code, 'Use (SELECT app.user_id()) instead of auth.uid().').not.toMatch(/auth\.uid\(\)/i);
    expect(code, 'Use is_super_admin() instead of auth.jwt().').not.toMatch(/auth\.jwt\(\)/i);
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

describe('Auth: only the in-process auth exists, and it is not permissive', () => {
  // Auth is the app's own /api/auth (src/server/auth/). A second, external
  // auth service reachable at /auth/v1 would be a parallel sign-in path with
  // its own users, sessions and redirect rules, outside every check here.
  const yamlUnder = (function walk(dir: string): string[] {
    if (!exists(dir)) return [];
    return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) return walk(rel);
      return /\.ya?ml$/.test(e.name) ? [rel] : [];
    });
  });
  const routingFiles = [
    ...readdirSync(ROOT).filter((f) => /^docker-compose.*\.ya?ml$/.test(f)),
    ...yamlUnder('volumes/kong'),
    ...yamlUnder('volumes/traefik'),
    ...yamlUnder('k8s'),
  ];
  const uncommented = (text: string) => text.replace(/^\s*#.*$/gm, '');

  it('nothing routes /auth/v1 (no external auth service behind any edge)', () => {
    expect(routingFiles).toContain('volumes/kong/kong.yml');
    expect(routingFiles).toContain('k8s/base/traefik/ingressroute.yaml');
    const offenders = routingFiles.filter((f) => uncommented(read(f)).includes('/auth/v1'));
    expect(
      offenders,
      `${offenders.join(', ')} route /auth/v1. Auth is the app's /api/auth; do not ` +
        'route a public path to a separate auth service.'
    ).toEqual([]);
  });

  it('no compose file or chart value runs a separate auth service', () => {
    for (const f of routingFiles.filter((f) => f.startsWith('docker-compose'))) {
      expect(uncommented(read(f)), `${f} defines an auth service`).not.toMatch(/^ {2}auth:\s*$/m);
    }
    expect(
      read('k8s/values/supabase.values.yaml'),
      "the chart's auth service must stay disabled"
    ).toMatch(/^deployment:\n {2}auth:\n(?: {4}#.*\n)* {4}enabled: false$/m);
  });

  // trustedOrigins decides which origins may call the auth API with cookies
  // and which callback / redirect targets it honours. "*" (or any glob) lets
  // an attacker's page send a victim's password reset or magic link to their
  // own domain = account takeover.
  const authConfig = read('src/server/auth/index.ts');

  it('trustedOrigins is the exact-origin list, never a wildcard', () => {
    expect(authConfig).toContain('trustedOrigins: allowedOrigins()');
    expect(uncommented(authConfig)).not.toMatch(/trustedOrigins:\s*\[?\s*['"`]\*/);
    // allowedOrigins() refuses a glob in SITE_URL and CORS_ORIGINS.
    const origins = read('src/server/lib/origins.ts');
    expect(origins).toContain('/[*?]/.test(origin)');
    expect(origins).toMatch(/throw new Error\(/);
  });

  it('the auth API keeps its own origin and CSRF checks on', () => {
    expect(authConfig).toContain('disableOriginCheck: false');
    expect(authConfig).toContain('disableCSRFCheck: false');
  });

  it('a password minimum length (>=8) is set', () => {
    const m = authConfig.match(/minPasswordLength:\s*(\d+)/);
    expect(m, 'minPasswordLength missing in src/server/auth/index.ts').not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(8);
  });

  it('the session cookie stays host-only (no parent-domain scope)', () => {
    // A parent-domain session cookie would reach every admin subdomain.
    expect(authConfig).not.toContain('crossSubDomainCookies');
    expect(uncommented(authConfig)).not.toMatch(/\bdomain:/);
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

  it('password sign-in has a dedicated strict limiter (10 per 15 min per IP)', () => {
    const caps = srv('middleware/auth-rate-limits.ts');
    expect(caps).toMatch(
      /path:\s*'\/api\/auth\/sign-in\/email',\s*windowMs:\s*15\s*\*\s*MINUTE,\s*max:\s*10\b/
    );
  });

  it.runIf(auth)('no legacy password login route survives beside the auth API', () => {
    expect(auth).not.toMatch(/authRoutes\.post\(\s*['"]\/login['"]/);
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
  // Two cookies, two jobs, never merged:
  //  - the auth API's session cookie: HttpOnly, host-only, set by
  //    /api/auth/*. Page JS never sees it or any session token.
  //  - vc-admin-token: the ForwardAuth credential, HttpOnly, super admins only.
  const verifyRole = read('src/server/routes/_internal/verify-role.ts');
  const forwardAuthCookie = read('src/server/routes/v1/forwardauth-cookie.ts');
  const authProvider = read('src/client/components/auth/AuthProvider.tsx');
  const clientSources = (function walk(dir: string): [string, string][] {
    return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) return walk(rel);
      return /\.(ts|tsx)$/.test(e.name) ? [[rel, read(rel)] as [string, string]] : [];
    });
  })('src/client');

  it('the SPA keeps no session of its own: no client-side session module', () => {
    expect(
      exists('src/client/lib/supabase.ts'),
      'A client session store is back. Sessions are HttpOnly cookies the auth ' +
        'API sets; page JS must never hold a session or refresh token.'
    ).toBe(false);
  });

  it('client code never sends an Authorization header (the cookie is the credential)', () => {
    for (const [rel, src] of clientSources) {
      expect(
        /Authorization['"]?\s*:/.test(src) || /Bearer \$\{/.test(src),
        `${rel} attaches an Authorization header. Same-origin calls carry the ` +
          'HttpOnly session cookie; there is no token in page JS to send.'
      ).toBe(false);
    }
  });

  it('API calls go out same-origin with credentials', () => {
    const api = read('src/client/lib/api.ts');
    expect(api).toContain("credentials: 'same-origin'");
  });

  it('verify-role does not accept the SPA session cookie as a ForwardAuth credential', () => {
    for (const legacy of ["'sb-auth-token'", "'sb-access-token'", "startsWith('sb-')"]) {
      expect(
        verifyRole.includes(legacy),
        `verify-role parses ${legacy}. Only vc-admin-token may gate admin infra.`
      ).toBe(false);
    }
    expect(forwardAuthCookie).toContain("FORWARDAUTH_COOKIE = 'vc-admin-token'");
    // The only credential read: the ForwardAuth cookie. No header tokens.
    expect(verifyRole).toContain('getCookie(c, FORWARDAUTH_COOKIE)');
    expect(verifyRole).not.toMatch(/header\(\s*['"](Authorization|X-Forwarded-Access-Token)['"]/i);
  });

  it('verify-role resolves the dedicated ForwardAuth token, never a session cookie', () => {
    expect(verifyRole).toContain('resolveForwardAuthToken(token)');
    expect(verifyRole).not.toContain('getSession');
  });

  it('the ForwardAuth cookie lives one hour, scoped to the parent domain', () => {
    expect(forwardAuthCookie).toContain('maxAge: FORWARDAUTH_TTL_SECONDS');
    expect(forwardAuthCookie).toContain('domain: parentCookieDomain(siteUrl)');
    expect(read('src/server/auth/forwardauth-token.ts')).toContain(
      'export const FORWARDAUTH_TTL_SECONDS = 3600;'
    );
  });

  it('the ForwardAuth cookie is HttpOnly and carries a dedicated token, never the session token', () => {
    expect(forwardAuthCookie).toMatch(/httpOnly:\s*true/);
    expect(forwardAuthCookie).toContain('mintForwardAuthToken(session.id)');
    expect(forwardAuthCookie).not.toContain('session.token');
    expect(forwardAuthCookie).not.toMatch(/header\(\s*['"]Authorization['"]/);
    // Only the hash is stored.
    const store = read('src/server/auth/forwardauth-token.ts');
    expect(store).toContain("createHash('sha256')");
    expect(store).toContain('randomBytes(32)');
  });

  it('impersonation goes through the auth API only (no app impersonation route)', () => {
    expect(exists('src/server/routes/v1/impersonation.ts')).toBe(false);
    expect(read('src/server/routes/v1/index.ts')).not.toContain('/admin/impersonate');
  });

  it('the client never stores a session in web storage (impersonation stash regression)', () => {
    expect(
      authProvider.includes('impersonation_admin_session'),
      'The pre-split impersonation stash key is back. The admin session stays ' +
        'server-side, in an HttpOnly cookie.'
    ).toBe(false);
    for (const [rel, src] of clientSources) {
      expect(
        /(localStorage|sessionStorage)\.setItem\([^)]*([sS]ession|[tT]oken)/.test(src),
        `${rel} writes a session or token into web storage.`
      ).toBe(false);
    }
  });
});
