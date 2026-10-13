import { describe, expect, it, vi } from 'vitest';

// The DB module validates env at import; the pool connects lazily and is
// never dialed here.
process.env.SUPABASE_URL ??= 'http://supabase.test';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.DB_HOST ??= 'db.test';
process.env.DB_PASSWORD ??= 'pw';

vi.mock('@server/lib/logger', () => ({
  logger: { fatal: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { assertBypassRole, DbNotMigratedError, DbRoleError } = await import('@server/db/client');
const { checkDbRoleAtStartup } = await import('@server/db/startup');

function fakeLog() {
  return { fatal: vi.fn(), info: vi.fn(), warn: vi.fn() };
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
