import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware, isAPIError } from 'better-auth/api';

/**
 * Keep the session token out of every /api/auth JSON body.
 *
 * Better Auth puts the raw session token in the bodies of sign-up, sign-in,
 * get-session (`session.token`), list-sessions, magic-link verify,
 * impersonation and more, for bearer-token clients. This app has none: the
 * HttpOnly session cookie is the only carrier, so script on the page (an
 * XSS payload included) never sees a token it could replay. The browser
 * client reads the session from these bodies but never uses the token.
 *
 * Server-side `auth.api` calls are untouched (no request), so
 * `c.get('session')` keeps its token for server code.
 *
 * Registered as the LAST plugin, so its after hook sees what every other
 * plugin returned. It rewrites only the body; the Set-Cookie headers
 * already on the response stay as they are.
 *
 * Trade-off: revoking one specific session by token (`/revoke-session`) is
 * not possible from the browser. Sign-out, revoke-other-sessions and
 * revoke-sessions still are.
 */

/** A copy of `value` with every `token` key removed, at any depth. */
export function withoutTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTokens);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === 'token') continue;
      out[key] = withoutTokens(v);
    }
    return out;
  }
  return value;
}

function hasToken(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasToken);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.entries(value).some(([key, v]) => key === 'token' || hasToken(v));
  }
  return false;
}

export const stripSessionToken = () =>
  ({
    id: 'strip-session-token',
    hooks: {
      after: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            // Only HTTP responses. Server-side auth.api calls (the session
            // middleware, bootstrap) keep the full objects.
            if (!ctx.request) return;
            const returned = ctx.context.returned;
            if (
              returned === null ||
              typeof returned !== 'object' ||
              returned instanceof Response ||
              isAPIError(returned) ||
              !hasToken(returned)
            ) {
              return;
            }
            return ctx.json(withoutTokens(returned) as Record<string, unknown>);
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
