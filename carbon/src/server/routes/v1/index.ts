import type { SupabaseClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { z } from 'zod';
import { orgInviteEmail } from '../../emails/templates';
import { isSuperAdmin } from '../../lib/auth';
import { sendEmail } from '../../lib/email';
import { sanitizeError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { type getSupabaseClient, supabaseAdmin } from '../../lib/supabase';
import { assertAal2, requireAal2 } from '../../middleware/requireAal2';
import type { HonoVariables } from '../../types';
import { forwardAuthCookieRoutes } from './forwardauth-cookie';
import { impersonationRoutes } from './impersonation';
import { setupRoutes } from './setup';

// Helper to access tables not yet in generated types (notifications, etc.)
// biome-ignore lint/suspicious/noExplicitAny: Tables not yet in generated Database types
const adminDb = supabaseAdmin as SupabaseClient<any>;

const v1Routes = new Hono<{ Variables: HonoVariables }>();

// HttpOnly ForwardAuth cookie mint/clear (super_admin only) — see module doc.
v1Routes.route('/admin/forwardauth-cookie', forwardAuthCookieRoutes);

// Server-side impersonation swap (super_admin only) — see module doc.
v1Routes.route('/admin/impersonate', impersonationRoutes);

// Setup progress + billing opt-out (super_admin only).
v1Routes.route('/admin/setup', setupRoutes);

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const createOrganizationSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be 100 characters or less')
    .trim(),
  slug: z
    .string()
    .min(3, 'Slug must be at least 3 characters')
    .max(50, 'Slug must be 50 characters or less')
    .regex(/^[a-z0-9-]+$/, 'Slug can only contain lowercase letters, numbers, and hyphens')
    .trim(),
});

const addMemberSchema = z.object({
  email: z.string().email('Valid email is required'),
  role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
});

const updateMemberRoleSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
});

const createNotificationSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title must be 200 characters or less'),
  message: z.string().max(1000, 'Message must be 1000 characters or less').optional(),
  type: z.enum(['info', 'warning', 'error', 'success']).default('info'),
  visibility: z.enum(['all', 'authenticated', 'public']).default('all'),
  dismissible: z.boolean().default(true),
  organizationId: z.string().uuid().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  actionLabel: z.string().max(50).optional().or(z.literal('')),
  actionUrl: z.string().url().optional().or(z.literal('')),
  isActive: z.boolean().default(true),
});

const updateNotificationSchema = createNotificationSchema.partial();

// Pagination schema for admin list endpoints - prevents DoS via excessive limits or complex searches
const adminPaginationSchema = z.object({
  search: z
    .string()
    .max(100, 'Search query too long')
    .regex(/^[a-zA-Z0-9@.\-_ ]*$/, 'Search contains invalid characters')
    .optional()
    .default(''),
  sortBy: z.enum(['name', 'slug', 'plan', 'created_at', 'email']).optional().default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';

// Helper to get user's role in an organization
async function getUserOrgRole(
  supabase: ReturnType<typeof getSupabaseClient>,
  userId: string,
  organizationId: string
): Promise<OrgRole | null> {
  const { data } = await supabase
    .from('memberships')
    .select('role')
    .eq('user_id', userId)
    .eq('organization_id', organizationId)
    .single();

  return (data?.role as OrgRole) || null;
}

// Helper to check if user has admin access (OWNER or ADMIN)
async function hasOrgAdminAccess(
  supabase: ReturnType<typeof getSupabaseClient>,
  userId: string,
  organizationId: string
): Promise<boolean> {
  const role = await getUserOrgRole(supabase, userId, organizationId);
  return role === 'OWNER' || role === 'ADMIN';
}

// ============================================================================
// USER ENDPOINTS
// ============================================================================

// Get current user info
v1Routes.get('/me', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Fetch user's organizations/memberships
  const supabase = c.get('supabase');
  const { data: memberships, error } = await supabase.from('memberships').select(`
      id,
      role,
      organization:organizations (
        id,
        name,
        slug,
        plan,
        created_at,
        updated_at
      )
    `);

  if (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch memberships') }, 500);
  }

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.user_metadata?.full_name || user.user_metadata?.name,
      avatar: user.user_metadata?.avatar_url,
      emailVerified: user.email_confirmed_at !== null,
      role: user.app_metadata?.role || null,
    },
    memberships,
  });
});

