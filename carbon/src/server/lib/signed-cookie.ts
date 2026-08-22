import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Tamper-evident cookie payloads (HMAC-SHA256).
 *
 * Used for the impersonation restore cookie: /stop trusts the cookie's
 * contents to refresh a session and to write the audit record, and the cookie
 * is set on a shared parent domain in compose mode — so without integrity
 * protection a compromised admin subdomain could TOSS a forged cookie
 * (document.cookie with domain=.{apex}), spoofing the audit log or fixating
 * the acting session. Signing with a server-only secret makes a tossed cookie
 * fail verification.
 *
 * The key is the service-role secret (server-only, high-entropy, never sent to
 * a client). Read lazily so importing this module never triggers env
 * validation — callers run in request handlers where the secret is present.
 */
function hmacKey(): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required to sign cookies');
  }
  return secret;
}

/** Sign an object into `base64url(json).base64url(hmac)`. */
export function signCookiePayload(obj: unknown): string {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = createHmac('sha256', hmacKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verify + parse a signed cookie value. Returns null on ANY tampering
 * (bad shape, signature mismatch, unparseable payload) — callers treat null
 * as "no valid cookie" and fail closed.
 */
export function verifyCookiePayload<T>(raw: string): T | null {
  const dot = raw.lastIndexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac('sha256', hmacKey()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}
