import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { auth } from '@server/auth';
import { capImpersonationExpiry } from '@server/auth/impersonation';
import { adminDb } from '@server/db/client';
import { appSettings } from '@server/db/schema';
import { __resetMfaSettingsCache } from '@server/lib/mfa-settings';
import { csrfProtection } from '@server/middleware/csrf';
import { sessionMiddleware } from '@server/middleware/session';
import { verifyRoleRoutes } from '@server/routes/_internal/verify-role';
import { authRoutes } from '@server/routes/v1/auth';
import { statsRoutes } from '@server/routes/v1/stats';
import type { HonoVariables } from '@server/types';
import { connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * The admin surfaces on the in-process auth, against a real database:
 * impersonation (the admin plugin plus this app's rules), the ForwardAuth
 * cookie and verify-role, account deletion, the users list, member details,
 * invites by email, the user counts on the stats page, and the second
 * factor every super-admin route asks for while MFA is on.
 *
 * The app below is wired the way server/index.ts wires these routes (CSRF,
 * the /api/auth mount, the session middleware), minus the rate limiters.
 */

const ORIGIN = 'http://app.test'; // SITE_URL in tests/_helpers/setup-db.ts
const PASSWORD = 'correct-horse-battery';
const SESSION_COOKIE = 'better-auth.session_token';

vi.mock('@server/auth/email', () => ({ sendAuthEmail: async () => undefined }));
vi.mock('@server/lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@server/lib/email')>()),
  sendEmail: async () => ({}),
}));

async function buildApp() {
  const { v1Routes } = await import('@server/routes/v1/index');
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('/api/*', csrfProtection());
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
  app.use('/api/*', sessionMiddleware);
  app.route('/api/_internal/verify-role', verifyRoleRoutes);
  app.route('/api/v1', v1Routes);
  app.route('/api/v1/auth', authRoutes);
  app.route('/api/v1/admin/stats', statsRoutes);
  return app;
}

/** A browser's cookie store, enough for these flows (one host, no paths). */
class CookieJar {
  cookies = new Map<string, string>();

  take(res: Response): Response {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1);
      const expired = value === '' || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  get header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  only(...names: string[]): string {
    return names
      .filter((n) => this.cookies.has(n))
      .map((n) => `${n}=${this.cookies.get(n)}`)
      .join('; ');
  }
}

