import { describe, expect, it } from 'vitest';
import { isSuperAdmin } from '@server/lib/auth';

/**
 * isSuperAdmin must agree with SQL is_super_admin(), which is
 * `role = 'super_admin'` on the server-controlled "user".role column: an
 * exact match, nothing looser.
 */
describe('isSuperAdmin', () => {
  it('is true only for the exact role super_admin', () => {
    expect(isSuperAdmin({ role: 'super_admin' })).toBe(true);
  });

  it.each([
    ['no role', {}],
    ['null role', { role: null }],
    ['user', { role: 'user' }],
    ['the non-existent platform admin role', { role: 'admin' }],
    ['different case', { role: 'Super_Admin' }],
    ['padding', { role: ' super_admin' }],
    ['a comma list containing it', { role: 'user,super_admin' }],
  ])('is false for %s', (_name, user) => {
    expect(isSuperAdmin(user)).toBe(false);
  });

  it('ignores the old metadata shape entirely', () => {
    const legacy = { app_metadata: { role: 'super_admin' } } as { role?: string | null };
    expect(isSuperAdmin(legacy)).toBe(false);
  });
});
