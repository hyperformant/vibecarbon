import type { User } from '@supabase/supabase-js';
import type { getSupabaseClient } from './lib/supabase';

/**
 * Shared Hono context variables for authenticated routes.
 * Used to type the user and supabase client available via c.get().
 */
export type HonoVariables = {
  user: User | null;
  supabase: ReturnType<typeof getSupabaseClient>;
  /** Authenticator Assurance Level of the current session, or null if unknown. */
  aal: 'aal1' | 'aal2' | null;
};
