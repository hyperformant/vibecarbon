import { describe, expect, it } from 'vitest';
import { withoutTokens } from '@server/auth/strip-session-token';

/** The body rewrite behind keeping session tokens out of /api/auth JSON. */
describe('withoutTokens', () => {
  it('drops token keys at any depth and keeps everything else', () => {
    const at = new Date(0);
    expect(
      withoutTokens({
        token: 't',
        user: { id: 'u', createdAt: at },
        session: { token: 't', id: 's' },
        list: [{ token: 't', id: 1 }],
      })
    ).toEqual({ user: { id: 'u', createdAt: at }, session: { id: 's' }, list: [{ id: 1 }] });
  });

  it('passes primitives and null through', () => {
    expect(withoutTokens(null)).toBeNull();
    expect(withoutTokens('token')).toBe('token');
    expect(withoutTokens([1, 'a'])).toEqual([1, 'a']);
  });
});
