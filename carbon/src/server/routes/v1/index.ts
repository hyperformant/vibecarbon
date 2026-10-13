import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { adminDb, type UserDb, withUserDb } from '../../db/client';
import {
  customers,
  memberships,
  notificationDismissals,
  notifications,
  organizations,
} from '../../db/schema';
import { isoTimestamp, isUuid, pgErrorCode } from '../../db/values';
import { orgInviteEmail } from '../../emails/templates';
import { isSuperAdmin } from '../../lib/auth';
import { sendEmail } from '../../lib/email';
import { sanitizeError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { supabaseAdmin } from '../../lib/supabase';
import { assertAal2, requireAal2 } from '../../middleware/requireAal2';
import type { HonoVariables } from '../../types';
import { forwardAuthCookieRoutes } from './forwardauth-cookie';
import { impersonationRoutes } from './impersonation';
import { setupRoutes } from './setup';

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

/**
 * `userId`'s role in an organization, as RLS lets the caller of `tx` see it:
 * a caller only sees memberships of organizations they belong to, so this is
 * null for any org the caller is not in. A malformed org id is simply "no
 * role".
 */
async function getUserOrgRole(
  tx: UserDb,
  userId: string,
  organizationId: string
): Promise<OrgRole | null> {
  if (!isUuid(userId) || !isUuid(organizationId)) return null;
  const [row] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)))
    .limit(1);

  return (row?.role as OrgRole) || null;
}

// Helper to check if user has admin access (OWNER or ADMIN)
async function hasOrgAdminAccess(userId: string, organizationId: string): Promise<boolean> {
  const role = await withUserDb(userId, (tx) => getUserOrgRole(tx, userId, organizationId));
  return role === 'OWNER' || role === 'ADMIN';
}

/** Creating an org: the owner membership insert failed (the org rolls back with it). */
class MembershipInsertError extends Error {
  constructor(cause: unknown) {
    super('Failed to create membership', { cause });
    this.name = 'MembershipInsertError';
  }
}

type OrganizationRow = typeof organizations.$inferSelect;

/** An organization row in the snake_case shape the API has always returned. */
function organizationJson(org: OrganizationRow) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan: org.plan,
    created_at: isoTimestamp(org.createdAt),
    updated_at: isoTimestamp(org.updatedAt),
  };
}

type NotificationRow = typeof notifications.$inferSelect;

/** The fields every notification listing shares (user and admin views). */
function notificationBaseJson(n: NotificationRow) {
  return {
    id: n.id,
    title: n.title,
    message: n.message,
    type: n.type,
  };
}

/** A notification as an end user (or anonymous visitor) sees it. */
function userNotificationJson(n: NotificationRow) {
  return {
    ...notificationBaseJson(n),
    dismissible: n.dismissible,
    action: n.actionLabel && n.actionUrl ? { label: n.actionLabel, url: n.actionUrl } : undefined,
    createdAt: isoTimestamp(n.createdAt),
  };
}

