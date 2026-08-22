import type { SupabaseClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { z } from 'zod';
import { isSuperAdmin } from '../../lib/auth';
import { getClientIp } from '../../lib/client-ip';
import { env } from '../../lib/env';
import { sanitizeError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { createRateLimiter } from '../../lib/rate-limiter';
import { createAuthClient, supabaseAdmin } from '../../lib/supabase';
import type { HonoVariables } from '../../types';

// Helper to access tables not yet in generated types
// biome-ignore lint/suspicious/noExplicitAny: Tables not yet in generated Database types
const adminDb = supabaseAdmin as SupabaseClient<any>;

const authRoutes = new Hono<{ Variables: HonoVariables }>();

// Strict per-IP limiter on login, on top of the app-wide 100/min and the
// per-(email,ip) DB lockout. The lockout is per-email, so without this an
// attacker gets 100 req/min/IP of CROSS-email credential stuffing (a fresh
// lockout bucket per email). 10/15min/IP closes the stuffing + GoTrue-load gap
// without letting an attacker lock a victim out on the victim's own IP.
authRoutes.use('/login', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 }));

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const loginSchema = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(1, 'Password is required'),
});

const unlockAccountSchema = z.object({
  email: z.string().email('Valid email is required'),
});

const updateSettingsSchema = z.object({
  mfa_enabled: z.boolean().optional(),
  user_docs_enabled: z.boolean().optional(),
  api_docs_enabled: z.boolean().optional(),
});

// ============================================================================
// LOGIN ENDPOINT (consolidated lockout + auth)
// ============================================================================

/**
 * Login with email/password
 * Handles lockout checking, authentication, and lockout recording in a single request
 */
authRoutes.post('/login', async (c) => {
  let body: z.infer<typeof loginSchema>;
  try {
    const rawBody = await c.req.json();
    const result = loginSchema.safeParse(rawBody);

    if (!result.success) {
      const errors = result.error.issues.map((e: { message: string }) => e.message).join(', ');
      return c.json({ error: errors }, 400);
    }

    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const ipAddress = getClientIp(c);
  const email = body.email.toLowerCase();

  try {
    // Step 1: Check if account is locked
    const { data: lockoutData, error: lockoutError } = await adminDb.rpc('check_account_lockout', {
      p_email: email,
      p_ip_address: ipAddress,
    });

    if (lockoutError) {
      logger.error({ error: lockoutError }, 'Failed to check lockout status');
      // Continue with login attempt even if lockout check fails
    } else if (lockoutData?.locked) {
      return c.json(
        {
          error: `Account temporarily locked due to too many failed attempts. Please try again in ${lockoutData.remaining_minutes} minute${lockoutData.remaining_minutes === 1 ? '' : 's'}.`,
          locked: true,
          remainingMinutes: lockoutData.remaining_minutes,
        },
        429
      );
    }

    // Step 2: Attempt login via fresh auth client
    // Uses a disposable client to avoid contaminating supabaseAdmin's session state
    const authClient = createAuthClient();
    const { data: authData, error: authError } = await authClient.auth.signInWithPassword({
      email,
      password: body.password,
    });

    if (authError || !authData.session) {
      // Step 3a: Record failed attempt
      try {
        await adminDb.rpc('record_failed_login', {
          p_email: email,
          p_ip_address: ipAddress,
        });
        logger.warn({ email, ip: ipAddress }, 'Failed login attempt recorded');
      } catch (recordError) {
        logger.error({ error: recordError }, 'Failed to record login attempt');
      }

      // SECURITY: return a single generic message regardless of the underlying
      // auth error so responses can't be used to enumerate which emails exist
      // or distinguish "wrong password" from "no such user".
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    // Step 3b: Clear failed attempts on success
    try {
      await adminDb.rpc('clear_failed_logins', {
        p_email: email,
        p_ip_address: ipAddress,
      });
    } catch (clearError) {
      logger.error({ error: clearError }, 'Failed to clear lockout records');
    }

    // Return session data for client to use
    return c.json({
      session: {
        access_token: authData.session.access_token,
        refresh_token: authData.session.refresh_token,
        expires_in: authData.session.expires_in,
        expires_at: authData.session.expires_at,
        token_type: authData.session.token_type,
      },
      user: {
        id: authData.user.id,
        email: authData.user.email,
        app_metadata: authData.user.app_metadata,
        user_metadata: authData.user.user_metadata,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Login error');
    return c.json({ error: sanitizeError(error, 'Login failed') }, 500);
  }
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

  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }

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
    const { error } = await adminDb.rpc('admin_unlock_account', {
      p_email: body.email.toLowerCase(),
    });

    if (error) {
      throw error;
    }

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

  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }

  try {
    const { data, error } = await adminDb.rpc('get_locked_accounts');

    if (error) {
      throw error;
    }

    return c.json({
      lockedAccounts: (data || []).map(
        (account: {
          email: string;
          attempt_count: number;
          first_attempt: string;
          last_attempt: string;
        }) => ({
          email: account.email,
          attemptCount: account.attempt_count,
          firstAttempt: account.first_attempt,
          lastAttempt: account.last_attempt,
        })
      ),
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
    const { data, error } = await adminDb
      .from('app_settings')
      .select('key, value')
      .in('key', ['mfa_enabled', 'user_docs_enabled', 'api_docs_enabled']);

    // If table doesn't exist or query fails, return defaults
    if (error) {
      logger.debug({ error: error.message }, 'app_settings query failed, using defaults');
    }

    // Convert to object
    const settings: Record<string, unknown> = {};
    for (const row of data || []) {
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
          google: env.GOOGLE_ENABLED,
          microsoft: env.MICROSOFT_ENABLED,
          github: env.GITHUB_ENABLED,
          apple: env.APPLE_ENABLED,
          discord: env.DISCORD_ENABLED,
        },
        magicLinkEnabled: env.MAGIC_LINK_ENABLED,
      },
    });
  } catch (error) {
    // Return defaults on any error
    logger.debug({ error }, 'app_settings fetch failed, using defaults');
    return c.json({
      settings: {
        mfaEnabled: false,
        userDocsEnabled: true,
        apiDocsEnabled: true,
        providers: {
          google: env.GOOGLE_ENABLED,
          microsoft: env.MICROSOFT_ENABLED,
          github: env.GITHUB_ENABLED,
          apple: env.APPLE_ENABLED,
          discord: env.DISCORD_ENABLED,
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

  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }

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
      const { error } = await adminDb.from('app_settings').upsert({
        key: 'mfa_enabled',
        value: { enabled: body.mfa_enabled },
        updated_by: user.id,
      });

      if (error) {
        throw error;
      }

      logger.info({ mfaEnabled: body.mfa_enabled, updatedBy: user.id }, 'MFA setting updated');
    }

    if (body.user_docs_enabled !== undefined) {
      const { error } = await adminDb.from('app_settings').upsert({
        key: 'user_docs_enabled',
        value: { enabled: body.user_docs_enabled },
        updated_by: user.id,
      });

      if (error) {
        throw error;
      }

      logger.info(
        { userDocsEnabled: body.user_docs_enabled, updatedBy: user.id },
        'User docs setting updated'
      );
    }

    if (body.api_docs_enabled !== undefined) {
      const { error } = await adminDb.from('app_settings').upsert({
        key: 'api_docs_enabled',
        value: { enabled: body.api_docs_enabled },
        updated_by: user.id,
      });

      if (error) {
        throw error;
      }

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
