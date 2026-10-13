import type { User } from '@supabase/supabase-js';

/**
 * Shared Hono context variables for authenticated routes.
 *
 * Data access does not live on the context: routes run user-scoped queries
 * through `withUserDb(c.get('user')?.id ?? null, ...)` (see db/client.ts).
 */
export type HonoVariables = {
  user: User | null;
  /** Authenticator Assurance Level of the current session, or null if unknown. */
  aal: 'aal1' | 'aal2' | null;
};
