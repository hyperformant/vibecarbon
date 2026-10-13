import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, like, lte, or, sql } from 'drizzle-orm';
import { adminDb } from '../db/client';
import { session as sessionTable, user as userTable, verification } from '../db/schema';

/**
 * The ForwardAuth credential (`vc-admin-token`): a dedicated, short-lived
 * token, never the session token.
 *
 * The cookie is scoped to the parent domain, so the browser sends it to
 * every admin subdomain, and Traefik passes it on to the tools behind them
 * (Grafana, n8n, Metabase, Studio). What those tools can see must be worth
 * little: 32 random bytes that only verify-role accepts, live 1 hour, and
 * die with the session they were minted from (sign-out, revocation, ban).
 * It is useless against the app's own API.
 *
 * Storage: a row in Better Auth's `verification` table, identifier
 * `forwardauth:<sha256 of the token>`, value = the bound session id,
 * expires_at = mint + 1 h. Only the hash is stored, so a database read
 * does not yield a usable token. That table is already server-only (RLS on,
 * no request-role privileges), has exactly the shape needed (identifier,
 * value, expiry), and Better Auth only ever looks rows up by its own
 * identifiers, so the `forwardauth:` prefix cannot collide. A new table
 * would add a migration and a policy for the same three columns.
 */

export const FORWARDAUTH_TTL_SECONDS = 3600;
const PREFIX = 'forwardauth:';

function identifierFor(rawToken: string): string {
  return `${PREFIX}${createHash('sha256').update(rawToken).digest('hex')}`;
}

/**
 * Mint a token bound to `sessionId`, replacing any earlier one for that
 * session, and sweep expired ForwardAuth rows. Returns the raw token (for
 * the cookie only; never log it).
 */
export async function mintForwardAuthToken(sessionId: string): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + FORWARDAUTH_TTL_SECONDS * 1000);
  await adminDb.transaction(async (tx) => {
    await tx
      .delete(verification)
      .where(
        and(
          like(verification.identifier, `${PREFIX}%`),
          or(eq(verification.value, sessionId), lte(verification.expiresAt, new Date()))
        )
      );
    await tx
      .insert(verification)
      .values({ identifier: identifierFor(raw), value: sessionId, expiresAt });
  });
  return raw;
}

/** Forget a token (DELETE /api/v1/admin/forwardauth-cookie). */
export async function revokeForwardAuthToken(rawToken: string): Promise<void> {
  await adminDb.delete(verification).where(eq(verification.identifier, identifierFor(rawToken)));
}

export type ForwardAuthIdentity = {
  user: {
    id: string;
    email: string;
    role: string | null;
    banned: boolean | null;
    banExpires: Date | null;
  };
  session: { id: string; twoFactorVerified: boolean };
};

/**
 * The identity behind a token, read from the database every time: the token
 * row must exist and be unexpired, and its session must still exist and be
 * unexpired. Null otherwise. Role, ban and assurance checks are the
 * caller's (verify-role).
 */
export async function resolveForwardAuthToken(
  rawToken: string
): Promise<ForwardAuthIdentity | null> {
  const now = new Date();
  const [row] = await adminDb
    .select({
      sessionId: sessionTable.id,
      twoFactorVerified: sessionTable.twoFactorVerified,
      userId: userTable.id,
      email: userTable.email,
      role: userTable.role,
      banned: userTable.banned,
      banExpires: userTable.banExpires,
    })
    .from(verification)
    // value is text (the table is shared with Better Auth); session.id is uuid.
    .innerJoin(sessionTable, sql`${sessionTable.id}::text = ${verification.value}`)
    .innerJoin(userTable, eq(userTable.id, sessionTable.userId))
    .where(
      and(
        eq(verification.identifier, identifierFor(rawToken)),
        gt(verification.expiresAt, now),
        gt(sessionTable.expiresAt, now)
      )
    )
    .limit(1);
  if (!row) return null;
  return {
    user: {
      id: row.userId,
      email: row.email,
      role: row.role,
      banned: row.banned,
      banExpires: row.banExpires,
    },
    session: { id: row.sessionId, twoFactorVerified: row.twoFactorVerified },
  };
}
