import { Hono } from 'hono';
import { z } from 'zod';
import { isBillingConfigured } from '../../billing';
import { isSuperAdmin } from '../../lib/auth';
import { isEmailConfigured } from '../../lib/email';
import { env } from '../../lib/env';
import { logger } from '../../lib/logger';
import { supabaseAdmin } from '../../lib/supabase';
import type { HonoVariables } from '../../types';

/**
 * Super-admin setup progress.
 *
 * GET reports which runtime-detectable `configure` features are set plus a
 * persisted "launching without charging" opt-out; the client turns these into
 * a completion percentage (see client/lib/setup-progress.ts). PATCH persists
 * the opt-out in app_settings alongside the theme.
 */
const setupRoutes = new Hono<{ Variables: HonoVariables }>();

const BILLING_OPT_OUT_KEY = 'billing_opt_out';

async function readBillingOptOut(): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('app_settings')
    .select('value')
    .eq('key', BILLING_OPT_OUT_KEY)
    .single();
  return (data?.value as { optedOut?: boolean } | null)?.optedOut === true;
}

function analyticsConfigured(): boolean {
  const domain = process.env.VITE_PLAUSIBLE_DOMAIN;
  // In dev the index.html placeholder can arrive unreplaced as "%VITE_...%".
  return !!domain && !domain.startsWith('%');
}

setupRoutes.get('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!isSuperAdmin(user)) return c.json({ error: 'Super admin access required' }, 403);

  const billingOptOut = await readBillingOptOut().catch(() => false);

  return c.json({
    email: isEmailConfigured(),
    payments: isBillingConfigured(),
    oauth: Boolean(env.GOOGLE_ENABLED || env.MICROSOFT_ENABLED),
    analytics: analyticsConfigured(),
    deployed: env.NODE_ENV === 'production',
    billingOptOut,
  });
});

const patchSchema = z.object({ billingOptOut: z.boolean() });

setupRoutes.patch('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!isSuperAdmin(user)) return c.json({ error: 'Super admin access required' }, 403);

  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);

  const { error } = await supabaseAdmin.from('app_settings').upsert(
    {
      key: BILLING_OPT_OUT_KEY,
      value: { optedOut: parsed.data.billingOptOut },
      updated_by: user.id,
    },
    { onConflict: 'key' }
  );

  if (error) {
    logger.error({ error, userId: user.id }, 'Failed to save billing opt-out');
    return c.json({ error: 'Failed to save setting' }, 500);
  }

  return c.json({ success: true, billingOptOut: parsed.data.billingOptOut });
});

export { setupRoutes };