// Delete current user's account
v1Routes.delete('/me', requireAal2, async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Super admins cannot delete themselves
  if (isSuperAdmin(user)) {
    return c.json(
      { error: 'Super admins cannot delete their own account. Remove the super_admin role first.' },
      403
    );
  }

  // Check if user is the sole member of any organization
  const { data: memberships } = await supabaseAdmin
    .from('memberships')
    .select('organization_id')
    .eq('user_id', user.id);

  if (memberships && memberships.length > 0) {
    for (const membership of memberships) {
      const { count } = await supabaseAdmin
        .from('memberships')
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', membership.organization_id);

      if (count === 1) {
        const { data: org } = await supabaseAdmin
          .from('organizations')
          .select('name')
          .eq('id', membership.organization_id)
          .single();

        return c.json(
          {
            error: `You are the only member of "${org?.name || 'an organization'}". Transfer ownership or delete the organization first.`,
          },
          400
        );
      }
    }
  }

  // Cancel any active Stripe subscriptions
  const { data: customer } = await adminDb
    .from('customers')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .is('organization_id', null)
    .maybeSingle();

  if (customer?.stripe_customer_id) {
    try {
      const { isStripeConfigured, getStripe } = await import('../../lib/stripe');
      if (isStripeConfigured()) {
        const stripe = getStripe();
        const subscriptions = await stripe.subscriptions.list({
          customer: customer.stripe_customer_id,
          status: 'active',
        });
        for (const sub of subscriptions.data) {
          await stripe.subscriptions.cancel(sub.id);
        }
      }
    } catch (stripeError) {
      logger.warn(
        { error: stripeError },
        'Failed to cancel Stripe subscriptions during account deletion'
      );
    }
  }

  // Delete the user (cascades to memberships, customers, notification_dismissals)
  const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(user.id);

  if (deleteError) {
    return c.json({ error: sanitizeError(deleteError, 'Failed to delete account') }, 500);
  }

  logger.info({ userId: user.id, email: user.email }, 'User account deleted');

  return c.json({ success: true });
});

// ============================================================================
// ORGANIZATION ENDPOINTS
// ============================================================================

// Create organization
v1Routes.post('/organizations', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Parse and validate request body
  let body: z.infer<typeof createOrganizationSchema>;
  try {
    const rawBody = await c.req.json();
    const result = createOrganizationSchema.safeParse(rawBody);

    if (!result.success) {
      const errors = result.error.issues.map((e: { message: string }) => e.message).join(', ');
      return c.json({ error: errors }, 400);
    }

    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Use admin client to create org (bypasses RLS for insert)
  const { data: org, error: orgError } = await supabaseAdmin
    .from('organizations')
    .insert({ name: body.name, slug: body.slug })
    .select()
    .single();

  if (orgError) {
    // Check for unique constraint violation
    if (orgError.code === '23505') {
      return c.json({ error: 'An organization with this slug already exists' }, 400);
    }
    return c.json({ error: sanitizeError(orgError, 'Failed to create organization') }, 400);
  }

  // Create membership for the creator as OWNER
  const { error: memberError } = await supabaseAdmin.from('memberships').insert({
    user_id: user.id,
    organization_id: org.id,
    role: 'OWNER',
  });

  if (memberError) {
    // Rollback org creation
    await supabaseAdmin.from('organizations').delete().eq('id', org.id);
    return c.json({ error: sanitizeError(memberError, 'Failed to create membership') }, 400);
  }

  return c.json({ organization: org }, 201);
});

// List user's organizations
v1Routes.get('/organizations', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const supabase = c.get('supabase');
  const { data, error } = await supabase.from('organizations').select('*');

  if (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch organizations') }, 500);
  }

  return c.json({ organizations: data });
});

// ============================================================================
// MEMBERSHIP ENDPOINTS
// ============================================================================

