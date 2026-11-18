import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '@server/auth';
import { appWithUser } from '../../../_helpers/app';
import { SUPER_ADMIN } from '../../../_helpers/factories';

// The user, organization, membership and notification routes of
// routes/v1/index.ts, requested through the real handlers. The database is a
// double with two sides, as the routes use it:
// - withUserDb reads `db.visible`: the rows RLS would let the caller see, by
//   table, narrowed by the equality filters the handler's own WHERE carries.
// - adminDb reads come from `db.admin`, one result per query in the order the
//   handler asks; every query's bound values land in `db.reads`.
// Every insert, update and delete, on either side, lands in `db.writes`.

interface Call {
  op: 'select' | 'insert' | 'update' | 'delete';
  table: string;
  values?: Record<string, unknown>;
  params: unknown[];
  sql: string;
  limit?: number;
  offset?: number;
}

const db = vi.hoisted(() => ({
  visible: {} as Record<string, Array<Record<string, unknown>>>,
  admin: [] as unknown[][],
  reads: [] as Call[],
  writes: [] as Call[],
  /** Return an error to make that write fail. */
  fail: undefined as undefined | ((call: Call) => unknown),
  /** Set to make every write return these rows instead of the row it wrote. */
  returned: undefined as undefined | unknown[],
}));

const AT = '2026-01-01 00:00:00+00';
const AT_JSON = '2026-01-01T00:00:00+00:00';
const NEW_ID = '00000000-0000-4000-8000-0000000000ff';

vi.mock('@server/db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const dialect = new PgDialect();
  const camel = (column: string) => column.replace(/_(\w)/g, (_m, ch: string) => ch.toUpperCase());

  function run(call: Call, side: 'user' | 'admin'): unknown {
    if (call.op !== 'select') {
      db.writes.push(call);
      const error = db.fail?.(call);
      if (error) throw error;
      if (db.returned) return db.returned;
      return [{ id: NEW_ID, createdAt: AT, updatedAt: AT, ...call.values }];
    }
    if (side === 'admin') {
      db.reads.push(call);
      return db.admin.shift() ?? [];
    }
    let rows = db.visible[call.table] ?? [];
    for (const [, table, column, n] of call.sql.matchAll(/"(\w+)"\."(\w+)" = \$(\d+)/g)) {
      if (table !== call.table) continue;
      rows = rows.filter((row) => row[camel(column)] === call.params[Number(n) - 1]);
    }
    return rows;
  }

  // biome-ignore lint/suspicious/noExplicitAny: the chain stands in for every builder type
  function chain(op: Call['op'], side: 'user' | 'admin', table?: any): any {
    const call: Call = { op, table: table ? getTableName(table) : '', params: [], sql: '' };
    // biome-ignore lint/suspicious/noExplicitAny: Proxy over a callable target
    const proxy: any = new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve()
              .then(() => run(call, side))
              .then(resolve, reject);
        }
        // biome-ignore lint/suspicious/noExplicitAny: a Drizzle table
        if (prop === 'from') return (t: any) => ((call.table = getTableName(t)), proxy);
        if (prop === 'values' || prop === 'set') {
          return (v: Record<string, unknown>) => ((call.values = v), proxy);
        }
        if (prop === 'limit') return (n: number) => ((call.limit = n), proxy);
        if (prop === 'offset') return (n: number) => ((call.offset = n), proxy);
        if (prop === 'where') {
          // biome-ignore lint/suspicious/noExplicitAny: a Drizzle condition, or none
          return (cond: any) => {
            if (cond) {
              const query = dialect.sqlToQuery(cond);
              call.sql = query.sql;
              call.params = query.params;
            }
            return proxy;
          };
        }
        return () => proxy;
      },
    });
    return proxy;
  }

  const client = (side: 'user' | 'admin') => ({
    select: () => chain('select', side),
    // biome-ignore lint/suspicious/noExplicitAny: a Drizzle table
    insert: (t: any) => chain('insert', side, t),
    // biome-ignore lint/suspicious/noExplicitAny: a Drizzle table
    update: (t: any) => chain('update', side, t),
    // biome-ignore lint/suspicious/noExplicitAny: a Drizzle table
    delete: (t: any) => chain('delete', side, t),
  });
  const adminDb = {
    ...client('admin'),
    transaction: (fn: (tx: unknown) => unknown) => fn(client('admin')),
  };
  return {
    adminDb,
    withUserDb: (_userId: string | null, fn: (tx: unknown) => unknown) => fn(client('user')),
  };
});
// OWNER promotion and the super-admin routes sit behind the aal2 gate
// (v1-aal2.test.ts); the MFA setting is not under test here.
vi.mock('@server/lib/mfa-settings', () => ({ isMfaGloballyEnabled: async () => false }));
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock('@server/lib/email', () => ({ sendEmail }));

