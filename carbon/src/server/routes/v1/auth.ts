import { inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { socialProviders } from '../../auth/providers';
import { adminDb } from '../../db/client';
import { dbErrorForLog } from '../../db/errors';
import { appSettings } from '../../db/schema';
import { isoTimestamp } from '../../db/values';
import { env } from '../../lib/env';
import { sanitizeError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { checkSuperAdmin } from '../../middleware/requireSuperAdmin';
import type { HonoVariables } from '../../types';

/**
 * Upsert one app_settings flag as `{ enabled }`, stamped with the admin who set it.
 */
async function setFlag(key: string, enabled: boolean, updatedBy: string): Promise<void> {
  await adminDb
    .insert(appSettings)
    .values({ key, value: { enabled }, updatedBy })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: { enabled }, updatedBy } });
}

/**
 * App settings and the account-lockout admin tools. Sign-in itself is the
 * in-process auth API at /api/auth (server/auth/), whose lockout plugin
 * (auth/lockout.ts) records and clears the failures these endpoints list
 * and unlock.
 */
const authRoutes = new Hono<{ Variables: HonoVariables }>();

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const unlockAccountSchema = z.object({
  email: z.string().email('Valid email is required'),
});

const updateSettingsSchema = z.object({
  mfa_enabled: z.boolean().optional(),
  user_docs_enabled: z.boolean().optional(),
  api_docs_enabled: z.boolean().optional(),
});

// ============================================================================
// ADMIN ENDPOINTS (Super Admin only)
// ============================================================================

/**
 * Manually unlock an account (super admin only)
 */
authRoutes.post('/admin/unlock-account', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const blocked = await checkSuperAdmin(c);
  if (blocked) return blocked;

  let body: z.infer<typeof unlockAccountSchema>;
  try {
    const rawBody = await c.req.json();
    const result = unlockAccountSchema.safeParse(rawBody);

    if (!result.success) {
      const errors = result.error.issues.map((e: { message: string }) => e.message).join(', ');
      return c.json({ error: errors }, 400);
    }

    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    await adminDb.execute(sql`select admin_unlock_account(${body.email.toLowerCase()})`);

    logger.info({ email: body.email, unlockedBy: user.id }, 'Account unlocked by admin');

    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to unlock account') }, 500);
  }
});

/**
 * Get list of currently locked accounts (super admin only)
 */
authRoutes.get('/admin/locked-accounts', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const blocked = await checkSuperAdmin(c);
  if (blocked) return blocked;

  try {
    const { rows } = await adminDb.execute<{
      email: string;
      attempt_count: string | number;
      first_attempt: string;
      last_attempt: string;
    }>(sql`select email, attempt_count, first_attempt, last_attempt from get_locked_accounts()`);

    return c.json({
      lockedAccounts: rows.map((account) => ({
        email: account.email,
        // count(*) is a bigint, which the driver returns as text.
        attemptCount: Number(account.attempt_count),
        firstAttempt: isoTimestamp(String(account.first_attempt)),
        lastAttempt: isoTimestamp(String(account.last_attempt)),
      })),
    });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch locked accounts') }, 500);
  }
});

// ============================================================================
// APP SETTINGS ENDPOINTS
// ============================================================================

/**
 * Get app settings (public - for checking MFA requirement)
 */
authRoutes.get('/settings', async (c) => {
  try {
    // If the table doesn't exist or the query fails, return defaults
    let rows: { key: string; value: unknown }[] = [];
    try {
      rows = await adminDb
        .select({ key: appSettings.key, value: appSettings.value })
        .from(appSettings)
        .where(inArray(appSettings.key, ['mfa_enabled', 'user_docs_enabled', 'api_docs_enabled']));
    } catch (error) {
      logger.debug({ err: dbErrorForLog(error) }, 'app_settings query failed, using defaults');
    }

    // Convert to object
    const settings: Record<string, unknown> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }

    return c.json({
      settings: {
        mfaEnabled: (settings.mfa_enabled as { enabled?: boolean } | undefined)?.enabled ?? false,
        userDocsEnabled:
          (settings.user_docs_enabled as { enabled?: boolean } | undefined)?.enabled ?? true,
        apiDocsEnabled:
          (settings.api_docs_enabled as { enabled?: boolean } | undefined)?.enabled ?? true,
        providers: {
          google: socialProviders.google,
          microsoft: socialProviders.microsoft,
        },
        magicLinkEnabled: env.MAGIC_LINK_ENABLED,
      },
    });
  } catch (error) {
    // Return defaults on any error
    logger.debug({ err: dbErrorForLog(error) }, 'app_settings fetch failed, using defaults');
    return c.json({
      settings: {
        mfaEnabled: false,
        userDocsEnabled: true,
        apiDocsEnabled: true,
        providers: {
          google: socialProviders.google,
          microsoft: socialProviders.microsoft,
        },
        magicLinkEnabled: env.MAGIC_LINK_ENABLED,
      },
    });
  }
});

/**
 * Update app settings (super admin only)
 */
authRoutes.patch('/admin/settings', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const blocked = await checkSuperAdmin(c);
  if (blocked) return blocked;

  let body: z.infer<typeof updateSettingsSchema>;
  try {
    const rawBody = await c.req.json();
    const result = updateSettingsSchema.safeParse(rawBody);

    if (!result.success) {
      const errors = result.error.issues.map((e: { message: string }) => e.message).join(', ');
      return c.json({ error: errors }, 400);
    }

    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    // Update MFA setting if provided
    if (body.mfa_enabled !== undefined) {
      await setFlag('mfa_enabled', body.mfa_enabled, user.id);

      logger.info({ mfaEnabled: body.mfa_enabled, updatedBy: user.id }, 'MFA setting updated');
    }

    if (body.user_docs_enabled !== undefined) {
      await setFlag('user_docs_enabled', body.user_docs_enabled, user.id);

      logger.info(
        { userDocsEnabled: body.user_docs_enabled, updatedBy: user.id },
        'User docs setting updated'
      );
    }

    if (body.api_docs_enabled !== undefined) {
      await setFlag('api_docs_enabled', body.api_docs_enabled, user.id);

      logger.info(
        { apiDocsEnabled: body.api_docs_enabled, updatedBy: user.id },
        'API docs setting updated'
      );
    }

    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to update settings') }, 500);
  }
});

export { authRoutes };
