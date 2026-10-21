import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it, vi } from 'vitest';

/**
 * The migrate step (db/migrate-cli.ts) runs before the app, as the owner: the
 * compose `app-migrate` one-shot and the k8s `migrate` init container. It
 * exits 0 when the migrations are applied (or the database is a standby) and
 * 1 on a real failure. A database that is not up yet is waited out, as the
 * app's own startup does, so a cold k8s deploy does not crash-loop it.
 */
vi.mock('@server/lib/logger', () => ({
  logger: { fatal: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { migrateConnectionFromEnv, migrateMain, runMigrateStep } = await import(
  '@server/db/migrate-cli'
);

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('migrateMain', () => {
  it('exits 0 after applying, and on a standby', async () => {
    expect(
      await migrateMain({
        run: async () => ({ kind: 'applied', newlyApplied: 3 }),
        log: log(),
        pause: async () => {},
      })
    ).toBe(0);
    expect(
      await migrateMain({
        run: async () => ({ kind: 'standby', upToDate: false }),
        log: log(),
        pause: async () => {},
      })
    ).toBe(0);
  });

  it('waits through connection loss, warning once, then exits 0', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const run = vi
      .fn()
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce({ kind: 'applied', newlyApplied: 0 });
    const l = log();
    expect(await migrateMain({ run, log: l, pause: async () => {} })).toBe(0);
    expect(run).toHaveBeenCalledTimes(3);
    expect(l.warn).toHaveBeenCalledTimes(1);
  });

  it('exits 1 at once on a failed migration or rejected credentials, logging the SQLSTATE', async () => {
    for (const code of ['42P01', '28P01']) {
      const err = new DrizzleQueryError('x', [], Object.assign(new Error('boom'), { code }));
      const run = vi.fn().mockRejectedValue(err);
      const l = log();
      expect(await migrateMain({ run, log: l, pause: async () => {} })).toBe(1);
      expect(run).toHaveBeenCalledTimes(1);
      expect(l.error).toHaveBeenCalledTimes(1);
    }
  });
});

describe('runMigrateStep', () => {
  it('refuses to run without APP_DB_PASSWORD, before connecting', async () => {
    await expect(
      runMigrateStep({ host: 'db.invalid', port: 5432, user: 'postgres', password: 'x' }, '')
    ).rejects.toThrow(/APP_DB_PASSWORD is not set/);
  });
});

describe('migrateConnectionFromEnv', () => {
  it('defaults to the owner on the standard port and database', () => {
    expect(migrateConnectionFromEnv({ DB_HOST: 'db', DB_PASSWORD: 'SENTINEL_OWNER' })).toEqual({
      host: 'db',
      port: 5432,
      user: 'postgres',
      password: 'SENTINEL_OWNER',
      database: 'postgres',
    });
  });

  it('needs a host and the owner password', () => {
    expect(() => migrateConnectionFromEnv({ DB_PASSWORD: 'x' })).toThrow(/DB_HOST/);
    expect(() => migrateConnectionFromEnv({ DB_HOST: 'db' })).toThrow(/DB_PASSWORD/);
  });
});
