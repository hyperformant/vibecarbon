import { createHmac, randomUUID } from 'node:crypto';
import { handleOAuthUserInfo } from 'better-auth/oauth2';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { auth } from '@server/auth';
import { adminDb } from '@server/db/client';
import { appSettings } from '@server/db/schema';
import { env } from '@server/lib/env';
import { __resetMfaSettingsCache } from '@server/lib/mfa-settings';
import { csrfProtection } from '@server/middleware/csrf';
import { requireAal2 } from '@server/middleware/requireAal2';
import { sessionMiddleware } from '@server/middleware/session';
import type { HonoVariables } from '@server/types';
import { totpCode, wrongTotpCode } from '../_helpers/totp';
import { connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * Two-factor sign-in and the per-session assurance level, against the
 * app's real auth instance and a real database.
 *
 * A session is aal2 when it passed a second factor (TOTP or a backup code)
 * itself; everything else (password alone, magic link, social, a trusted
 * device) is aal1. `requireAal2` routes and Better Auth's admin endpoints
 * refuse aal1 while MFA is globally on.
 */

const ORIGIN = 'http://app.test'; // SITE_URL in tests/_helpers/setup-db.ts
const PASSWORD = 'correct-horse-battery';

const sentEmails = vi.hoisted(() => [] as { kind: string; to: string; url: string }[]);
vi.mock('@server/auth/email', () => ({
  sendAuthEmail: async (kind: string, to: string, url: string) => {
    sentEmails.push({ kind, to, url });
  },
}));

function buildApp() {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('/api/*', csrfProtection());
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
  app.use('/api/*', sessionMiddleware);
  app.get('/api/v1/whoami', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ id: user.id, sessionId: c.get('session')?.id, aal: c.get('session')?.twoFactorVerified ? 'aal2' : 'aal1' });
  });
  app.delete('/api/v1/gated', requireAal2, (c) => c.json({ ok: true }));
  return app;
}

/** A browser's cookie store, enough for these flows (one host, no paths). */
class CookieJar {
  private cookies = new Map<string, string>();

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

  has(name: string): boolean {
    return this.cookies.has(name);
  }
}

