import type { SupabaseClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { z } from 'zod';
import { sendEmail } from '../../lib/email';
import { env } from '../../lib/env';
import { sanitizeError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { createRateLimiter } from '../../lib/rate-limiter';
import { supabaseAdmin } from '../../lib/supabase';
import type { HonoVariables } from '../../types';

// biome-ignore lint/suspicious/noExplicitAny: Tables not yet in generated Database types
const adminDb = supabaseAdmin as SupabaseClient<any>;

const newsletterRoutes = new Hono<{ Variables: HonoVariables }>();

// Rate limiting for subscribe (10 per 15 minutes per IP)
newsletterRoutes.use('/subscribe', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 }));

const subscribeSchema = z.object({
  email: z.string().email('Valid email is required').max(200),
  name: z.string().max(200).optional(),
});

/**
 * Subscribe to newsletter (public, rate-limited)
 * Uses double opt-in: sends confirmation email with token.
 */
newsletterRoutes.post('/subscribe', async (c) => {
  let body: z.infer<typeof subscribeSchema>;
  try {
    const rawBody = await c.req.json();
    const result = subscribeSchema.safeParse(rawBody);
    if (!result.success) {
      return c.json({ error: result.error.issues.map((e) => e.message).join(', ') }, 400);
    }
    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    // Check if already subscribed
    const { data: existing } = await adminDb
      .from('newsletter_subscribers')
      .select('id, status')
      .eq('email', body.email)
      .maybeSingle();

    if (existing?.status === 'active') {
      // Already subscribed — don't reveal this to prevent email enumeration
      return c.json({ success: true, message: 'Check your email to confirm your subscription.' });
    }

    if (existing?.status === 'pending') {
      // Resend confirmation
      return c.json({ success: true, message: 'Check your email to confirm your subscription.' });
    }

    // Insert or update (if previously unsubscribed)
    const { data: subscriber, error: insertError } = await adminDb
      .from('newsletter_subscribers')
      .upsert(
        {
          email: body.email,
          name: body.name || null,
          status: 'pending',
          confirmation_token: crypto.randomUUID(),
          unsubscribed_at: null,
        },
        { onConflict: 'email' }
      )
      .select('confirmation_token')
      .single();

    if (insertError) {
      logger.error({ error: insertError }, 'Failed to create newsletter subscriber');
      return c.json({ error: sanitizeError(insertError, 'Failed to subscribe') }, 500);
    }

    // Send confirmation email (double opt-in)
    const baseUrl = env.SITE_URL || 'http://localhost:5173';
    const confirmUrl = `${baseUrl}/api/v1/newsletter/confirm?token=${subscriber.confirmation_token}`;

    sendEmail({
      to: body.email,
      subject: 'Confirm your newsletter subscription',
      html: `<h2>Confirm Your Subscription</h2>
<p>Click the link below to confirm your newsletter subscription:</p>
<p style="text-align: center; margin: 24px 0;">
  <a href="${confirmUrl}" style="display: inline-block; padding: 10px 24px; background: #18181b; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">Confirm Subscription</a>
</p>
<p style="font-size: 12px; color: #71717a;">If you didn't request this, you can safely ignore this email.</p>`,
    }).catch((err) => {
      logger.error({ error: err }, 'Failed to send newsletter confirmation email');
    });

    return c.json({ success: true, message: 'Check your email to confirm your subscription.' });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to subscribe') }, 500);
  }
});

/**
 * Confirm newsletter subscription (via email link)
 */
newsletterRoutes.get('/confirm', async (c) => {
  const token = c.req.query('token');

  if (!token) {
    return c.json({ error: 'Missing confirmation token' }, 400);
  }

  try {
    // NOTE: confirmation_token is intentionally NOT cleared here — it doubles as
    // the per-subscriber unsubscribe secret (see the unsubscribe route below).
    // Re-confirmation is already prevented by the `status = 'pending'` filter.
    const { data, error } = await adminDb
      .from('newsletter_subscribers')
      .update({
        status: 'active',
        subscribed_at: new Date().toISOString(),
      })
      .eq('confirmation_token', token)
      .eq('status', 'pending')
      .select('email')
      .maybeSingle();

    if (error) {
      return c.json({ error: sanitizeError(error, 'Failed to confirm') }, 500);
    }

    if (!data) {
      return c.json({ error: 'Invalid or expired confirmation link' }, 400);
    }

    // Redirect to homepage with success
    const baseUrl = env.SITE_URL || 'http://localhost:5173';
    return c.redirect(`${baseUrl}/?newsletter=confirmed`);
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to confirm') }, 500);
  }
});

/**
 * Unsubscribe from newsletter (via email link)
 */
newsletterRoutes.get('/unsubscribe', async (c) => {
  const email = c.req.query('email');
  const token = c.req.query('token');

  // SECURITY: require the per-subscriber token (confirmation_token) so a caller
  // can't unsubscribe an arbitrary address by guessing/knowing only the email.
  // The token was matched against the wrong column (`id`) before, and was
  // optional — either flaw let anyone unsubscribe anyone.
  if (!email || !token) {
    return c.json({ error: 'Missing email or unsubscribe token' }, 400);
  }

  try {
    const { data, error } = await adminDb
      .from('newsletter_subscribers')
      .update({
        status: 'unsubscribed',
        unsubscribed_at: new Date().toISOString(),
      })
      .eq('email', email)
      .eq('confirmation_token', token)
      .select('id')
      .maybeSingle();

    if (error) {
      return c.json({ error: sanitizeError(error, 'Failed to unsubscribe') }, 500);
    }

    if (!data) {
      return c.json({ error: 'Invalid unsubscribe link' }, 400);
    }

    const baseUrl = env.SITE_URL || 'http://localhost:5173';
    return c.redirect(`${baseUrl}/?newsletter=unsubscribed`);
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to unsubscribe') }, 500);
  }
});

export { newsletterRoutes };
