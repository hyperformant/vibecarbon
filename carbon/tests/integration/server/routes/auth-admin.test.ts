import type { AuthUser as User } from '@server/auth';
import type { HonoVariables } from '@server/types';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryChain } from '../../../_helpers/drizzle-mock';

/**
 * src/server/routes/v1/auth.ts: the account-lockout admin tools
 * (POST /admin/unlock-account, GET /admin/locked-accounts), the MFA flag on
 * GET /settings and PATCH /admin/settings. The docs flags on the same two
 * settings endpoints are in docs-settings-route.test.ts.
 */

const { db, mode } = vi.hoisted(() => ({
  db: {
    execute: [] as SQL[],
    executeResult: { rows: [] as unknown[] } as { rows: unknown[] } | Error,
    selectRows: [] as { key: string; value: unknown }[] | Error,
    upserts: [] as Array<{ key: string; value: unknown; updatedBy?: string }>,
    upsertError: null as Error | null,
  },
  mode: { NODE_ENV: undefined as string | undefined },
}));

vi.mock('@server/db/client', () => ({
  adminDb: {
    execute: async (query: SQL) => {
      db.execute.push(query);
      if (db.executeResult instanceof Error) throw db.executeResult;
      return db.executeResult;
    },
    select: () =>
      queryChain(() => {
        if (db.selectRows instanceof Error) throw db.selectRows;
        return db.selectRows;
      }),
    insert: () => ({
      values: (row: { key: string; value: unknown; updatedBy?: string }) => ({
        onConflictDoUpdate: async () => {
          if (db.upsertError) throw db.upsertError;
          db.upserts.push(row);
        },
      }),
    }),
  },
}));
// The admin routes sit behind the aal2 gate; the MFA setting is not under test here.
vi.mock('@server/lib/mfa-settings', () => ({ isMfaGloballyEnabled: async () => false }));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// The real env, with NODE_ENV switchable so a 500 can be read as production
// sends it (sanitizeError hands the client the route's fallback there).
vi.mock('@server/lib/env', async (importOriginal) => {
  const real = await importOriginal<typeof import('@server/lib/env')>();
  return {
    ...real,
    env: new Proxy(real.env, {
      get: (target, key) =>
        key === 'NODE_ENV' && mode.NODE_ENV !== undefined
          ? mode.NODE_ENV
          : Reflect.get(target, key),
    }),
  };
});

const { authRoutes } = await import('@server/routes/v1/auth');

const SUPER_ADMIN: Partial<User> = { id: 'admin-1', role: 'super_admin' };
const REGULAR: Partial<User> = { id: 'user-1', role: 'user' };

function appAs(user: Partial<User> | null) {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    if (user) c.set('user', user as any);
    await next();
  });
  app.route('/api/v1/auth', authRoutes);
  return app;
}