/** The signed session cookie a browser would hold for `token`. */
function sessionCookieFor(token: string): string {
  const signature = createHmac('sha256', env.BETTER_AUTH_SECRET).update(token).digest('base64');
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

describe.skipIf(!dbTestsEnabled)('two-factor and session assurance (real database)', () => {
  let db: pg.Client;
  let app: ReturnType<typeof buildApp>;
  const emails: string[] = [];
  let originalMfa: unknown;

  const newEmail = () => {
    const email = `auth-mfa-${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  };

  const post = (path: string, body: unknown, jar?: CookieJar) =>
    app
      .request(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          ...(jar ? { cookie: jar.header } : {}),
        },
        body: JSON.stringify(body),
      })
      .then((res) => (jar ? jar.take(res) : res));

  const get = (path: string, jar: CookieJar) =>
    app.request(path, { headers: { cookie: jar.header } }).then((res) => jar.take(res));

  const whoami = async (jar: CookieJar) => {
    const res = await app.request('/api/v1/whoami', { headers: { cookie: jar.header } });
    return res.status === 200 ? ((await res.json()) as { sessionId: string; aal: string }) : null;
  };

  const gated = (jar: CookieJar) =>
    app.request('/api/v1/gated', {
      method: 'DELETE',
      headers: { cookie: jar.header, origin: ORIGIN },
    });

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

  /**
   * Sign up with a password; the jar holds the new (aal1) session. Verified
   * by default (as with SMTP configured): a magic link onto an UNverified
   * account is the pre-hijacking case, which drops its second factor.
   */
  const passwordUser = async ({ verified = true } = {}) => {
    const email = newEmail();
    const jar = new CookieJar();
    expect((await post('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'M' }, jar)).status).toBe(200);
    if (verified) {
      await db.query('update public."user" set email_verified = true where email = $1', [email]);
    }
    return { email, jar };
  };

  /** Enable TOTP and confirm the first code, the way the Security page does. */
  const enroll = async (jar: CookieJar, password: string | undefined = PASSWORD) => {
    const enable = await post('/api/auth/two-factor/enable', password ? { password } : {}, jar);
    expect(enable.status).toBe(200);
    const { totpURI, backupCodes } = (await enable.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    const verify = await post('/api/auth/two-factor/verify-totp', { code: totpCode(totpURI) }, jar);
    expect(verify.status).toBe(200);
    return { totpURI, backupCodes };
  };

  /** Password sign-in that stops at the 2FA challenge; the jar holds its cookie. */
  const passwordChallenge = async (email: string) => {
    const jar = new CookieJar();
    const res = await post('/api/auth/sign-in/email', { email, password: PASSWORD }, jar);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ twoFactorRedirect: true });
    expect(await whoami(jar)).toBeNull();
    return jar;
  };

  const magicLinkSignIn = async (email: string) => {
    sentEmails.length = 0;
    expect((await post('/api/auth/sign-in/magic-link', { email })).status).toBe(200);
    const link = new URL(sentEmails.at(-1)?.url as string);
    const jar = new CookieJar();
    const res = await get(`${link.pathname}${link.search}`, jar);
    expect([200, 302]).toContain(res.status);
    return jar;
  };

  const googleSignIn = async (email: string) => {
    const c = { context: await auth.$context, headers: new Headers(), body: {}, query: {} };
    // biome-ignore lint/suspicious/noExplicitAny: minimal endpoint context for an internal step
    const result = await handleOAuthUserInfo(c as any, {
      userInfo: { id: `g-${randomUUID()}`, email, emailVerified: true, name: 'Social' },
      account: { providerId: 'google', accountId: `g-${randomUUID()}` },
    });
    const session = result.data?.session as { token: string };
    const jar = new CookieJar();
    jar.take(new Response(null, { headers: { 'set-cookie': sessionCookieFor(session.token) } }));
    return jar;
  };

  beforeAll(async () => {
    db = await connectTestDb();
    app = buildApp();
    const [row] = await adminDb
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, 'mfa_enabled'));
    originalMfa = row?.value;
  });

  afterEach(() => {
    __resetMfaSettingsCache();
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
    await db.query('delete from public."user" where email = any($1::text[])', [emails]);
    await db.query('delete from public.failed_login_attempts where email = any($1::text[])', [
      emails,
    ]);
    await db.end();
  });

  describe('reaching aal2', () => {
    it('enrolling (enable, then the first code) makes this session aal2 on the very next request', async () => {
      const { jar } = await passwordUser();
      expect((await whoami(jar))?.aal).toBe('aal1');
      await enroll(jar);
      expect((await whoami(jar))?.aal).toBe('aal2');
      // The browser's cached session (get-session reads the cookie cache)
      // says so too, without waiting for the cache to expire.
      const cached = await get('/api/auth/get-session', jar);
      expect((await cached.json()).session.twoFactorVerified).toBe(true);
    });

    it('password + TOTP sign-in yields aal2', async () => {
      const { email, jar: first } = await passwordUser();
      const { totpURI } = await enroll(first);
      const jar = await passwordChallenge(email);
      const res = await post('/api/auth/two-factor/verify-totp', { code: totpCode(totpURI) }, jar);
      expect(res.status).toBe(200);
      expect((await whoami(jar))?.aal).toBe('aal2');
      expect((await (await get('/api/auth/get-session', jar)).json()).session.twoFactorVerified).toBe(
        true,
      );
      await setMfa(true);
      expect((await gated(jar)).status).toBe(200);
    });

    it('password + backup code sign-in yields aal2', async () => {
      const { email, jar: first } = await passwordUser();
      const { backupCodes } = await enroll(first);
      const jar = await passwordChallenge(email);
      const res = await post('/api/auth/two-factor/verify-backup-code', { code: backupCodes[0] }, jar);
      expect(res.status).toBe(200);
      expect((await whoami(jar))?.aal).toBe('aal2');
    });

    it('a wrong code yields no session at all', async () => {
      const { email, jar: first } = await passwordUser();
      const { totpURI } = await enroll(first);
      const jar = await passwordChallenge(email);
      const res = await post('/api/auth/two-factor/verify-totp', { code: wrongTotpCode(totpURI) }, jar);
      expect(res.status).toBe(401);
      expect(await whoami(jar)).toBeNull();
    });

    it('the client cannot mark its own session verified', async () => {
      const { jar } = await passwordUser();
      const res = await post('/api/auth/update-session', { twoFactorVerified: true }, jar);
      expect(res.status).toBe(404);
      // Nor through the profile update (it is not a user field).
      await post('/api/auth/update-user', { twoFactorVerified: true }, jar);
      expect((await whoami(jar))?.aal).toBe('aal1');
    });
  });

  describe('Review Focus 1: magic link and social sign-in stay aal1 with 2FA enrolled', () => {
    it('magic link: aal1, and requireAal2 answers 403 mfa_required while MFA is on', async () => {
      const { email, jar: first } = await passwordUser();
      await enroll(first);
      const jar = await magicLinkSignIn(email);
      expect((await whoami(jar))?.aal).toBe('aal1');
      await setMfa(true);
      const res = await gated(jar);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: 'mfa_required',
        current_aal: 'aal1',
        aal_required: 'aal2',
        mfa_enrolled: true,
      });
    });

    it('social: aal1, and requireAal2 answers 403 mfa_required while MFA is on', async () => {
      const email = newEmail();
      const first = await googleSignIn(email);
      await enroll(first, undefined); // no password: a social-only account
      const jar = await googleSignIn(email);
      expect((await whoami(jar))?.aal).toBe('aal1');
      await setMfa(true);
      const res = await gated(jar);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'mfa_required', mfa_enrolled: true });
    });

    it('step-up: a code verified from an aal1 session upgrades THAT session', async () => {
      const { email, jar: first } = await passwordUser();
      const { totpURI } = await enroll(first);
      const jar = await magicLinkSignIn(email);
      const before = await whoami(jar);
      const sessions = async () =>
        (
          await db.query('select count(*)::int as n from public.session where user_id = $1', [
            await userIdOf(email),
          ])
        ).rows[0].n;
      const count = await sessions();
      const res = await post('/api/auth/two-factor/verify-totp', { code: totpCode(totpURI) }, jar);
      expect(res.status).toBe(200);
      const after = await whoami(jar);
      expect(after).toMatchObject({ aal: 'aal2', sessionId: before?.sessionId });
      expect((await (await get('/api/auth/get-session', jar)).json()).session.twoFactorVerified).toBe(
        true,
      );
      await setMfa(true);
      expect((await gated(jar)).status).toBe(200);
      // No new session: the one the user already had was upgraded.
      expect(await sessions()).toBe(count);
    });

    it('step-up with a backup code works too', async () => {
      const { email, jar: first } = await passwordUser();
      const { backupCodes } = await enroll(first);
      const jar = await magicLinkSignIn(email);
      const res = await post('/api/auth/two-factor/verify-backup-code', { code: backupCodes[1] }, jar);
      expect(res.status).toBe(200);
      expect((await whoami(jar))?.aal).toBe('aal2');
    });

    it('step-up guessing locks after 10 wrong codes, even for the right one', async () => {
      const { email, jar: first } = await passwordUser();
      const { totpURI } = await enroll(first);
      const jar = await magicLinkSignIn(email);
      for (let i = 0; i < 10; i++) {
        const res = await post('/api/auth/two-factor/verify-totp', { code: wrongTotpCode(totpURI) }, jar);
        expect(res.status).toBe(401);
      }
      const locked = await post('/api/auth/two-factor/verify-totp', { code: totpCode(totpURI) }, jar);
      expect(locked.status).toBe(429);
      expect((await whoami(jar))?.aal).toBe('aal1');
    });

    it('a success resets the step-up failure count', async () => {
      const { email, jar: first } = await passwordUser();
      const { totpURI } = await enroll(first);
      const jar = await magicLinkSignIn(email);
      for (let i = 0; i < 3; i++) {
        await post('/api/auth/two-factor/verify-totp', { code: wrongTotpCode(totpURI) }, jar);
      }
      expect((await post('/api/auth/two-factor/verify-totp', { code: totpCode(totpURI) }, jar)).status).toBe(200);
      const { rows } = await db.query(
        'select failed_verification_count as n from public.two_factor where user_id = $1',
        [await userIdOf(email)],
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe('the MFA switch', () => {
    it('MFA globally off lets an aal1 session through requireAal2', async () => {
      const { jar } = await passwordUser();
      await setMfa(false);
      expect((await gated(jar)).status).toBe(200);
    });

    it('MFA on: a user with no second factor is refused and told to enroll', async () => {
      const { jar } = await passwordUser();
      await setMfa(true);
      const res = await gated(jar);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'mfa_required', mfa_enrolled: false });
    });
  });

  describe('managing an enrolled factor needs an aal2 session', () => {
    it.each([
      ['/api/auth/two-factor/get-totp-uri', { password: PASSWORD }],
      ['/api/auth/two-factor/generate-backup-codes', { password: PASSWORD }],
      ['/api/auth/two-factor/disable', { password: PASSWORD }],
    ])('%s is refused from an aal1 session', async (path, body) => {
      const { email, jar: first } = await passwordUser();
      await enroll(first);
      const jar = await magicLinkSignIn(email);
      const res = await post(path, body, jar);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('MFA_REQUIRED');
    });

    it('from an aal2 session the factor can be read and removed; the session drops to aal1', async () => {
      const { email, jar } = await passwordUser();
      await enroll(jar);
      expect((await post('/api/auth/two-factor/get-totp-uri', { password: PASSWORD }, jar)).status).toBe(200);
      expect((await post('/api/auth/two-factor/disable', { password: PASSWORD }, jar)).status).toBe(200);
      expect((await whoami(jar))?.aal).toBe('aal1');
      const { rows } = await db.query('select two_factor_enabled from public."user" where email = $1', [
        email,
      ]);
      expect(rows[0].two_factor_enabled).toBe(false);
    });

    it('a social-only account enrolls without a password (it has none)', async () => {
      const email = newEmail();
      const jar = await googleSignIn(email);
      await enroll(jar, undefined);
      expect((await whoami(jar))?.aal).toBe('aal2');
    });

    it('a password account still needs its password to enroll', async () => {
      const { jar } = await passwordUser();
      expect((await post('/api/auth/two-factor/enable', {}, jar)).status).toBe(400);
    });

    it('the email one-time-code factor is not offered', async () => {
      const { jar } = await passwordUser();
      expect((await post('/api/auth/two-factor/send-otp', {}, jar)).status).toBe(404);
      expect((await post('/api/auth/two-factor/verify-otp', { code: '000000' }, jar)).status).toBe(404);
    });
  });

  describe("Better Auth's admin endpoints", () => {
    const superAdmin = async () => {
      const user = await passwordUser();
      await db.query(`update public."user" set role = 'super_admin' where email = $1`, [user.email]);
      return user;
    };

    it('MFA on: an aal1 super admin is refused with mfa_required', async () => {
      const { jar } = await superAdmin();
      await setMfa(true);
      const res = await get('/api/auth/admin/list-users', jar);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('MFA_REQUIRED');
    });

    it('MFA on: an aal2 super admin gets through', async () => {
      const { jar } = await superAdmin();
      await enroll(jar);
      await setMfa(true);
      expect((await get('/api/auth/admin/list-users', jar)).status).toBe(200);
    });

    it('MFA off: an aal1 super admin gets through', async () => {
      const { jar } = await superAdmin();
      await setMfa(false);
      expect((await get('/api/auth/admin/list-users', jar)).status).toBe(200);
    });

    it('MFA on: an aal2 admin impersonates, and the aal1 impersonation session can stop', async () => {
      const { jar } = await superAdmin();
      await enroll(jar);
      const adminSession = (await whoami(jar))?.sessionId;
      const { email: targetEmail } = await passwordUser();
      await setMfa(true);

      const start = await post(
        '/api/auth/admin/impersonate-user',
        { userId: await userIdOf(targetEmail) },
        jar,
      );
      expect(start.status).toBe(200);
      const as = await whoami(jar);
      expect(as).toMatchObject({ id: await userIdOf(targetEmail), aal: 'aal1' });

      const stop = await post('/api/auth/admin/stop-impersonating', {}, jar);
      expect(stop.status).toBe(200);
      expect(await whoami(jar)).toMatchObject({ sessionId: adminSession, aal: 'aal2' });
    });

    it.each([
      '/api/auth/admin/create-user',
      '/api/auth/admin/update-user',
      '/api/auth/admin/set-user-password',
      '/api/auth/admin/ban-user',
      '/api/auth/admin/unban-user',
      '/api/auth/admin/revoke-user-session',
      '/api/auth/admin/revoke-user-sessions',
      '/api/auth/admin/list-user-sessions',
      '/api/auth/admin/get-user',
      '/api/auth/admin/has-permission',
      '/api/auth/admin/set-role',
    ])('%s is not served over HTTP', async (path) => {
      const { jar } = await superAdmin();
      await enroll(jar);
      expect((await post(path, {}, jar)).status).toBe(404);
    });

    it('server-side calls with no request (the startup bootstrap) are not gated', async () => {
      await setMfa(true);
      const email = newEmail();
      await auth.api.createUser({ body: { email, password: PASSWORD, name: 'Server' } });
      expect(await userIdOf(email)).toBeTruthy();
    });
  });

  describe('a magic link onto an unverified account drops a second factor nobody proved', () => {
    it("an attacker's TOTP on a pre-registered address does not survive the owner's magic link", async () => {
      // The attacker registers the victim's address (unverified: no SMTP)
      // and enrolls their own authenticator.
      const { email, jar } = await passwordUser({ verified: false });
      await enroll(jar);
      const victim = await magicLinkSignIn(email);
      expect(await whoami(victim)).not.toBeNull();
      const userId = await userIdOf(email);
      const { rows } = await db.query(
        `select u.two_factor_enabled, u.email_verified,
                (select count(*)::int from public.two_factor t where t.user_id = u.id) as factors,
                (select count(*)::int from public.account a where a.user_id = u.id) as accounts
           from public."user" u where u.id = $1`,
        [userId],
      );
      expect(rows[0]).toEqual({
        two_factor_enabled: false,
        email_verified: true,
        factors: 0,
        accounts: 0,
      });
    });
  });
  describe('fix round 1', () => {
    it('an unconfirmed enrollment cannot reach aal2 with a backup code', async () => {
      const { email, jar } = await passwordUser();
      const enable = await post('/api/auth/two-factor/enable', { password: PASSWORD }, jar);
      const { backupCodes } = (await enable.json()) as { backupCodes: string[] };
      // The user never confirmed a code from the authenticator app.
      const res = await post('/api/auth/two-factor/verify-backup-code', { code: backupCodes[0] }, jar);
      expect(res.status).toBe(400);
      expect((await whoami(jar))?.aal).toBe('aal1');
      const { rows } = await db.query(
        'select two_factor_verified from public.session where user_id = $1',
        [await userIdOf(email)],
      );
      expect(rows.every((r) => r.two_factor_verified === false)).toBe(true);
    });

    it('a passwordless account enrolls only from a fresh session (re-sign-in after 10 minutes)', async () => {
      const email = newEmail();
      const jar = await googleSignIn(email);
      await db.query(
        `update public.session set created_at = now() - interval '11 minutes'
          where user_id = $1`,
        [await userIdOf(email)],
      );
      const stale = await post('/api/auth/two-factor/enable', {}, jar);
      expect(stale.status).toBe(403);
      expect(await stale.json()).toMatchObject({ error: 'reauth_required' });
      const { rows } = await db.query('select count(*)::int as n from public.two_factor where user_id = $1', [
        await userIdOf(email),
      ]);
      expect(rows[0].n).toBe(0);

      // A fresh sign-in may enroll.
      const fresh = await googleSignIn(email);
      expect((await post('/api/auth/two-factor/enable', {}, fresh)).status).toBe(200);
    });

    it('an aal1 session cannot re-enroll over an enrolled factor', async () => {
      const { email, jar: first } = await passwordUser();
      await enroll(first);
      const secret = async () =>
        (await db.query('select secret from public.two_factor where user_id = $1', [await userIdOf(email)]))
          .rows[0].secret;
      const before = await secret();
      const jar = await magicLinkSignIn(email);
      const res = await post('/api/auth/two-factor/enable', { password: PASSWORD }, jar);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('MFA_REQUIRED');
      expect(await secret()).toBe(before);
    });

    it('concurrent wrong step-up codes never exceed the cap', async () => {
      const { email, jar: first } = await passwordUser();
      const { totpURI } = await enroll(first);
      const jar = await magicLinkSignIn(email);
      const results = await Promise.all(
        Array.from({ length: 25 }, () =>
          post('/api/auth/two-factor/verify-totp', { code: wrongTotpCode(totpURI) }, jar).then(
            (r) => r.status,
          ),
        ),
      );
      expect(results.filter((s) => s === 401).length).toBeLessThanOrEqual(10);
      expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(15);
      const { rows } = await db.query(
        'select failed_verification_count as n, locked_until from public.two_factor where user_id = $1',
        [await userIdOf(email)],
      );
      expect(rows[0].n).toBeLessThanOrEqual(10);
      expect(rows[0].locked_until).not.toBeNull();
    });

    it('a failed magic-link factor cleanup aborts the verification; the retry finishes it', async () => {
      const { email, jar } = await passwordUser({ verified: false });
      await enroll(jar);
      const userId = await userIdOf(email);
      // A trusted-device record the attacker's browser holds.
      await db.query(
        `insert into public.verification (identifier, value, expires_at)
         values ($1, $2, now() + interval '1 day')`,
        [`trust-device-${randomUUID()}`, userId],
      );
      sentEmails.length = 0;
      expect((await post('/api/auth/sign-in/magic-link', { email })).status).toBe(200);
      const link = new URL(sentEmails.at(-1)?.url as string);
      const path = `${link.pathname}${link.search}`;

      const tx = vi.spyOn(adminDb, 'transaction').mockRejectedValueOnce(new Error('db down'));
      const failed = await app.request(path);
      tx.mockRestore();
      expect(failed.headers.getSetCookie().join('')).not.toMatch(/session_token=[^;]/);
      const state = async () =>
        (
          await db.query(
            `select u.email_verified,
                    (select count(*)::int from public.two_factor t where t.user_id = u.id) as factors,
                    (select count(*)::int from public.verification v
                      where v.identifier like 'trust-device-%' and v.value = u.id::text) as trusted
               from public."user" u where u.id = $1`,
            [userId],
          )
        ).rows[0];
      expect(await state()).toEqual({ email_verified: false, factors: 1, trusted: 1 });

      // The link was not used up: the owner clicks it again.
      const victim = new CookieJar();
      const retry = await get(path, victim);
      expect([200, 302]).toContain(retry.status);
      expect(await whoami(victim)).not.toBeNull();
      expect(await state()).toEqual({ email_verified: true, factors: 0, trusted: 0 });
    });
  });
  describe('fix round 2', () => {
    const ageSessions = async (email: string) =>
      db.query(
        `update public.session set created_at = now() - interval '11 minutes' where user_id = $1`,
        [await userIdOf(email)],
      );

    it('disable with no confirmed factor is refused (it cannot renew a stale session)', async () => {
      const email = newEmail();
      const jar = await googleSignIn(email);
      await ageSessions(email);
      const disable = await post('/api/auth/two-factor/disable', {}, jar);
      expect(disable.status).toBe(403);
      // So the stale session still cannot enroll.
      const enable = await post('/api/auth/two-factor/enable', {}, jar);
      expect(enable.status).toBe(403);
      expect(await enable.json()).toMatchObject({ error: 'reauth_required' });
    });

    it('a stale passwordless session cannot finish an abandoned enrollment', async () => {
      const email = newEmail();
      const owner = await googleSignIn(email);
      const enable = await post('/api/auth/two-factor/enable', {}, owner);
      const { totpURI } = (await enable.json()) as { totpURI: string };
      // The owner walks away; later a thief holds the (now stale) cookie.
      await ageSessions(email);
      for (const path of ['/api/auth/two-factor/get-totp-uri', '/api/auth/two-factor/generate-backup-codes']) {
        const res = await post(path, {}, owner);
        expect(res.status, path).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'reauth_required' });
      }
      const confirm = await post('/api/auth/two-factor/verify-totp', { code: totpCode(totpURI) }, owner);
      expect(confirm.status).toBe(403);
      expect((await whoami(owner))?.aal).toBe('aal1');
    });

    it('guessing the code of an unconfirmed enrollment is capped too', async () => {
      const { email, jar } = await passwordUser();
      const enable = await post('/api/auth/two-factor/enable', { password: PASSWORD }, jar);
      const { totpURI } = (await enable.json()) as { totpURI: string };
      const results = await Promise.all(
        Array.from({ length: 25 }, () =>
          post('/api/auth/two-factor/verify-totp', { code: wrongTotpCode(totpURI) }, jar).then(
            (r) => r.status,
          ),
        ),
      );
      expect(results.filter((s) => s === 401).length).toBeLessThanOrEqual(10);
      const { rows } = await db.query(
        'select failed_verification_count as n from public.two_factor where user_id = $1',
        [await userIdOf(email)],
      );
      expect(rows[0].n).toBeLessThanOrEqual(10);
    });

    it('a confirmed enrollment starts with a clean failure count', async () => {
      const { email, jar } = await passwordUser();
      const enable = await post('/api/auth/two-factor/enable', { password: PASSWORD }, jar);
      const { totpURI } = (await enable.json()) as { totpURI: string };
      await post('/api/auth/two-factor/verify-totp', { code: wrongTotpCode(totpURI) }, jar);
      expect((await post('/api/auth/two-factor/verify-totp', { code: totpCode(totpURI) }, jar)).status).toBe(200);
      const { rows } = await db.query(
        'select failed_verification_count as n from public.two_factor where user_id = $1',
        [await userIdOf(email)],
      );
      expect(rows[0].n).toBe(0);
    });

    it('a revoked session still in the cookie cache is refused, not served from the cache', async () => {
      const { email, jar } = await passwordUser();
      await enroll(jar);
      // The jar now holds the cache cookie for an aal2 session.
      await db.query('delete from public.session where user_id = $1', [await userIdOf(email)]);
      const res = await post('/api/auth/two-factor/get-totp-uri', { password: PASSWORD }, jar);
      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).not.toContain('otpauth');
    });
  });
});
