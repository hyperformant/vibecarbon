import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { adminDb } from '../db/client';
import { session as sessionTable, user as userTable } from '../db/schema';
import { isUuid } from '../db/values';
import { isSuperAdmin } from '../lib/auth';
import { logger } from '../lib/logger';
import { liveSession } from './assurance';

/**
 * Impersonation rules on top of the admin plugin's impersonate-user and
 * stop-impersonating endpoints (the only admin endpoints served over HTTP).
 *
 * Who may start one: a super admin (the plugin's own permission check), from
 * an aal2 session while MFA is globally on (auth/assurance.ts gates every
 * /admin/* path), and only on a regular user:
 * - never themselves (400 CANNOT_IMPERSONATE_SELF);
 * - never another super admin (403 CANNOT_IMPERSONATE_ADMIN). The plugin
 *   refuses that too, because the super_admin role lacks
 *   `impersonate-admins` (auth/index.ts); this check keeps holding if that
 *   grant ever changes;
 * - never from an impersonation session (no nesting).
 *
 * What an impersonation session may do: act as the user in the app, for at
 * most one hour (the plugin's default `impersonationSessionDuration`). It is
 * not the user, so it may not change how the account signs in or read its
 * provider tokens (IMPERSONATION_REFUSED_PATHS, 403
 * IMPERSONATION_NOT_ALLOWED), or touch two-factor (auth/assurance.ts). Every
 * path that could re-issue it as a full-lifetime session is closed:
 * - get-session's sliding refresh may not push its expiry past the hour
 *   (capImpersonationExpiry, a session update hook);
 * - change-password (revokeOtherSessions re-issues the session) and the
 *   two-factor confirm/verify paths are refused outright;
 * - /update-session is not served at all (auth/index.ts).
 *
 * Starts and stops are logged with both ids (the audit trail).
 */

const IMPERSONATE = '/admin/impersonate-user';
const STOP = '/admin/stop-impersonating';

/**
 * Better Auth endpoints an impersonation session may not call: they change
 * how the account signs in (password, email, linked providers), delete it,
 * or hand out the user's own provider tokens.
 */
export const IMPERSONATION_REFUSED_PATHS: ReadonlySet<string> = new Set([
  '/change-password',
  '/change-email',
  '/delete-user',
  '/link-social',
  '/unlink-account',
  '/verify-password',
  '/get-access-token',
  '/refresh-token',
  '/account-info',
  IMPERSONATE,
]);

function refused(): APIError {
  return new APIError('FORBIDDEN', {
    code: 'IMPERSONATION_NOT_ALLOWED',
    message: 'This is not available while impersonating a user.',
  });
}

/** The target's role, or undefined when there is no such user. */
async function targetRole(userId: string): Promise<{ role: string | null } | undefined> {
  const [row] = await adminDb
    .select({ role: userTable.role })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  return row;
}

const before = createAuthMiddleware(async (ctx) => {
  const current = await liveSession(ctx);
  // No session cookie: the endpoint itself answers 401.
  if (!current) return;
  if (current.session.impersonatedBy) throw refused();
  if (ctx.path !== IMPERSONATE) return;

  const userId = (ctx.body as { userId?: unknown } | undefined)?.userId;
  if (!isUuid(userId)) {
    throw new APIError('NOT_FOUND', { code: 'USER_NOT_FOUND', message: 'User not found' });
  }
  if (userId === current.user.id) {
    throw new APIError('BAD_REQUEST', {
      code: 'CANNOT_IMPERSONATE_SELF',
      message: 'You cannot impersonate yourself.',
    });
  }
  const target = await targetRole(userId);
  if (!target) {
    throw new APIError('NOT_FOUND', { code: 'USER_NOT_FOUND', message: 'User not found' });
  }
  if (isSuperAdmin(target)) {
    throw new APIError('FORBIDDEN', {
      code: 'CANNOT_IMPERSONATE_ADMIN',
      message: 'You cannot impersonate another super admin.',
    });
  }
});

/** Audit log of a successful start or stop. */
const after = createAuthMiddleware(async (ctx) => {
  const returned = ctx.context.returned;
  if (isAPIError(returned) || returned === undefined || returned === null) return;
  const body = returned as { session?: { userId?: string; impersonatedBy?: string | null } };
  if (ctx.path === IMPERSONATE) {
    logger.info(
      { adminId: body.session?.impersonatedBy, targetUserId: body.session?.userId },
      'Admin impersonation started'
    );
  } else {
    // The restored admin session; the impersonation it ended was deleted.
    logger.info(
      { adminId: body.session?.userId, endedSessionOf: ctx.context.session?.user?.id },
      'Admin impersonation stopped'
    );
  }
});

type CappedSession = { impersonatedBy?: string | null; expiresAt?: Date | string | null };

/**
 * The session an update is for, when the endpoint context does not carry it:
 * the request's own session cookie names it. Null when there is no request
 * (a server-side call) or no such session.
 */
// biome-ignore lint/suspicious/noExplicitAny: Better Auth's endpoint context
async function sessionOfRequest(ctx: any): Promise<CappedSession | null> {
  if (!ctx?.getSignedCookie || !ctx.context?.authCookies) return null;
  const token = await ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret
  );
  if (typeof token !== 'string' || !token) return null;
  const [row] = await adminDb
    .select({ impersonatedBy: sessionTable.impersonatedBy, expiresAt: sessionTable.expiresAt })
    .from(sessionTable)
    .where(eq(sessionTable.token, token))
    .limit(1);
  return row ?? null;
}

/**
 * Session update hook (databaseHooks.session.update.before): an
 * impersonation session's expiry never moves later. get-session slides a
 * session's expiry forward (to the full session lifetime) when the browser
 * drops the plugin's "don't remember me" cookie, which a client controls.
 * The session being refreshed is the endpoint's `ctx.context.session`; when
 * that is absent, the request's session cookie names it (read from the
 * database), so a refresh path that does not set it is capped too.
 */
export async function capImpersonationExpiry(
  update: { expiresAt?: Date | string | null },
  // biome-ignore lint/suspicious/noExplicitAny: Better Auth's endpoint context
  ctx: any
): Promise<{ data: { expiresAt: Date } } | undefined> {
  if (!update.expiresAt) return;
  const current: CappedSession | null =
    (ctx?.context?.session?.session as CappedSession | undefined) ?? (await sessionOfRequest(ctx));
  if (!current?.impersonatedBy || !current.expiresAt) return;
  const cap = new Date(current.expiresAt);
  if (new Date(update.expiresAt).getTime() <= cap.getTime()) return;
  return { data: { expiresAt: cap } };
}

/**
 * The impersonation rules as a plugin. Register it after sessionAssurance,
 * so an aal1 admin hears "verify a code" before anything about the target.
 */
export const impersonationGuard = () =>
  ({
    id: 'impersonation-guard',
    hooks: {
      before: [
        {
          matcher: (ctx) => IMPERSONATION_REFUSED_PATHS.has(ctx.path ?? ''),
          handler: before,
        },
      ],
      after: [{ matcher: (ctx) => ctx.path === IMPERSONATE || ctx.path === STOP, handler: after }],
    },
  }) satisfies BetterAuthPlugin;
