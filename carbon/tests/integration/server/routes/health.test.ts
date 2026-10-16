import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mountRoute } from '../../../_helpers/app';

// The readiness check asks the DB module whether Postgres answers. pingDb
// never throws (an unreachable db is `{ ok: false, error }`), so each case
// sets its result.
type Ping = { ok: true } | { ok: false; error: unknown };
const { pingDb, logger } = vi.hoisted(() => ({
  pingDb: vi.fn<() => Promise<Ping>>(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/db/client', () => ({ pingDb }));
vi.mock('@server/lib/logger', () => ({ logger }));

const UP: Ping = { ok: true };
const down = (): Ping => ({
  ok: false,
  error: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' }),
});

const { healthRoutes } = await import('@server/routes/health');
const app = mountRoute('/api/health', healthRoutes);

describe('GET /api/health', () => {
  it('returns 200 with a timestamp (liveness probe is independent of deps)', async () => {
    // Hono mounts: app.route('/api/health', healthRoutes) + healthRoutes.get('/').
    // Match the path without a trailing slash — Hono's router is strict.
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');
  });

  // `vibecarbon deploy` waits for adminReady before calling a deploy done,
  // and stops early on a terminal adminStatus.
  it('reports the startup bootstrap: pending, then ready or a terminal reason', async () => {
    const { setAdminStatus } = await import('@server/auth/admin-status');
    const read = async () =>
      (await (await app.request('/api/health')).json()) as {
        adminReady: unknown;
        adminStatus: unknown;
      };
    expect(await read()).toMatchObject({ adminReady: false, adminStatus: 'pending' });
    setAdminStatus('ready');
    expect(await read()).toMatchObject({ adminReady: true, adminStatus: 'ready' });
    setAdminStatus('refused');
    expect(await read()).toMatchObject({ adminReady: false, adminStatus: 'refused' });
    setAdminStatus('pending');
  });

  // `vibecarbon deploy` also waits for the migrations; a failure carries a
  // SQLSTATE, never the error message.
  it('reports the migrations: pending, applied, or failed with a SQLSTATE', async () => {
    const { setMigrationStatus } = await import('@server/db/migration-status');
    const read = async () =>
      (await (await app.request('/api/health')).json()) as Record<string, unknown>;
    expect(await read()).toMatchObject({ migrationStatus: 'pending' });
    expect(await read()).not.toHaveProperty('migrationError');
    setMigrationStatus('failed', 'SQLSTATE 42P07');
    expect(await read()).toMatchObject({
      migrationStatus: 'failed',
      migrationError: 'SQLSTATE 42P07',
    });
    setMigrationStatus('applied');
    const applied = await read();
    expect(applied.migrationStatus).toBe('applied');
    expect(applied).not.toHaveProperty('migrationError');
    setMigrationStatus('pending');
  });
});

describe('GET /api/health/ready before migrations', () => {
  it('is 503 until the migrations are applied, without asking the database', async () => {
    pingDb.mockClear();
    const res = await app.request('/api/health/ready');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'not_ready', migrationStatus: 'pending' });
    expect(pingDb).not.toHaveBeenCalled();
  });
});

describe('GET /api/health/ready', () => {
  beforeAll(async () => {
    const { setMigrationStatus } = await import('@server/db/migration-status');
    setMigrationStatus('applied');
  });

  it('returns 200 when the database answers', async () => {
    pingDb.mockResolvedValueOnce(UP);
    const res = await app.request('/api/health/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      services: Record<string, string>;
    };
    expect(body.status).toBe('ready');
    expect(body.services).toEqual({ database: 'connected' });
  });

  // Review Focus 5: the db container may still be starting. The server is up
  // and says so: 503 not_ready, so the orchestrator holds traffic back.
  it('returns 503 not_ready when the database is unreachable', async () => {
    pingDb.mockResolvedValueOnce(down());
    const res = await app.request('/api/health/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('not_ready');
  });

  // The orchestrator probes every few seconds. An outage logs its cause
  // once when it starts and once when it ends, never a line per probe.
  it('logs the cause once per outage and once on recovery, not on every probe', async () => {
    pingDb.mockReset();
    pingDb.mockResolvedValueOnce(UP);
    await app.request('/api/health/ready');
    logger.error.mockClear();
    logger.info.mockClear();

    pingDb.mockResolvedValue(down());
    for (let i = 0; i < 4; i++) {
      expect((await app.request('/api/health/ready')).status).toBe(503);
    }
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [fields] = logger.error.mock.calls[0] as [{ err: { code?: string } }];
    expect(fields.err.code).toBe('ECONNREFUSED');

    pingDb.mockResolvedValue(UP);
    for (let i = 0; i < 3; i++) {
      expect((await app.request('/api/health/ready')).status).toBe(200);
    }
    expect(logger.info).toHaveBeenCalledTimes(1);

    // A second outage is a new state change, so it logs again.
    pingDb.mockResolvedValue(down());
    await app.request('/api/health/ready');
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('the liveness probe stays 200 while the database is down', async () => {
    pingDb.mockReset();
    pingDb.mockResolvedValue(down());
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(pingDb).not.toHaveBeenCalled();
  });
});
