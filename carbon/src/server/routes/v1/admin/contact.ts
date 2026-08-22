import type { SupabaseClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { z } from 'zod';
import { sanitizeError } from '../../../lib/errors';
import { supabaseAdmin } from '../../../lib/supabase';
import { requireSuperAdmin } from '../../../middleware/requireSuperAdmin';
import type { HonoVariables } from '../../../types';

// biome-ignore lint/suspicious/noExplicitAny: Tables not yet in generated Database types
const adminDb = supabaseAdmin as SupabaseClient<any>;

const adminContactRoutes = new Hono<{ Variables: HonoVariables }>();

// Require super admin for all contact management endpoints (JWT-based role
// check — see requireSuperAdmin). The prior `adminDb.from('auth.users')` guard
// errored on the unexposed auth schema and fell closed for everyone.
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
    let query = adminDb
      .from('contact_submissions')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query;

    if (error) {
      return c.json({ error: sanitizeError(error, 'Failed to fetch submissions') }, 500);
    }

    return c.json({
      submissions: data || [],
      total: count || 0,
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

  try {
    const { error } = await adminDb
      .from('contact_submissions')
      .update({ status: body.status })
      .eq('id', id);

    if (error) {
      return c.json({ error: sanitizeError(error, 'Failed to update submission') }, 500);
    }

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

  try {
    const { error } = await adminDb.from('contact_submissions').delete().eq('id', id);

    if (error) {
      return c.json({ error: sanitizeError(error, 'Failed to delete submission') }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to delete submission') }, 500);
  }
});

export { adminContactRoutes };
