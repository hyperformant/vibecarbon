import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { isSuperAdmin } from '../../lib/auth';
import { logger } from '../../lib/logger';
import { signCookiePayload, verifyCookiePayload } from '../../lib/signed-cookie';
import { refreshUserSession, supabaseAdmin } from '../../lib/supabase';
import { requireAal2 } from '../../middleware/requireAal2';
import type { HonoVariables } from '../../types';

type RestorePayload = {
  refreshToken: string;
  adminId: string;
  adminEmail: string;
  startedAt: number;
};

/**
 * ADMIN IMPERSONATION (Super Admin only) — server-side session swap.
 *
 * SECURITY: the admin's refresh token is parked in the HttpOnly
 * vc-impersonation-restore cookie — never in localStorage or anywhere else
 * JS can read (spec 2026-07-24-session-cookie-split). The cookie is
 * path-scoped to these endpoints (the browser sends it nowhere else),
 * SameSite=Strict, and Max-Age is the hard impersonation window: past 1 hour
 * restore fails closed and the operator re-authenticates.
 */
export const RESTORE_COOKIE = 'vc-impersonation-restore';

function restoreCookieOpts() {
  const siteUrl = process.env.SITE_URL || 'http://localhost:5173';
  return {
    httpOnly: true,
    secure: siteUrl.startsWith('https:'),
    sameSite: 'Strict' as const,
    path: '/api/v1/admin/impersonate',
    maxAge: 3600,
  };
}

const impersonationRoutes = new Hono<{ Variables: HonoVariables }>();

// SECURITY: impersonation mints a login link for another user — the highest-
// impact admin action here — so it is gated behind aal2 (step-up MFA) in
// addition to the super_admin check, when MFA is globally enabled.
// NOTE: registered before /:userId so "stop" is never treated as a user id.
impersonationRoutes.post('/stop', async (c) => {
  const raw = getCookie(c, RESTORE_COOKIE);
  deleteCookie(c, RESTORE_COOKIE, restoreCookieOpts());
  if (!raw) {
    return c.json({ error: 'No impersonation to stop' }, 401);
  }

  // Reject a forged/tossed cookie: the signature must match a value this
  // server minted (see signed-cookie.ts). Null on any tampering → fail closed.
  const parked = verifyCookiePayload<RestorePayload>(raw);
  if (!parked) {
    logger.warn('Admin impersonation stop: restore cookie failed signature verification');
    return c.json({ error: 'Invalid restore state' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  if (body.discard === true) {
    logger.info({ adminId: parked.adminId }, 'Admin impersonation discarded (sign-out)');
    return c.body(null, 204);
  }

  const { data, error } = await refreshUserSession(parked.refreshToken);
  if (error || !data.session) {
    logger.warn(
      { adminId: parked.adminId, error: error?.message },
      'Admin impersonation stop: restore refresh failed'
    );
    return c.json({ error: 'Restore session expired; sign in again' }, 401);
  }

  logger.info(
    {
      adminId: parked.adminId,
      adminEmail: parked.adminEmail,
      durationMs: Date.now() - parked.startedAt,
    },
    'Admin impersonation stopped'
  );

  return c.json({
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    },
  });
});

impersonationRoutes.post('/:userId', requireAal2, async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }

  // Fail closed: adminEmail is signed into the restore cookie (RestorePayload)
  // and must be a string. An admin session without an email can't safely mint
  // a restorable impersonation, so reject before any state is created.
  if (!user.email) {
    return c.json({ error: 'Admin account has no email address' }, 400);
  }

  const targetUserId = c.req.param('userId');

  if (!targetUserId) {
    return c.json({ error: 'User ID is required' }, 400);
  }

  if (targetUserId === user.id) {
    return c.json({ error: 'Cannot impersonate yourself' }, 400);
  }

  // The client hands over its refresh token ONCE, over TLS; it comes back only
  // as the HttpOnly restore cookie below.
  const body = await c.req.json().catch(() => ({}));
  const adminRefreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : null;
  if (!adminRefreshToken) {
    return c.json({ error: 'refreshToken is required' }, 400);
  }

  const { data: targetUserData, error: userError } =
    await supabaseAdmin.auth.admin.getUserById(targetUserId);

  if (userError || !targetUserData.user) {
    return c.json({ error: 'User not found' }, 404);
  }

  const targetUser = targetUserData.user;

  if (targetUser.app_metadata?.role === 'super_admin') {
    return c.json({ error: 'Cannot impersonate another super admin' }, 403);
  }

  if (!targetUser.email) {
    return c.json({ error: 'User has no email address' }, 400);
  }

  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: targetUser.email,
  });

  if (linkError || !linkData) {
    logger.error({ error: linkError }, 'Failed to generate impersonation link');
    return c.json({ error: 'Failed to generate impersonation session' }, 500);
  }

  setCookie(
    c,
    RESTORE_COOKIE,
    // HMAC-signed so a cookie tossed from a compromised subdomain can't forge
    // the restore token or the audit record (see signed-cookie.ts).
    signCookiePayload({
      refreshToken: adminRefreshToken,
      adminId: user.id,
      adminEmail: user.email,
      startedAt: Date.now(),
    } satisfies RestorePayload),
    restoreCookieOpts()
  );

  logger.info(
    { adminId: user.id, adminEmail: user.email, targetUserId, targetEmail: targetUser.email },
    'Admin impersonation started'
  );

  return c.json({
    tokenHash: linkData.properties.hashed_token,
    user: {
      id: targetUser.id,
      email: targetUser.email,
      name: targetUser.user_metadata?.full_name || targetUser.user_metadata?.name || null,
    },
  });
});

export { impersonationRoutes };
