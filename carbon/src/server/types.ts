import type { AuthSession, AuthUser } from './auth';

/**
 * Shared Hono context variables, set for every /api/* request by the
 * session middleware (middleware/session.ts).
 *
 * Data access does not live on the context: routes run user-scoped queries
 * through `withUserDb(c.get('user')?.id ?? null, ...)` (see db/client.ts).
 */
export type HonoVariables = {
  /** The signed-in user, or null. */
  user: AuthUser | null;
  /** The caller's session row, or null when signed out. */
  session: AuthSession | null;
  /** 'aal2' once this session passed a second factor, 'aal1' otherwise, null when signed out. */
  aal: 'aal1' | 'aal2' | null;
};