// List organization members
v1Routes.get('/organizations/:orgId/members', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const orgId = c.req.param('orgId');
  const supabase = c.get('supabase');

  // Check if user is a member of this organization (RLS will handle this)
  const { data: members, error } = await supabase
    .from('memberships')
    .select(`
      id,
      role,
      created_at,
      user_id
    `)
    .eq('organization_id', orgId);

  if (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch members') }, 500);
  }

  // If no members returned, either org doesn't exist or user isn't a member
  if (!members || members.length === 0) {
    return c.json({ error: 'Organization not found or access denied' }, 404);
  }

  // Fetch user details only for the specific member IDs (not all users)
  const userDetailsMap = new Map<
    string,
    { id: string; email?: string; name?: string; avatar?: string }
  >();

  // Fetch user details with BOUNDED concurrency. A naive Promise.all over all
  // members fires one GoTrue Admin call per member with no cap, so a member of
  // a large org could drive hundreds of parallel calls against the auth service
  // per request — an amplification vector on a shared box. Chunk into small
  // batches so the fan-out is bounded regardless of org size. (A hard page cap
  // on the members list itself is a follow-up.)
  const MEMBER_LOOKUP_CONCURRENCY = 20;
  for (let i = 0; i < members.length; i += MEMBER_LOOKUP_CONCURRENCY) {
    const batch = members.slice(i, i + MEMBER_LOOKUP_CONCURRENCY);
    await Promise.all(
      batch.map(async (member) => {
        const { data, error } = await supabaseAdmin.auth.admin.getUserById(member.user_id);
        if (!error && data?.user) {
          userDetailsMap.set(member.user_id, {
            id: data.user.id,
            email: data.user.email,
            name: data.user.user_metadata?.full_name || data.user.user_metadata?.name,
            avatar: data.user.user_metadata?.avatar_url,
          });
        }
      })
    );
  }

  // Map user details to members
  const membersWithDetails = members.map((member) => ({
    id: member.id,
    role: member.role,
    createdAt: member.created_at,
    user: userDetailsMap.get(member.user_id) || null,
  }));

  return c.json({ members: membersWithDetails });
});

// Add member to organization
v1Routes.post('/organizations/:orgId/members', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const orgId = c.req.param('orgId');
  const supabase = c.get('supabase');

  // Check if user has admin access
  if (!(await hasOrgAdminAccess(supabase, user.id, orgId))) {
    return c.json({ error: 'You must be an admin to add members' }, 403);
  }

  // Parse and validate request body
  let body: z.infer<typeof addMemberSchema>;
  try {
    const rawBody = await c.req.json();
    const result = addMemberSchema.safeParse(rawBody);

    if (!result.success) {
      const errors = result.error.issues.map((e: { message: string }) => e.message).join(', ');
      return c.json({ error: errors }, 400);
    }

    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Find user by email using paginated search (avoids loading all users at once)
  const emailLower = body.email.toLowerCase();
  let targetUser = null;
  let page = 1;
  const perPage = 100;
  const maxPages = 50; // Safety limit: 5000 users max search

  while (!targetUser && page <= maxPages) {
    const { data: usersPage, error: userLookupError } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage,
    });

    if (userLookupError) {
      return c.json({ error: sanitizeError(userLookupError, 'Failed to look up user') }, 500);
    }

    targetUser = usersPage.users.find((u) => u.email?.toLowerCase() === emailLower);

    // Stop if we've exhausted the user list
    if (usersPage.users.length < perPage) break;
    page++;
  }

  if (!targetUser) {
    return c.json({ error: 'User not found. They must sign up first.' }, 404);
  }

  // Check if user is already a member
  const { data: existingMembership } = await supabaseAdmin
    .from('memberships')
    .select('id')
    .eq('user_id', targetUser.id)
    .eq('organization_id', orgId)
    .single();

  if (existingMembership) {
    return c.json({ error: 'User is already a member of this organization' }, 400);
  }

  // Add membership using admin client
  const { data: membership, error: memberError } = await supabaseAdmin
    .from('memberships')
    .insert({
      user_id: targetUser.id,
      organization_id: orgId,
      role: body.role,
    })
    .select()
    .single();

  if (memberError) {
    return c.json({ error: sanitizeError(memberError, 'Failed to add member') }, 500);
  }

  logger.info(
    { orgId, targetUserId: targetUser.id, role: body.role, addedBy: user.id },
    'Member added to organization'
  );

  // Send invite email (fire-and-forget, don't block response)
  const { data: orgData } = await supabaseAdmin
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .single();

  if (targetUser.email && orgData) {
    const inviterName =
      user.user_metadata?.full_name || user.user_metadata?.name || user.email || 'A team member';
    const baseUrl = process.env.SITE_URL || 'http://localhost:5173';
    const template = orgInviteEmail({
      inviterName,
      organizationName: orgData.name,
      role: body.role,
      loginUrl: `${baseUrl}/login`,
    });
    sendEmail({ to: targetUser.email, ...template }).catch((err) => {
      logger.error({ error: err }, 'Failed to send org invite email');
    });
  }

  return c.json(
    {
      member: {
        id: membership.id,
        role: membership.role,
        createdAt: membership.created_at,
        user: {
          id: targetUser.id,
          email: targetUser.email,
          name: targetUser.user_metadata?.full_name || targetUser.user_metadata?.name,
        },
      },
    },
    201
  );
});

