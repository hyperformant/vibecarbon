import { createMiddleware } from 'hono/factory';
import { allowedOrigins } from '../lib/origins';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Paths that answer for their own origin story:
 * - /api/auth/: Better Auth checks the origin of its own endpoints.
 * - /api/webhooks/: providers post cross-site by design; each handler
 *   verifies the payload signature instead.
 * - /api/_internal/: reached through Traefik ForwardAuth and the admin
 *   tools, which relay the tool's own Origin; each route checks the role.
 */
const EXEMPT_PREFIXES = ['/api/auth/', '/api/webhooks/', '/api/_internal/'];

/**
 * CSRF protection for cookie-authenticated API routes.
 *
 * The session is a cookie, so the browser attaches it to a request any site
 * makes. Every mutating request (anything but GET/HEAD/OPTIONS) that carries
 * a Cookie header must prove it comes from one of our origins, whatever its
 * content type:
 *
 * 1. Origin present: it must be in allowedOrigins(). The literal `null`
 *    (sandboxed frames, opaque redirects) is refused.
 * 2. Origin absent: the Referer's origin must be in allowedOrigins().
 * 3. Both absent: only `Sec-Fetch-Site: same-origin` passes.
 *
 * Requests without a Cookie header carry no ambient session and are not
 * checked. A non-browser client that sends a cookie must also send a
 * matching Origin.
 */
export function csrfProtection() {
  return createMiddleware(async (c, next) => {
    const path = c.req.path;
    if (
      SAFE_METHODS.has(c.req.method) ||
      EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
      !c.req.header('cookie')
    ) {
      await next();
      return;
    }
    if (!isFromOurOrigin(c.req.raw.headers)) {
      return c.json({ error: 'Cross-origin request refused' }, 403);
    }
    await next();
  });
}

function isFromOurOrigin(headers: Headers): boolean {
  const allowed = allowedOrigins();
  const origin = headers.get('origin');
  if (origin !== null) {
    return origin !== 'null' && allowed.includes(originOf(origin) ?? '');
  }
  const referer = headers.get('referer');
  if (referer !== null) {
    return allowed.includes(originOf(referer) ?? '');
  }
  return headers.get('sec-fetch-site') === 'same-origin';
}

function originOf(url: string): string | null {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}
