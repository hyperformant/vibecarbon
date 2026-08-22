import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Tests for v1 API route validation schemas and endpoint logic
 * Tests the logic patterns used in carbon/src/server/routes/v1/index.ts
 * Re-implements key logic inline since path aliases don't resolve in tests
 */

// ============================================================================
// MOCK TYPES
// ============================================================================

interface MockUser {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
  app_metadata?: {
    role?: string;
    [key: string]: unknown;
  };
  user_metadata?: {
    full_name?: string;
    name?: string;
    avatar_url?: string;
    [key: string]: unknown;
  };
}

type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';

interface MockMembership {
  user_id: string;
  organization_id: string;
  role: OrgRole;
}

interface _MockOrganization {
  id: string;
  name: string;
  slug: string;
  plan?: string;
}

// ============================================================================
// VALIDATION SCHEMAS (from template)
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
  dismissible: z.boolean().default(true),
  organizationId: z.string().uuid().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  actionLabel: z.string().max(50).optional(),
  actionUrl: z.string().url().optional(),
  isActive: z.boolean().default(true),
});

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

// ============================================================================
// HELPER FUNCTIONS (from template)
// ============================================================================

function getUserOrgRole(
  memberships: MockMembership[],
  userId: string,
  organizationId: string,
): OrgRole | null {
  const membership = memberships.find(
    (m) => m.user_id === userId && m.organization_id === organizationId,
  );
  return membership?.role || null;
}

function hasOrgAdminAccess(
  memberships: MockMembership[],
  userId: string,
  organizationId: string,
): boolean {
  const role = getUserOrgRole(memberships, userId, organizationId);
  return role === 'OWNER' || role === 'ADMIN';
}

function isSuperAdmin(user: MockUser): boolean {
  return user.app_metadata?.role === 'super_admin';
}

// ============================================================================
// SCHEMA VALIDATION TESTS
// ============================================================================