// Update member role
v1Routes.patch('/organizations/:orgId/members/:userId', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const orgId = c.req.param('orgId');
  const targetUserId = c.req.param('userId');
  const supabase = c.get('supabase');

  // Parse and validate request body
  let body: z.infer<typeof updateMemberRoleSchema>;
  try {
    const rawBody = await c.req.json();
    const result = updateMemberRoleSchema.safeParse(rawBody);

    if (!result.success) {
      const errors = result.error.issues.map((e: { message: string }) => e.message).join(', ');
      return c.json({ error: errors }, 400);
    }

    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Promoting/transferring a member to OWNER is a high-privilege action —
  // require an aal2 (MFA-validated) session. Checked here, before the authz
  // lookups: an unauthorized caller is still rejected by the role checks below,
  // and gating early keeps the check cheap and trivially testable.
  if (body.role === 'OWNER') {
    const blocked = await assertAal2(c);
    if (blocked) return blocked;
  }

  // Get current user's role
  const currentUserRole = await getUserOrgRole(supabase, user.id, orgId);

  if (!currentUserRole) {
    return c.json({ error: 'Organization not found or access denied' }, 404);
  }

  // Get target user's current role
  const targetUserRole = await getUserOrgRole(supabase, targetUserId, orgId);

  if (!targetUserRole) {
    return c.json({ error: 'Member not found' }, 404);
  }

  // Permission checks:
  // 1. Only OWNER can change roles to/from OWNER
  // 2. OWNER can change any role
  // 3. ADMIN can change MEMBER to ADMIN and vice versa, but not touch OWNER

  if (body.role === 'OWNER' || targetUserRole === 'OWNER') {
    if (currentUserRole !== 'OWNER') {
      return c.json({ error: 'Only the owner can transfer or modify ownership' }, 403);
    }
  } else if (currentUserRole !== 'OWNER' && currentUserRole !== 'ADMIN') {
    return c.json({ error: 'You must be an admin to change member roles' }, 403);
  }

  // Prevent changing own role (except owner transferring ownership)
  if (user.id === targetUserId && body.role !== 'OWNER') {
    return c.json({ error: 'You cannot change your own role' }, 400);
  }

  // Update the role using admin client
  const { error: updateError } = await supabaseAdmin
    .from('memberships')
    .update({ role: body.role })
    .eq('user_id', targetUserId)
    .eq('organization_id', orgId);

  if (updateError) {
    return c.json({ error: sanitizeError(updateError, 'Failed to update role') }, 500);
  }

  // If transferring ownership, demote current owner to admin
  if (body.role === 'OWNER' && user.id !== targetUserId) {
    await supabaseAdmin
      .from('memberships')
      .update({ role: 'ADMIN' })
      .eq('user_id', user.id)
      .eq('organization_id', orgId);
  }

  logger.info(
    { orgId, targetUserId, oldRole: targetUserRole, newRole: body.role, changedBy: user.id },
    'Member role updated'
  );

  return c.json({ success: true, role: body.role });
});

