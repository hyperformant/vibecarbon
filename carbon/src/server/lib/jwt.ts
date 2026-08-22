/** Supabase Authenticator Assurance Level. */
export type Aal = 'aal1' | 'aal2';

/**
 * Read the `aal` (Authenticator Assurance Level) claim from a Supabase JWT.
 *
 * This does NOT verify the signature — callers must only pass a token that has
 * already been verified upstream (the session middleware validates it via
 * `supabase.auth.getUser()` before decoding here). It is a pure payload read.
 *
 * Returns 'aal1' | 'aal2', or null when the token is absent, malformed, or
 * carries no recognizable aal claim.
 */
export function decodeAalFromJwt(token: string | undefined): Aal | null {
  if (!token) return null;
  const jwt = token.startsWith('Bearer ') ? token.slice('Bearer '.length) : token;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      aal?: unknown;
    };
    return payload.aal === 'aal1' || payload.aal === 'aal2' ? payload.aal : null;
  } catch {
    return null;
  }
}
