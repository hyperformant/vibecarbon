import { describe, expect, it, vi } from 'vitest';

/**
 * The app never migrates (security plan 2026-10-20, R8). Migrations run as
 * the owner in a step of their own (`app-migrate` on compose, an init
 * container on k8s), so the request process never holds the owner password.
 * At startup the app only compares drizzle's ledger with db/migrations: while
 * the ledger is behind it logs "migrations pending" and serves with
 * readiness down, and it reports `applied` once the migrate step has caught
 * the ledger up. It never calls drizzle's migrator and never takes the
 * migration lock.
 */
process.env.BETTER_AUTH_SECRET ??= 'test-auth-secret-at-least-32-characters-long';
process.env.SITE_URL ??= 'http://app.test';
process.env.DB_HOST ??= 'db.test';
process.env.DB_PASSWORD ??= 'pw';

const { ledger, queries, migrate } = vi.hoisted(() => ({
  // The hashes of the migrations the fake database has recorded.
  ledger: { hashes: [] as string[] },
  queries: [] as string[],
  migrate: vi.fn(),
}));

vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate }));
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg')>();
  const Client = vi.fn(function Client() {
    return {
      connect: async () => undefined,
      end: async () => undefined,
      query: async (text: string) => {
        queries.push(text);
        if (text.includes('pg_is_in_recovery')) return { rows: [{ standby: false }] };
        if (text.includes('to_regclass')) return { rows: [{ present: true }] };
        if (text.includes('__drizzle_migrations')) {
          return { rows: ledger.hashes.map((hash) => ({ hash })) };
        }
        return { rows: [] };
      },
    };
  });
  return { default: { ...actual.default, Client } };
});
vi.mock('@server/lib/logger', () => ({
  logger: { fatal: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { verifyMigrationsAtStartup } = await import('@server/db/startup');
const { getMigrationStatus, setMigrationStatus } = await import('@server/db/migration-status');
const { healthRoutes } = await import('@server/routes/health');
const { readMigrationFiles } = await import('drizzle-orm/migrator');
const { migrationsFolder } = await import('@server/db/migrate');

const journalHashes = readMigrationFiles({ migrationsFolder: migrationsFolder() }).map(
  (m) => m.hash
);

describe('startup is verify-only', () => {
  it('with the ledger behind the folder: logs "migrations pending", ready stays down, never migrates', async () => {
    setMigrationStatus('pending');
    // One journal migration is not in the ledger yet.
    ledger.hashes = journalHashes.slice(0, -1);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let pauses = 0;
    let caughtUp: () => void = () => {};
    const sawPending = new Promise<void>((resolve) => {
      caughtUp = resolve;
    });
    const done = verifyMigrationsAtStartup({
      log,
      retryMs: 0,
      pause: async () => {
        pauses += 1;
        if (pauses === 3) caughtUp();
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    await sawPending;

    const pendingLines = log.info.mock.calls.filter(([msg]) =>
      String(msg).includes('migrations pending')
    );
    expect(pendingLines).toHaveLength(1);
    expect(getMigrationStatus()).toBe('pending');
    const ready = await healthRoutes.request('/ready');
    expect(ready.status).toBe(503);

    // The migrate step catches the ledger up; the app notices on its next look.
    ledger.hashes = journalHashes;
    expect(await done).toBe('applied');
    expect(getMigrationStatus()).toBe('applied');

    expect(migrate).not.toHaveBeenCalled();
    expect(queries.some((q) => q.includes('pg_advisory_lock'))).toBe(false);
    expect(queries.some((q) => /\b(create|alter|insert|drop)\b/i.test(q))).toBe(false);
  });
});