// Remove member from organization
v1Routes.delete('/organizations/:orgId/members/:userId', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const orgId = c.req.param('orgId');
  const targetUserId = c.req.param('userId');
  const supabase = c.get('supabase');

  // Get current user's role
  const currentUserRole = await getUserOrgRole(supabase, user.id, orgId);

  if (!currentUserRole) {
    return c.json({ error: 'Organization not found or access denied' }, 404);
  }

  // Get target user's role
  const targetUserRole = await getUserOrgRole(supabase, targetUserId, orgId);

  if (!targetUserRole) {
    return c.json({ error: 'Member not found' }, 404);
  }

  // Permission checks:
  // 1. Users can remove themselves (leave org) - unless they're the only owner
  // 2. OWNER can remove anyone except themselves if they're the only owner
  // 3. ADMIN can remove MEMBER only

  const isSelf = user.id === targetUserId;

  if (isSelf) {
    // Check if user is the only owner
    if (targetUserRole === 'OWNER') {
      const { count } = await supabaseAdmin
        .from('memberships')
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('role', 'OWNER');

      if (count === 1) {
        return c.json({ error: 'You are the only owner. Transfer ownership before leaving.' }, 400);
      }
    }
  } else {
    // Removing someone else
    if (currentUserRole === 'MEMBER') {
      return c.json({ error: 'You must be an admin to remove members' }, 403);
    }

    if (currentUserRole === 'ADMIN' && targetUserRole !== 'MEMBER') {
      return c.json({ error: 'Admins can only remove members, not other admins or owners' }, 403);
    }

    if (targetUserRole === 'OWNER') {
      return c.json({ error: 'Cannot remove the organization owner' }, 403);
    }
  }

  // Remove the membership
  const { error: deleteError } = await supabaseAdmin
    .from('memberships')
    .delete()
    .eq('user_id', targetUserId)
    .eq('organization_id', orgId);

  if (deleteError) {
    return c.json({ error: sanitizeError(deleteError, 'Failed to remove member') }, 500);
  }

  logger.info(
    { orgId, targetUserId, removedBy: user.id, wasSelf: isSelf },
    'Member removed from organization'
  );

  return c.json({ success: true });
});

// Delete an organization (OWNER only)
v1Routes.delete('/organizations/:orgId', requireAal2, async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // biome-ignore lint/style/noNonNullAssertion: orgId is always defined when this route matches
  const orgId = c.req.param('orgId')!;
  const supabase = c.get('supabase');

  // Only the owner can delete
  const role = await getUserOrgRole(supabase, user.id, orgId);

  if (!role) {
    return c.json({ error: 'Organization not found or access denied' }, 404);
  }

  if (role !== 'OWNER') {
    return c.json({ error: 'Only the organization owner can delete the organization' }, 403);
  }

  // Cannot delete the user's last organization
  const { count: orgCount } = await supabaseAdmin
    .from('memberships')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id);

  if (orgCount != null && orgCount <= 1) {
    return c.json(
      { error: 'You cannot delete your only organization. Create another organization first.' },
      400
    );
  }

  // Delete all memberships first, then the organization
  const { error: memberError } = await supabaseAdmin
    .from('memberships')
    .delete()
    .eq('organization_id', orgId);

  if (memberError) {
    return c.json({ error: sanitizeError(memberError, 'Failed to delete organization') }, 500);
  }

  const { error: orgError } = await supabaseAdmin.from('organizations').delete().eq('id', orgId);

  if (orgError) {
    return c.json({ error: sanitizeError(orgError, 'Failed to delete organization') }, 500);
  }

  logger.info({ orgId, deletedBy: user.id }, 'Organization deleted');

  return c.json({ success: true });
});

// ============================================================================
// ADMIN DATA ENDPOINTS (Super Admin only)
// ============================================================================

