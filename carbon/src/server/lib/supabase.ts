import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../shared/types';
import { env } from './env';

/**
 * Supabase Auth (GoTrue) access for the server, and nothing else.
 *
 * Data never goes through here: the server reads and writes Postgres through
 * src/server/db/client.ts (`withUserDb` for anything done for a user,
 * `adminDb` where the server acts for itself). Every client this module
 * hands out is typed as auth-only, so `.from()` / `.rpc()` do not compile,
 * and tests/structural/db-access-census.test.ts fails on any data call
 * through a Supabase client under src/server.
 */
export type AuthOnlyClient = Pick<SupabaseClient<Database>, 'auth'>;

const noSession = { autoRefreshToken: false, persistSession: false } as const;

/**
 * Service-role client for the auth admin API (`auth.admin.*`: look up,
 * list, delete users, generate links) and for verifying a bearer token
 * with `auth.getUser(token)`.
 */
export const supabaseAdmin: AuthOnlyClient = createClient<Database>(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: noSession }
);

/**
 * A fresh client for auth flows that create a session (signInWithPassword).
 * Never use `supabaseAdmin` for those: it would store the user's session on
 * the shared singleton.
 */
export function createAuthClient(): AuthOnlyClient {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: noSession,
  });
}

/**
 * Refresh a parked refresh token against GoTrue (impersonation restore).
 * Anon key on purpose: token refresh is a user-context operation and must
 * not ride the service role. A fresh client per call so no session sticks.
 */
export async function refreshUserSession(refreshToken: string) {
  const client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: noSession,
  });
  return client.auth.refreshSession({ refresh_token: refreshToken });
}

/**
 * The session middleware's client for `auth.getUser()` on a request's bearer
 * token. ANON key as the apikey with the user's JWT layered on: GoTrue
 * resolves the user from the JWT, and a dropped Authorization header
 * degrades to anonymous, never to the service role.
 */
export function getSupabaseClient(authHeader: string | undefined): AuthOnlyClient {
  const headers = authHeader?.startsWith('Bearer ')
    ? { Authorization: `Bearer ${authHeader.replace('Bearer ', '')}` }
    : undefined;
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    ...(headers ? { global: { headers } } : {}),
    auth: noSession,
  });
}
