import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { adminDb } from '../../db/client';
import { dbErrorForLog } from '../../db/errors';
import { newsletterSubscribers } from '../../db/schema';
import { isUuid } from '../../db/values';
import { sendEmail } from '../../lib/email';
import { env } from '../../lib/env';
import { sanitizeError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { createRateLimiter } from '../../lib/rate-limiter';
import type { HonoVariables } from '../../types';

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
    const [existing] = await adminDb
      .select({ id: newsletterSubscribers.id, status: newsletterSubscribers.status })
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, body.email))
      .limit(1);

    if (existing?.status === 'active') {
      // Already subscribed — don't reveal this to prevent email enumeration
      return c.json({ success: true, message: 'Check your email to confirm your subscription.' });
    }

    if (existing?.status === 'pending') {
      // Resend confirmation
      return c.json({ success: true, message: 'Check your email to confirm your subscription.' });
    }

    // Insert or update (if previously unsubscribed)
    let confirmationToken: string | null;
    try {
      const changes = {
        name: body.name || null,
        status: 'pending',
        confirmationToken: crypto.randomUUID(),
        unsubscribedAt: null,
      };
      const [subscriber] = await adminDb
        .insert(newsletterSubscribers)
        .values({ email: body.email, ...changes })
        .onConflictDoUpdate({ target: newsletterSubscribers.email, set: changes })
        .returning({ confirmationToken: newsletterSubscribers.confirmationToken });
      confirmationToken = subscriber?.confirmationToken ?? null;
    } catch (insertError) {
      logger.error({ err: dbErrorForLog(insertError) }, 'Failed to create newsletter subscriber');
      return c.json({ error: sanitizeError(insertError, 'Failed to subscribe') }, 500);
    }

    // Send confirmation email (double opt-in)
    const baseUrl = env.SITE_URL || 'http://localhost:5173';
    const confirmUrl = `${baseUrl}/api/v1/newsletter/confirm?token=${confirmationToken}`;

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

  // The token column is a uuid; anything else cannot match a row.
  if (!isUuid(token)) {
    return c.json({ error: 'Invalid or expired confirmation link' }, 400);
  }

  try {
    // NOTE: confirmation_token is intentionally NOT cleared here — it doubles as
    // the per-subscriber unsubscribe secret (see the unsubscribe route below).
    // Re-confirmation is already prevented by the `status = 'pending'` filter.
    const [data] = await adminDb
      .update(newsletterSubscribers)
      .set({ status: 'active', subscribedAt: new Date().toISOString() })
      .where(
        and(
          eq(newsletterSubscribers.confirmationToken, token),
          eq(newsletterSubscribers.status, 'pending')
        )
      )
      .returning({ email: newsletterSubscribers.email });

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

  // The token column is a uuid; anything else cannot match a row.
  if (!isUuid(token)) {
    return c.json({ error: 'Invalid unsubscribe link' }, 400);
  }

  try {
    const [data] = await adminDb
      .update(newsletterSubscribers)
      .set({ status: 'unsubscribed', unsubscribedAt: new Date().toISOString() })
      .where(
        and(
          eq(newsletterSubscribers.email, email),
          eq(newsletterSubscribers.confirmationToken, token)
        )
      )
      .returning({ id: newsletterSubscribers.id });

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
