import { Hono } from 'hono';
import { z } from 'zod';
import { adminDb } from '../../db/client';
import { dbErrorForLog } from '../../db/errors';
import { contactSubmissions } from '../../db/schema';
import { sendEmail } from '../../lib/email';
import { env } from '../../lib/env';
import { sanitizeError } from '../../lib/errors';
import { escapeHtml } from '../../lib/html';
import { logger } from '../../lib/logger';
import { createRateLimiter } from '../../lib/rate-limiter';
import type { HonoVariables } from '../../types';

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
    try {
      await adminDb.insert(contactSubmissions).values({
        name: body.name,
        email: body.email,
        subject: body.subject,
        message: body.message,
      });
    } catch (insertError) {
      logger.error({ err: dbErrorForLog(insertError) }, 'Failed to save contact submission');
      return c.json({ error: sanitizeError(insertError, 'Failed to submit') }, 500);
    }

    // Notify admin via email (non-blocking)
    if (env.SMTP_ADMIN_EMAIL) {
      // SECURITY: the Subject is a mail header, not HTML, so it is not
      // entity-escaped (the reader would see `&amp;`). What a header must not
      // carry is a line break, which would start a header of the sender's
      // choosing. nodemailer folds them too; this keeps it true whatever
      // transport sends the mail.
      const subjectLine = body.subject.replace(/[\r\n]+/g, ' ');
      sendEmail({
        to: env.SMTP_ADMIN_EMAIL,
        subject: `New contact form: ${subjectLine}`,
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
