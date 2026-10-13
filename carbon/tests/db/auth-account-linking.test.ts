import { randomUUID } from 'node:crypto';
import { handleOAuthUserInfo } from 'better-auth/oauth2';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auth } from '@server/auth';
import { adminDb } from '@server/db/client';
import { logger } from '@server/lib/logger';
import { connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * Account pre-hijacking: an attacker registers the victim's address with a
 * password (no email verification without SMTP); the victim later signs in
 * with Google. The link must cut the attacker out.
 *
 * The OAuth round trip itself (redirect, code exchange) needs a live
 * provider, so these tests enter at the step after it: Better Auth's own
 * `handleOAuthUserInfo`, which the callback route calls with the provider's
 * user info. Everything from there on (linking rules, database hooks,
 * session creation) is the real code path.
 */

const ORIGIN = 'http://app.test';
const PASSWORD = 'correct-horse-battery';

describe.skipIf(!dbTestsEnabled)('social sign-in onto an existing email (real database)', () => {
  let db: pg.Client;
  const emails: string[] = [];

  const newEmail = () => {
    const email = `auth-link-${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  };

  const post = (path: string, body: unknown) =>
    auth.handler(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify(body),
      }),
    );

  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');

  /** The provider callback's step: Better Auth handles the provider's user info. */
  const googleSignIn = async (email: string, emailVerified: boolean) => {
    const c = {
      context: await auth.$context,
      headers: new Headers(),
      body: {},
      query: {},
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal endpoint context for an internal step
    return handleOAuthUserInfo(c as any, {
      userInfo: { id: `g-${randomUUID()}`, email, emailVerified, name: 'Victim' },
      account: { providerId: 'google', accountId: `g-${randomUUID()}` },
    });
  };

  const accountsOf = async (email: string) =>
    (
      await db.query<{ provider_id: string }>(
        'select a.provider_id from public.account a join public."user" u on u.id = a.user_id where u.email = $1 order by 1',
        [email],
      )
    ).rows.map((r) => r.provider_id);

  beforeAll(async () => {
    db = await connectTestDb();
  });

  afterAll(async () => {
    await db.query('delete from public."user" where email = any($1::text[])', [emails]);
    await db.end();
  });

  it("the victim's verified Google sign-in removes the attacker's password and sessions", async () => {
    const email = newEmail();
    // The attacker registers the victim's address and stays signed in.
    const signup = await post('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'A' });
    expect(signup.status).toBe(200);
    const attackerCookie = cookieOf(signup);
    const before = await auth.api.getSession({
      headers: new Headers({ cookie: attackerCookie }),
      query: { disableCookieCache: true },
    });
    expect(before?.user.email).toBe(email);

    const result = await googleSignIn(email, true);
    expect(result.error).toBeFalsy();
    expect(result.data?.user.email).toBe(email);

    expect(await accountsOf(email)).toEqual(['google']);
    const { rows } = await db.query('select email_verified from public."user" where email = $1', [
      email,
    ]);
    expect(rows[0].email_verified).toBe(true);
    // The attacker's session is gone and the password no longer works.
    const after = await auth.api.getSession({
      headers: new Headers({ cookie: attackerCookie }),
      query: { disableCookieCache: true },
    });
    expect(after).toBeNull();
    expect((await post('/api/auth/sign-in/email', { email, password: PASSWORD })).status).toBe(401);
    // The victim got a fresh session.
    expect(result.data?.session.userId).toBe(result.data?.user.id);
  });

  it('fails closed: if the cleanup fails, no link, no session, nothing changed', async () => {
    const email = newEmail();
    const signup = await post('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'A' });
    const attackerCookie = cookieOf(signup);

    const boom = Object.assign(new Error('connection lost'), { code: '57P01' });
    const tx = vi.spyOn(adminDb, 'transaction').mockRejectedValueOnce(boom);
    const errors = vi.spyOn(logger, 'error');
    try {
      const result = await googleSignIn(email, true);
      expect(result.error).toBeTruthy();
      expect(result.data).toBeNull();
      expect(tx).toHaveBeenCalledTimes(1);
      const logged = errors.mock.calls.find((call) =>
        String(call[1]).includes('refusing the link'),
      );
      expect(logged).toBeDefined();
      // Logged through dbErrorForLog: the error is there, as a plain object.
      expect((logged?.[0] as { err: { message?: string } }).err.message).toContain(
        'connection lost',
      );
    } finally {
      tx.mockRestore();
      errors.mockRestore();
    }

    // State unchanged: no google account, the password and session are as
    // they were, the email still unverified.
    expect(await accountsOf(email)).toEqual(['credential']);
    const { rows } = await db.query('select email_verified from public."user" where email = $1', [
      email,
    ]);
    expect(rows[0].email_verified).toBe(false);
    const still = await auth.api.getSession({
      headers: new Headers({ cookie: attackerCookie }),
      query: { disableCookieCache: true },
    });
    expect(still?.user.email).toBe(email);
    const sessions = await db.query(
      'select count(*)::int as n from public.session s join public."user" u on u.id = s.user_id where u.email = $1',
      [email],
    );
    expect(sessions.rows[0].n).toBe(1);
  });

  it('a provider that does not vouch for the email cannot link at all', async () => {
    const email = newEmail();
    await post('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'A' });
    const result = await googleSignIn(email, false);
    expect(result.error).toBe('account not linked');
    expect(await accountsOf(email)).toEqual(['credential']);
  });

  it('a verified password account keeps its password when a provider links', async () => {
    const email = newEmail();
    await post('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'Owner' });
    await db.query('update public."user" set email_verified = true where email = $1', [email]);
    const result = await googleSignIn(email, true);
    expect(result.error).toBeFalsy();
    expect(await accountsOf(email)).toEqual(['credential', 'google']);
    expect((await post('/api/auth/sign-in/email', { email, password: PASSWORD })).status).toBe(200);
  });

  it('a brand-new social user is left as the provider described them', async () => {
    const email = newEmail();
    const result = await googleSignIn(email, false);
    expect(result.error).toBeFalsy();
    expect(await accountsOf(email)).toEqual(['google']);
    const { rows } = await db.query('select email_verified from public."user" where email = $1', [
      email,
    ]);
    expect(rows[0].email_verified).toBe(false);
  });
});
