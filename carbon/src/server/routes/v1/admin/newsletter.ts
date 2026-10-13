import { and, count, desc, eq, ilike, or, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { adminDb } from '../../../db/client';
import { newsletterSubscribers } from '../../../db/schema';
import { isoTimestamp, isUuid } from '../../../db/values';
import { sendEmail } from '../../../lib/email';
import { env } from '../../../lib/env';
import { sanitizeError } from '../../../lib/errors';
import { logger } from '../../../lib/logger';
import { requireSuperAdmin } from '../../../middleware/requireSuperAdmin';
import type { HonoVariables } from '../../../types';

const adminNewsletterRoutes = new Hono<{ Variables: HonoVariables }>();

// Require super admin for all newsletter management endpoints (JWT-based role
// check — see requireSuperAdmin). The prior PostgREST lookup of auth.users
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
    const filters: SQL[] = [];
    if (status) filters.push(eq(newsletterSubscribers.status, status));
    if (search) {
      // Escape LIKE wildcards so a search for "50%" or "a_b" matches literally.
      const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      const match = or(
        ilike(newsletterSubscribers.email, pattern),
        ilike(newsletterSubscribers.name, pattern)
      );
      if (match) filters.push(match);
    }
    const where = filters.length ? and(...filters) : undefined;

    const [rows, [totals]] = await Promise.all([
      adminDb
        .select()
        .from(newsletterSubscribers)
        .where(where)
        .orderBy(desc(newsletterSubscribers.createdAt))
        .limit(limit)
        .offset(offset),
      adminDb.select({ total: count() }).from(newsletterSubscribers).where(where),
    ]);

    return c.json({
      subscribers: rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        status: r.status,
        confirmation_token: r.confirmationToken,
        subscribed_at: r.subscribedAt === null ? null : isoTimestamp(r.subscribedAt),
        unsubscribed_at: r.unsubscribedAt === null ? null : isoTimestamp(r.unsubscribedAt),
        created_at: isoTimestamp(r.createdAt),
        updated_at: isoTimestamp(r.updatedAt),
      })),
      total: totals?.total ?? 0,
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
    const rows = await adminDb
      .select({ status: newsletterSubscribers.status, n: count() })
      .from(newsletterSubscribers)
      .groupBy(newsletterSubscribers.status);
    const byStatus = new Map(rows.map((r) => [r.status, r.n]));

    return c.json({
      total: rows.reduce((sum, r) => sum + r.n, 0),
      active: byStatus.get('active') ?? 0,
      pending: byStatus.get('pending') ?? 0,
      unsubscribed: byStatus.get('unsubscribed') ?? 0,
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
    const subscribers = await adminDb
      .select({
        id: newsletterSubscribers.id,
        email: newsletterSubscribers.email,
        confirmation_token: newsletterSubscribers.confirmationToken,
      })
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.status, 'active'));

    if (subscribers.length === 0) {
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

  if (!isUuid(id)) {
    return c.json({ error: 'Subscriber not found' }, 404);
  }

  try {
    await adminDb.delete(newsletterSubscribers).where(eq(newsletterSubscribers.id, id));

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
    const data = await adminDb
      .select({
        email: newsletterSubscribers.email,
        name: newsletterSubscribers.name,
        status: newsletterSubscribers.status,
        subscribedAt: newsletterSubscribers.subscribedAt,
        createdAt: newsletterSubscribers.createdAt,
      })
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.status, 'active'))
      .orderBy(desc(newsletterSubscribers.createdAt));

    const csv = [
      'email,name,status,subscribed_at,created_at',
      ...data.map((s) =>
        [
          s.email,
          s.name,
          s.status,
          s.subscribedAt === null ? null : isoTimestamp(s.subscribedAt),
          isoTimestamp(s.createdAt),
        ]
          .map(csvCell)
          .join(',')
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
