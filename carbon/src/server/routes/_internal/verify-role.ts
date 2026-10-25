import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { resolveForwardAuthToken } from '../../auth/forwardauth-token';
import { dbErrorForLog } from '../../db/errors';
import { logger } from '../../lib/logger';
import { isMfaGloballyEnabled } from '../../lib/mfa-settings';
import type { HonoVariables } from '../../types';
import { FORWARDAUTH_COOKIE } from '../v1/forwardauth-cookie';

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
 * elevated platform role is `super_admin` (`user.role`); there is no
 * platform `admin` role, so production gates use `?role=super_admin`. The
 * `?roles=a,b` (any-of) form exists for user-defined tiers — if you ever add
 * one, ALWAYS include super_admin so a super admin is never locked out.
 *
 * Usage:
 *   GET /api/_internal/verify-role?role=super_admin
 *   GET /api/_internal/verify-role?roles=editor,super_admin (any of these)
 *
 * Authentication: ONLY the HttpOnly `vc-admin-token` cookie, minted by
 * POST /api/v1/admin/forwardauth-cookie for super admins. It carries a
 * dedicated 1-hour ForwardAuth token (auth/forwardauth-token.ts), never a
 * session token. This route looks the token up by its hash, then the
 * session it is bound to, from the database every time (no cache, no
 * refresh), so an expired or forgotten token, or a signed-out, revoked or
 * banned session, is refused at once. NOT accepted:
 *   - the app's own session cookie (host-only; possession of it must never
 *     gate admin infra, and it is never sent to admin subdomains anyway);
 *   - `Authorization: Bearer` / `X-Forwarded-Access-Token`: no client holds
 *     a session token (it never reaches page JS), so these have no
 *     legitimate sender, and a tool's own API token in them must not be
 *     taken for a session.
 * While MFA is globally on (or its setting is unreadable), the session must have passed two-factor (aal2).
 *
 * Returns:
 *   200 - User authenticated and has required role
 *   401 - Not authenticated, or the session is gone, banned, or aal1 while
 *         MFA is on
 *   403 - Authenticated but missing required role
 *
 * Response headers (on success):
 *   X-User-Id: The authenticated user's ID
 *   X-User-Email: The authenticated user's email
 *   X-User-Role: The user's role (`user.role`)
 *   X-Authenticated-User: The authenticated user's email — consumed by
 *     Grafana's auth-proxy (GF_AUTH_PROXY_HEADER_NAME). Traefik copies this
 *     from the ForwardAuth response onto the upstream request. SECURITY: the
 *     header is only trustworthy because Traefik strips any client-supplied
 *     copy (strip-proxy-headers middleware) before ForwardAuth runs, and
 *     Grafana additionally restricts it to the proxy source IP via
 *     GF_AUTH_PROXY_WHITELIST. See services/observability H-9.
 */

const verifyRoleRoutes = new Hono<{ Variables: HonoVariables }>();

function isBanned(user: { banned?: boolean | null; banExpires?: Date | null }): boolean {
  if (!user.banned) return false;
  return !user.banExpires || new Date(user.banExpires).getTime() > Date.now();
}

verifyRoleRoutes.all('/', async (c) => {
  const requiredRole = c.req.query('role');
  const requiredRolesParam = c.req.query('roles');
  const requiredRoles = requiredRole
    ? [requiredRole]
    : requiredRolesParam
      ? requiredRolesParam
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : [];

  if (requiredRoles.length === 0) {
    logger.warn('verify-role called without role parameter');
    return c.text('Bad Request: role or roles parameter required', 400);
  }

  const token = getCookie(c, FORWARDAUTH_COOKIE) || null;

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
    // From the database every time: a revocation counts at once, and the
    // session is never extended from here.
    const data = await resolveForwardAuthToken(token);

    if (!data || isBanned(data.user)) {
      logger.debug('verify-role: Invalid or ended session');
      return c.text('Unauthorized', 401);
    }

    const { user, session } = data;
    if (session.twoFactorVerified !== true && (await isMfaGloballyEnabled()) !== false) {
      logger.info({ userId: user.id }, 'verify-role: session has not passed two-factor');
      return c.text('Unauthorized', 401);
    }

    const userRole = user.role ?? '';
    const hasRequiredRole = requiredRoles.includes(userRole);

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
    c.header('X-User-Role', userRole);
    // Grafana auth-proxy identity header (GF_AUTH_PROXY_HEADER_NAME). Grafana
    // auto-provisions/logs in the user named here, so it must be the verified
    // email — never a client-controlled value. Only reaches Grafana via
    // Traefik's authResponseHeaders after strip-proxy-headers clears any spoof.
    c.header('X-Authenticated-User', user.email || '');

    logger.debug({ userId: user.id, userRole }, 'verify-role: Access granted');
    return c.text('OK', 200);
  } catch (err) {
    logger.error({ err: dbErrorForLog(err) }, 'verify-role: Unexpected error');
    return c.text('Internal Server Error', 500);
  }
});

export { verifyRoleRoutes };