// List all organizations (super admin)
v1Routes.get('/admin/organizations', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }

  // Validate and parse query params
  const queryResult = adminPaginationSchema.safeParse({
    search: c.req.query('search'),
    sortBy: c.req.query('sortBy'),
    sortOrder: c.req.query('sortOrder'),
    page: c.req.query('page'),
    limit: c.req.query('limit'),
  });

  if (!queryResult.success) {
    const errors = queryResult.error.issues.map((e) => e.message).join(', ');
    return c.json({ error: errors }, 400);
  }

  const { search, sortBy, sortOrder, page, limit } = queryResult.data;
  const offset = (page - 1) * limit;

  // Build query using admin client (bypasses RLS)
  let query = supabaseAdmin
    .from('organizations')
    .select('*, memberships(count)', { count: 'exact' });

  // Apply search filter (safe: input validated to [a-zA-Z0-9@.\-_ ] via Zod schema)
  // Note: underscore acts as single-char wildcard in SQL ILIKE - acceptable for admin search
  if (search) {
    query = query.or(`name.ilike.%${search}%,slug.ilike.%${search}%`);
  }

  // Apply sorting (validated against allowed values)
  const ascending = sortOrder === 'asc';
  if (sortBy === 'name' || sortBy === 'slug' || sortBy === 'plan' || sortBy === 'created_at') {
    query = query.order(sortBy, { ascending });
  }

  // Apply pagination
  query = query.range(offset, offset + limit - 1);

  const { data: organizations, error, count } = await query;

  if (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch organizations') }, 500);
  }

  return c.json({
    organizations: (organizations || []).map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: org.plan,
      memberCount: Array.isArray(org.memberships) ? org.memberships[0]?.count || 0 : 0,
      createdAt: org.created_at,
      updatedAt: org.updated_at,
    })),
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    },
  });
});

// List all users (super admin)
v1Routes.get('/admin/users', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }

  // Validate and parse query params
  const queryResult = adminPaginationSchema.safeParse({
    search: c.req.query('search'),
    sortBy: c.req.query('sortBy'),
    sortOrder: c.req.query('sortOrder'),
    page: c.req.query('page'),
    limit: c.req.query('limit'),
  });

  if (!queryResult.success) {
    const errors = queryResult.error.issues.map((e) => e.message).join(', ');
    return c.json({ error: errors }, 400);
  }

  const { search, sortBy, sortOrder, page, limit } = queryResult.data;

  // Fetch all users using admin client
  const { data: usersData, error: usersError } = await supabaseAdmin.auth.admin.listUsers({
    page,
    perPage: limit,
  });

  if (usersError) {
    return c.json({ error: sanitizeError(usersError, 'Failed to fetch users') }, 500);
  }

  let users = usersData.users;

  // Apply search filter
  if (search) {
    const searchLower = search.toLowerCase();
    users = users.filter(
      (u) =>
        u.email?.toLowerCase().includes(searchLower) ||
        u.user_metadata?.full_name?.toLowerCase().includes(searchLower) ||
        u.user_metadata?.name?.toLowerCase().includes(searchLower)
    );
  }

  // Apply sorting
  users.sort((a, b) => {
    let aVal: string | Date | undefined;
    let bVal: string | Date | undefined;

    switch (sortBy) {
      case 'email':
        aVal = a.email;
        bVal = b.email;
        break;
      case 'name':
        aVal = a.user_metadata?.full_name || a.user_metadata?.name || '';
        bVal = b.user_metadata?.full_name || b.user_metadata?.name || '';
        break;
      default:
        // Default to created_at for any other sortBy values
        aVal = a.created_at;
        bVal = b.created_at;
        break;
    }

    if (!aVal && !bVal) return 0;
    if (!aVal) return sortOrder === 'asc' ? -1 : 1;
    if (!bVal) return sortOrder === 'asc' ? 1 : -1;

    const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    return sortOrder === 'asc' ? comparison : -comparison;
  });

  // Get membership counts for each user
  const userIds = users.map((u) => u.id);
  const { data: memberships } = await supabaseAdmin
    .from('memberships')
    .select('user_id, organization_id')
    .in('user_id', userIds);

  const membershipCounts = new Map<string, number>();
  memberships?.forEach((m) => {
    membershipCounts.set(m.user_id, (membershipCounts.get(m.user_id) || 0) + 1);
  });

  return c.json({
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.user_metadata?.full_name || u.user_metadata?.name || null,
      avatar: u.user_metadata?.avatar_url || null,
      role: u.app_metadata?.role || null,
      emailVerified: u.email_confirmed_at !== null,
      organizationCount: membershipCounts.get(u.id) || 0,
      lastSignIn: u.last_sign_in_at,
      createdAt: u.created_at,
    })),
    pagination: {
      page,
      limit,
      total: usersData.total || users.length,
      totalPages: Math.ceil((usersData.total || users.length) / limit),
    },
  });
});

// ============================================================================
// ADMIN IMPERSONATION (Super Admin only)
// ============================================================================
// Server-side session swap — see routes/v1/impersonation.ts for the routes
// and the vc-impersonation-restore cookie contract.

