import { csrf } from 'hono/csrf';
import { createMiddleware } from 'hono/factory';
import { allowedOrigins } from '../lib/origins';

/**
 * CSRF protection for cookie-authenticated API routes.
 *
 * The session is a cookie, so the browser attaches it to a request any site
 * makes. A cross-site page can send a "simple" request (a form post, or
 * fetch with text/plain) without a CORS preflight; Hono's `csrf()` refuses
 * a mutating one of those unless Sec-Fetch-Site says same-origin or the
 * Origin is one of ours. Anything else (JSON, custom headers, PUT/DELETE)
 * needs a preflight, which the CORS middleware only grants to our origins.
 *
 * Skipped where it does not apply:
 * - /api/auth/*: Better Auth checks the origin of its own endpoints.
 * - /api/webhooks/*: providers post cross-site by design; each handler
 *   verifies the payload signature instead.
 * - requests without a Cookie header: no ambient session, nothing to forge.
 */
export function csrfProtection() {
  const check = csrf({ origin: (origin) => allowedOrigins().includes(origin) });
  return createMiddleware(async (c, next) => {
    const path = c.req.path;
    if (
      path.startsWith('/api/auth/') ||
      path.startsWith('/api/webhooks/') ||
      !c.req.header('cookie')
    ) {
      await next();
      return;
    }
    return check(c, next);
  });
}
