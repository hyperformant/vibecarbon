import type { SupabaseClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { z } from 'zod';
import { sendEmail } from '../../../lib/email';
import { env } from '../../../lib/env';
import { sanitizeError } from '../../../lib/errors';
import { logger } from '../../../lib/logger';
import { supabaseAdmin } from '../../../lib/supabase';
import { requireSuperAdmin } from '../../../middleware/requireSuperAdmin';
import type { HonoVariables } from '../../../types';

// biome-ignore lint/suspicious/noExplicitAny: Tables not yet in generated Database types
const adminDb = supabaseAdmin as SupabaseClient<any>;

const adminNewsletterRoutes = new Hono<{ Variables: HonoVariables }>();

// Require super admin for all newsletter management endpoints (JWT-based role
// check — see requireSuperAdmin). The prior `adminDb.from('auth.users')` guard
// errored on the unexposed auth schema and fell closed for everyone.
adminNewsletterRoutes.use('*', requireSuperAdmin);

/**
 * Escape a value for safe inclusion in a CSV cell.
 *
 * SECURITY: subscriber `name` is attacker-controlled via the public /subscribe
 * endpoint. Two hazards are handled:
 *  1. CSV structure — always quote and double any internal `"` so a value can't
 *     inject extra columns/rows.
 *  2. CSV/formula injection — a cell beginning with `= + - @` or a control char
 *     (tab, CR) is executed as a formula by Excel/Sheets when the file is opened.
 *     Prefix such cells with a single quote to neutralize them.
 */
function csvCell(value: string | null | undefined): string {
  const s = value == null ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * List subscribers with pagination and filtering
 */
adminNewsletterRoutes.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') || '1'));
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || '20')));
  const status = c.req.query('status');
  const search = c.req.query('search');
  const offset = (page - 1) * limit;

  try {
    let query = adminDb
      .from('newsletter_subscribers')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    if (search) {
      query = query.or(`email.ilike.%${search}%,name.ilike.%${search}%`);
    }

    const { data, error, count } = await query;

    if (error) {
      return c.json({ error: sanitizeError(error, 'Failed to fetch subscribers') }, 500);
    }

    return c.json({
      subscribers: data || [],
      total: count || 0,
      page,
      limit,
    });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch subscribers') }, 500);
  }
});

/**
 * Get subscriber stats
 */
adminNewsletterRoutes.get('/stats', async (c) => {
  try {
    const { count: total } = await adminDb
      .from('newsletter_subscribers')
      .select('*', { count: 'exact', head: true });

    const { count: active } = await adminDb
      .from('newsletter_subscribers')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active');

    const { count: pending } = await adminDb
      .from('newsletter_subscribers')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');

    const { count: unsubscribed } = await adminDb
      .from('newsletter_subscribers')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'unsubscribed');

    return c.json({
      total: total || 0,
      active: active || 0,
      pending: pending || 0,
      unsubscribed: unsubscribed || 0,
    });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch stats') }, 500);
  }
});

/**
 * Send newsletter to all active subscribers
 */
const sendNewsletterSchema = z.object({
  subject: z.string().min(1, 'Subject is required').max(300),
  html: z.string().min(1, 'Content is required').max(100000),
});

adminNewsletterRoutes.post('/send', async (c) => {
  let body: z.infer<typeof sendNewsletterSchema>;
  try {
    const rawBody = await c.req.json();
    const result = sendNewsletterSchema.safeParse(rawBody);
    if (!result.success) {
      return c.json({ error: result.error.issues.map((e) => e.message).join(', ') }, 400);
    }
    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    // Get all active subscribers. confirmation_token doubles as the per-subscriber
    // unsubscribe secret (see routes/v1/newsletter.ts).
    const { data: subscribers, error } = await adminDb
      .from('newsletter_subscribers')
      .select('id, email, confirmation_token')
      .eq('status', 'active');

    if (error) {
      return c.json({ error: sanitizeError(error, 'Failed to fetch subscribers') }, 500);
    }

    if (!subscribers || subscribers.length === 0) {
      return c.json({ error: 'No active subscribers' }, 400);
    }

    const baseUrl = env.SITE_URL || 'http://localhost:5173';
    let sent = 0;
    let failed = 0;

    // Send emails in batches (non-blocking)
    for (const subscriber of subscribers) {
      const unsubscribeUrl = `${baseUrl}/api/v1/newsletter/unsubscribe?email=${encodeURIComponent(subscriber.email)}&token=${encodeURIComponent(subscriber.confirmation_token ?? '')}`;
      const emailHtml = `${body.html}
<hr style="margin: 32px 0; border: none; border-top: 1px solid #e4e4e7;">
<p style="font-size: 12px; color: #71717a; text-align: center;">
  <a href="${unsubscribeUrl}" style="color: #71717a;">Unsubscribe</a>
</p>`;

      try {
        await sendEmail({
          to: subscriber.email,
          subject: body.subject,
          html: emailHtml,
        });
        sent++;
      } catch (err) {
        failed++;
        logger.error({ error: err, email: subscriber.email }, 'Failed to send newsletter');
      }
    }

    return c.json({ sent, failed, total: subscribers.length });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to send newsletter') }, 500);
  }
});

/**
 * Delete a subscriber
 */
adminNewsletterRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');

  try {
    const { error } = await adminDb.from('newsletter_subscribers').delete().eq('id', id);

    if (error) {
      return c.json({ error: sanitizeError(error, 'Failed to delete subscriber') }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to delete subscriber') }, 500);
  }
});

/**
 * Export subscribers as CSV
 */
adminNewsletterRoutes.get('/export', async (c) => {
  try {
    const { data, error } = await adminDb
      .from('newsletter_subscribers')
      .select('email, name, status, subscribed_at, created_at')
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (error) {
      return c.json({ error: sanitizeError(error, 'Failed to export') }, 500);
    }

    const csv = [
      'email,name,status,subscribed_at,created_at',
      ...(data || []).map(
        (s: {
          email: string;
          name: string | null;
          status: string;
          subscribed_at: string | null;
          created_at: string;
        }) => [s.email, s.name, s.status, s.subscribed_at, s.created_at].map(csvCell).join(',')
      ),
    ].join('\r\n');

    c.header('Content-Type', 'text/csv');
    c.header('Content-Disposition', 'attachment; filename="newsletter-subscribers.csv"');
    return c.body(csv);
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to export') }, 500);
  }
});

export { adminNewsletterRoutes };
