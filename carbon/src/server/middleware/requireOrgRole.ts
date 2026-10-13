import { and, eq } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import { withUserDb } from '../db/client';
import { memberships } from '../db/schema';
import { isUuid } from '../db/values';
import type { HonoVariables } from '../types';

/**
 * Hono middleware factory: gate an organization-scoped billing route behind
 * org membership.
 *
 * The route indicates its target via `type` ('user' | 'organization') and,
 * when organization-scoped, `organizationId`. Reads are GET requests that carry
 * these in the query string; writes are POSTs that carry them in the JSON body
 * (Hono caches the parsed body, so the handler can re-parse it safely).
 *
 * SECURITY: the membership lookup runs under RLS as the caller (`withUserDb`),
 * never through `adminDb`. A caller can only see memberships in organizations
 * they belong to, so this can neither be bypassed nor used to probe arbitrary
 * organizations. When `type !== 'organization'` the guard is inert.
 *
 * Applying this as route middleware (rather than an inline check per handler)
 * ensures no org-scoped billing route can silently skip the membership check.
 */
export function requireOrgRole(roles: string[]) {
  return async (
    c: Context<{ Variables: HonoVariables }>,
    next: Next
  ): Promise<Response | undefined> => {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let type: string | undefined;
    let organizationId: string | undefined;

    if (c.req.method === 'GET') {
      type = c.req.query('type') ?? 'user';
      organizationId = c.req.query('organizationId');
    } else {
      try {
        const body = (await c.req.json()) as {
          type?: string;
          organizationId?: string;
        };
        type = body?.type;
        organizationId = body?.organizationId;
      } catch {
        // Malformed JSON — let the handler's own validation return the 400 so
        // error handling stays in one place. No data is accessed here.
        await next();
        return;
      }
    }

    if (type !== 'organization') {
      await next();
      return;
    }

    if (!organizationId) {
      return c.json({ error: 'Organization ID is required for organization billing' }, 400);
    }

    // A malformed id can match no membership: deny without asking the db.
    const membership = isUuid(organizationId)
      ? await withUserDb(user.id, async (tx) => {
          const [row] = await tx
            .select({ role: memberships.role })
            .from(memberships)
            .where(
              and(eq(memberships.userId, user.id), eq(memberships.organizationId, organizationId))
            )
            .limit(1);
          return row ?? null;
        })
      : null;

    if (!membership?.role || !roles.includes(membership.role)) {
      return c.json({ error: 'You must be an admin to manage organization billing' }, 403);
    }

    await next();
  };
}
