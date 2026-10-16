import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Security invariants — the dev-time net.
 *
 * These assert the security properties that keep this app safe as you extend
 * it. They run under `npm test` and in CI, so a change that would reopen a
 * known hole (an un-RLS'd table, a second public data path, a permissive
 * auth config) fails fast, with a clear message, before it can ship. (The deploy also re-checks RLS against the live database
 * as a ground-truth backstop — this catches it earlier and explains why.)
 *
 * If a test here fails, DO NOT delete the assertion — fix the code. Each guards
 * a real, exploitable vulnerability, explained inline.
 */

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');
const exists = (rel: string) => existsSync(join(ROOT, rel));

function allMigrationsSql(): string {
  const dir = join(ROOT, 'db', 'migrations');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf-8'))
    .join('\n');
}

const sql = allMigrationsSql();

describe('RLS: every public table is protected', () => {
  // User requests run through withUserDb() as role app_user, so RLS is what
  // scopes every row they see. A `public` table without RLS is readable AND
  // writable by every signed-in user.
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

// The routing surfaces: every compose file plus the Traefik dynamic config.
const composeFiles = readdirSync(ROOT).filter((f) => /^docker-compose.*\.ya?ml$/.test(f));
const yamlUnder = (function walk(dir: string): string[] {
  if (!exists(dir)) return [];
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return walk(rel);
    return /\.ya?ml$/.test(e.name) ? [rel] : [];
  });
});
// YAML comments (`#`), for the routing files.
const uncommented = (text: string) => text.replace(/^\s*#.*$/gm, '');

describe('Routing: the app is the only public data path', () => {
  // The app's own /api is the one way in to the data, behind sessions, RLS
  // and rate limits. A gateway path to the database (a REST layer, a
  // websocket feed) would be a second way in with none of those checks.
  // There is no separate api.<domain> host either.
  const routingSurfaces = [...composeFiles, ...yamlUnder('volumes/traefik'), ...yamlUnder('k8s')];

  it('the routing surfaces are found (the checks below are not vacuous)', () => {
    expect(routingSurfaces).toContain('docker-compose.yml');
    expect(routingSurfaces).toContain('docker-compose.prod.yml');
    expect(routingSurfaces).toContain('volumes/traefik/middlewares.yml');
    expect(routingSurfaces).toContain('k8s/base/traefik/ingressroute.yaml');
  });

  it('nothing routes /rest, /realtime or /storage (versioned or bare)', () => {
    const gatewayPath = /\/(rest|realtime|storage)\/v1|PathPrefix\(`\/(rest|realtime|storage)`\)/;
    const offenders = routingSurfaces.filter((f) => gatewayPath.test(uncommented(read(f))));
    expect(
      offenders,
      `Gateway paths routed in ${offenders.join(', ')}. Serve data through ` +
        "the app's /api routes instead."
    ).toEqual([]);
  });

  it('no compose file defines a gateway, database API or admin console service', () => {
    const forbidden = ['gateway', 'rest', 'realtime', 'meta', 'studio', 'edge-functions'];
    for (const f of composeFiles) {
      const text = uncommented(read(f));
      for (const name of forbidden) {
        expect(
          new RegExp(`^ {2}${name}:\\s*$`, 'm').test(text),
          `${f} defines a "${name}" service. The stack is app, db, traefik and ` +
            'docker-socket-proxy; reach the database through `vibecarbon shell`.'
        ).toBe(false);
      }
    }
  });

  // Every workload (and Helm release) the k8s manifests define, as
  // `<Kind>/<name>`: the k8s twin of the compose service list.
  const k8sWorkloads = () =>
    yamlUnder('k8s').flatMap((f) =>
      uncommented(read(f))
        .split(/^---\s*$/m)
        .flatMap((doc) => {
          const kind = doc.match(/^kind: (Deployment|StatefulSet|DaemonSet|HelmRelease)\s*$/m)?.[1];
          const name = doc.match(/^metadata:\n(?: {2}.*\n)*? {2}name: (\S+)/m)?.[1];
          return kind && name ? [`${kind}/${name}`] : [];
        })
    );

  it('no k8s workload is a gateway, database API or admin console', () => {
    // The k8s twin of the compose check above. Postgres is our own StatefulSet
    // (k8s/base/db); everything else is the app, its edge and the platform.
    expect(k8sWorkloads().sort()).toEqual(
      [
        'Deployment/app',
        'Deployment/cluster-autoscaler',
        'Deployment/local-registry',
        'Deployment/traefik',
        'HelmRelease/cert-manager-webhook-hetzner',
        'StatefulSet/db',
      ].sort()
    );
  });

  it('the workload check sees the db StatefulSet', () => {
    // Guards the parser above against silently matching nothing.
    expect(k8sWorkloads()).toContain('StatefulSet/db');
  });

  it('the service-name check sees a top-level service key', () => {
    // Guards the regex above against silently matching nothing.
    expect(/^ {2}app:\s*$/m.test(read('docker-compose.yml'))).toBe(true);
  });

  it('nothing is re-exposed on an api.<domain> host', () => {
    for (const f of composeFiles) expect(read(f), f).not.toContain('Host(`api.');
  });
});

describe('Auth: only the in-process auth exists, and it is not permissive', () => {
  // Auth is the app's own /api/auth (src/server/auth/). A second, external
  // auth service reachable at /auth/v1 would be a parallel sign-in path with
  // its own users, sessions and redirect rules, outside every check here.
  const routingFiles = [...composeFiles, ...yamlUnder('volumes/traefik'), ...yamlUnder('k8s')];
  // TypeScript comments: block comments, and `//` to end of line when it
  // starts a line or follows whitespace (so `https://` in a string stays).
  // A commented-out `trustedOrigins: ['*']` must not trip the checks below,
  // and a live one must not hide behind a `#`-only strip.
  const uncommentedTs = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

  it('nothing routes /auth/v1 (no external auth service behind any edge)', () => {
    expect(routingFiles).toContain('docker-compose.prod.yml');
    expect(routingFiles).toContain('k8s/base/traefik/ingressroute.yaml');
    const offenders = routingFiles.filter((f) => uncommented(read(f)).includes('/auth/v1'));
    expect(
      offenders,
      `${offenders.join(', ')} route /auth/v1. Auth is the app's /api/auth; do not ` +
        'route a public path to a separate auth service.'
    ).toEqual([]);
  });

  it('no compose file or k8s manifest runs a separate auth service', () => {
    for (const f of routingFiles.filter((f) => f.startsWith('docker-compose'))) {
      expect(uncommented(read(f)), `${f} defines an auth service`).not.toMatch(/^ {2}auth:\s*$/m);
    }
    // The k8s workload list is pinned above; an auth workload would also have
    // to be named here to pass it.
    for (const f of yamlUnder('k8s')) {
      expect(uncommented(read(f)), `${f} defines an auth workload`).not.toMatch(
        /^kind: (Deployment|StatefulSet)\s*\nmetadata:\n(?: {2}.*\n)*? {2}name: \S*auth\S*$/m
      );
    }
  });

  // trustedOrigins decides which origins may call the auth API with cookies
  // and which callback / redirect targets it honours. "*" (or any glob) lets
  // an attacker's page send a victim's password reset or magic link to their
  // own domain = account takeover.
  const authConfig = read('src/server/auth/index.ts');

  it('trustedOrigins is the exact-origin list, never a wildcard', () => {
    expect(authConfig).toContain('trustedOrigins: allowedOrigins()');
    expect(uncommentedTs(authConfig)).not.toMatch(/trustedOrigins:\s*\[?\s*['"`]\*/);
    // allowedOrigins() refuses a glob in SITE_URL and CORS_ORIGINS.
    const origins = read('src/server/lib/origins.ts');
    expect(origins).toContain('/[*?]/.test(origin)');
    expect(origins).toMatch(/throw new Error\(/);
  });

  it('magic-link tokens keep the plain storage the assurance cleanup reads', () => {
    // auth/assurance.ts finds the pending link by `magic-link:<token>` to
    // revoke an unproven second factor before the link signs anyone in. A
    // magicLink `storeToken` (hashed or custom) changes that identifier, so
    // the lookup would silently find nothing and the cleanup would never run.
    const live = uncommentedTs(authConfig);
    expect(live).toContain('magicLink({');
    expect(live).not.toMatch(/storeToken/);
    const assurance = read('src/server/auth/assurance.ts');
    expect(assurance).toContain('`magic-link:${token}`');
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

  it('the TS comment strip removes comments but keeps code and URLs', () => {
    const src = [
      '/* trustedOrigins: ["*"] */',
      "// domain: 'example.com'",
      "const u = 'https://example.com'; // domain: x",
      'const live = 1;',
    ].join('\n');
    const out = uncommentedTs(src);
    expect(out).not.toMatch(/trustedOrigins|domain:/);
    expect(out).toContain("'https://example.com'");
    expect(out).toContain('const live = 1;');
  });

  it('the session cookie stays host-only (no parent-domain scope)', () => {
    // A parent-domain session cookie would reach every admin subdomain.
    expect(authConfig).not.toContain('crossSubDomainCookies');
    expect(uncommentedTs(authConfig)).not.toMatch(/\bdomain:/);
  });
});

describe('Super-admin routes: the role check always comes with the aal2 rule', () => {
  // An inline `if (!isSuperAdmin(user))` checks the role only. While MFA is
  // globally on, an aal1 admin session (a stolen cookie, a password-only
  // sign-in) could then turn MFA off from that very route. Gate with
  // `requireSuperAdmin` / `checkSuperAdmin` (middleware/requireSuperAdmin.ts),
  // which applies `checkAal2` after the role.
  const routesDir = join(ROOT, 'src', 'server', 'routes');
  const routeFiles = (readdirSync(routesDir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join('src', 'server', 'routes', f));
  // Uses that are not an access gate, or that chain requireAal2 themselves.
  const allowed: Record<string, number> = {
    // DELETE /me refuses a super admin deleting itself (behind requireAal2).
    [join('src', 'server', 'routes', 'v1', 'index.ts')]: 1,
    // Mints the ForwardAuth cookie; chains requireAal2 right after.
    [join('src', 'server', 'routes', 'v1', 'forwardauth-cookie.ts')]: 1,
  };

  it('no route checks isSuperAdmin() inline outside the allowlist', () => {
    const offenders: string[] = [];
    for (const rel of routeFiles) {
      const count = (read(rel).match(/\bisSuperAdmin\(/g) ?? []).length;
      if (count > (allowed[rel] ?? 0)) offenders.push(`${rel} (${count})`);
    }
    expect(
      offenders,
      `Inline super-admin checks skip the aal2 rule: ${offenders.join(', ')}. ` +
        'Use requireSuperAdmin or checkSuperAdmin from middleware/requireSuperAdmin.ts.',
    ).toEqual([]);
  });

  it('checkSuperAdmin applies checkAal2 after the role', () => {
    const mw = read('src/server/middleware/requireSuperAdmin.ts');
    expect(mw).toMatch(/return checkAal2\(c\);/);
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

  it('the OpenAPI spec documents the session cookie, not a Bearer token', () => {
    // The API reads only the session cookie; a spec promising Bearer auth
    // sends integrators (and agents) after a header the server ignores.
    const index = read('src/server/index.ts');
    expect(index).not.toMatch(/bearerAuth|scheme:\s*'bearer'/);
    expect(index).toMatch(/sessionCookie:\s*\{\s*type:\s*'apiKey',\s*in:\s*'cookie'/);
    const uses = index.match(/security:\s*\[\{\s*(\w+):/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/sessionCookie/);
  });

  it('the SPA keeps no session of its own: no client code handles a session token', () => {
    for (const [rel, src] of clientSources) {
      expect(
        /\b(?:access|refresh)_?token\b/i.test(src),
        `${rel} handles an access or refresh token. Sessions are HttpOnly cookies ` +
          'the auth API sets; page JS must never hold a session or refresh token.'
      ).toBe(false);
    }
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