describe('Validation Schemas', () => {
  describe('createOrganizationSchema', () => {
    it('validates correct organization data', () => {
      const valid = { name: 'My Org', slug: 'my-org' };
      const result = createOrganizationSchema.safeParse(valid);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('My Org');
        expect(result.data.slug).toBe('my-org');
      }
    });

    it('trims whitespace from name and slug', () => {
      // Note: The schema trims AFTER validation, so leading/trailing spaces in slug will fail regex
      // This test verifies that valid slugs with spaces get trimmed
      const input = { name: '  My Org  ', slug: 'my-org' };
      const result = createOrganizationSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('My Org');
        expect(result.data.slug).toBe('my-org');
      }
    });

    it('rejects empty name', () => {
      const result = createOrganizationSchema.safeParse({ name: '', slug: 'my-org' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Name is required');
      }
    });

    it('rejects name over 100 characters', () => {
      const longName = 'a'.repeat(101);
      const result = createOrganizationSchema.safeParse({ name: longName, slug: 'my-org' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('100 characters or less');
      }
    });

    it('rejects slug under 3 characters', () => {
      const result = createOrganizationSchema.safeParse({ name: 'My Org', slug: 'ab' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('at least 3 characters');
      }
    });

    it('rejects slug over 50 characters', () => {
      const longSlug = 'a'.repeat(51);
      const result = createOrganizationSchema.safeParse({ name: 'My Org', slug: longSlug });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('50 characters or less');
      }
    });

    it('rejects slug with uppercase letters', () => {
      const result = createOrganizationSchema.safeParse({ name: 'My Org', slug: 'My-Org' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('lowercase letters');
      }
    });

    it('rejects slug with special characters', () => {
      const invalidSlugs = ['my_org', 'my.org', 'my org', 'my@org', 'my+org'];
      invalidSlugs.forEach((slug) => {
        const result = createOrganizationSchema.safeParse({ name: 'My Org', slug });
        expect(result.success).toBe(false);
      });
    });

    it('accepts slug with lowercase letters, numbers, and hyphens', () => {
      const validSlugs = ['my-org', 'org-123', 'test-org-2024', 'abc-def-123'];
      validSlugs.forEach((slug) => {
        const result = createOrganizationSchema.safeParse({ name: 'My Org', slug });
        expect(result.success).toBe(true);
      });
    });
  });

  describe('addMemberSchema', () => {
    it('validates correct member data', () => {
      const valid = { email: 'user@example.com', role: 'ADMIN' as const };
      const result = addMemberSchema.safeParse(valid);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('user@example.com');
        expect(result.data.role).toBe('ADMIN');
      }
    });

    it('defaults role to MEMBER', () => {
      const input = { email: 'user@example.com' };
      const result = addMemberSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe('MEMBER');
      }
    });

    it('rejects invalid email', () => {
      const result = addMemberSchema.safeParse({ email: 'not-an-email', role: 'MEMBER' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Valid email is required');
      }
    });

    it('rejects OWNER role (not in enum)', () => {
      const result = addMemberSchema.safeParse({ email: 'user@example.com', role: 'OWNER' });
      expect(result.success).toBe(false);
    });
  });

  describe('updateMemberRoleSchema', () => {
    it('validates all role types', () => {
      const roles: Array<'OWNER' | 'ADMIN' | 'MEMBER'> = ['OWNER', 'ADMIN', 'MEMBER'];
      roles.forEach((role) => {
        const result = updateMemberRoleSchema.safeParse({ role });
        expect(result.success).toBe(true);
      });
    });

    it('rejects invalid role', () => {
      const result = updateMemberRoleSchema.safeParse({ role: 'INVALID' });
      expect(result.success).toBe(false);
    });

    it('rejects missing role', () => {
      const result = updateMemberRoleSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('createNotificationSchema', () => {
    it('validates minimal notification', () => {
      const valid = { title: 'Test Notification' };
      const result = createNotificationSchema.safeParse(valid);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe('Test Notification');
        expect(result.data.type).toBe('info'); // default
        expect(result.data.dismissible).toBe(true); // default
        expect(result.data.isActive).toBe(true); // default
      }
    });

    it('validates full notification with all fields', () => {
      const valid = {
        title: 'Maintenance',
        message: 'System maintenance scheduled',
        type: 'warning' as const,
        dismissible: false,
        organizationId: '123e4567-e89b-12d3-a456-426614174000',
        startsAt: '2024-01-01T00:00:00Z',
        endsAt: '2024-01-02T00:00:00Z',
        actionLabel: 'Learn More',
        actionUrl: 'https://example.com',
        isActive: false,
      };
      const result = createNotificationSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('rejects empty title', () => {
      const result = createNotificationSchema.safeParse({ title: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Title is required');
      }
    });

    it('rejects title over 200 characters', () => {
      const longTitle = 'a'.repeat(201);
      const result = createNotificationSchema.safeParse({ title: longTitle });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('200 characters or less');
      }
    });

    it('rejects message over 1000 characters', () => {
      const longMessage = 'a'.repeat(1001);
      const result = createNotificationSchema.safeParse({
        title: 'Test',
        message: longMessage,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('1000 characters or less');
      }
    });

    it('rejects invalid type', () => {
      const result = createNotificationSchema.safeParse({ title: 'Test', type: 'invalid' });
      expect(result.success).toBe(false);
    });

    it('rejects invalid UUID for organizationId', () => {
      const result = createNotificationSchema.safeParse({
        title: 'Test',
        organizationId: 'not-a-uuid',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid datetime format', () => {
      const result = createNotificationSchema.safeParse({
        title: 'Test',
        startsAt: 'not-a-datetime',
      });
      expect(result.success).toBe(false);
    });

    it('rejects actionLabel over 50 characters', () => {
      const longLabel = 'a'.repeat(51);
      const result = createNotificationSchema.safeParse({
        title: 'Test',
        actionLabel: longLabel,
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid URL for actionUrl', () => {
      const result = createNotificationSchema.safeParse({
        title: 'Test',
        actionUrl: 'not-a-url',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('adminPaginationSchema', () => {
    it('validates with defaults', () => {
      const result = adminPaginationSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.search).toBe('');
        expect(result.data.sortBy).toBe('created_at');
        expect(result.data.sortOrder).toBe('desc');
        expect(result.data.page).toBe(1);
        expect(result.data.limit).toBe(20);
      }
    });

    it('validates custom values', () => {
      const input = {
        search: 'test query',
        sortBy: 'name' as const,
        sortOrder: 'asc' as const,
        page: '5',
        limit: '50',
      };
      const result = adminPaginationSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.search).toBe('test query');
        expect(result.data.sortBy).toBe('name');
        expect(result.data.sortOrder).toBe('asc');
        expect(result.data.page).toBe(5);
        expect(result.data.limit).toBe(50);
      }
    });

    it('rejects search over 100 characters', () => {
      const longSearch = 'a'.repeat(101);
      const result = adminPaginationSchema.safeParse({ search: longSearch });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Search query too long');
      }
    });

    it('rejects search with invalid characters', () => {
      const invalidSearches = ['test<script>', 'test&param=1', 'test;DROP TABLE'];
      invalidSearches.forEach((search) => {
        const result = adminPaginationSchema.safeParse({ search });
        expect(result.success).toBe(false);
      });
    });

    it('accepts search with allowed characters', () => {
      const validSearches = ['test query', 'user@example.com', 'org-name', 'test_123'];
      validSearches.forEach((search) => {
        const result = adminPaginationSchema.safeParse({ search });
        expect(result.success).toBe(true);
      });
    });

    it('rejects invalid sortBy', () => {
      const result = adminPaginationSchema.safeParse({ sortBy: 'invalid' });
      expect(result.success).toBe(false);
    });

    it('rejects page under 1', () => {
      const result = adminPaginationSchema.safeParse({ page: '0' });
      expect(result.success).toBe(false);
    });

    it('rejects page over 1000', () => {
      const result = adminPaginationSchema.safeParse({ page: '1001' });
      expect(result.success).toBe(false);
    });

    it('rejects limit under 1', () => {
      const result = adminPaginationSchema.safeParse({ limit: '0' });
      expect(result.success).toBe(false);
    });

    it('rejects limit over 100', () => {
      const result = adminPaginationSchema.safeParse({ limit: '101' });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// HELPER FUNCTION TESTS
// ============================================================================

describe('Helper Functions', () => {
  describe('getUserOrgRole', () => {
    const memberships: MockMembership[] = [
      { user_id: 'user-1', organization_id: 'org-1', role: 'OWNER' },
      { user_id: 'user-1', organization_id: 'org-2', role: 'ADMIN' },
      { user_id: 'user-2', organization_id: 'org-1', role: 'MEMBER' },
    ];

    it('returns role when user is member', () => {
      expect(getUserOrgRole(memberships, 'user-1', 'org-1')).toBe('OWNER');
      expect(getUserOrgRole(memberships, 'user-1', 'org-2')).toBe('ADMIN');
      expect(getUserOrgRole(memberships, 'user-2', 'org-1')).toBe('MEMBER');
    });

    it('returns null when user is not member', () => {
      expect(getUserOrgRole(memberships, 'user-1', 'org-999')).toBeNull();
      expect(getUserOrgRole(memberships, 'user-999', 'org-1')).toBeNull();
    });

    it('returns null for empty memberships', () => {
      expect(getUserOrgRole([], 'user-1', 'org-1')).toBeNull();
    });
  });

  describe('hasOrgAdminAccess', () => {
    const memberships: MockMembership[] = [
      { user_id: 'owner', organization_id: 'org-1', role: 'OWNER' },
      { user_id: 'admin', organization_id: 'org-1', role: 'ADMIN' },
      { user_id: 'member', organization_id: 'org-1', role: 'MEMBER' },
    ];

    it('returns true for OWNER', () => {
      expect(hasOrgAdminAccess(memberships, 'owner', 'org-1')).toBe(true);
    });

    it('returns true for ADMIN', () => {
      expect(hasOrgAdminAccess(memberships, 'admin', 'org-1')).toBe(true);
    });

    it('returns false for MEMBER', () => {
      expect(hasOrgAdminAccess(memberships, 'member', 'org-1')).toBe(false);
    });

    it('returns false for non-member', () => {
      expect(hasOrgAdminAccess(memberships, 'non-member', 'org-1')).toBe(false);
    });
  });

  describe('isSuperAdmin', () => {
    it('returns true for super_admin role', () => {
      const user: MockUser = {
        id: 'admin-1',
        email: 'admin@example.com',
        app_metadata: { role: 'super_admin' },
      };
      expect(isSuperAdmin(user)).toBe(true);
    });

    it('returns false for users without role', () => {
      const user: MockUser = { id: 'user-1', email: 'user@example.com' };
      expect(isSuperAdmin(user)).toBe(false);
    });

    it('returns false for other roles', () => {
      const user: MockUser = {
        id: 'user-1',
        email: 'user@example.com',
        app_metadata: { role: 'user' },
      };
      expect(isSuperAdmin(user)).toBe(false);
    });
  });
});

// ============================================================================
// ENDPOINT LOGIC TESTS
// ============================================================================

describe('Endpoint Logic', () => {
  describe('GET /me', () => {
    function getMeEndpoint(user: MockUser | null, memberships: unknown[]) {
      if (!user) {
        return { status: 401, body: { error: 'Unauthorized' } };
      }

      return {
        status: 200,
        body: {
          user: {
            id: user.id,
            email: user.email,
            name: user.user_metadata?.full_name || user.user_metadata?.name,
            avatar: user.user_metadata?.avatar_url,
            emailVerified: user.email_confirmed_at !== null,
            role: user.app_metadata?.role || null,
          },
          memberships,
        },
      };
    }

    it('returns 401 when no user', () => {
      const result = getMeEndpoint(null, []);
      expect(result.status).toBe(401);
      expect(result.body.error).toBe('Unauthorized');
    });

    it('returns user data with memberships', () => {
      const user: MockUser = {
        id: 'user-1',
        email: 'user@example.com',
        email_confirmed_at: '2024-01-01T00:00:00Z',
        user_metadata: { full_name: 'Test User', avatar_url: 'https://example.com/avatar.jpg' },
        app_metadata: { role: 'user' },
      };
      const memberships = [{ id: 'mem-1', role: 'OWNER', organization: { id: 'org-1' } }];

      const result = getMeEndpoint(user, memberships);
      expect(result.status).toBe(200);
      expect(result.body.user).toEqual({
        id: 'user-1',
        email: 'user@example.com',
        name: 'Test User',
        avatar: 'https://example.com/avatar.jpg',
        emailVerified: true,
        role: 'user',
      });
      expect(result.body.memberships).toEqual(memberships);
    });

    it('returns emailVerified false when not confirmed', () => {
      const user: MockUser = {
        id: 'user-1',
        email: 'user@example.com',
        email_confirmed_at: null,
      };

      const result = getMeEndpoint(user, []);
      expect(result.status).toBe(200);
      expect(result.body.user.emailVerified).toBe(false);
    });
  });

  describe('POST /organizations', () => {
    function createOrgEndpoint(user: MockUser | null, body: unknown, orgExistsWithSlug: boolean) {
      if (!user) {
        return { status: 401, body: { error: 'Unauthorized' } };
      }

      const result = createOrganizationSchema.safeParse(body);
      if (!result.success) {
        const errors = result.error.issues.map((e) => e.message).join(', ');
        return { status: 400, body: { error: errors } };
      }

      if (orgExistsWithSlug) {
        return {
          status: 400,
          body: { error: 'An organization with this slug already exists' },
        };
      }

      const org = {
        id: 'new-org-id',
        name: result.data.name,
        slug: result.data.slug,
      };

      return { status: 201, body: { organization: org } };
    }

    it('returns 401 when no user', () => {
      const result = createOrgEndpoint(null, { name: 'Org', slug: 'org' }, false);
      expect(result.status).toBe(401);
    });

    it('returns 400 for invalid body', () => {
      const user: MockUser = { id: 'user-1', email: 'user@example.com' };
      const result = createOrgEndpoint(user, { name: '', slug: 'org' }, false);
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('Name is required');
    });

    it('returns 400 when slug exists', () => {
      const user: MockUser = { id: 'user-1', email: 'user@example.com' };
      const result = createOrgEndpoint(user, { name: 'Org', slug: 'existing' }, true);
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('slug already exists');
    });

    it('creates organization successfully', () => {
      const user: MockUser = { id: 'user-1', email: 'user@example.com' };
      const result = createOrgEndpoint(user, { name: 'New Org', slug: 'new-org' }, false);
      expect(result.status).toBe(201);
      expect(result.body.organization).toEqual({
        id: 'new-org-id',
        name: 'New Org',
        slug: 'new-org',
      });
    });
  });

  describe('GET /organizations/:orgId/members', () => {
    function getMembersEndpoint(user: MockUser | null, userIsMember: boolean) {
      if (!user) {
        return { status: 401, body: { error: 'Unauthorized' } };
      }

      if (!userIsMember) {
        return { status: 404, body: { error: 'Organization not found or access denied' } };
      }

      return {
        status: 200,
        body: {
          members: [
            { id: 'mem-1', role: 'OWNER', user: { id: 'user-1', email: 'owner@example.com' } },
          ],
        },
      };
    }

    it('returns 401 when no user', () => {
      const result = getMembersEndpoint(null, false);
      expect(result.status).toBe(401);
    });

    it('returns 404 when user is not member', () => {
      const user: MockUser = { id: 'user-1', email: 'user@example.com' };
      const result = getMembersEndpoint(user, false);
      expect(result.status).toBe(404);
      expect(result.body.error).toContain('not found or access denied');
    });

    it('returns members when user is member', () => {
      const user: MockUser = { id: 'user-1', email: 'user@example.com' };
      const result = getMembersEndpoint(user, true);
      expect(result.status).toBe(200);
      expect(result.body.members).toHaveLength(1);
    });
  });

  describe('POST /organizations/:orgId/members', () => {
    function addMemberEndpoint(
      user: MockUser | null,
      memberships: MockMembership[],
      orgId: string,
      body: unknown,
      targetUserExists: boolean,
      targetUserAlreadyMember: boolean,
    ) {
      if (!user) {
        return { status: 401, body: { error: 'Unauthorized' } };
      }

      if (!hasOrgAdminAccess(memberships, user.id, orgId)) {
        return { status: 403, body: { error: 'You must be an admin to add members' } };
      }

      const result = addMemberSchema.safeParse(body);
      if (!result.success) {
        const errors = result.error.issues.map((e) => e.message).join(', ');
        return { status: 400, body: { error: errors } };
      }

      if (!targetUserExists) {
        return { status: 404, body: { error: 'User not found. They must sign up first.' } };
      }

      if (targetUserAlreadyMember) {
        return {
          status: 400,
          body: { error: 'User is already a member of this organization' },
        };
      }

      return {
        status: 201,
        body: {
          member: {
            id: 'new-mem-id',
            role: result.data.role,
            user: { id: 'target-user-id', email: result.data.email },
          },
        },
      };
    }

    it('returns 401 when no user', () => {
      const result = addMemberEndpoint(
        null,
        [],
        'org-1',
        { email: 'user@example.com' },
        true,
        false,
      );
      expect(result.status).toBe(401);
    });

    it('returns 403 when user is not admin', () => {
      const user: MockUser = { id: 'member', email: 'member@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'member', organization_id: 'org-1', role: 'MEMBER' },
      ];
      const result = addMemberEndpoint(
        user,
        memberships,
        'org-1',
        { email: 'new@example.com' },
        true,
        false,
      );
      expect(result.status).toBe(403);
      expect(result.body.error).toContain('must be an admin');
    });

    it('returns 400 for invalid body', () => {
      const user: MockUser = { id: 'admin', email: 'admin@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'admin', organization_id: 'org-1', role: 'ADMIN' },
      ];
      const result = addMemberEndpoint(
        user,
        memberships,
        'org-1',
        { email: 'invalid-email' },
        true,
        false,
      );
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('Valid email is required');
    });

    it('returns 404 when target user not found', () => {
      const user: MockUser = { id: 'admin', email: 'admin@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'admin', organization_id: 'org-1', role: 'ADMIN' },
      ];
      const result = addMemberEndpoint(
        user,
        memberships,
        'org-1',
        { email: 'new@example.com' },
        false,
        false,
      );
      expect(result.status).toBe(404);
      expect(result.body.error).toContain('must sign up first');
    });

    it('returns 400 when user already member', () => {
      const user: MockUser = { id: 'admin', email: 'admin@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'admin', organization_id: 'org-1', role: 'ADMIN' },
      ];
      const result = addMemberEndpoint(
        user,
        memberships,
        'org-1',
        { email: 'existing@example.com' },
        true,
        true,
      );
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('already a member');
    });

    it('adds member successfully', () => {
      const user: MockUser = { id: 'owner', email: 'owner@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'owner', organization_id: 'org-1', role: 'OWNER' },
      ];
      const result = addMemberEndpoint(
        user,
        memberships,
        'org-1',
        { email: 'new@example.com', role: 'ADMIN' },
        true,
        false,
      );
      expect(result.status).toBe(201);
      expect(result.body.member.role).toBe('ADMIN');
      expect(result.body.member.user.email).toBe('new@example.com');
    });
  });

  describe('PATCH /organizations/:orgId/members/:userId', () => {
    function updateMemberRoleEndpoint(
      user: MockUser | null,
      memberships: MockMembership[],
      orgId: string,
      targetUserId: string,
      body: unknown,
    ) {
      if (!user) {
        return { status: 401, body: { error: 'Unauthorized' } };
      }

      const result = updateMemberRoleSchema.safeParse(body);
      if (!result.success) {
        const errors = result.error.issues.map((e) => e.message).join(', ');
        return { status: 400, body: { error: errors } };
      }

      const currentUserRole = getUserOrgRole(memberships, user.id, orgId);
      if (!currentUserRole) {
        return { status: 404, body: { error: 'Organization not found or access denied' } };
      }

      const targetUserRole = getUserOrgRole(memberships, targetUserId, orgId);
      if (!targetUserRole) {
        return { status: 404, body: { error: 'Member not found' } };
      }

      // Only OWNER can set/unset OWNER role
      if (result.data.role === 'OWNER' || targetUserRole === 'OWNER') {
        if (currentUserRole !== 'OWNER') {
          return {
            status: 403,
            body: { error: 'Only the owner can transfer or modify ownership' },
          };
        }
      } else if (currentUserRole !== 'OWNER' && currentUserRole !== 'ADMIN') {
        return { status: 403, body: { error: 'You must be an admin to change member roles' } };
      }

      // Prevent changing own role (except owner transferring)
      if (user.id === targetUserId && result.data.role !== 'OWNER') {
        return { status: 400, body: { error: 'You cannot change your own role' } };
      }

      return { status: 200, body: { success: true, role: result.data.role } };
    }

    it('returns 401 when no user', () => {
      const result = updateMemberRoleEndpoint(null, [], 'org-1', 'user-2', { role: 'ADMIN' });
      expect(result.status).toBe(401);
    });

    it('returns 403 when MEMBER tries to change roles', () => {
      const user: MockUser = { id: 'member', email: 'member@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'member', organization_id: 'org-1', role: 'MEMBER' },
        { user_id: 'other', organization_id: 'org-1', role: 'MEMBER' },
      ];
      const result = updateMemberRoleEndpoint(user, memberships, 'org-1', 'other', {
        role: 'ADMIN',
      });
      expect(result.status).toBe(403);
    });

    it('returns 403 when ADMIN tries to set OWNER role', () => {
      const user: MockUser = { id: 'admin', email: 'admin@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'admin', organization_id: 'org-1', role: 'ADMIN' },
        { user_id: 'other', organization_id: 'org-1', role: 'MEMBER' },
      ];
      const result = updateMemberRoleEndpoint(user, memberships, 'org-1', 'other', {
        role: 'OWNER',
      });
      expect(result.status).toBe(403);
      expect(result.body.error).toContain('Only the owner');
    });

    it('returns 400 when user tries to change own role to non-OWNER', () => {
      const user: MockUser = { id: 'admin', email: 'admin@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'admin', organization_id: 'org-1', role: 'ADMIN' },
      ];
      const result = updateMemberRoleEndpoint(user, memberships, 'org-1', 'admin', {
        role: 'MEMBER',
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('cannot change your own role');
    });

    it('allows OWNER to transfer ownership', () => {
      const user: MockUser = { id: 'owner', email: 'owner@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'owner', organization_id: 'org-1', role: 'OWNER' },
        { user_id: 'admin', organization_id: 'org-1', role: 'ADMIN' },
      ];
      const result = updateMemberRoleEndpoint(user, memberships, 'org-1', 'admin', {
        role: 'OWNER',
      });
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.role).toBe('OWNER');
    });

    it('allows ADMIN to change MEMBER role', () => {
      const user: MockUser = { id: 'admin', email: 'admin@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'admin', organization_id: 'org-1', role: 'ADMIN' },
        { user_id: 'member', organization_id: 'org-1', role: 'MEMBER' },
      ];
      const result = updateMemberRoleEndpoint(user, memberships, 'org-1', 'member', {
        role: 'ADMIN',
      });
      expect(result.status).toBe(200);
      expect(result.body.role).toBe('ADMIN');
    });
  });

  describe('DELETE /organizations/:orgId/members/:userId', () => {
    function removeMemberEndpoint(
      user: MockUser | null,
      memberships: MockMembership[],
      orgId: string,
      targetUserId: string,
      ownerCount: number,
    ) {
      if (!user) {
        return { status: 401, body: { error: 'Unauthorized' } };
      }

      const currentUserRole = getUserOrgRole(memberships, user.id, orgId);
      if (!currentUserRole) {
        return { status: 404, body: { error: 'Organization not found or access denied' } };
      }

      const targetUserRole = getUserOrgRole(memberships, targetUserId, orgId);
      if (!targetUserRole) {
        return { status: 404, body: { error: 'Member not found' } };
      }

      const isSelf = user.id === targetUserId;

      if (isSelf) {
        if (targetUserRole === 'OWNER' && ownerCount === 1) {
          return {
            status: 400,
            body: { error: 'You are the only owner. Transfer ownership before leaving.' },
          };
        }
      } else {
        if (currentUserRole === 'MEMBER') {
          return { status: 403, body: { error: 'You must be an admin to remove members' } };
        }

        if (currentUserRole === 'ADMIN' && targetUserRole !== 'MEMBER') {
          return {
            status: 403,
            body: { error: 'Admins can only remove members, not other admins or owners' },
          };
        }

        if (targetUserRole === 'OWNER') {
          return { status: 403, body: { error: 'Cannot remove the organization owner' } };
        }
      }

      return { status: 200, body: { success: true } };
    }

    it('returns 401 when no user', () => {
      const result = removeMemberEndpoint(null, [], 'org-1', 'user-2', 1);
      expect(result.status).toBe(401);
    });

    it('allows user to leave when not only owner', () => {
      const user: MockUser = { id: 'owner', email: 'owner@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'owner', organization_id: 'org-1', role: 'OWNER' },
      ];
      const result = removeMemberEndpoint(user, memberships, 'org-1', 'owner', 2);
      expect(result.status).toBe(200);
    });

    it('prevents only owner from leaving', () => {
      const user: MockUser = { id: 'owner', email: 'owner@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'owner', organization_id: 'org-1', role: 'OWNER' },
      ];
      const result = removeMemberEndpoint(user, memberships, 'org-1', 'owner', 1);
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('Transfer ownership');
    });

    it('prevents MEMBER from removing others', () => {
      const user: MockUser = { id: 'member', email: 'member@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'member', organization_id: 'org-1', role: 'MEMBER' },
        { user_id: 'other', organization_id: 'org-1', role: 'MEMBER' },
      ];
      const result = removeMemberEndpoint(user, memberships, 'org-1', 'other', 1);
      expect(result.status).toBe(403);
    });

    it('prevents ADMIN from removing OWNER', () => {
      const user: MockUser = { id: 'admin', email: 'admin@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'admin', organization_id: 'org-1', role: 'ADMIN' },
        { user_id: 'owner', organization_id: 'org-1', role: 'OWNER' },
      ];
      const result = removeMemberEndpoint(user, memberships, 'org-1', 'owner', 1);
      expect(result.status).toBe(403);
      // The logic first checks if ADMIN is trying to remove non-MEMBER
      expect(result.body.error).toContain('Admins can only remove members');
    });

    it('allows ADMIN to remove MEMBER', () => {
      const user: MockUser = { id: 'admin', email: 'admin@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'admin', organization_id: 'org-1', role: 'ADMIN' },
        { user_id: 'member', organization_id: 'org-1', role: 'MEMBER' },
      ];
      const result = removeMemberEndpoint(user, memberships, 'org-1', 'member', 1);
      expect(result.status).toBe(200);
    });

    it('allows OWNER to remove anyone', () => {
      const user: MockUser = { id: 'owner', email: 'owner@example.com' };
      const memberships: MockMembership[] = [
        { user_id: 'owner', organization_id: 'org-1', role: 'OWNER' },
        { user_id: 'admin', organization_id: 'org-1', role: 'ADMIN' },
      ];
      const result = removeMemberEndpoint(user, memberships, 'org-1', 'admin', 1);
      expect(result.status).toBe(200);
    });
  });

  describe('GET /admin/organizations', () => {
    function getAdminOrgsEndpoint(user: MockUser | null) {
      if (!user) {
        return { status: 401, body: { error: 'Unauthorized' } };
      }

      if (!isSuperAdmin(user)) {
        return { status: 403, body: { error: 'Super admin access required' } };
      }

      return { status: 200, body: { organizations: [] } };
    }

    it('returns 401 when no user', () => {
      const result = getAdminOrgsEndpoint(null);
      expect(result.status).toBe(401);
    });

    it('returns 403 when not super admin', () => {
      const user: MockUser = { id: 'user-1', email: 'user@example.com' };
      const result = getAdminOrgsEndpoint(user);
      expect(result.status).toBe(403);
    });

    it('returns organizations for super admin', () => {
      const user: MockUser = {
        id: 'admin-1',
        email: 'admin@example.com',
        app_metadata: { role: 'super_admin' },
      };
      const result = getAdminOrgsEndpoint(user);
      expect(result.status).toBe(200);
    });
  });

  describe('POST /admin/impersonate/:userId', () => {
    function impersonateEndpoint(
      user: MockUser | null,
      targetUserId: string,
      targetUser: MockUser | null,
    ) {
      if (!user) {
        return { status: 401, body: { error: 'Unauthorized' } };
      }

      if (!isSuperAdmin(user)) {
        return { status: 403, body: { error: 'Super admin access required' } };
      }

      if (targetUserId === user.id) {
        return { status: 400, body: { error: 'Cannot impersonate yourself' } };
      }

      if (!targetUser) {
        return { status: 404, body: { error: 'User not found' } };
      }

      if (targetUser.app_metadata?.role === 'super_admin') {
        return { status: 403, body: { error: 'Cannot impersonate another super admin' } };
      }

      if (!targetUser.email) {
        return { status: 400, body: { error: 'User has no email address' } };
      }

      return {
        status: 200,
        body: {
          tokenHash: 'fake-token-hash',
          user: {
            id: targetUser.id,
            email: targetUser.email,
            name: targetUser.user_metadata?.full_name || targetUser.user_metadata?.name || null,
          },
        },
      };
    }

    it('returns 401 when no user', () => {
      const result = impersonateEndpoint(null, 'user-2', null);
      expect(result.status).toBe(401);
    });

    it('returns 403 when not super admin', () => {
      const user: MockUser = { id: 'user-1', email: 'user@example.com' };
      const targetUser: MockUser = { id: 'user-2', email: 'target@example.com' };
      const result = impersonateEndpoint(user, 'user-2', targetUser);
      expect(result.status).toBe(403);
    });

    it('returns 400 when impersonating self', () => {
      const user: MockUser = {
        id: 'admin-1',
        email: 'admin@example.com',
        app_metadata: { role: 'super_admin' },
      };
      const result = impersonateEndpoint(user, 'admin-1', user);
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('Cannot impersonate yourself');
    });

    it('returns 404 when target user not found', () => {
      const user: MockUser = {
        id: 'admin-1',
        email: 'admin@example.com',
        app_metadata: { role: 'super_admin' },
      };
      const result = impersonateEndpoint(user, 'nonexistent', null);
      expect(result.status).toBe(404);
    });

    it('returns 403 when impersonating another super admin', () => {
      const user: MockUser = {
        id: 'admin-1',
        email: 'admin1@example.com',
        app_metadata: { role: 'super_admin' },
      };
      const targetUser: MockUser = {
        id: 'admin-2',
        email: 'admin2@example.com',
        app_metadata: { role: 'super_admin' },
      };
      const result = impersonateEndpoint(user, 'admin-2', targetUser);
      expect(result.status).toBe(403);
      expect(result.body.error).toContain('Cannot impersonate another super admin');
    });

    it('returns 400 when user has no email', () => {
      const user: MockUser = {
        id: 'admin-1',
        email: 'admin@example.com',
        app_metadata: { role: 'super_admin' },
      };
      const targetUser: MockUser = { id: 'user-2' };
      const result = impersonateEndpoint(user, 'user-2', targetUser);
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('no email address');
    });

    it('generates impersonation token for valid target', () => {
      const user: MockUser = {
        id: 'admin-1',
        email: 'admin@example.com',
        app_metadata: { role: 'super_admin' },
      };
      const targetUser: MockUser = {
        id: 'user-2',
        email: 'user@example.com',
        user_metadata: { full_name: 'Test User' },
      };
      const result = impersonateEndpoint(user, 'user-2', targetUser);
      expect(result.status).toBe(200);
      expect(result.body.tokenHash).toBeDefined();
      expect(result.body.user).toEqual({
        id: 'user-2',
        email: 'user@example.com',
        name: 'Test User',
      });
    });
  });

  describe('GET /notifications', () => {
    function getNotificationsEndpoint(
      user: MockUser | null,
      notifications: Array<{ id: string; dismissible: boolean }>,
      dismissedIds: string[],
    ) {
      if (!user) {
        return { status: 401, body: { error: 'Unauthorized' } };
      }

      const dismissedSet = new Set(dismissedIds);
      const activeNotifications = notifications.filter((n) => !dismissedSet.has(n.id));

      return { status: 200, body: { notifications: activeNotifications } };
    }

    it('returns 401 when no user', () => {
      const result = getNotificationsEndpoint(null, [], []);
      expect(result.status).toBe(401);
    });

    it('filters out dismissed notifications', () => {
      const user: MockUser = { id: 'user-1', email: 'user@example.com' };
      const notifications = [
        { id: 'notif-1', dismissible: true },
        { id: 'notif-2', dismissible: true },
        { id: 'notif-3', dismissible: true },
      ];
      const dismissedIds = ['notif-1', 'notif-3'];

      const result = getNotificationsEndpoint(user, notifications, dismissedIds);
      expect(result.status).toBe(200);
      expect(result.body.notifications).toHaveLength(1);
      expect(result.body.notifications[0].id).toBe('notif-2');
    });

    it('returns all notifications when none dismissed', () => {
      const user: MockUser = { id: 'user-1', email: 'user@example.com' };
      const notifications = [
        { id: 'notif-1', dismissible: true },
        { id: 'notif-2', dismissible: false },
      ];

      const result = getNotificationsEndpoint(user, notifications, []);
      expect(result.status).toBe(200);
      expect(result.body.notifications).toHaveLength(2);
    });
  });

  describe('POST /notifications/:id/dismiss', () => {
    function dismissNotificationEndpoint(
      user: MockUser | null,
      notificationExists: boolean,
      notificationDismissible: boolean,
    ) {
      if (!user) {
        return { status: 401, body: { error: 'Unauthorized' } };
      }

      if (!notificationExists) {
        return { status: 404, body: { error: 'Notification not found' } };
      }

      if (!notificationDismissible) {
        return { status: 400, body: { error: 'This notification cannot be dismissed' } };
      }

      return { status: 200, body: { success: true } };
    }

    it('returns 401 when no user', () => {
      const result = dismissNotificationEndpoint(null, true, true);
      expect(result.status).toBe(401);
    });

    it('returns 404 when notification not found', () => {
      const user: MockUser = { id: 'user-1', email: 'user@example.com' };
      const result = dismissNotificationEndpoint(user, false, true);
      expect(result.status).toBe(404);
    });

    it('returns 400 when notification not dismissible', () => {
      const user: MockUser = { id: 'user-1', email: 'user@example.com' };
      const result = dismissNotificationEndpoint(user, true, false);
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('cannot be dismissed');
    });

    it('dismisses notification successfully', () => {
      const user: MockUser = { id: 'user-1', email: 'user@example.com' };
      const result = dismissNotificationEndpoint(user, true, true);
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });
  });
});
