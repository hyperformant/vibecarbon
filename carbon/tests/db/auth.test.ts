import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth } from '@server/auth';
import { bootstrapAdmin } from '@server/auth/bootstrap-admin';
import { csrfProtection } from '@server/middleware/csrf';
import { sessionMiddleware } from '@server/middleware/session';
import type { HonoVariables } from '@server/types';
import { connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * The in-process auth against a real database: sign-up, sign-in and
 * sign-out through `auth.handler`, the session middleware, the account
 * lockout, the startup admin bootstrap, and the CSRF origin check.
 *
 * The app below is wired the way server/index.ts wires it (CSRF, then the
 * /api/auth mount, then the session middleware), minus the rate limiters.
 */

const ORIGIN = 'http://app.test'; // SITE_URL in tests/_helpers/setup-db.ts
const PASSWORD = 'correct-horse-battery';

function buildApp() {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('/api/*', csrfProtection());
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
  app.use('/api/*', sessionMiddleware);
  app.get('/api/v1/whoami', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({
      id: user.id,
      email: user.email,
      role: user.role,
      aal: c.get('aal'),
      serverSeesToken: Boolean(c.get('session')?.token),
    });
  });
  app.post('/api/v1/echo', (c) => {
    if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ ok: true });
  });
  app.post('/api/webhooks/test', (c) => c.json({ received: true }));
  return app;
}

/** `Set-Cookie` headers of a response as a `Cookie` request header. */
function cookieHeader(res: Response, only?: string): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .filter((pair) => (only ? pair.startsWith(`${only}=`) : true))
    .join('; ');
}

const TOKEN_COOKIE = 'better-auth.session_token';

