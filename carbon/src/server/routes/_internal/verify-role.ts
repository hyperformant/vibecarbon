import { Hono } from 'hono';
import { logger } from '../../lib/logger';
import { supabaseAdmin } from '../../lib/supabase';

/**
 * Validate and sanitize the SITE_URL for redirect.
 * Prevents open redirect vulnerabilities by ensuring the URL is well-formed
 * and has a valid protocol.
 */
function getValidatedSiteUrl(): string {
  const siteUrl = process.env.SITE_URL || 'http://localhost:5173';

  try {
    const url = new URL(siteUrl);
    // Only allow http and https protocols
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      logger.warn({ siteUrl }, 'Invalid SITE_URL protocol, falling back to localhost');
      return 'http://localhost:5173';
    }
    return url.origin;
  } catch {
    logger.warn({ siteUrl }, 'Invalid SITE_URL format, falling back to localhost');
    return 'http://localhost:5173';
  }
}

/**
 * Internal endpoint for Traefik ForwardAuth middleware. NOT publicly
 * reachable — Traefik denies /api/_internal/verify-role on the public
 * entrypoint (internal-only middleware) and calls it over the internal
 * network; do not build client flows against it.
 *
 * Verifies that the user is authenticated and has the required role. The only
 * elevated platform role is `super_admin` (app_metadata.role); there is no
 * platform `admin` role, so production gates use `?role=super_admin`. The
 * `?roles=a,b` (any-of) form exists for user-defined tiers — if you ever add
 * one, ALWAYS include super_admin so a super admin is never locked out.
 *
 * Usage:
 *   GET /api/_internal/verify-role?role=super_admin
 *   GET /api/_internal/verify-role?roles=editor,super_admin (any of these)
 *
 * Authentication:
 *   - Reads JWT from Authorization header (Bearer token)
 *   - Or from the HttpOnly vc-admin-token cookie (browser sessions — minted
 *     by POST /api/v1/admin/forwardauth-cookie; the SPA's sb-auth-token
 *     session cookie is deliberately NOT accepted)
 *   - Or from X-Forwarded-Access-Token header (set by Traefik)
 *
 * Returns:
 *   200 - User authenticated and has required role
 *   401 - Not authenticated or invalid token
 *   403 - Authenticated but missing required role
 *
 * Response headers (on success):
 *   X-User-Id: The authenticated user's ID
 *   X-User-Email: The authenticated user's email
 *   X-User-Role: The user's role from app_metadata
 *   X-Authenticated-User: The authenticated user's email — consumed by
 *     Grafana's auth-proxy (GF_AUTH_PROXY_HEADER_NAME). Traefik copies this
 *     from the ForwardAuth response onto the upstream request. SECURITY: the
 *     header is only trustworthy because Traefik strips any client-supplied
 *     copy (strip-proxy-headers middleware) before ForwardAuth runs, and
 *     Grafana additionally restricts it to the proxy source IP via
 *     GF_AUTH_PROXY_WHITELIST. See services/observability H-9.
 */

import type { HonoVariables } from '../../types';

const verifyRoleRoutes = new Hono<{ Variables: HonoVariables }>();

// Helper to extract JWT from various sources
function extractToken(req: Request, cookieHeader: string | undefined): string | null {
  // 1. Check Authorization header
  const authHeader = req.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 2. Check X-Forwarded-Access-Token (set by Traefik ForwardAuth)
  const forwardedToken = req.headers.get('X-Forwarded-Access-Token');
  if (forwardedToken) {
    return forwardedToken;
  }

  // 3. Check cookies for Supabase auth token
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').reduce(
      (acc, cookie) => {
        const [key, value] = cookie.trim().split('=');
        if (key && value) {
          acc[key] = value;
        }
        return acc;
      },
      {} as Record<string, string>
    );

    // ONLY the dedicated ForwardAuth cookie is accepted. The SPA session
    // cookie (sb-auth-token) is deliberately NOT a credential here: it is
    // apex-host-only, JS-readable, and possession of it must not gate admin
    // infra. vc-admin-token is HttpOnly and carries the raw access token
    // (minted by POST /api/v1/admin/forwardauth-cookie for super_admins).
    const adminToken = cookies['vc-admin-token'];
    if (adminToken) {
      return decodeURIComponent(adminToken);
    }
  }

  return null;
}

verifyRoleRoutes.all('/', async (c) => {
  const requiredRole = c.req.query('role');
  const requiredRolesParam = c.req.query('roles');
  const requiredRoles = requiredRole
    ? [requiredRole]
    : requiredRolesParam
      ? requiredRolesParam.split(',').map((r) => r.trim())
      : [];

  if (requiredRoles.length === 0) {
    logger.warn('verify-role called without role parameter');
    return c.text('Bad Request: role or roles parameter required', 400);
  }

  // Extract token from request
  const token = extractToken(c.req.raw, c.req.header('Cookie'));

  if (!token) {
    logger.debug('verify-role: No token found');

    // For browser requests, redirect to login page with full return URL
    // so the user is sent back to the original service (e.g., n8n.localhost)
    const acceptHeader = c.req.header('Accept') || '';
    if (acceptHeader.includes('text/html')) {
      const forwardedProto = c.req.header('X-Forwarded-Proto') || 'http';
      const forwardedHost = c.req.header('X-Forwarded-Host');
      const forwardedUri = c.req.header('X-Forwarded-Uri') || '/';

      // Build full return URL from Traefik's forwarded headers
      const returnUrl = forwardedHost
        ? `${forwardedProto}://${forwardedHost}${forwardedUri}`
        : forwardedUri;

      const siteUrl = getValidatedSiteUrl();
      return c.redirect(`${siteUrl}/login?redirect=${encodeURIComponent(returnUrl)}`);
    }

    return c.text('Unauthorized', 401);
  }

  try {
    // Verify the JWT and get user info using Supabase Admin
    const {
      data: { user },
      error,
    } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      logger.debug({ error: error?.message }, 'verify-role: Invalid token');
      return c.text('Unauthorized', 401);
    }

    // Check user's role in app_metadata
    const userRole = user.app_metadata?.role as string | undefined;
    const hasRequiredRole = requiredRoles.includes(userRole || '');

    if (!hasRequiredRole) {
      logger.info(
        { userId: user.id, userRole, requiredRoles },
        'verify-role: User lacks required role'
      );
      return c.text('Forbidden', 403);
    }

    // Success - set headers for downstream services
    c.header('X-User-Id', user.id);
    c.header('X-User-Email', user.email || '');
    c.header('X-User-Role', userRole || '');
    // Grafana auth-proxy identity header (GF_AUTH_PROXY_HEADER_NAME). Grafana
    // auto-provisions/logs in the user named here, so it must be the verified
    // email — never a client-controlled value. Only reaches Grafana via
    // Traefik's authResponseHeaders after strip-proxy-headers clears any spoof.
    c.header('X-Authenticated-User', user.email || '');

    logger.debug({ userId: user.id, userRole }, 'verify-role: Access granted');
    return c.text('OK', 200);
  } catch (err) {
    logger.error({ error: err }, 'verify-role: Unexpected error');
    return c.text('Internal Server Error', 500);
  }
});

export { verifyRoleRoutes };
