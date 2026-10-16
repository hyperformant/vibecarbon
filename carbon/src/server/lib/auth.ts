/**
 * True only for the platform super admin: the server-controlled
 * `user.role` column, exact match. Mirrors SQL `is_super_admin()`, so the
 * API and RLS never disagree about who is an admin (`'admin'`,
 * `'Super_Admin'`, a list containing it: all false).
 */
export function isSuperAdmin(user: { role?: string | null }): boolean {
  return user.role === 'super_admin';
}
