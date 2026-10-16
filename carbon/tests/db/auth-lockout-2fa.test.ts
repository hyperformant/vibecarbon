import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth } from '@server/auth';
import { connectTestDb, dbTestsEnabled } from './_helpers';

/**
 * The lockout must see a pending second-factor challenge as neither a
 * failure nor a success. twoFactor's after hook is what turns a correct
 * password into a challenge (it drops `newSession`), so the lockout has to
 * run after it: plugin after hooks run in array order, and the top-level
 * `hooks.after` option would run before all of them. stripSessionToken
 * must be last (it rewrites every body the others produced).
 *
 * Both are checked on the app's real auth instance.
 */

const ORIGIN = 'http://app.test';
const PASSWORD = 'correct-horse-battery';
const IP = '203.0.113.81';

describe('auth plugin order', () => {
  it('twoFactor runs before the lockout, and stripSessionToken runs last', () => {
    const ids = (auth.options.plugins ?? []).map((p) => p.id);
    expect(ids).toEqual([
      'admin',
      'magic-link',
      'two-factor',
      'session-assurance',
      'impersonation-guard',
      'account-lockout',
      'strip-session-token',
    ]);
  });
});

describe.skipIf(!dbTestsEnabled)('lockout with a pending 2FA challenge (real database)', () => {
  let db: pg.Client;
  const emails: string[] = [];

  const post = (path: string, body: unknown) =>
    auth.handler(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': IP },
        body: JSON.stringify(body),
      }),
    );

  const failures = async (email: string) =>
    (
      await db.query<{ n: number }>(
        'select count(*)::int as n from public.failed_login_attempts where email = $1 and ip_address = $2::inet',
        [email, IP],
      )
    ).rows[0].n;

  beforeAll(async () => {
    db = await connectTestDb();
  });

  afterAll(async () => {
    await db.query('delete from public."user" where email = any($1::text[])', [emails]);
    await db.query('delete from public.failed_login_attempts where email = any($1::text[])', [
      emails,
    ]);
    await db.end();
  });

  it('a correct password that opens a 2FA challenge neither clears nor records failures', async () => {
    const email = `auth-2fa-${randomUUID()}@example.test`;
    emails.push(email);
    expect((await post('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'T' })).status).toBe(200);
    await db.query('update public."user" set two_factor_enabled = true where email = $1', [email]);

    for (let i = 0; i < 3; i++) {
      expect((await post('/api/auth/sign-in/email', { email, password: 'wrong-password' })).status).toBe(401);
    }
    expect(await failures(email)).toBe(3);

    const challenge = await post('/api/auth/sign-in/email', { email, password: PASSWORD });
    expect(challenge.status).toBe(200);
    expect((await challenge.json()).twoFactorRedirect).toBe(true);
    // No session was issued (only the challenge cookie)...
    expect(challenge.headers.getSetCookie().join('\n')).not.toMatch(/session_token=[^;]/);
    // ...so the earlier failures stand (not cleared), and the right password
    // was not counted as a failure either.
    expect(await failures(email)).toBe(3);
  });
});