const { v1Routes } = await import('@server/routes/v1/index');

const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const ORG = uuid(0);
const OWNER = uuid(1);
const ADMIN = uuid(2);
const MEMBER = uuid(3);
const MEMBER_2 = uuid(4);
const OUTSIDER = uuid(5);
/** A fifth member, added by the cases that need a second admin or owner. */
const EXTRA = uuid(6);

/** The caller, as the session middleware would set it. */
function as(id: string | null, extra: Partial<AuthUser> = {}) {
  const user = id ? { id, email: `${id.slice(-1)}@example.test`, ...extra } : null;
  return appWithUser(user, '/api/v1', v1Routes);
}

function send(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

const membership = (userId: string, role: string) => ({
  id: `m-${userId.slice(-1)}`,
  userId,
  organizationId: ORG,
  role,
  createdAt: AT,
});

/** One organization with an owner, an admin and two members. */
function seedOrg() {
  db.visible.memberships = [
    membership(OWNER, 'OWNER'),
    membership(ADMIN, 'ADMIN'),
    membership(MEMBER, 'MEMBER'),
    membership(MEMBER_2, 'MEMBER'),
  ];
}

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

beforeEach(() => {
  db.visible = {};
  db.admin = [];
  db.reads = [];
  db.writes = [];
  db.fail = undefined;
  db.returned = undefined;
  sendEmail.mockClear();
});

describe('GET /me', () => {
  it('answers 401 with no user', async () => {
    const res = await as(null).request('/api/v1/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns the user as the session holds it, with their memberships', async () => {
    const organization = { id: ORG, name: 'Acme', slug: 'acme', plan: 'FREE', createdAt: AT, updatedAt: AT };
    db.visible.memberships = [{ ...membership(OWNER, 'OWNER'), organization }];
    const res = await as(OWNER, {
      name: 'Test User',
      image: 'https://example.test/avatar.jpg',
      emailVerified: true,
      role: 'user',
    }).request('/api/v1/me');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toEqual({
      id: OWNER,
      email: '1@example.test',
      name: 'Test User',
      avatar: 'https://example.test/avatar.jpg',
      emailVerified: true,
      role: 'user',
    });
    expect(body.memberships).toEqual([
      {
        id: 'm-1',
        role: 'OWNER',
        organization: { id: ORG, name: 'Acme', slug: 'acme', plan: 'FREE', created_at: AT_JSON, updated_at: AT_JSON },
      },
    ]);
  });

  it('reports an unverified email, and no role as null', async () => {
    const res = await as(OWNER, { emailVerified: false }).request('/api/v1/me');
    const { user } = await res.json();
    expect(user.emailVerified).toBe(false);
    expect(user.role).toBeNull();
  });
});

describe('POST /organizations', () => {
  const create = (body: unknown, caller: string | null = OWNER) =>
    as(caller).request('/api/v1/organizations', send('POST', body));

  it('answers 401 with no user', async () => {
    expect((await create({ name: 'Org', slug: 'org' }, null)).status).toBe(401);
    expect(db.writes).toEqual([]);
  });

  it('creates the organization and makes the creator its owner', async () => {
    const res = await create({ name: 'New Org', slug: 'new-org' });
    expect(res.status).toBe(201);
    expect((await res.json()).organization).toMatchObject({ id: NEW_ID, name: 'New Org', slug: 'new-org' });
    expect(db.writes.map((w) => [w.op, w.table, w.values])).toEqual([
      ['insert', 'organizations', { name: 'New Org', slug: 'new-org' }],
      ['insert', 'memberships', { userId: OWNER, organizationId: NEW_ID, role: 'OWNER' }],
    ]);
  });

  it('stores the name trimmed', async () => {
    expect((await create({ name: '  My Org  ', slug: 'my-org' })).status).toBe(201);
    expect(db.writes[0].values).toEqual({ name: 'My Org', slug: 'my-org' });
  });

  it.each(['my-org', 'org-123', 'test-org-2024', 'abc-def-123'])('accepts the slug %s', async (slug) => {
    expect((await create({ name: 'My Org', slug })).status).toBe(201);
  });

  it.each([
    ['an empty name', { name: '', slug: 'my-org' }, 'Name is required'],
    ['a name over 100 characters', { name: 'a'.repeat(101), slug: 'my-org' }, 'Name must be 100 characters or less'],
    ['a slug under 3 characters', { name: 'My Org', slug: 'ab' }, 'Slug must be at least 3 characters'],
    ['a slug over 50 characters', { name: 'My Org', slug: 'a'.repeat(51) }, 'Slug must be 50 characters or less'],
    ['an uppercase slug', { name: 'My Org', slug: 'My-Org' }, 'lowercase letters, numbers, and hyphens'],
    ['an underscore', { name: 'My Org', slug: 'my_org' }, 'lowercase letters'],
    ['a dot', { name: 'My Org', slug: 'my.org' }, 'lowercase letters'],
    ['a space', { name: 'My Org', slug: 'my org' }, 'lowercase letters'],
    ['an @', { name: 'My Org', slug: 'my@org' }, 'lowercase letters'],
    ['a plus', { name: 'My Org', slug: 'my+org' }, 'lowercase letters'],
  ])('refuses %s with 400 and writes nothing', async (_name, body, message) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain(message);
    expect(db.writes).toEqual([]);
  });

  it('answers 400 for a slug that is taken, and adds no membership', async () => {
    // Drizzle wraps the driver's unique violation; the route reads its code.
    db.fail = (call) =>
      call.table === 'organizations' ? new Error('query failed', { cause: { code: '23505' } }) : undefined;
    const res = await create({ name: 'Org', slug: 'existing' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('An organization with this slug already exists');
    expect(db.writes.map((w) => w.table)).toEqual(['organizations']);
  });
});

describe('PATCH /organizations/:orgId', () => {
  const rename = (caller: string | null, body: unknown, orgId = ORG) =>
    as(caller).request(`/api/v1/organizations/${orgId}`, send('PATCH', body));

  beforeEach(seedOrg);

  it('answers 401 with no user', async () => {
    const res = await rename(null, { name: 'Renamed' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(db.writes).toEqual([]);
  });

  it.each([
    ['the owner', OWNER],
    ['an admin', ADMIN],
  ])('%s renames the organization, and gets it back', async (_name, caller) => {
    const res = await rename(caller, { name: '  Renamed Org  ' });
    expect(res.status).toBe(200);
    expect((await res.json()).organization).toEqual({
      id: NEW_ID,
      name: 'Renamed Org',
      created_at: AT_JSON,
      updated_at: AT_JSON,
    });
    // One write, to this organization only, of the trimmed name.
    expect(db.writes.map((w) => [w.op, w.table, w.values, w.params])).toEqual([
      ['update', 'organizations', { name: 'Renamed Org' }, [ORG]],
    ]);
  });

  it('SECURITY: writes the name only, whatever else the body carries', async () => {
    const res = await rename(OWNER, { name: 'Renamed', slug: 'taken-over', plan: 'ENTERPRISE', id: uuid(9) });
    expect(res.status).toBe(200);
    expect(db.writes[0].values).toEqual({ name: 'Renamed' });
  });

  it('answers 403 to a member who is not an admin, and writes nothing', async () => {
    const res = await rename(MEMBER, { name: 'Renamed' });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('You must be an admin to rename the organization');
    expect(db.writes).toEqual([]);
  });

  it.each([
    ['a caller outside the organization', OUTSIDER, ORG],
    ['an organization id that is not a UUID', OWNER, 'not-a-uuid'],
  ])('SECURITY: answers 404 for %s, and writes nothing', async (_name, caller, orgId) => {
    const res = await rename(caller, { name: 'Renamed' }, orgId);
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe('Organization not found or access denied');
    expect(db.writes).toEqual([]);
  });

  it.each([
    ['an empty name', { name: '' }, 'Name is required'],
    ['a name of spaces only', { name: '   ' }, 'Name is required'],
    ['a name over 100 characters', { name: 'a'.repeat(101) }, 'Name must be 100 characters or less'],
    ['no name', {}, ''],
    ['a name that is not text', { name: 42 }, ''],
  ])('answers 400 for %s, and writes nothing', async (_name, body, message) => {
    const res = await rename(OWNER, body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain(message);
    expect(db.writes).toEqual([]);
  });

  it('answers 400 for a body that is not JSON, as the other routes do', async () => {
    const res = await as(OWNER).request(`/api/v1/organizations/${ORG}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
    expect(db.writes).toEqual([]);
  });

  it('accepts a name of exactly 100 characters', async () => {
    expect((await rename(OWNER, { name: 'a'.repeat(100) })).status).toBe(200);
  });

  it('answers 404 when the organization is gone by the time of the write', async () => {
    db.returned = [];
    const res = await rename(OWNER, { name: 'Renamed' });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe('Organization not found or access denied');
  });

  it('answers 500 when the update fails', async () => {
    db.fail = () => new Error('connection lost');
    expect((await rename(OWNER, { name: 'Renamed' })).status).toBe(500);
  });
});

describe('GET /organizations/:orgId/members', () => {
  const list = (caller: string | null) => as(caller).request(`/api/v1/organizations/${ORG}/members`);

  it('answers 401 with no user', async () => {
    expect((await list(null)).status).toBe(401);
  });

  it('answers 404 when RLS shows the caller no member of that organization', async () => {
    const res = await list(OUTSIDER);
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe('Organization not found or access denied');
    // The profile lookup runs on adminDb: it must not happen for a non-member.
    expect(db.reads).toEqual([]);
  });

  it('returns the members with their profile details', async () => {
    seedOrg();
    db.admin = [[{ id: OWNER, email: 'owner@example.test', name: '', avatar: null }]];
    const res = await list(MEMBER);
    expect(res.status).toBe(200);
    const { members } = await res.json();
    expect(members).toHaveLength(4);
    expect(members[0]).toEqual({
      id: 'm-1',
      role: 'OWNER',
      createdAt: AT_JSON,
      user: { id: OWNER, email: 'owner@example.test', name: null, avatar: null },
    });
    // Profiles are read for exactly the members RLS returned.
    expect(db.reads[0].params).toEqual([OWNER, ADMIN, MEMBER, MEMBER_2]);
  });
});

describe('POST /organizations/:orgId/members', () => {
  const TARGET = { id: OUTSIDER, email: 'new@example.test', name: 'New Person' };
  const add = (caller: string | null, body: unknown) =>
    as(caller).request(`/api/v1/organizations/${ORG}/members`, send('POST', body));

  beforeEach(seedOrg);

  it('answers 401 with no user', async () => {
    expect((await add(null, { email: 'new@example.test' })).status).toBe(401);
  });

  it.each([
    ['a member', MEMBER],
    ['someone outside the organization', OUTSIDER],
  ])('answers 403 for %s, before reading the body or any user', async (_name, caller) => {
    const res = await add(caller, { email: 'not-an-email' });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('You must be an admin to add members');
    expect(db.reads).toEqual([]);
  });

  it.each([
    ['an invalid email', { email: 'invalid-email' }, 'Valid email is required'],
    ['the OWNER role, which is transferred and never invited', { email: 'new@example.test', role: 'OWNER' }, ''],
  ])('answers 400 for %s', async (_name, body, message) => {
    const res = await add(ADMIN, body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain(message);
    expect(db.writes).toEqual([]);
  });

  it('answers 404 when nobody has signed up with that email', async () => {
    db.admin = [[]];
    const res = await add(ADMIN, { email: 'new@example.test' });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe('User not found. They must sign up first.');
    expect(db.writes).toEqual([]);
  });

  it('answers 400 when that user is already a member', async () => {
    db.admin = [[TARGET], [{ id: 'm-existing' }]];
    const res = await add(ADMIN, { email: 'new@example.test' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('User is already a member of this organization');
    expect(db.writes).toEqual([]);
  });

  it('an owner adds an admin, found by lowercased email, and the invite goes out', async () => {
    db.admin = [[TARGET], [], [{ name: 'Acme' }]];
    const res = await add(OWNER, { email: 'New@Example.test', role: 'ADMIN' });
    expect(res.status).toBe(201);
    expect((await res.json()).member).toEqual({
      id: NEW_ID,
      role: 'ADMIN',
      createdAt: AT_JSON,
      user: TARGET,
    });
    expect(db.reads[0].params).toEqual(['new@example.test']);
    expect(db.writes.map((w) => [w.op, w.table, w.values])).toEqual([
      ['insert', 'memberships', { userId: OUTSIDER, organizationId: ORG, role: 'ADMIN' }],
    ]);
    expect(sendEmail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: 'new@example.test' }));
  });

  it('an admin adds a member, and the role defaults to MEMBER', async () => {
    db.admin = [[TARGET], [], [{ name: 'Acme' }]];
    const res = await add(ADMIN, { email: 'new@example.test' });
    expect(res.status).toBe(201);
    expect(db.writes[0].values).toMatchObject({ role: 'MEMBER' });
  });
});

describe('PATCH /organizations/:orgId/members/:userId', () => {
  const setRole = (caller: string | null, target: string, body: unknown) =>
    as(caller).request(`/api/v1/organizations/${ORG}/members/${target}`, send('PATCH', body));
  const roleWrites = () => db.writes.map((w) => [w.op, w.table, w.values, w.params]);

  beforeEach(seedOrg);

  it('answers 401 with no user', async () => {
    expect((await setRole(null, MEMBER, { role: 'ADMIN' })).status).toBe(401);
  });

  it.each([
    ['an unknown role', { role: 'INVALID' }],
    ['no role', {}],
  ])('answers 400 for %s', async (_name, body) => {
    expect((await setRole(OWNER, MEMBER, body)).status).toBe(400);
    expect(db.writes).toEqual([]);
  });

  it('answers 404 to a caller outside the organization', async () => {
    const res = await setRole(OUTSIDER, MEMBER, { role: 'ADMIN' });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe('Organization not found or access denied');
  });

  it('answers 404 for a target who is not a member', async () => {
    const res = await setRole(OWNER, OUTSIDER, { role: 'ADMIN' });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe('Member not found');
  });

  it('answers 403 when a member changes a role', async () => {
    const res = await setRole(MEMBER, MEMBER_2, { role: 'ADMIN' });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('You must be an admin to change member roles');
    expect(db.writes).toEqual([]);
  });

  it.each([
    ['promotes a member to owner', MEMBER, 'OWNER'],
    ['demotes the owner', OWNER, 'MEMBER'],
  ])('answers 403 when an admin %s', async (_name, target, role) => {
    const res = await setRole(ADMIN, target, { role });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('Only the owner can transfer or modify ownership');
    expect(db.writes).toEqual([]);
  });

  it('answers 400 when the caller changes their own role', async () => {
    const res = await setRole(ADMIN, ADMIN, { role: 'MEMBER' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('You cannot change your own role');
    expect(db.writes).toEqual([]);
  });

  it('an admin changes a member to admin', async () => {
    const res = await setRole(ADMIN, MEMBER, { role: 'ADMIN' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, role: 'ADMIN' });
    expect(roleWrites()).toEqual([['update', 'memberships', { role: 'ADMIN' }, [MEMBER, ORG]]]);
  });

  it('an owner changes an admin to member', async () => {
    expect((await setRole(OWNER, ADMIN, { role: 'MEMBER' })).status).toBe(200);
    expect(roleWrites()).toEqual([['update', 'memberships', { role: 'MEMBER' }, [ADMIN, ORG]]]);
  });

  it('an owner transfers ownership and becomes an admin', async () => {
    const res = await setRole(OWNER, ADMIN, { role: 'OWNER' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, role: 'OWNER' });
    expect(roleWrites()).toEqual([
      ['update', 'memberships', { role: 'OWNER' }, [ADMIN, ORG]],
      ['update', 'memberships', { role: 'ADMIN' }, [OWNER, ORG]],
    ]);
  });
});

describe('DELETE /organizations/:orgId/members/:userId', () => {
  const remove = (caller: string | null, target: string) =>
    as(caller).request(`/api/v1/organizations/${ORG}/members/${target}`, send('DELETE'));
  const removed = () => db.writes.map((w) => [w.op, w.table, w.params]);

  beforeEach(seedOrg);

  it('answers 401 with no user', async () => {
    expect((await remove(null, MEMBER)).status).toBe(401);
  });

  it('an owner leaves when another owner remains', async () => {
    db.admin = [[{ value: 2 }]];
    expect((await remove(OWNER, OWNER)).status).toBe(200);
    expect(removed()).toEqual([['delete', 'memberships', [OWNER, ORG]]]);
  });

  it('the only owner cannot leave', async () => {
    db.admin = [[{ value: 1 }]];
    const res = await remove(OWNER, OWNER);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('You are the only owner. Transfer ownership before leaving.');
    expect(db.writes).toEqual([]);
  });

  it('a member leaves without an owner count', async () => {
    expect((await remove(MEMBER, MEMBER)).status).toBe(200);
    expect(db.reads).toEqual([]);
    expect(removed()).toEqual([['delete', 'memberships', [MEMBER, ORG]]]);
  });

  it('a member cannot remove someone else', async () => {
    const res = await remove(MEMBER, MEMBER_2);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('You must be an admin to remove members');
    expect(db.writes).toEqual([]);
  });

  it.each([
    ['the owner', OWNER],
    ['another admin', EXTRA],
  ])('an admin cannot remove %s', async (_name, target) => {
    db.visible.memberships.push(membership(EXTRA, 'ADMIN'));
    const res = await remove(ADMIN, target);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('Admins can only remove members, not other admins or owners');
    expect(db.writes).toEqual([]);
  });

  it('an admin removes a member', async () => {
    expect((await remove(ADMIN, MEMBER)).status).toBe(200);
    expect(removed()).toEqual([['delete', 'memberships', [MEMBER, ORG]]]);
  });

  it('an owner removes an admin', async () => {
    expect((await remove(OWNER, ADMIN)).status).toBe(200);
    expect(removed()).toEqual([['delete', 'memberships', [ADMIN, ORG]]]);
  });

  it('an owner cannot remove another owner', async () => {
    db.visible.memberships.push(membership(EXTRA, 'OWNER'));
    const res = await remove(OWNER, EXTRA);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('Cannot remove the organization owner');
    expect(db.writes).toEqual([]);
  });
});

describe('the super-admin lists', () => {
  const admin = appWithUser(SUPER_ADMIN, '/api/v1', v1Routes);
  /** The list query finds no rows; the count query counts none. */
  const emptyList = () => {
    db.admin = [[], [{ value: 0 }]];
  };

  it('answers 403 to a signed-in user who is not a super admin, and reads nothing', async () => {
    const res = await as(OWNER, { role: 'user' }).request('/api/v1/admin/organizations');
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('Super admin access required');
    expect(db.reads).toEqual([]);
  });

  it('defaults to page 1 of 20, with no search', async () => {
    emptyList();
    const res = await admin.request('/api/v1/admin/organizations');
    expect(res.status).toBe(200);
    expect((await res.json()).pagination).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
    expect(db.reads[0]).toMatchObject({ limit: 20, offset: 0, params: [] });
  });

  it('reads page, limit and search from the query string', async () => {
    db.admin = [[], [{ value: 230 }]];
    const res = await admin.request('/api/v1/admin/organizations?search=test%20query&page=5&limit=50');
    expect(res.status).toBe(200);
    expect((await res.json()).pagination).toEqual({ page: 5, limit: 50, total: 230, totalPages: 5 });
    expect(db.reads[0]).toMatchObject({ limit: 50, offset: 200, params: ['%test query%', '%test query%'] });
  });

  it.each(['test query', 'user@example.com', 'org-name', 'test_123'])('accepts the search "%s"', async (search) => {
    emptyList();
    const res = await admin.request(`/api/v1/admin/users?search=${encodeURIComponent(search)}`);
    expect(res.status).toBe(200);
  });

  it.each([
    [`search=${'a'.repeat(101)}`, 'Search query too long'],
    ['search=test%3Cscript%3E', 'Search contains invalid characters'],
    ['search=test%26param%3D1', 'Search contains invalid characters'],
    ['search=test%3BDROP%20TABLE', 'Search contains invalid characters'],
    ['sortBy=invalid', ''],
    ['page=0', ''],
    ['page=1001', ''],
    ['limit=0', ''],
    ['limit=101', ''],
  ])('refuses ?%s with 400 before reading anything', async (query, message) => {
    const res = await admin.request(`/api/v1/admin/organizations?${query}`);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain(message);
    expect(db.reads).toEqual([]);
  });
});

const NOTE = uuid(7);
const notification = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Notice ${id.slice(-1)}`,
  message: null,
  type: 'info',
  dismissible: true,
  actionLabel: null,
  actionUrl: null,
  createdAt: AT,
  ...extra,
});

describe('GET /notifications', () => {
  it('serves an anonymous visitor the public notifications', async () => {
    db.admin = [[notification(NOTE, { actionLabel: 'Learn more', actionUrl: 'https://example.test' })]];
    const res = await as(null).request('/api/v1/notifications');
    expect(res.status).toBe(200);
    expect((await res.json()).notifications).toEqual([
      {
        id: NOTE,
        title: 'Notice 7',
        message: null,
        type: 'info',
        dismissible: true,
        action: { label: 'Learn more', url: 'https://example.test' },
        createdAt: AT_JSON,
      },
    ]);
    // Active, and visible to everyone or to the public only
    expect(db.reads[0].params.slice(0, 3)).toEqual([true, 'all', 'public']);
  });

  it('leaves out the notifications the user dismissed', async () => {
    db.visible.notifications = [notification(uuid(7)), notification(uuid(8)), notification(uuid(9))];
    db.visible.notification_dismissals = [
      { notificationId: uuid(7), userId: OWNER },
      { notificationId: uuid(9), userId: OWNER },
      // Another user's dismissal, should RLS ever show one
      { notificationId: uuid(8), userId: MEMBER },
    ];
    const res = await as(OWNER).request('/api/v1/notifications');
    expect(res.status).toBe(200);
    const { notifications } = await res.json();
    expect(notifications.map((n: { id: string }) => n.id)).toEqual([uuid(8)]);
  });

  it('returns every notification when none is dismissed, dismissible or not', async () => {
    db.visible.notifications = [notification(uuid(7)), notification(uuid(8), { dismissible: false })];
    const { notifications } = await (await as(OWNER).request('/api/v1/notifications')).json();
    expect(notifications.map((n: { dismissible: boolean }) => n.dismissible)).toEqual([true, false]);
  });
});

describe('POST /notifications/:id/dismiss', () => {
  const dismiss = (caller: string | null, id: string) =>
    as(caller).request(`/api/v1/notifications/${id}/dismiss`, send('POST'));

  it('answers 401 with no user', async () => {
    expect((await dismiss(null, NOTE)).status).toBe(401);
  });

  it.each([
    ['one the user cannot see', NOTE],
    ['a malformed id', 'not-a-uuid'],
  ])('answers 404 for %s', async (_name, id) => {
    const res = await dismiss(OWNER, id);
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe('Notification not found');
    expect(db.writes).toEqual([]);
  });

  it('answers 400 for a notification that cannot be dismissed', async () => {
    db.visible.notifications = [notification(NOTE, { dismissible: false })];
    const res = await dismiss(OWNER, NOTE);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('This notification cannot be dismissed');
    expect(db.writes).toEqual([]);
  });

  it('records the dismissal for the caller', async () => {
    db.visible.notifications = [notification(NOTE)];
    const res = await dismiss(OWNER, NOTE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(db.writes.map((w) => [w.op, w.table, w.values])).toEqual([
      ['insert', 'notification_dismissals', { notificationId: NOTE, userId: OWNER }],
    ]);
  });
});

describe('POST /admin/notifications', () => {
  const admin = appWithUser(SUPER_ADMIN, '/api/v1', v1Routes);
  const create = (body: unknown) => admin.request('/api/v1/admin/notifications', send('POST', body));

  it('fills the defaults of a notification that names only a title', async () => {
    const res = await create({ title: 'Test Notification' });
    expect(res.status).toBe(201);
    expect(db.writes[0].values).toMatchObject({
      title: 'Test Notification',
      type: 'info',
      visibility: 'all',
      dismissible: true,
      isActive: true,
      createdBy: SUPER_ADMIN.id,
    });
  });

  it('stores every field it is given', async () => {
    const full = {
      title: 'Maintenance',
      message: 'System maintenance scheduled',
      type: 'warning',
      visibility: 'authenticated',
      dismissible: false,
      organizationId: '123e4567-e89b-12d3-a456-426614174000',
      startsAt: '2024-01-01T00:00:00Z',
      endsAt: '2024-01-02T00:00:00Z',
      actionLabel: 'Learn More',
      actionUrl: 'https://example.com',
      isActive: false,
    };
    const res = await create(full);
    expect(res.status).toBe(201);
    expect(db.writes[0].values).toEqual({ ...full, createdBy: SUPER_ADMIN.id });
    expect((await res.json()).notification).toMatchObject({ title: 'Maintenance', isActive: false });
  });

  it('accepts an empty action label and URL, as the admin form sends them', async () => {
    expect((await create({ title: 'Test', actionLabel: '', actionUrl: '' })).status).toBe(201);
  });

  it.each([
    ['an empty title', { title: '' }, 'Title is required'],
    ['a title over 200 characters', { title: 'a'.repeat(201) }, 'Title must be 200 characters or less'],
    ['a message over 1000 characters', { title: 'Test', message: 'a'.repeat(1001) }, 'Message must be 1000 characters or less'],
    ['an unknown type', { title: 'Test', type: 'invalid' }, ''],
    ['an organization id that is not a UUID', { title: 'Test', organizationId: 'not-a-uuid' }, ''],
    ['a start that is not a datetime', { title: 'Test', startsAt: 'not-a-datetime' }, ''],
    ['an action label over 50 characters', { title: 'Test', actionLabel: 'a'.repeat(51) }, ''],
    ['an action URL that is not a URL', { title: 'Test', actionUrl: 'not-a-url' }, ''],
  ])('refuses %s with 400 and stores nothing', async (_name, body, message) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain(message);
    expect(db.writes).toEqual([]);
  });
});
