import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../shared/types';
import { env } from './env';

// Server-side Supabase client with service role key
// This bypasses RLS - use only for admin operations
export const supabaseAdmin: SupabaseClient<Database> = createClient<Database>(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// Create a client for a specific user's context (respects RLS).
//
// SECURITY: uses the ANON key (not the service-role key) as the apikey, with the
// user's JWT layered on via the Authorization header. PostgREST derives the
// Postgres role from the JWT, so RLS is enforced for the authenticated user.
// The critical property is fail-safe degradation: if the Authorization header is
// ever dropped (bug, proxy stripping, refactor), the client falls back to the
// anon role under RLS rather than to service_role BYPASSRLS. The dedicated
// service-role clients (supabaseAdmin / createAuthClient) remain for admin ops.
export function createSupabaseClient(accessToken: string): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// Create a fresh client for auth operations (signInWithPassword, etc.)
// IMPORTANT: Never use supabaseAdmin for signInWithPassword — it stores the
// user's session on the singleton, contaminating all subsequent admin queries
// with the user's "authenticated" role instead of the "service_role" key.
export function createAuthClient(): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// Refresh a parked refresh token against GoTrue (impersonation restore).
// Anon key on purpose: token refresh is a user-context operation and must not
// ride the service role. A fresh client per call so no session sticks.
export async function refreshUserSession(refreshToken: string) {
  const client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return client.auth.refreshSession({ refresh_token: refreshToken });
}

// Helper to get Supabase client from request headers
export function getSupabaseClient(authHeader: string | undefined): SupabaseClient<Database> {
  if (!authHeader?.startsWith('Bearer ')) {
    // No valid auth header — return an anon client so RLS is enforced.
    // Routes must still reject unauthenticated requests via c.get('user'),
    // but this ensures any accidental query falls under anon RLS policies
    // rather than bypassing them entirely with the service role key.
    return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  const token = authHeader.replace('Bearer ', '');
  return createSupabaseClient(token);
}