/** A notification as the super-admin management screens see it. */
function adminNotificationJson(n: NotificationRow) {
  return {
    ...notificationBaseJson(n),
    visibility: n.visibility,
    dismissible: n.dismissible,
    organizationId: n.organizationId,
    startsAt: isoTimestamp(n.startsAt),
    endsAt: isoTimestamp(n.endsAt),
    actionLabel: n.actionLabel,
    actionUrl: n.actionUrl,
    isActive: n.isActive,
  };
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

  // Fetch the user's own memberships with their organizations. RLS would also
  // show the other members of the user's orgs, so filter to the user's rows:
  // the client reads `role` from here as the caller's role in each org.
  let userMemberships: Array<{
    id: string;
    role: string | null;
    organization: ReturnType<typeof organizationJson>;
  }>;
  try {
    const rows = await withUserDb(user.id, (tx) =>
      tx
        .select({ id: memberships.id, role: memberships.role, organization: organizations })
        .from(memberships)
        .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
        .where(eq(memberships.userId, user.id))
    );
    userMemberships = rows.map((m) => ({
      id: m.id,
      role: m.role,
      organization: organizationJson(m.organization),
    }));
  } catch (error) {
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
    memberships: userMemberships,
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
  const userMemberships = await adminDb
    .select({ organizationId: memberships.organizationId })
    .from(memberships)
    .where(eq(memberships.userId, user.id));

  if (userMemberships.length > 0) {
    for (const membership of userMemberships) {
      const [{ value: memberCount }] = await adminDb
        .select({ value: count() })
        .from(memberships)
        .where(eq(memberships.organizationId, membership.organizationId));

      if (memberCount === 1) {
        const [org] = await adminDb
          .select({ name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, membership.organizationId))
          .limit(1);

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
  const [customer] = await adminDb
    .select({ stripeCustomerId: customers.stripeCustomerId })
    .from(customers)
    .where(and(eq(customers.userId, user.id), isNull(customers.organizationId)))
    .limit(1);

  if (customer?.stripeCustomerId) {
    try {
      const { isStripeConfigured, getStripe } = await import('../../lib/stripe');
      if (isStripeConfigured()) {
        const stripe = getStripe();
        const subscriptions = await stripe.subscriptions.list({
          customer: customer.stripeCustomerId,
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

  // The org row and the creator's OWNER membership go in through adminDb, in
  // one transaction: the creator is not a member until the membership exists,
  // so RLS would hide the new org from them, and a failed membership insert
  // must not leave an ownerless org behind.
  let org: OrganizationRow;
  try {
    org = await adminDb.transaction(async (tx) => {
      const [created] = await tx
        .insert(organizations)
        .values({ name: body.name, slug: body.slug })
        .returning();
      try {
        await tx
          .insert(memberships)
          .values({ userId: user.id, organizationId: created.id, role: 'OWNER' });
      } catch (memberError) {
        throw new MembershipInsertError(memberError);
      }
      return created;
    });
  } catch (error) {
    if (error instanceof MembershipInsertError) {
      return c.json({ error: sanitizeError(error.cause, 'Failed to create membership') }, 400);
    }
    // Check for unique constraint violation
    if (pgErrorCode(error) === '23505') {
      return c.json({ error: 'An organization with this slug already exists' }, 400);
    }
    return c.json({ error: sanitizeError(error, 'Failed to create organization') }, 400);
  }

  return c.json({ organization: organizationJson(org) }, 201);
});

// List user's organizations
v1Routes.get('/organizations', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // RLS returns exactly the organizations the user belongs to.
  try {
    const rows = await withUserDb(user.id, (tx) => tx.select().from(organizations));
    return c.json({ organizations: rows.map(organizationJson) });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch organizations') }, 500);
  }
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

  // biome-ignore lint/style/noNonNullAssertion: orgId is always defined when this route matches
  const orgId = c.req.param('orgId')!;

  // RLS returns rows only if the caller is a member of this organization.
  let members: Array<{ id: string; role: string | null; createdAt: string; userId: string }>;
  try {
    members = await withUserDb(user.id, (tx) =>
      tx
        .select({
          id: memberships.id,
          role: memberships.role,
          createdAt: memberships.createdAt,
          userId: memberships.userId,
        })
        .from(memberships)
        .where(eq(memberships.organizationId, orgId))
    );
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch members') }, 500);
  }

  // If no members returned, either org doesn't exist or user isn't a member
  if (members.length === 0) {
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
        const { data, error } = await supabaseAdmin.auth.admin.getUserById(member.userId);
        if (!error && data?.user) {
          userDetailsMap.set(member.userId, {
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
    createdAt: isoTimestamp(member.createdAt),
    user: userDetailsMap.get(member.userId) || null,
  }));

  return c.json({ members: membersWithDetails });
});

// Add member to organization
v1Routes.post('/organizations/:orgId/members', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // biome-ignore lint/style/noNonNullAssertion: orgId is always defined when this route matches
  const orgId = c.req.param('orgId')!;

  // Check if user has admin access
  if (!(await hasOrgAdminAccess(user.id, orgId))) {
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
  const [existingMembership] = await adminDb
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, targetUser.id), eq(memberships.organizationId, orgId)))
    .limit(1);

  if (existingMembership) {
    return c.json({ error: 'User is already a member of this organization' }, 400);
  }

  // Add membership using admin client
  let membership: typeof memberships.$inferSelect;
  try {
    [membership] = await adminDb
      .insert(memberships)
      .values({ userId: targetUser.id, organizationId: orgId, role: body.role })
      .returning();
  } catch (memberError) {
    return c.json({ error: sanitizeError(memberError, 'Failed to add member') }, 500);
  }

  logger.info(
    { orgId, targetUserId: targetUser.id, role: body.role, addedBy: user.id },
    'Member added to organization'
  );

  // Send invite email (fire-and-forget, don't block response)
  const [orgData] = await adminDb
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

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
        createdAt: isoTimestamp(membership.createdAt),
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

  // biome-ignore lint/style/noNonNullAssertion: orgId is always defined when this route matches
  const orgId = c.req.param('orgId')!;
  // biome-ignore lint/style/noNonNullAssertion: userId is always defined when this route matches
  const targetUserId = c.req.param('userId')!;

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

  // Current user's role and the target's, both read as the caller under RLS
  const { currentUserRole, targetUserRole } = await withUserDb(user.id, async (tx) => ({
    currentUserRole: await getUserOrgRole(tx, user.id, orgId),
    targetUserRole: await getUserOrgRole(tx, targetUserId, orgId),
  }));

  if (!currentUserRole) {
    return c.json({ error: 'Organization not found or access denied' }, 404);
  }

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

  // Update the role using admin client. An ownership transfer also demotes
  // the current owner to admin, in the same transaction so the org never ends
  // up with two owners or none.
  try {
    await adminDb.transaction(async (tx) => {
      await tx
        .update(memberships)
        .set({ role: body.role })
        .where(and(eq(memberships.userId, targetUserId), eq(memberships.organizationId, orgId)));

      if (body.role === 'OWNER' && user.id !== targetUserId) {
        await tx
          .update(memberships)
          .set({ role: 'ADMIN' })
          .where(and(eq(memberships.userId, user.id), eq(memberships.organizationId, orgId)));
      }
    });
  } catch (updateError) {
    return c.json({ error: sanitizeError(updateError, 'Failed to update role') }, 500);
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

  // biome-ignore lint/style/noNonNullAssertion: orgId is always defined when this route matches
  const orgId = c.req.param('orgId')!;
  // biome-ignore lint/style/noNonNullAssertion: userId is always defined when this route matches
  const targetUserId = c.req.param('userId')!;

  // Current user's role and the target's, both read as the caller under RLS
  const { currentUserRole, targetUserRole } = await withUserDb(user.id, async (tx) => ({
    currentUserRole: await getUserOrgRole(tx, user.id, orgId),
    targetUserRole: await getUserOrgRole(tx, targetUserId, orgId),
  }));

  if (!currentUserRole) {
    return c.json({ error: 'Organization not found or access denied' }, 404);
  }

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
      const [{ value: ownerCount }] = await adminDb
        .select({ value: count() })
        .from(memberships)
        .where(and(eq(memberships.organizationId, orgId), eq(memberships.role, 'OWNER')));

      if (ownerCount === 1) {
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
  try {
    await adminDb
      .delete(memberships)
      .where(and(eq(memberships.userId, targetUserId), eq(memberships.organizationId, orgId)));
  } catch (deleteError) {
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

  // Only the owner can delete
  const role = await withUserDb(user.id, (tx) => getUserOrgRole(tx, user.id, orgId));

  if (!role) {
    return c.json({ error: 'Organization not found or access denied' }, 404);
  }

  if (role !== 'OWNER') {
    return c.json({ error: 'Only the organization owner can delete the organization' }, 403);
  }

  // Cannot delete the user's last organization
  const [{ value: orgCount }] = await adminDb
    .select({ value: count() })
    .from(memberships)
    .where(eq(memberships.userId, user.id));

  if (orgCount <= 1) {
    return c.json(
      { error: 'You cannot delete your only organization. Create another organization first.' },
      400
    );
  }

  // Delete all memberships first, then the organization, as one unit
  try {
    await adminDb.transaction(async (tx) => {
      await tx.delete(memberships).where(eq(memberships.organizationId, orgId));
      await tx.delete(organizations).where(eq(organizations.id, orgId));
    });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to delete organization') }, 500);
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

  // Search filter (input validated to [a-zA-Z0-9@.\-_ ] via Zod schema, and
  // bound as a parameter). Underscore acts as a single-char wildcard in ILIKE,
  // acceptable for admin search.
  const where = search
    ? or(ilike(organizations.name, `%${search}%`), ilike(organizations.slug, `%${search}%`))
    : undefined;

  // Sorting (validated against allowed values; 'email' does not apply here)
  const sortColumns = {
    name: organizations.name,
    slug: organizations.slug,
    plan: organizations.plan,
    created_at: organizations.createdAt,
  } as const;
  const sortColumn = sortBy in sortColumns ? sortColumns[sortBy as keyof typeof sortColumns] : null;
  const orderBy = sortColumn ? [sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn)] : [];

  let rows: Array<OrganizationRow & { memberCount: number }>;
  let total: number;
  try {
    // Admin client (bypasses RLS)
    rows = await adminDb
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        plan: organizations.plan,
        createdAt: organizations.createdAt,
        updatedAt: organizations.updatedAt,
        memberCount: sql<number>`(select count(*) from ${memberships} where ${memberships.organizationId} = ${organizations.id})::int`,
      })
      .from(organizations)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset);
    [{ value: total }] = await adminDb.select({ value: count() }).from(organizations).where(where);
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch organizations') }, 500);
  }

  return c.json({
    organizations: rows.map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: org.plan,
      memberCount: org.memberCount || 0,
      createdAt: isoTimestamp(org.createdAt),
      updatedAt: isoTimestamp(org.updatedAt),
    })),
    pagination: {
      page,
      limit,
      total: total || 0,
      totalPages: Math.ceil((total || 0) / limit),
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
  const userMemberships =
    userIds.length > 0
      ? await adminDb
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(inArray(memberships.userId, userIds))
      : [];

  const membershipCounts = new Map<string, number>();
  for (const m of userMemberships) {
    membershipCounts.set(m.userId, (membershipCounts.get(m.userId) || 0) + 1);
  }

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
    try {
      const rows = await adminDb
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.isActive, true),
            inArray(notifications.visibility, ['all', 'public']),
            isNull(notifications.organizationId),
            or(isNull(notifications.startsAt), lte(notifications.startsAt, now)),
            or(isNull(notifications.endsAt), gt(notifications.endsAt, now))
          )
        )
        .orderBy(desc(notifications.createdAt));
      return c.json({ notifications: rows.map(userNotificationJson) });
    } catch (error) {
      return c.json({ error: sanitizeError(error, 'Failed to fetch notifications') }, 500);
    }
  }

  // Active notifications (RLS handles visibility) and the user's dismissals
  // (RLS limits them to the user's own), in one transaction.
  let visible: NotificationRow[];
  let dismissedIds: Set<string>;
  try {
    ({ visible, dismissedIds } = await withUserDb(user.id, async (tx) => {
      const rows = await tx.select().from(notifications).orderBy(desc(notifications.createdAt));
      const dismissals = await tx
        .select({ notificationId: notificationDismissals.notificationId })
        .from(notificationDismissals)
        .where(eq(notificationDismissals.userId, user.id));
      return { visible: rows, dismissedIds: new Set(dismissals.map((d) => d.notificationId)) };
    }));
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch notifications') }, 500);
  }

  // Filter out dismissed notifications and format response
  const activeNotifications = visible
    .filter((n) => !dismissedIds.has(n.id))
    .map(userNotificationJson);

  return c.json({ notifications: activeNotifications });
});

// Dismiss a notification
v1Routes.post('/notifications/:notificationId/dismiss', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const notificationId = c.req.param('notificationId');

  // A malformed id can name no notification
  if (!isUuid(notificationId)) {
    return c.json({ error: 'Notification not found' }, 404);
  }

  let outcome: 'not_found' | 'not_dismissible' | 'dismissed';
  try {
    outcome = await withUserDb(user.id, async (tx) => {
      // Check the notification exists (as RLS lets this user see it) and is dismissible
      const [notification] = await tx
        .select({ id: notifications.id, dismissible: notifications.dismissible })
        .from(notifications)
        .where(eq(notifications.id, notificationId))
        .limit(1);

      if (!notification) return 'not_found';
      if (!notification.dismissible) return 'not_dismissible';

      // Create dismissal record; an existing one (already dismissed) is fine
      await tx
        .insert(notificationDismissals)
        .values({ notificationId, userId: user.id })
        .onConflictDoNothing();
      return 'dismissed';
    });
  } catch (dismissError) {
    return c.json({ error: sanitizeError(dismissError, 'Failed to dismiss notification') }, 500);
  }

  if (outcome === 'not_found') {
    return c.json({ error: 'Notification not found' }, 404);
  }

  if (outcome === 'not_dismissible') {
    return c.json({ error: 'This notification cannot be dismissed' }, 400);
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
  let rows: NotificationRow[];
  try {
    rows = await adminDb.select().from(notifications).orderBy(desc(notifications.createdAt));
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch notifications') }, 500);
  }

  return c.json({
    notifications: rows.map((n) => ({
      ...adminNotificationJson(n),
      createdBy: n.createdBy,
      createdAt: isoTimestamp(n.createdAt),
      updatedAt: isoTimestamp(n.updatedAt),
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

  let notification: NotificationRow;
  try {
    [notification] = await adminDb
      .insert(notifications)
      .values({
        title: body.title,
        message: body.message,
        type: body.type,
        visibility: body.visibility,
        dismissible: body.dismissible,
        organizationId: body.organizationId,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        actionLabel: body.actionLabel,
        actionUrl: body.actionUrl,
        isActive: body.isActive,
        createdBy: user.id,
      })
      .returning();
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to create notification') }, 500);
  }

  logger.info({ notificationId: notification.id, createdBy: user.id }, 'Notification created');

  return c.json(
    {
      notification: {
        ...adminNotificationJson(notification),
        createdAt: isoTimestamp(notification.createdAt),
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

  // Only the fields the request carried
  const updateData: Partial<typeof notifications.$inferInsert> = {};
  if (body.title !== undefined) updateData.title = body.title;
  if (body.message !== undefined) updateData.message = body.message;
  if (body.type !== undefined) updateData.type = body.type;
  if (body.visibility !== undefined) updateData.visibility = body.visibility;
  if (body.dismissible !== undefined) updateData.dismissible = body.dismissible;
  if (body.organizationId !== undefined) updateData.organizationId = body.organizationId;
  if (body.startsAt !== undefined) updateData.startsAt = body.startsAt;
  if (body.endsAt !== undefined) updateData.endsAt = body.endsAt;
  if (body.actionLabel !== undefined) updateData.actionLabel = body.actionLabel;
  if (body.actionUrl !== undefined) updateData.actionUrl = body.actionUrl;
  if (body.isActive !== undefined) updateData.isActive = body.isActive;

  let notification: NotificationRow | undefined;
  try {
    // An empty body changes nothing; answer with the row as it stands.
    [notification] =
      Object.keys(updateData).length > 0
        ? await adminDb
            .update(notifications)
            .set(updateData)
            .where(eq(notifications.id, notificationId))
            .returning()
        : await adminDb
            .select()
            .from(notifications)
            .where(eq(notifications.id, notificationId))
            .limit(1);
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to update notification') }, 500);
  }

  if (!notification) {
    return c.json({ error: 'Notification not found' }, 404);
  }

  logger.info({ notificationId, updatedBy: user.id }, 'Notification updated');

  return c.json({
    notification: {
      ...adminNotificationJson(notification),
      updatedAt: isoTimestamp(notification.updatedAt),
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

  try {
    await adminDb.delete(notifications).where(eq(notifications.id, notificationId));
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to delete notification') }, 500);
  }

  logger.info({ notificationId, deletedBy: user.id }, 'Notification deleted');

  return c.json({ success: true });
});

export { v1Routes };