describe.skipIf(!dbTestsEnabled)('admin surfaces (real database)', () => {
  let db: pg.Client;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const emails: string[] = [];
  const orgIds: string[] = [];
  let originalMfa: unknown;

  const newEmail = () => {
    const email = `admin-surfaces-${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  };

  const send = (method: string, path: string, jar: CookieJar | string | null, body?: unknown) =>
    app
      .request(path, {
        method,
        headers: {
          origin: ORIGIN,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(jar ? { cookie: typeof jar === 'string' ? jar : jar.header } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      .then((res) => (jar instanceof CookieJar ? jar.take(res) : res));

  const post = (path: string, body: unknown, jar: CookieJar | string | null) =>
    send('POST', path, jar, body);
  const get = (path: string, jar: CookieJar | string | null) => send('GET', path, jar);

  const setMfa = async (enabled: boolean) => {
    await adminDb
      .insert(appSettings)
      .values({ key: 'mfa_enabled', value: { enabled } })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: { enabled } } });
    __resetMfaSettingsCache();
  };

  const userIdOf = async (email: string) =>
    (await db.query('select id from public."user" where email = $1', [email])).rows[0]
      .id as string;

  /** Sign up (the jar holds the new session). */
  const member = async (name = 'Member') => {
    const email = newEmail();
    const jar = new CookieJar();
    const res = await post('/api/auth/sign-up/email', { email, password: PASSWORD, name }, jar);
    expect(res.status).toBe(200);
    return { email, jar, id: await userIdOf(email) };
  };

  const superAdmin = async () => {
    const user = await member('Admin');
    await db.query(`update public."user" set role = 'super_admin' where id = $1`, [user.id]);
    return user;
  };

  const whoami = async (jar: CookieJar) => {
    const res = await get('/api/v1/me', jar);
    return res.status === 200 ? ((await res.json()) as { user: { id: string } }).user.id : null;
  };

  beforeAll(async () => {
    db = await connectTestDb();
    app = await buildApp();
    const [row] = await adminDb
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, 'mfa_enabled'));
    originalMfa = row?.value;
    await setMfa(false);
  });

  afterEach(async () => {
    await setMfa(false);
  });

  afterAll(async () => {
    if (originalMfa === undefined) {
      await adminDb.delete(appSettings).where(eq(appSettings.key, 'mfa_enabled'));
    } else {
      await adminDb
        .update(appSettings)
        .set({ value: originalMfa })
        .where(eq(appSettings.key, 'mfa_enabled'));
    }
    __resetMfaSettingsCache();
    if (orgIds.length) {
      await db.query('delete from public.organizations where id = any($1::uuid[])', [orgIds]);
    }
    await db.query('delete from public."user" where email = any($1::text[])', [emails]);
    await db.end();
  });

  describe('impersonation', () => {
    const impersonate = (jar: CookieJar, userId: string) =>
      post('/api/auth/admin/impersonate-user', { userId }, jar);

    it('a super admin impersonates a regular user and comes back', async () => {
      const admin = await superAdmin();
      const target = await member();
      const res = await impersonate(admin.jar, target.id);
      expect(res.status).toBe(200);
      expect(await whoami(admin.jar)).toBe(target.id);
      expect((await post('/api/auth/admin/stop-impersonating', {}, admin.jar)).status).toBe(200);
      expect(await whoami(admin.jar)).toBe(admin.id);
    });

    it('refuses impersonating yourself', async () => {
      const admin = await superAdmin();
      const res = await impersonate(admin.jar, admin.id);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('CANNOT_IMPERSONATE_SELF');
    });

    it('refuses impersonating another super admin', async () => {
      const admin = await superAdmin();
      const other = await superAdmin();
      const res = await impersonate(admin.jar, other.id);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('CANNOT_IMPERSONATE_ADMIN');
      expect(await whoami(admin.jar)).toBe(admin.id);
    });

    it('a regular user cannot impersonate', async () => {
      const user = await member();
      const target = await member();
      expect((await impersonate(user.jar, target.id)).status).toBe(403);
      expect(await whoami(user.jar)).toBe(user.id);
    });

    it('MFA on: an aal1 super admin hears "verify a code" before anything about the target', async () => {
      const admin = await superAdmin();
      await setMfa(true);
      const res = await impersonate(admin.jar, admin.id);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('MFA_REQUIRED');
    });

    describe('an impersonation session', () => {
      const asTarget = async () => {
        const admin = await superAdmin();
        const target = await member();
        expect((await impersonate(admin.jar, target.id)).status).toBe(200);
        return { admin, target, jar: admin.jar };
      };

      it.each([
        ['/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-one-123' }],
        ['/api/auth/link-social', { provider: 'google' }],
        ['/api/auth/unlink-account', { providerId: 'google' }],
        ['/api/auth/verify-password', { password: PASSWORD }],
        ['/api/auth/change-email', { newEmail: 'x@example.test' }],
      ])('may not call %s', async (path, body) => {
        const { jar } = await asTarget();
        const res = await post(path, body, jar);
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe('IMPERSONATION_NOT_ALLOWED');
      });

      it('may not start another impersonation', async () => {
        const { jar } = await asTarget();
        const other = await member();
        const res = await impersonate(jar, other.id);
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe('IMPERSONATION_NOT_ALLOWED');
      });

      it('the expiry cap also holds when the endpoint context does not carry the session', async () => {
        const { target } = await asTarget();
        const { rows } = await db.query<{ token: string; expires_at: Date }>(
          'select token, expires_at from public.session where user_id = $1 and impersonated_by is not null',
          [target.id]
        );
        const authCtx = await auth.$context;
        // What a refresh path that never set ctx.context.session would hand the hook.
        const ctx = {
          context: { authCookies: authCtx.authCookies, secret: authCtx.secret },
          getSignedCookie: async () => rows[0].token,
        };
        const far = new Date(Date.now() + 7 * 24 * 3600_000);
        expect(await capImpersonationExpiry({ expiresAt: far }, ctx)).toEqual({
          data: { expiresAt: rows[0].expires_at },
        });
        // No request at all (a server-side call): nothing to cap.
        expect(await capImpersonationExpiry({ expiresAt: far }, null)).toBeUndefined();
      });

      it('may not take sensitive actions (requireAal2 routes), even with MFA off', async () => {
        const { jar, target } = await asTarget();
        const res = await send('DELETE', '/api/v1/me', jar);
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe('impersonation_not_allowed');
        expect(await userIdOf(target.email)).toBe(target.id);
      });

      it('may not mint the ForwardAuth cookie', async () => {
        const { jar } = await asTarget();
        const res = await post('/api/v1/admin/forwardauth-cookie', {}, jar);
        expect(res.status).toBe(403);
        expect(res.headers.getSetCookie().some((c) => c.startsWith('vc-admin-token='))).toBe(false);
      });

      it('never outlives its hour, even when the client drops the "don\'t remember" cookie', async () => {
        const { jar, target } = await asTarget();
        const expiry = async () =>
          (
            await db.query<{ expires_at: Date; created_at: Date }>(
              'select expires_at, created_at from public.session where user_id = $1 and impersonated_by is not null',
              [target.id]
            )
          ).rows[0];
        const before = await expiry();
        expect(before.expires_at.getTime() - before.created_at.getTime()).toBeLessThanOrEqual(
          3600_000 + 5_000
        );

        // A client that keeps only the session token cookie: get-session would
        // slide the expiry to the full session lifetime.
        const bare = jar.only(SESSION_COOKIE);
        const res = await get('/api/auth/get-session?disableCookieCache=true', bare);
        expect(res.status).toBe(200);
        const after = await expiry();
        expect(after.expires_at.getTime()).toBeLessThanOrEqual(before.expires_at.getTime());
      });

      it('does not count as the user signing in', async () => {
        const { target } = await asTarget();
        const { rows } = await db.query<{ last_sign_in_at: Date }>(
          'select last_sign_in_at from public."user" where id = $1',
          [target.id]
        );
        // Set by the sign-up session only.
        const signUp = await db.query<{ created_at: Date }>(
          'select min(created_at) as created_at from public.session where user_id = $1 and impersonated_by is null',
          [target.id]
        );
        expect(Math.abs(rows[0].last_sign_in_at.getTime() - signUp.rows[0].created_at.getTime())).toBeLessThan(
          5_000
        );
      });
    });
  });

  describe('ForwardAuth: the vc-admin-token cookie and verify-role', () => {
    const mint = (jar: CookieJar) => post('/api/v1/admin/forwardauth-cookie', {}, jar);
    const verify = (cookie: string) =>
      get('/api/_internal/verify-role?role=super_admin', cookie || null);

    it('a super admin gets the cookie; verify-role accepts it and names the user', async () => {
      const admin = await superAdmin();
      const res = await mint(admin.jar);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      const set = res.headers.getSetCookie().find((c) => c.startsWith('vc-admin-token='));
      expect(set).toMatch(/HttpOnly/i);
      expect(set).toMatch(/Max-Age=3600/);

      const ok = await verify(admin.jar.only('vc-admin-token'));
      expect(ok.status).toBe(200);
      expect(ok.headers.get('X-User-Id')).toBe(admin.id);
      expect(ok.headers.get('X-User-Email')).toBe(admin.email);
      expect(ok.headers.get('X-User-Role')).toBe('super_admin');
      expect(ok.headers.get('X-Authenticated-User')).toBe(admin.email);
    });

    it("the app's own session cookie is not a ForwardAuth credential", async () => {
      const admin = await superAdmin();
      const res = await verify(admin.jar.only(SESSION_COOKIE, 'better-auth.session_data'));
      expect(res.status).toBe(401);
    });

    const sessionTokenOf = async (userId: string) =>
      (await db.query('select token from public.session where user_id = $1', [userId])).rows[0]
        .token as string;
    const tokenRows = (userId: string) =>
      db
        .query<{ identifier: string; expires_at: Date }>(
          `select v.identifier, v.expires_at from public.verification v
             join public.session s on s.id::text = v.value
            where s.user_id = $1 and v.identifier like 'forwardauth:%'`,
          [userId]
        )
        .then((r) => r.rows);

    it('the cookie carries a dedicated token: never the session token, stored only as a hash', async () => {
      const admin = await superAdmin();
      await mint(admin.jar);
      const token = decodeURIComponent(admin.jar.cookies.get('vc-admin-token') as string);
      const sessionToken = await sessionTokenOf(admin.id);
      expect(token).not.toBe(sessionToken);
      expect(token).not.toContain(sessionToken);
      expect(sessionToken).not.toContain(token);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      // Useless against the app's own API.
      expect((await get('/api/v1/me', `${SESSION_COOKIE}=${token}`)).status).toBe(401);
      // One row for the session, 1 h, holding a hash and no raw token.
      const rows = await tokenRows(admin.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].identifier).not.toContain(token);
      expect(rows[0].identifier).toMatch(/^forwardauth:[0-9a-f]{64}$/);
      expect(rows[0].expires_at.getTime() - Date.now()).toBeLessThanOrEqual(3600_000);
      expect(rows[0].expires_at.getTime() - Date.now()).toBeGreaterThan(3500_000);
    });

    it('an expired token is refused', async () => {
      const admin = await superAdmin();
      await mint(admin.jar);
      const cookie = admin.jar.only('vc-admin-token');
      expect((await verify(cookie)).status).toBe(200);
      await db.query(
        `update public.verification set expires_at = now() - interval '1 second'
          where identifier like 'forwardauth:%' and value = (select id::text from public.session where user_id = $1)`,
        [admin.id]
      );
      expect((await verify(cookie)).status).toBe(401);
    });

    it('a revoked session takes its token with it', async () => {
      const admin = await superAdmin();
      await mint(admin.jar);
      const cookie = admin.jar.only('vc-admin-token');
      await db.query('delete from public.session where user_id = $1', [admin.id]);
      expect((await verify(cookie)).status).toBe(401);
    });

    it('DELETE forgets the token and clears the cookie', async () => {
      const admin = await superAdmin();
      await mint(admin.jar);
      const cookie = admin.jar.only('vc-admin-token');
      const res = await send('DELETE', '/api/v1/admin/forwardauth-cookie', admin.jar);
      expect(res.status).toBe(204);
      expect(admin.jar.cookies.has('vc-admin-token')).toBe(false);
      expect((await verify(cookie)).status).toBe(401);
      expect(await tokenRows(admin.id)).toHaveLength(0);
    });

    it('a session keeps its newest two tokens: a third mint drops the oldest', async () => {
      const admin = await superAdmin();
      const minted: string[] = [];
      for (let i = 0; i < 3; i++) {
        await mint(admin.jar);
        minted.push(admin.jar.only('vc-admin-token'));
      }
      expect(new Set(minted).size).toBe(3);
      expect((await verify(minted[0])).status).toBe(401);
      expect((await verify(minted[1])).status).toBe(200);
      expect((await verify(minted[2])).status).toBe(200);
      expect(await tokenRows(admin.id)).toHaveLength(2);
    });

    it('DELETE forgets every token of the session, not just the cookie one', async () => {
      const admin = await superAdmin();
      await mint(admin.jar);
      const first = admin.jar.only('vc-admin-token');
      await mint(admin.jar);
      const second = admin.jar.only('vc-admin-token');
      expect(await tokenRows(admin.id)).toHaveLength(2);
      expect((await send('DELETE', '/api/v1/admin/forwardauth-cookie', admin.jar)).status).toBe(204);
      expect((await verify(first)).status).toBe(401);
      expect((await verify(second)).status).toBe(401);
      expect(await tokenRows(admin.id)).toHaveLength(0);
    });

    it('DELETE without the cookie still forgets the caller session tokens', async () => {
      const admin = await superAdmin();
      await mint(admin.jar);
      const token = admin.jar.only('vc-admin-token');
      admin.jar.cookies.delete('vc-admin-token');
      expect((await send('DELETE', '/api/v1/admin/forwardauth-cookie', admin.jar)).status).toBe(204);
      expect((await verify(token)).status).toBe(401);
      expect(await tokenRows(admin.id)).toHaveLength(0);
    });

    it('two concurrent mints both leave a working token, whichever response lands last', async () => {
      const admin = await superAdmin();
      const cookieOf = (res: Response) =>
        (res.headers.getSetCookie().find((c) => c.startsWith('vc-admin-token=')) as string).split(
          ';'
        )[0];
      const cookie = admin.jar.header;
      const [a, b] = await Promise.all([
        post('/api/v1/admin/forwardauth-cookie', {}, cookie),
        post('/api/v1/admin/forwardauth-cookie', {}, cookie),
      ]);
      expect([a.status, b.status]).toEqual([204, 204]);
      expect(cookieOf(a)).not.toBe(cookieOf(b));
      expect((await verify(cookieOf(a))).status).toBe(200);
      expect((await verify(cookieOf(b))).status).toBe(200);
    });

    it('a regular user gets no cookie', async () => {
      const user = await member();
      expect((await mint(user.jar)).status).toBe(403);
    });

    it('signing out ends it at once', async () => {
      const admin = await superAdmin();
      await mint(admin.jar);
      const cookie = admin.jar.only('vc-admin-token');
      expect((await verify(cookie)).status).toBe(200);
      expect((await post('/api/auth/sign-out', {}, admin.jar)).status).toBe(200);
      expect((await verify(cookie)).status).toBe(401);
    });

    it('a banned or demoted admin is refused at once', async () => {
      const admin = await superAdmin();
      await mint(admin.jar);
      const cookie = admin.jar.only('vc-admin-token');
      await db.query('update public."user" set role = null where id = $1', [admin.id]);
      expect((await verify(cookie)).status).toBe(403);
      await db.query(`update public."user" set role = 'super_admin', banned = true where id = $1`, [
        admin.id,
      ]);
      expect((await verify(cookie)).status).toBe(401);
    });

    it('MFA on: an aal1 admin is asked to verify a code before getting the cookie', async () => {
      const admin = await superAdmin();
      await setMfa(true);
      const res = await mint(admin.jar);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('mfa_required');
    });

    it('MFA turned on later: a cookie minted from an aal1 session stops working', async () => {
      const admin = await superAdmin();
      await mint(admin.jar);
      const cookie = admin.jar.only('vc-admin-token');
      await setMfa(true);
      expect((await verify(cookie)).status).toBe(401);
    });

    it('verify-role never extends the session', async () => {
      const admin = await superAdmin();
      await mint(admin.jar);
      // Old enough that get-session would slide it forward.
      await db.query(
        `update public.session set expires_at = now() + interval '1 hour' where user_id = $1`,
        [admin.id]
      );
      expect((await verify(admin.jar.only('vc-admin-token'))).status).toBe(200);
      const { rows } = await db.query<{ left: number }>(
        `select extract(epoch from expires_at - now())::int as left from public.session where user_id = $1`,
        [admin.id]
      );
      expect(rows[0].left).toBeLessThanOrEqual(3600);
    });
  });

  describe('DELETE /api/v1/me', () => {
    it('deletes the user and everything that hangs off it', async () => {
      const user = await member();
      const res = await send('DELETE', '/api/v1/me', user.jar);
      expect(res.status).toBe(200);
      const counts = await db.query<{ users: number; sessions: number; accounts: number }>(
        `select (select count(*) from public."user" where id = $1)::int as users,
                (select count(*) from public.session where user_id = $1)::int as sessions,
                (select count(*) from public.account where user_id = $1)::int as accounts`,
        [user.id]
      );
      expect(counts.rows[0]).toEqual({ users: 0, sessions: 0, accounts: 0 });
      expect(await whoami(user.jar)).toBeNull();
    });

    it('the only member of an organization is told to hand it over first', async () => {
      const user = await member();
      const slug = `solo-${randomUUID().slice(0, 8)}`;
      const created = await post('/api/v1/organizations', { name: slug, slug }, user.jar);
      expect(created.status).toBe(201);
      orgIds.push((await created.json()).organization.id);
      const res = await send('DELETE', '/api/v1/me', user.jar);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('only member');
      expect(await userIdOf(user.email)).toBe(user.id);
    });

    it('a super admin cannot delete their own account', async () => {
      const admin = await superAdmin();
      expect((await send('DELETE', '/api/v1/me', admin.jar)).status).toBe(403);
    });
  });

  describe('admin users list', () => {
    it('searches every user by email or name, sorts and paginates, with the old response shape', async () => {
      const admin = await superAdmin();
      const tag = randomUUID().slice(0, 8);
      const a = await member(`Zed ${tag}`);
      const b = await member(`Amy ${tag}`);
      await db.query(
        `insert into public.organizations (name, slug) values ($1, $1) returning id`,
        [`org-${tag}`]
      ).then(async ({ rows }) => {
        orgIds.push(rows[0].id);
        await db.query(
          `insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'OWNER')`,
          [rows[0].id, a.id]
        );
      });

      const res = await get(
        `/api/v1/admin/users?search=${tag}&sortBy=name&sortOrder=asc&limit=1&page=1`,
        admin.jar
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
      expect(body.users).toHaveLength(1);
      expect(body.users[0]).toMatchObject({
        id: b.id,
        email: b.email,
        name: `Amy ${tag}`,
        avatar: null,
        role: 'user', // the admin plugin's default role
        emailVerified: false,
        organizationCount: 0,
      });
      expect(typeof body.users[0].createdAt).toBe('string');
      expect(typeof body.users[0].lastSignIn).toBe('string');

      const page2 = await (
        await get(`/api/v1/admin/users?search=${tag}&sortBy=name&sortOrder=asc&limit=1&page=2`, admin.jar)
      ).json();
      expect(page2.users[0]).toMatchObject({ id: a.id, organizationCount: 1 });

      // The organizations list counts members the same way.
      const orgs = await (
        await get(`/api/v1/admin/organizations?search=org-${tag}`, admin.jar)
      ).json();
      expect(orgs.organizations).toHaveLength(1);
      expect(orgs.organizations[0].memberCount).toBe(1);
      // "_" is matched literally, not as LIKE's one-character wildcard.
      const literal = await (
        await get(`/api/v1/admin/organizations?search=org_${tag}`, admin.jar)
      ).json();
      expect(literal.organizations).toHaveLength(0);
    });

    it('is super admin only', async () => {
      const user = await member();
      expect((await get('/api/v1/admin/users', user.jar)).status).toBe(403);
    });
  });

  describe('organization members', () => {
    it('invite by email finds the user (any case); the member list carries profile details', async () => {
      const owner = await member('Owner');
      const invitee = await member('Invitee');
      const slug = `org-${randomUUID().slice(0, 8)}`;
      const created = await post('/api/v1/organizations', { name: slug, slug }, owner.jar);
      expect(created.status).toBe(201);
      const orgId = (await created.json()).organization.id as string;
      orgIds.push(orgId);

      const added = await post(
        `/api/v1/organizations/${orgId}/members`,
        { email: invitee.email.toUpperCase(), role: 'MEMBER' },
        owner.jar
      );
      expect(added.status).toBe(201);
      expect((await added.json()).member.user).toEqual({
        id: invitee.id,
        email: invitee.email,
        name: 'Invitee',
      });

      const missing = await post(
        `/api/v1/organizations/${orgId}/members`,
        { email: `nobody-${randomUUID()}@example.test`, role: 'MEMBER' },
        owner.jar
      );
      expect(missing.status).toBe(404);

      const list = await (await get(`/api/v1/organizations/${orgId}/members`, owner.jar)).json();
      const users = list.members.map((m: { user: unknown }) => m.user);
      expect(users).toContainEqual({ id: invitee.id, email: invitee.email, name: 'Invitee', avatar: null });
      expect(users).toContainEqual({ id: owner.id, email: owner.email, name: 'Owner', avatar: null });
    });
  });

  describe('super-admin routes while MFA is globally on', () => {
    const patchSettings = (jar: CookieJar, body: unknown) =>
      send('PATCH', '/api/v1/auth/admin/settings', jar, body);
    const verifySession = (userId: string) =>
      db.query('update public.session set two_factor_verified = true where user_id = $1', [userId]);

    it('an aal1 super admin cannot turn MFA off (or anything else) until it verifies a code', async () => {
      const admin = await superAdmin();
      await setMfa(true);
      const res = await patchSettings(admin.jar, { mfa_enabled: false });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('mfa_required');
      const [row] = await adminDb
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, 'mfa_enabled'));
      expect(row.value).toEqual({ enabled: true });

      for (const path of ['/api/v1/admin/users', '/api/v1/admin/stats', '/api/v1/admin/organizations']) {
        const blocked = await get(path, admin.jar);
        expect(blocked.status, path).toBe(403);
        expect((await blocked.json()).error, path).toBe('mfa_required');
      }
    });

    it('the same super admin passes once this session verified a code (aal2)', async () => {
      const admin = await superAdmin();
      await setMfa(true);
      await verifySession(admin.id);
      expect((await get('/api/v1/admin/users', admin.jar)).status).toBe(200);
      expect((await get('/api/v1/admin/stats', admin.jar)).status).toBe(200);
      const res = await patchSettings(admin.jar, { mfa_enabled: false });
      expect(res.status).toBe(200);
      __resetMfaSettingsCache();
    });

    it('a regular user still hears "super admin only", not a step-up prompt', async () => {
      const user = await member();
      await setMfa(true);
      const res = await patchSettings(user.jar, { mfa_enabled: false });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('Super admin access required');
    });

    it('with MFA off, an aal1 super admin is not asked for a code', async () => {
      const admin = await superAdmin();
      expect((await patchSettings(admin.jar, { user_docs_enabled: true })).status).toBe(200);
    });
  });

  describe('stats', () => {
    it('counts users and recently active users from the database', async () => {
      const admin = await superAdmin();
      const stats = async () => (await (await get('/api/v1/admin/stats', admin.jar)).json()).users;
      const before = await stats();
      await member();
      const after = await stats();
      expect(after.total).toBe(before.total + 1);
      expect(after.newThisMonth).toBe(before.newThisMonth + 1);
      expect(after.activeThisMonth).toBe(before.activeThisMonth + 1);
      const weekly = after.weeklySignups as { week: string; count: number }[];
      expect(weekly.map((w) => w.week)).toEqual(['W1', 'W2', 'W3', 'W4', 'W5', 'W6']);
      expect(weekly[5].count).toBe((before.weeklySignups as { count: number }[])[5].count + 1);
    });
  });
});
