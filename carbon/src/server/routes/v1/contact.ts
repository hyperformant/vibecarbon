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

const contactRoutes = new Hono<{ Variables: HonoVariables }>();

// Stricter rate limiting for contact form (5 per 15 minutes per IP)
contactRoutes.use('/submit', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 }));

const contactSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  email: z.string().email('Valid email is required').max(200),
  subject: z.string().min(1, 'Subject is required').max(300),
  message: z.string().min(10, 'Message must be at least 10 characters').max(5000),
  // Honeypot field - must be empty (bots fill it in)
  website: z.string().max(0).optional(),
});

/**
 * Submit a contact form (public, rate-limited)
 */
contactRoutes.post('/submit', async (c) => {
  let body: z.infer<typeof contactSchema>;
  try {
    const rawBody = await c.req.json();
    const result = contactSchema.safeParse(rawBody);
    if (!result.success) {
      const errors = result.error.issues.map((e) => e.message).join(', ');
      return c.json({ error: errors }, 400);
    }
    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Honeypot check - if website field is filled, it's likely a bot
  if (body.website) {
    // Silently accept but don't store (don't tip off the bot)
    return c.json({ success: true });
  }

  try {
    const { error: insertError } = await adminDb.from('contact_submissions').insert({
      name: body.name,
      email: body.email,
      subject: body.subject,
      message: body.message,
    });

    if (insertError) {
      logger.error({ error: insertError }, 'Failed to save contact submission');
      return c.json({ error: sanitizeError(insertError, 'Failed to submit') }, 500);
    }

    // Notify admin via email (non-blocking)
    if (env.SMTP_ADMIN_EMAIL) {
      const escapeHtml = (s: string) =>
        s
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      sendEmail({
        to: env.SMTP_ADMIN_EMAIL,
        subject: `New contact form: ${escapeHtml(body.subject)}`,
        html: `<h2>New Contact Form Submission</h2>
<p><strong>From:</strong> ${escapeHtml(body.name)} (${escapeHtml(body.email)})</p>
<p><strong>Subject:</strong> ${escapeHtml(body.subject)}</p>
<hr>
<p>${escapeHtml(body.message).replace(/\n/g, '<br>')}</p>`,
        replyTo: body.email,
      }).catch((err) => {
        logger.error({ error: err }, 'Failed to send contact notification email');
      });
    }

    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to submit') }, 500);
  }
});

export { contactRoutes };
