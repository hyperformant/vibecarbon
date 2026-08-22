import type { User } from '@supabase/supabase-js';

/** Check if a user has the super_admin role (set via app_metadata by Supabase admin API) */
export function isSuperAdmin(user: User): boolean {
  return user.app_metadata?.role === 'super_admin';
}
