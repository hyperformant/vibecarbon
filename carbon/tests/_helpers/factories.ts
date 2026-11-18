import { randomBytes } from 'node:crypto';
import type { AuthUser } from '../../src/server/auth';

/**
 * Lightweight factories that produce plausible domain objects for tests.
 *
 * These don't touch the DB — they return plain TS objects you can hand to
 * a mocked module's resolved value (e.g. `mockResolvedValue(makeUser())`).
 *
 * Add new factories here as you write tests; the test-maintainer agent
 * follows this pattern when extending coverage.
 */

function rid(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

/** A platform super admin, as the session middleware sets `c.get('user')`. */
export const SUPER_ADMIN: Partial<AuthUser> = { id: 'admin-1', role: 'super_admin' };

export interface TestUser {
  id: string;
  email: string;
  user_metadata: { full_name?: string };
}

export function makeUser(overrides: Partial<TestUser> = {}): TestUser {
  return {
    id: rid('user'),
    email: `${rid('user')}@example.test`,
    user_metadata: { full_name: 'Test User' },
    ...overrides,
  };
}

export interface TestOrg {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
}

export function makeOrg(overrides: Partial<TestOrg> = {}): TestOrg {
  const id = rid('org');
  return {
    id,
    name: 'Test Org',
    slug: id,
    owner_id: rid('user'),
    ...overrides,
  };
}

export interface ContactSubmission {
  name: string;
  email: string;
  subject: string;
  message: string;
  website?: string;
}

export function makeContactSubmission(
  overrides: Partial<ContactSubmission> = {},
): ContactSubmission {
  return {
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    subject: 'Hello',
    message: 'Just dropping a line — this is a test message.',
    ...overrides,
  };
}