function send(user: Partial<User> | null, method: string, path: string, body?: string) {
  return appAs(user).request(`/api/v1/auth${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  });
}

const unlock = (user: Partial<User> | null, body: string) =>
  send(user, 'POST', '/admin/unlock-account', body);
const lockedAccounts = (user: Partial<User> | null) => send(user, 'GET', '/admin/locked-accounts');
const patchSettings = (user: Partial<User> | null, body: string) =>
  send(user, 'PATCH', '/admin/settings', body);

function executed(): Array<{ sql: string; params: unknown[] }> {
  return db.execute.map((q) => {
    const { sql, params } = new PgDialect().sqlToQuery(q);
    return { sql, params };
  });
}

beforeEach(() => {
  db.execute = [];
  db.executeResult = { rows: [] };
  db.selectRows = [];
  db.upserts = [];
  db.upsertError = null;
});

afterEach(() => {
  mode.NODE_ENV = undefined;
});

describe('POST /admin/unlock-account', () => {
  it('returns 401 with no user, and unlocks nothing', async () => {
    const res = await unlock(null, JSON.stringify({ email: 'locked@example.com' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(db.execute).toHaveLength(0);
  });

  it('returns 403 for a user who is not a super admin, and unlocks nothing', async () => {
    const res = await unlock(REGULAR, JSON.stringify({ email: 'locked@example.com' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Super admin access required' });
    expect(db.execute).toHaveLength(0);
  });

  it('returns 400 for a body that is not JSON', async () => {
    const res = await unlock(SUPER_ADMIN, 'not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
    expect(db.execute).toHaveLength(0);
  });

  it('returns 400 for an invalid email', async () => {
    const res = await unlock(SUPER_ADMIN, JSON.stringify({ email: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Valid email is required' });
    expect(db.execute).toHaveLength(0);
  });

  it('returns 400 with no email', async () => {
    const res = await unlock(SUPER_ADMIN, JSON.stringify({}));
    expect(res.status).toBe(400);
    expect(db.execute).toHaveLength(0);
  });

  it('unlocks the account by its lowercased email', async () => {
    const res = await unlock(SUPER_ADMIN, JSON.stringify({ email: 'Locked@Example.com' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(executed()).toEqual([
      { sql: 'select admin_unlock_account($1)', params: ['locked@example.com'] },
    ]);
  });

  it('returns 500 with the route’s message in production when the unlock fails', async () => {
    mode.NODE_ENV = 'production';
    db.executeResult = new Error('Database error');
    const res = await unlock(SUPER_ADMIN, JSON.stringify({ email: 'locked@example.com' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to unlock account' });
    expect(executed()[0]?.params).toEqual(['locked@example.com']);
  });
});

describe('GET /admin/locked-accounts', () => {
  it('returns 401 with no user, and queries nothing', async () => {
    const res = await lockedAccounts(null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(db.execute).toHaveLength(0);
  });

  it('returns 403 for a user who is not a super admin, and queries nothing', async () => {
    const res = await lockedAccounts(REGULAR);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Super admin access required' });
    expect(db.execute).toHaveLength(0);
  });

  it('returns 500 with the route’s message in production when the query fails', async () => {
    mode.NODE_ENV = 'production';
    db.executeResult = new Error('Database error');
    const res = await lockedAccounts(SUPER_ADMIN);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch locked accounts' });
  });

  it('lists the locked accounts in camelCase', async () => {
    db.executeResult = {
      rows: [
        {
          email: 'user1@example.com',
          attempt_count: 5,
          first_attempt: '2024-01-01T10:00:00Z',
          last_attempt: '2024-01-01T10:05:00Z',
        },
        {
          email: 'user2@example.com',
          attempt_count: 3,
          first_attempt: '2024-01-01T11:00:00Z',
          last_attempt: '2024-01-01T11:02:00Z',
        },
      ],
    };
    const res = await lockedAccounts(SUPER_ADMIN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lockedAccounts: [
        {
          email: 'user1@example.com',
          attemptCount: 5,
          firstAttempt: '2024-01-01T10:00:00Z',
          lastAttempt: '2024-01-01T10:05:00Z',
        },
        {
          email: 'user2@example.com',
          attemptCount: 3,
          firstAttempt: '2024-01-01T11:00:00Z',
          lastAttempt: '2024-01-01T11:02:00Z',
        },
      ],
    });
  });

  it('turns the driver’s text count and timestamps into a number and ISO strings', async () => {
    db.executeResult = {
      rows: [
        {
          email: 'user1@example.com',
          attempt_count: '5',
          first_attempt: '2024-01-01 10:00:00+00',
          last_attempt: '2024-01-01 10:05:00+00',
        },
      ],
    };
    const { lockedAccounts: list } = await (await lockedAccounts(SUPER_ADMIN)).json();
    expect(list).toEqual([
      {
        email: 'user1@example.com',
        attemptCount: 5,
        firstAttempt: '2024-01-01T10:00:00+00:00',
        lastAttempt: '2024-01-01T10:05:00+00:00',
      },
    ]);
  });

  it('returns an empty list when nothing is locked', async () => {
    const res = await lockedAccounts(SUPER_ADMIN);
    expect(await res.json()).toEqual({ lockedAccounts: [] });
  });
});

describe('GET /settings: mfaEnabled', () => {
  async function mfaEnabled(): Promise<unknown> {
    const res = await send(null, 'GET', '/settings');
    expect(res.status).toBe(200);
    return ((await res.json()) as { settings: { mfaEnabled: unknown } }).settings.mfaEnabled;
  }

  it('is true when the stored flag is on', async () => {
    db.selectRows = [{ key: 'mfa_enabled', value: { enabled: true } }];
    expect(await mfaEnabled()).toBe(true);
  });

  it('is false when the stored flag is off', async () => {
    db.selectRows = [{ key: 'mfa_enabled', value: { enabled: false } }];
    expect(await mfaEnabled()).toBe(false);
  });

  it('defaults to false when there is no row', async () => {
    expect(await mfaEnabled()).toBe(false);
  });

  it('defaults to false when the settings query fails', async () => {
    db.selectRows = new Error('relation "app_settings" does not exist');
    expect(await mfaEnabled()).toBe(false);
  });
});

describe('PATCH /admin/settings: mfa_enabled', () => {
  it('returns 401 with no user, and writes nothing', async () => {
    const res = await patchSettings(null, JSON.stringify({ mfa_enabled: true }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(db.upserts).toHaveLength(0);
  });

  it('returns 403 for a user who is not a super admin, and writes nothing', async () => {
    const res = await patchSettings(REGULAR, JSON.stringify({ mfa_enabled: false }));
    expect(res.status).toBe(403);
    expect(db.upserts).toHaveLength(0);
  });

  it('returns 400 for a body that is not JSON', async () => {
    const res = await patchSettings(SUPER_ADMIN, 'not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
    expect(db.upserts).toHaveLength(0);
  });

  it('returns 400 for a value that is not a boolean', async () => {
    const res = await patchSettings(SUPER_ADMIN, JSON.stringify({ mfa_enabled: 'yes' }));
    expect(res.status).toBe(400);
    expect(db.upserts).toHaveLength(0);
  });

  it.each([true, false])('stores mfa_enabled %s, stamped with the admin', async (enabled) => {
    const res = await patchSettings(SUPER_ADMIN, JSON.stringify({ mfa_enabled: enabled }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(db.upserts).toEqual([
      { key: 'mfa_enabled', value: { enabled }, updatedBy: 'admin-1' },
    ]);
  });

  it('succeeds and writes nothing when no flag is given', async () => {
    const res = await patchSettings(SUPER_ADMIN, JSON.stringify({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(db.upserts).toHaveLength(0);
  });

  it('returns 500 with the route’s message in production when the write fails', async () => {
    mode.NODE_ENV = 'production';
    db.upsertError = new Error('Database error');
    const res = await patchSettings(SUPER_ADMIN, JSON.stringify({ mfa_enabled: true }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update settings' });
  });
});
