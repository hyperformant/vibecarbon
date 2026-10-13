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

const { DbRoleError } = await import('@server/db/client');
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