describe.skipIf(!dbTestsEnabled)('auth (real database)', () => {
  let db: pg.Client;
  let app: ReturnType<typeof buildApp>;
  const emails: string[] = [];

  const newEmail = () => {
    const email = `auth-test-${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  };

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    });

  const signUp = (email: string, password = PASSWORD) =>
    post('/api/auth/sign-up/email', { email, password, name: 'Auth Test' });

  const signIn = (email: string, password: string, ip = '203.0.113.10') =>
    post('/api/auth/sign-in/email', { email, password }, { 'x-forwarded-for': ip });

  const failureCount = async (email: string, ip: string) => {
    const { rows } = await db.query<{ n: number }>(
      'select count(*)::int as n from public.failed_login_attempts where email = $1 and ip_address = $2::inet',
      [email.toLowerCase(), ip],
    );
    return rows[0].n;
  };

  beforeAll(async () => {
    db = await connectTestDb();
    app = buildApp();
  });

  afterAll(async () => {
    if (emails.length) {
      const lower = emails.map((e) => e.toLowerCase());
      await db.query('delete from public."user" where email = any($1::text[])', [lower]);
      await db.query('delete from public.failed_login_attempts where email = any($1::text[])', [
        lower,
      ]);
    }
    await db.end();
  });

  describe('sign-up, sign-in, sign-out and the session middleware', () => {
    it('signs up with a uuid id, the default role, and onboarding not done', async () => {
      const email = newEmail();
      const res = await signUp(email);
      expect(res.status).toBe(200);
      const { rows } = await db.query(
        'select id, role, onboarding_completed, email_verified from public."user" where email = $1',
        [email],
      );
      expect(rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(rows[0]).toMatchObject({ role: 'user', onboarding_completed: false });
      // No SMTP in tests, so verification is not required.
      expect(rows[0].email_verified).toBe(false);
    });

    it('a client cannot sign itself up as super_admin', async () => {
      const email = newEmail();
      await post('/api/auth/sign-up/email', {
        email,
        password: PASSWORD,
        name: 'Sneaky',
        role: 'super_admin',
      });
      const { rows } = await db.query('select role from public."user" where email = $1', [email]);
      expect(rows[0]?.role ?? null).not.toBe('super_admin');
    });

    it('signs in, and the session cookie makes the middleware set user and aal1', async () => {
      const email = newEmail();
      await signUp(email);
      const res = await signIn(email, PASSWORD);
      expect(res.status).toBe(200);
      const setCookies = res.headers.getSetCookie().join('\n');
      expect(setCookies).toMatch(/better-auth\.session_token=[^;]+;.*HttpOnly/i);
      expect(setCookies).toMatch(/SameSite=Lax/i);

      const me = await app.request('/api/v1/whoami', { headers: { cookie: cookieHeader(res) } });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ email, role: 'user', aal: 'aal1' });
    });

    it('no cookie, or a forged one, leaves user null', async () => {
      expect((await app.request('/api/v1/whoami')).status).toBe(401);
      const forged = await app.request('/api/v1/whoami', {
        headers: { cookie: `${TOKEN_COOKIE}=not-a-real-token.signature` },
      });
      expect(forged.status).toBe(401);
    });

    it('aal is aal2 only when this session passed a second factor', async () => {
      const email = newEmail();
      await signUp(email);
      const res = await signIn(email, PASSWORD);
      // The token cookie alone forces a database read (no cached session).
      const cookie = cookieHeader(res, TOKEN_COOKIE);
      const { rows } = await db.query('select id from public."user" where email = $1', [email]);
      await db.query('update public.session set two_factor_verified = true where user_id = $1', [
        rows[0].id,
      ]);
      const me = await app.request('/api/v1/whoami', { headers: { cookie } });
      expect((await me.json()).aal).toBe('aal2');
    });

    it('sign-out ends the session', async () => {
      const email = newEmail();
      await signUp(email);
      const res = await signIn(email, PASSWORD);
      const cookie = cookieHeader(res, TOKEN_COOKIE);
      const out = await post('/api/auth/sign-out', {}, { cookie });
      expect(out.status).toBe(200);
      const me = await app.request('/api/v1/whoami', { headers: { cookie } });
      expect(me.status).toBe(401);
    });
  });

  describe('the session token never reaches page JS', () => {
    /** The raw session token: the cookie value before the `.signature`. */
    const rawToken = (res: Response) =>
      decodeURIComponent(cookieHeader(res, TOKEN_COOKIE).split('=')[1]).split('.')[0];

    it('sign-up, sign-in, get-session and list-sessions bodies carry no token; the cookie still works', async () => {
      const email = newEmail();
      const up = await signUp(email);
      const upToken = rawToken(up);
      expect(upToken.length).toBeGreaterThan(10);
      const upText = await up.text();
      expect(upText).not.toContain(upToken);
      expect(JSON.parse(upText)).not.toHaveProperty('token');
      expect(JSON.parse(upText).user.email).toBe(email);

      const res = await signIn(email, PASSWORD, '203.0.113.11');
      const token = rawToken(res);
      const text = await res.text();
      expect(text).not.toContain(token);
      expect(JSON.parse(text)).not.toHaveProperty('token');
      expect(JSON.parse(text).user.email).toBe(email);

      // Token cookie only, so get-session reads the database row.
      const cookie = cookieHeader(res, TOKEN_COOKIE);
      const session = await app.request('/api/auth/get-session', { headers: { cookie } });
      expect(session.status).toBe(200);
      const sessionText = await session.text();
      expect(sessionText).not.toContain(token);
      const sessionBody = JSON.parse(sessionText);
      expect(sessionBody.user.email).toBe(email);
      expect(sessionBody.session).not.toHaveProperty('token');

      // And with the cached-session cookie too (the cookie-cache path).
      const cached = await app.request('/api/auth/get-session', {
        headers: { cookie: cookieHeader(res) },
      });
      expect(await cached.text()).not.toContain(token);

      const list = await app.request('/api/auth/list-sessions', { headers: { cookie } });
      expect(list.status).toBe(200);
      const listText = await list.text();
      expect(listText).not.toContain(token);
      expect(listText).not.toContain(upToken);

      // The cookie still authenticates, and server code still gets the token.
      const me = await app.request('/api/v1/whoami', { headers: { cookie } });
      expect(await me.json()).toMatchObject({ email, serverSeesToken: true });
    });

    it('withoutTokens drops token keys at any depth and keeps everything else', async () => {
      const { withoutTokens } = await import('@server/auth/strip-session-token');
      const at = new Date(0);
      expect(
        withoutTokens({
          token: 't',
          user: { id: 'u', createdAt: at },
          session: { token: 't', id: 's' },
          list: [{ token: 't', id: 1 }],
        }),
      ).toEqual({ user: { id: 'u', createdAt: at }, session: { id: 's' }, list: [{ id: 1 }] });
    });
  });

  describe('account lockout (5 failures per email + IP)', () => {
    it('locks after 5 wrong passwords: the right password then gets 429', async () => {
      const email = newEmail();
      const ip = '203.0.113.21';
      await signUp(email);
      for (let i = 0; i < 5; i++) {
        expect((await signIn(email, 'wrong-password', ip)).status).toBe(401);
      }
      expect(await failureCount(email, ip)).toBe(5);

      const locked = await signIn(email, PASSWORD, ip);
      expect(locked.status).toBe(429);
      const body = await locked.json();
      expect(body.code).toBe('ACCOUNT_LOCKED');
      expect(body.message).toMatch(/try again in \d+ minute/);
      expect(locked.headers.getSetCookie().join('')).not.toContain(TOKEN_COOKIE);
      // A refused attempt is not counted as another failure.
      expect(await failureCount(email, ip)).toBe(5);
    });

    it('the lock is per (email, IP): the same account from another IP still signs in', async () => {
      const email = newEmail();
      const ip = '203.0.113.22';
      await signUp(email);
      for (let i = 0; i < 5; i++) await signIn(email, 'wrong-password', ip);
      expect((await signIn(email, PASSWORD, '203.0.113.23')).status).toBe(200);
    });

    it('a successful sign-in clears the failures for that pair', async () => {
      const email = newEmail();
      const ip = '203.0.113.24';
      await signUp(email);
      for (let i = 0; i < 4; i++) await signIn(email, 'wrong-password', ip);
      expect(await failureCount(email, ip)).toBe(4);
      expect((await signIn(email, PASSWORD, ip)).status).toBe(200);
      expect(await failureCount(email, ip)).toBe(0);
    });

    it('counts failures for an unknown email too, under the same generic 401', async () => {
      const email = newEmail();
      const ip = '203.0.113.25';
      const res = await signIn(email, 'whatever-password', ip);
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('INVALID_EMAIL_OR_PASSWORD');
      expect(await failureCount(email, ip)).toBe(1);
    });

    it('keys on the trusted proxy hop, not a client-supplied leftmost X-Forwarded-For', async () => {
      const email = newEmail();
      await signUp(email);
      // TRUSTED_PROXY_HOPS=1: the rightmost entry is the one the proxy wrote.
      for (let i = 0; i < 5; i++) {
        await signIn(email, 'wrong-password', `198.51.100.${i}, 203.0.113.26`);
      }
      expect(await failureCount(email, '203.0.113.26')).toBe(5);
      expect((await signIn(email, PASSWORD, '198.51.100.99, 203.0.113.26')).status).toBe(429);
    });
  });

  describe('startup admin bootstrap', () => {
    const roleOf = async (email: string) =>
      (
        await db.query(
          'select role, email_verified, onboarding_completed from public."user" where email = $1',
          [email],
        )
      ).rows[0];

    it('does nothing without both ADMIN_EMAIL and ADMIN_PASSWORD', async () => {
      expect(await bootstrapAdmin({ email: newEmail() })).toBe('skipped');
      expect(await bootstrapAdmin({ password: PASSWORD })).toBe('skipped');
    });

    it('creates a verified super admin past onboarding who can sign in', async () => {
      const email = newEmail();
      expect(await bootstrapAdmin({ email, password: PASSWORD })).toBe('created');
      expect(await roleOf(email)).toEqual({
        role: 'super_admin',
        email_verified: true,
        onboarding_completed: true,
      });
      const res = await signIn(email, PASSWORD, '203.0.113.31');
      expect(res.status).toBe(200);
      const me = await app.request('/api/v1/whoami', { headers: { cookie: cookieHeader(res) } });
      expect((await me.json()).role).toBe('super_admin');
    });

    it('is idempotent and never resets an existing password', async () => {
      const email = newEmail();
      await bootstrapAdmin({ email, password: PASSWORD });
      expect(await bootstrapAdmin({ email, password: 'a-different-password' })).toBe('unchanged');
      const { rows } = await db.query(
        'select count(*)::int as n from public."user" where email = $1',
        [email],
      );
      expect(rows[0].n).toBe(1);
      expect((await signIn(email, PASSWORD, '203.0.113.32')).status).toBe(200);
      expect((await signIn(email, 'a-different-password', '203.0.113.33')).status).toBe(401);
    });

    it('promotes an existing non-admin with ADMIN_EMAIL, keeping their password', async () => {
      const email = newEmail();
      await signUp(email);
      expect(await bootstrapAdmin({ email, password: 'operator-password' })).toBe('promoted');
      expect((await roleOf(email)).role).toBe('super_admin');
      expect((await signIn(email, PASSWORD, '203.0.113.34')).status).toBe(200);
      expect((await signIn(email, 'operator-password', '203.0.113.35')).status).toBe(401);
    });

    it('matches ADMIN_EMAIL case-insensitively', async () => {
      const email = newEmail();
      await signUp(email);
      expect(await bootstrapAdmin({ email: email.toUpperCase(), password: PASSWORD })).toBe(
        'promoted',
      );
    });

    it('two replicas bootstrapping at once end with one super admin', async () => {
      const email = newEmail();
      const results = await Promise.all([
        bootstrapAdmin({ email, password: PASSWORD }),
        bootstrapAdmin({ email, password: PASSWORD }),
      ]);
      expect(results).toContain('created');
      const { rows } = await db.query(
        'select count(*)::int as n from public."user" where email = $1 and role = $2',
        [email, 'super_admin'],
      );
      expect(rows[0].n).toBe(1);
    });

    it('no HTTP path assigns roles: set-role is disabled even for a super admin', async () => {
      const email = newEmail();
      await bootstrapAdmin({ email, password: PASSWORD });
      const res = await signIn(email, PASSWORD, '203.0.113.36');
      const cookie = cookieHeader(res);
      const target = newEmail();
      await signUp(target);
      const { rows } = await db.query('select id from public."user" where email = $1', [target]);

      const setRole = await post(
        '/api/auth/admin/set-role',
        { userId: rows[0].id, role: 'super_admin' },
        { cookie },
      );
      expect(setRole.status).toBe(404);
      const update = await post(
        '/api/auth/admin/update-user',
        { userId: rows[0].id, data: { role: 'super_admin' } },
        { cookie },
      );
      expect(update.status).toBe(403);
      expect((await roleOf(target)).role).toBe('user');
    });
  });

  describe('CSRF origin check on cookie-authenticated API routes', () => {
    let cookie: string;

    beforeAll(async () => {
      const email = newEmail();
      await signUp(email);
      cookie = cookieHeader(await signIn(email, PASSWORD, '203.0.113.41'));
    });

    const simplePost = (headers: Record<string, string>) =>
      app.request('/api/v1/echo', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', cookie, ...headers },
        body: 'x',
      });

    it('refuses a cross-origin form-style POST that carries the session cookie', async () => {
      expect((await simplePost({ origin: 'https://evil.example' })).status).toBe(403);
      expect(
        (await simplePost({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }))
          .status,
      ).toBe(403);
      expect((await simplePost({})).status).toBe(403);
    });

    it('lets the same request through from our own origin', async () => {
      expect((await simplePost({ origin: ORIGIN })).status).toBe(200);
      expect((await simplePost({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    });

    it('leaves webhooks reachable cross-site (they verify signatures instead)', async () => {
      const res = await app.request('/api/webhooks/test', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', origin: 'https://provider.example', cookie },
        body: 'x',
      });
      expect(res.status).toBe(200);
    });

    it('auth endpoints refuse a cross-origin sign-out (Better Auth checks its own)', async () => {
      const res = await post('/api/auth/sign-out', {}, { cookie, origin: 'https://evil.example' });
      expect(res.status).toBe(403);
    });
  });
});
