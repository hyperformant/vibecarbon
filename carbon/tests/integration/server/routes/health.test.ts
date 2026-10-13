import { describe, expect, it, vi } from 'vitest';
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

  // `vibecarbon deploy` waits for adminReady before calling a deploy done.
  it('reports adminReady from the startup bootstrap, false until it succeeds', async () => {
    const { setAdminReady } = await import('@server/auth/admin-status');
    const read = async () =>
      ((await (await app.request('/api/health')).json()) as { adminReady: unknown }).adminReady;
    expect(await read()).toBe(false);
    setAdminReady(true);
    expect(await read()).toBe(true);
    setAdminReady(false);
    expect(await read()).toBe(false);
  });
});

describe('GET /api/health/ready', () => {
  it('returns 200 when the database answers', async () => {
    pingDb.mockResolvedValueOnce(UP);
    const res = await app.request('/api/health/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      services: { database: string; supabase: string };
    };
    expect(body.status).toBe('ready');
    expect(body.services.database).toBe('connected');
    expect(body.services.supabase).toBe('connected');
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
