import { count, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { adminDb } from '../../../db/client';
import { contactSubmissions } from '../../../db/schema';
import { isoTimestamp, isUuid } from '../../../db/values';
import { sanitizeError } from '../../../lib/errors';
import { requireSuperAdmin } from '../../../middleware/requireSuperAdmin';
import type { HonoVariables } from '../../../types';

const adminContactRoutes = new Hono<{ Variables: HonoVariables }>();

// Require super admin (plus a verified second factor while MFA is on) for all
// contact management endpoints; see requireSuperAdmin.
adminContactRoutes.use('*', requireSuperAdmin);

/**
 * List contact submissions with pagination
 */
adminContactRoutes.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') || '1'));
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') || '20')));
  const status = c.req.query('status');
  const offset = (page - 1) * limit;

  try {
    const where = status ? eq(contactSubmissions.status, status) : undefined;
    const [rows, [totals]] = await Promise.all([
      adminDb
        .select()
        .from(contactSubmissions)
        .where(where)
        .orderBy(desc(contactSubmissions.createdAt))
        .limit(limit)
        .offset(offset),
      adminDb.select({ total: count() }).from(contactSubmissions).where(where),
    ]);

    return c.json({
      submissions: rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        subject: r.subject,
        message: r.message,
        status: r.status,
        created_at: isoTimestamp(r.createdAt),
        updated_at: isoTimestamp(r.updatedAt),
      })),
      total: totals?.total ?? 0,
      page,
      limit,
    });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch submissions') }, 500);
  }
});

/**
 * Update submission status
 */
const updateStatusSchema = z.object({
  status: z.enum(['unread', 'read', 'replied', 'archived']),
});

adminContactRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');

  let body: z.infer<typeof updateStatusSchema>;
  try {
    const rawBody = await c.req.json();
    const result = updateStatusSchema.safeParse(rawBody);
    if (!result.success) {
      return c.json({ error: result.error.issues.map((e) => e.message).join(', ') }, 400);
    }
    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!isUuid(id)) {
    return c.json({ error: 'Submission not found' }, 404);
  }

  try {
    await adminDb
      .update(contactSubmissions)
      .set({ status: body.status })
      .where(eq(contactSubmissions.id, id));

    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to update submission') }, 500);
  }
});

/**
 * Delete a submission
 */
adminContactRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');

  if (!isUuid(id)) {
    return c.json({ error: 'Submission not found' }, 404);
  }

  try {
    await adminDb.delete(contactSubmissions).where(eq(contactSubmissions.id, id));

    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to delete submission') }, 500);
  }
});

export { adminContactRoutes };
