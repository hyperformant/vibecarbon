import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it, vi } from 'vitest';

// The DB module validates env at import; the pool connects lazily and is
// never dialed here.
process.env.BETTER_AUTH_SECRET ??= 'test-auth-secret-at-least-32-characters-long';
process.env.SITE_URL ??= 'http://app.test';
process.env.DB_HOST ??= 'db.test';
process.env.DB_PASSWORD ??= 'pw';

vi.mock('@server/lib/logger', () => ({
  logger: { fatal: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { assertBypassRole, DbNotMigratedError, DbRoleError, pool } = await import(
  '@server/db/client'
);
const { checkDbRoleAtStartup, ensureAdminAtStartup, isConnectionLoss, isDbAuthFailure } =
  await import('@server/db/startup');
const { AdminNotSettledError } = await import('@server/auth/admin-status');

function fakeLog() {
  return { fatal: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

/** A pg error as Drizzle surfaces it: the SQLSTATE sits on the cause. */
function wrappedPgError(code: string) {
  const pgErr = Object.assign(new Error('password authentication failed for user "postgres"'), {
    code,
    severity: 'FATAL',
    detail: undefined,
  });
  return new DrizzleQueryError('select current_user', [], pgErr);
}

describe('checkDbRoleAtStartup', () => {
  it('logs and returns once the connection role is confirmed', async () => {
    const log = fakeLog();
    const exit = vi.fn();
    await checkDbRoleAtStartup({ assert: async () => {}, log, exit, retryMs: 0 });
    expect(exit).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  // adminDb must never silently become RLS-scoped.
  it('exits with a fatal log when the role cannot bypass RLS', async () => {
    const log = fakeLog();
    const exit = vi.fn();
    await checkDbRoleAtStartup({
      assert: async () => {
        throw new DbRoleError('app_user');
      },
      log,
      exit,
      retryMs: 0,
    });
    expect(log.fatal).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  // Review Focus 5: the db container may still be starting. The server keeps
  // running (health reports the db down) and checks again, no crash loop.
  it('keeps retrying while the database is unreachable, then confirms', async () => {
    const log = fakeLog();
    const exit = vi.fn();
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const assert = vi
      .fn()
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(undefined);
    await checkDbRoleAtStartup({ assert, log, exit, retryMs: 0 });
    expect(assert).toHaveBeenCalledTimes(3);
    expect(exit).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('warns only once per outage, not on every retry', async () => {
    const log = fakeLog();
    const refused = new Error('connect ECONNREFUSED');
    const assert = vi.fn();
    for (let i = 0; i < 5; i++) assert.mockRejectedValueOnce(refused);
    assert.mockResolvedValueOnce(undefined);
    await checkDbRoleAtStartup({ assert, log, exit: vi.fn(), retryMs: 0 });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('checkDbRoleAtStartup: rejected credentials', () => {
  it('recognises 28P01 and 28000, directly or on a cause, and nothing else', () => {
    expect(isDbAuthFailure(wrappedPgError('28P01'))).toBe(true);
    expect(isDbAuthFailure(Object.assign(new Error('no pg_hba.conf entry'), { code: '28000' }))).toBe(
      true
    );
    expect(isDbAuthFailure(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(
      false
    );
    expect(isDbAuthFailure(new DbNotMigratedError())).toBe(false);
  });

  // Waiting never fixes a wrong password, so this is not "still starting":
  // error level, repeated every authRelogMs while it persists.
  it('logs a persistent auth failure at error level, again once per interval', async () => {
    const log = fakeLog();
    const exit = vi.fn();
    let clock = 0;
    const assert = vi.fn();
    // Ten failures, 15 s apart (0..135 s), then the fix lands.
    for (let i = 0; i < 10; i++) assert.mockRejectedValueOnce(wrappedPgError('28P01'));
    assert.mockResolvedValueOnce(undefined);
    await checkDbRoleAtStartup({
      assert: async () => {
        try {
          return await assert();
        } finally {
          clock += 15_000;
        }
      },
      log,
      exit,
      retryMs: 0,
      authRelogMs: 60_000,
      now: () => clock,
    });
    // Logged at t=15 s, 75 s, 135 s: first failure, then each full minute.
    expect(log.error).toHaveBeenCalledTimes(3);
    expect(log.warn).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    // Logged through dbErrorForLog: the SQLSTATE survives, the SQL does not.
    const [fields] = log.error.mock.calls[0] as [{ err: { code?: string; message?: string } }];
    expect(fields.err.code).toBe('28P01');
    expect(JSON.stringify(fields)).not.toContain('select current_user');
  });
});

describe('pool', () => {
  // A request Hono has timed out must not pin one of the pool's connections.
  it('bounds statements, idle transactions, and unanswered queries', () => {
    const options = pool.options as unknown as Record<string, unknown>;
    expect(options.statement_timeout).toBe(30_000);
    expect(options.idle_in_transaction_session_timeout).toBe(30_000);
    expect(options.query_timeout).toBe(35_000);
    expect(options.max).toBe(10);
  });
});

describe('assertBypassRole', () => {
  type Row = { role: string; bypass: boolean | null; hasAppUser: boolean; member: boolean };
  const executor = (row: Row) =>
    ({ execute: async () => ({ rows: [row] }) }) as unknown as Parameters<
      typeof assertBypassRole
    >[0];
  const ok: Row = { role: 'postgres', bypass: true, hasAppUser: true, member: true };

  it('accepts a bypass role that is a member of app_user', async () => {
    await expect(assertBypassRole(executor(ok))).resolves.toBeUndefined();
  });

  it('refuses a role RLS would scope', async () => {
    await expect(assertBypassRole(executor({ ...ok, bypass: false }))).rejects.toThrow(
      /cannot bypass row-level security/
    );
  });

  it('refuses a bypass role that is not a member of app_user', async () => {
    const err = await assertBypassRole(executor({ ...ok, member: false })).catch((e) => e);
    expect(err).toBeInstanceOf(DbRoleError);
    expect(err.message).toMatch(/not a member of app_user/);
  });

  // Fresh deploy: the app can start before the migrations create app_user.
  // That is "not ready yet" (retry), never a fatal exit.
  it('reports a database without app_user as not migrated, which startup retries', async () => {
    const notMigrated = { ...ok, hasAppUser: false, member: false };
    await expect(assertBypassRole(executor(notMigrated))).rejects.toBeInstanceOf(
      DbNotMigratedError
    );
    const exit = vi.fn();
    const assert = vi
      .fn()
      .mockImplementationOnce(() => assertBypassRole(executor(notMigrated)))
      .mockResolvedValueOnce(undefined);
    await checkDbRoleAtStartup({ assert, log: fakeLog(), exit, retryMs: 0 });
    expect(exit).not.toHaveBeenCalled();
    expect(assert).toHaveBeenCalledTimes(2);
  });
});

describe('ensureAdminAtStartup: the super admin bootstrap settles, waiting only on conditions', () => {
  const ready = async () => ({ ready: true, missing: [] });
  const run = (
    bootstrap: () => Promise<unknown>,
    extra: Partial<Parameters<typeof ensureAdminAtStartup>[0]> = {}
  ) => {
    const statuses: string[] = [];
    const log = fakeLog();
    const done = ensureAdminAtStartup({
      bootstrap: bootstrap as never,
      schemaReady: ready,
      setStatus: (s) => statuses.push(s),
      log,
      retryMs: 0,
      ...extra,
    });
    return { done, statuses, log };
  };
  const pgError = (code: string) =>
    new DrizzleQueryError('insert', [], Object.assign(new Error(`pg ${code}`), { code }));

  it('waits through connection loss and reports ready once it succeeds, without a restart', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const bootstrap = vi
      .fn()
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(pgError('57P01'))
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
      .mockResolvedValueOnce('created');
    const { done, statuses, log } = run(bootstrap);
    expect(await done).toBe('ready');
    expect(bootstrap).toHaveBeenCalledTimes(4);
    expect(statuses).toEqual(['ready']);
    expect(log.warn).toHaveBeenCalledTimes(1); // once per outage, not per retry
  });

  it('waits for the schema by a positive check, re-logging the cause at error level', async () => {
    let t = 0;
    const schemaReady = vi
      .fn()
      .mockResolvedValueOnce({ ready: false, missing: ['account.password'] })
      .mockResolvedValueOnce({ ready: false, missing: ['account.password'] })
      .mockResolvedValueOnce({ ready: false, missing: ['account.password'] })
      .mockResolvedValue({ ready: true, missing: [] });
    const bootstrap = vi.fn().mockResolvedValue('unchanged');
    const { done, log } = run(bootstrap, {
      schemaReady,
      relogMs: 60_000,
      now: () => {
        t += 40_000;
        return t;
      },
    });
    expect(await done).toBe('ready');
    expect(bootstrap).toHaveBeenCalledTimes(1); // never tried against a half schema
    expect(log.error.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(log.error.mock.calls.length).toBeLessThan(3); // throttled, not per probe
    expect(JSON.stringify(log.error.mock.calls[0])).toContain('account.password');
  });

  it('retries a half-made super admin (another replica mid-create) until it settles', async () => {
    const bootstrap = vi
      .fn()
      .mockRejectedValueOnce(new AdminNotSettledError('has no password', 'a@b.c'))
      .mockResolvedValueOnce('unchanged');
    const { done, statuses } = run(bootstrap);
    expect(await done).toBe('ready');
    expect(statuses).toEqual(['ready']);
  });

  it('settles a half-made super admin that stays half-made as refused, with the fix', async () => {
    let t = 0;
    const bootstrap = vi.fn().mockRejectedValue(new AdminNotSettledError('has no password', 'a@b.c'));
    const { done, statuses, log } = run(bootstrap, {
      notSettledMs: 120_000,
      now: () => {
        t += 50_000;
        return t;
      },
    });
    expect(await done).toBe('refused');
    expect(statuses).toEqual(['refused']);
    expect(log.error).toHaveBeenCalledWith({ email: 'a@b.c' }, 'has no password');
  });

  it('a refused bootstrap is terminal: reported, never retried', async () => {
    const bootstrap = vi.fn().mockResolvedValue('refused');
    const { done, statuses } = run(bootstrap);
    expect(await done).toBe('refused');
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['refused']);
  });

  it('missing ADMIN_* env is terminal (skipped)', async () => {
    const { done, statuses } = run(vi.fn().mockResolvedValue('skipped'));
    expect(await done).toBe('skipped');
    expect(statuses).toEqual(['skipped']);
  });

  it('reports failed for any other error, logs it, and recovers once the cause is fixed', async () => {
    const bootstrap = vi
      .fn()
      .mockRejectedValueOnce(pgError('23502'))
      .mockRejectedValueOnce(pgError('23502'))
      .mockResolvedValueOnce('created');
    const { done, statuses, log } = run(bootstrap);
    expect(await done).toBe('ready');
    expect(statuses).toEqual(['failed', 'failed', 'ready']);
    expect(log.error).toHaveBeenCalledTimes(1); // re-logged only every relogMs
  });

  it('a read-only standby stays pending (not failed) until the admin replicates', async () => {
    const bootstrap = vi
      .fn()
      .mockRejectedValueOnce(pgError('25006'))
      .mockRejectedValueOnce(pgError('25006'))
      .mockResolvedValueOnce('unchanged');
    const { done, statuses, log } = run(bootstrap);
    expect(await done).toBe('ready');
    expect(statuses).toEqual(['ready']);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('treats only connection loss as a connection wait', () => {
    for (const code of ['08006', '08001', '57P01', '57P03']) {
      expect(isConnectionLoss(pgError(code)), code).toBe(true);
    }
    expect(isConnectionLoss(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isConnectionLoss(new Error('Connection terminated unexpectedly'))).toBe(true);
    // A coded error with that text is judged by its code alone.
    expect(isConnectionLoss(Object.assign(new Error('Connection terminated'), { code: '23505' }))).toBe(
      false
    );
    for (const code of ['40001', '40P01', '42P01', '53300', '23505', '28P01']) {
      expect(isConnectionLoss(pgError(code)), code).toBe(false);
    }
    expect(isConnectionLoss(new Error('nope'))).toBe(false);
  });
});