// ============================================================================
// NOTIFICATION ENDPOINTS
// ============================================================================

// Get active notifications for current user (or public notifications for unauthenticated visitors)
v1Routes.get('/notifications', async (c) => {
  const user = c.get('user');

  if (!user) {
    // Serve public notifications for unauthenticated visitors via admin client with explicit filtering
    const now = new Date().toISOString();
    const { data: notifications, error } = await adminDb
      .from('notifications')
      .select('*')
      .eq('is_active', true)
      .in('visibility', ['all', 'public'])
      .is('organization_id', null)
      .or(`starts_at.is.null,starts_at.lte.${now}`)
      .or(`ends_at.is.null,ends_at.gt.${now}`)
      .order('created_at', { ascending: false });

    if (error) {
      return c.json({ error: sanitizeError(error, 'Failed to fetch notifications') }, 500);
    }

    return c.json({
      notifications: (notifications || []).map((n) => ({
        id: n.id,
        title: n.title,
        message: n.message,
        type: n.type,
        dismissible: n.dismissible,
        action:
          n.action_label && n.action_url ? { label: n.action_label, url: n.action_url } : undefined,
        createdAt: n.created_at,
      })),
    });
  }

  // Cast to any to access tables not yet in generated types
  // biome-ignore lint/suspicious/noExplicitAny: Tables not yet in generated Database types
  const supabase = c.get('supabase') as SupabaseClient<any>;

  // Fetch active notifications (RLS handles visibility)
  const { data: notifications, error } = await supabase
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch notifications') }, 500);
  }

  // Fetch user's dismissals
  const { data: dismissals } = await supabase
    .from('notification_dismissals')
    .select('notification_id');

  const dismissedIds = new Set(dismissals?.map((d) => d.notification_id) || []);

  // Filter out dismissed notifications and format response
  const activeNotifications = (notifications || [])
    .filter((n) => !dismissedIds.has(n.id))
    .map((n) => ({
      id: n.id,
      title: n.title,
      message: n.message,
      type: n.type,
      dismissible: n.dismissible,
      action:
        n.action_label && n.action_url ? { label: n.action_label, url: n.action_url } : undefined,
      createdAt: n.created_at,
    }));

  return c.json({ notifications: activeNotifications });
});

// Dismiss a notification
v1Routes.post('/notifications/:notificationId/dismiss', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const notificationId = c.req.param('notificationId');
  // biome-ignore lint/suspicious/noExplicitAny: Tables not yet in generated Database types
  const supabase = c.get('supabase') as SupabaseClient<any>;

  // Check if notification exists and is dismissible
  const { data: notification, error: notifError } = await supabase
    .from('notifications')
    .select('id, dismissible')
    .eq('id', notificationId)
    .single();

  if (notifError || !notification) {
    return c.json({ error: 'Notification not found' }, 404);
  }

  if (!notification.dismissible) {
    return c.json({ error: 'This notification cannot be dismissed' }, 400);
  }

  // Create dismissal record
  const { error: dismissError } = await supabase
    .from('notification_dismissals')
    .insert({ notification_id: notificationId, user_id: user.id });

  if (dismissError) {
    // Ignore duplicate key errors (already dismissed)
    if (dismissError.code !== '23505') {
      return c.json({ error: sanitizeError(dismissError, 'Failed to dismiss notification') }, 500);
    }
  }

  return c.json({ success: true });
});

// ============================================================================
// ADMIN NOTIFICATION ENDPOINTS (Super Admin only)
// ============================================================================

// List all notifications (including inactive) for admin management
v1Routes.get('/admin/notifications', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }

  // Use admin client to see all notifications
  const { data: notifications, error } = await adminDb
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch notifications') }, 500);
  }

  return c.json({
    notifications: (notifications || []).map((n) => ({
      id: n.id,
      title: n.title,
      message: n.message,
      type: n.type,
      visibility: n.visibility,
      dismissible: n.dismissible,
      organizationId: n.organization_id,
      startsAt: n.starts_at,
      endsAt: n.ends_at,
      actionLabel: n.action_label,
      actionUrl: n.action_url,
      isActive: n.is_active,
      createdBy: n.created_by,
      createdAt: n.created_at,
      updatedAt: n.updated_at,
    })),
  });
});

