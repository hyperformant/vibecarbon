import { describe, expect, it } from 'vitest';

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { signCookiePayload, verifyCookiePayload } = await import('@server/lib/signed-cookie');

describe('signed-cookie', () => {
  it('round-trips a signed payload', () => {
    const obj = { refreshToken: 'rt', adminId: 'a1', n: 42 };
    const signed = signCookiePayload(obj);
    expect(signed).toContain('.');
    expect(verifyCookiePayload(signed)).toEqual(obj);
  });

  it('rejects a tampered payload (flipped body, original signature)', () => {
    const signed = signCookiePayload({ refreshToken: 'rt' });
    const [, sig] = signed.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ refreshToken: 'evil' })).toString('base64url');
    expect(verifyCookiePayload(`${forgedBody}.${sig}`)).toBeNull();
  });

  it('rejects a payload signed with a different secret', () => {
    const signed = signCookiePayload({ refreshToken: 'rt' });
    const orig = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'a-different-secret';
    try {
      expect(verifyCookiePayload(signed)).toBeNull();
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = orig;
    }
  });

  it('rejects plain JSON (unsigned) and malformed values', () => {
    expect(verifyCookiePayload(JSON.stringify({ refreshToken: 'rt' }))).toBeNull();
    expect(verifyCookiePayload('no-dot')).toBeNull();
    expect(verifyCookiePayload('.onlysig')).toBeNull();
    expect(verifyCookiePayload('onlybody.')).toBeNull();
  });
});
