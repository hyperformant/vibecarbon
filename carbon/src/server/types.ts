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
  /**
   * The caller's session row, or null when signed out. Its assurance level
   * is `session.twoFactorVerified` (true = aal2); gate on it through
   * middleware/requireAal2.ts.
   */
  session: AuthSession | null;
};