// Create notification
v1Routes.post('/admin/notifications', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }

  // Parse and validate request body
  let body: z.infer<typeof createNotificationSchema>;
  try {
    const rawBody = await c.req.json();
    const result = createNotificationSchema.safeParse(rawBody);

    if (!result.success) {
      const errors = result.error.issues.map((e: { message: string }) => e.message).join(', ');
      return c.json({ error: errors }, 400);
    }

    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { data: notification, error } = await adminDb
    .from('notifications')
    .insert({
      title: body.title,
      message: body.message,
      type: body.type,
      visibility: body.visibility,
      dismissible: body.dismissible,
      organization_id: body.organizationId,
      starts_at: body.startsAt,
      ends_at: body.endsAt,
      action_label: body.actionLabel,
      action_url: body.actionUrl,
      is_active: body.isActive,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return c.json({ error: sanitizeError(error, 'Failed to create notification') }, 500);
  }

  logger.info({ notificationId: notification.id, createdBy: user.id }, 'Notification created');

  return c.json(
    {
      notification: {
        id: notification.id,
        title: notification.title,
        message: notification.message,
        type: notification.type,
        visibility: notification.visibility,
        dismissible: notification.dismissible,
        organizationId: notification.organization_id,
        startsAt: notification.starts_at,
        endsAt: notification.ends_at,
        actionLabel: notification.action_label,
        actionUrl: notification.action_url,
        isActive: notification.is_active,
        createdAt: notification.created_at,
      },
    },
    201
  );
});

// Update notification
v1Routes.patch('/admin/notifications/:notificationId', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }

  const notificationId = c.req.param('notificationId');

  // Parse and validate request body
  let body: z.infer<typeof updateNotificationSchema>;
  try {
    const rawBody = await c.req.json();
    const result = updateNotificationSchema.safeParse(rawBody);

    if (!result.success) {
      const errors = result.error.issues.map((e: { message: string }) => e.message).join(', ');
      return c.json({ error: errors }, 400);
    }

    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Build update object with snake_case keys
  const updateData: Record<string, unknown> = {};
  if (body.title !== undefined) updateData.title = body.title;
  if (body.message !== undefined) updateData.message = body.message;
  if (body.type !== undefined) updateData.type = body.type;
  if (body.visibility !== undefined) updateData.visibility = body.visibility;
  if (body.dismissible !== undefined) updateData.dismissible = body.dismissible;
  if (body.organizationId !== undefined) updateData.organization_id = body.organizationId;
  if (body.startsAt !== undefined) updateData.starts_at = body.startsAt;
  if (body.endsAt !== undefined) updateData.ends_at = body.endsAt;
  if (body.actionLabel !== undefined) updateData.action_label = body.actionLabel;
  if (body.actionUrl !== undefined) updateData.action_url = body.actionUrl;
  if (body.isActive !== undefined) updateData.is_active = body.isActive;

  const { data: notification, error } = await adminDb
    .from('notifications')
    .update(updateData)
    .eq('id', notificationId)
    .select()
    .single();

  if (error) {
    return c.json({ error: sanitizeError(error, 'Failed to update notification') }, 500);
  }

  if (!notification) {
    return c.json({ error: 'Notification not found' }, 404);
  }

  logger.info({ notificationId, updatedBy: user.id }, 'Notification updated');

  return c.json({
    notification: {
      id: notification.id,
      title: notification.title,
      message: notification.message,
      type: notification.type,
      visibility: notification.visibility,
      dismissible: notification.dismissible,
      organizationId: notification.organization_id,
      startsAt: notification.starts_at,
      endsAt: notification.ends_at,
      actionLabel: notification.action_label,
      actionUrl: notification.action_url,
      isActive: notification.is_active,
      updatedAt: notification.updated_at,
    },
  });
});

// Delete notification
v1Routes.delete('/admin/notifications/:notificationId', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }

  const notificationId = c.req.param('notificationId');

  const { error } = await adminDb.from('notifications').delete().eq('id', notificationId);

  if (error) {
    return c.json({ error: sanitizeError(error, 'Failed to delete notification') }, 500);
  }

  logger.info({ notificationId, deletedBy: user.id }, 'Notification deleted');

  return c.json({ success: true });
});

export { v1Routes };
