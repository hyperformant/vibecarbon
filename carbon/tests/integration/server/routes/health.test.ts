import { describe, expect, it, vi } from 'vitest';
import { mountRoute } from '../../../_helpers/app';

// The readiness check asks the DB module whether Postgres answers. pingDb
// never throws (an unreachable db is `false`), so each case sets its result.
const { pingDb } = vi.hoisted(() => ({ pingDb: vi.fn<() => Promise<boolean>>() }));
vi.mock('@server/db/client', () => ({ pingDb }));

// Quiet the route's error log on the failure path — it's expected.
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

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
});

describe('GET /api/health/ready', () => {
  it('returns 200 when the database answers', async () => {
    pingDb.mockResolvedValueOnce(true);
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
    pingDb.mockResolvedValueOnce(false);
    const res = await app.request('/api/health/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('not_ready');
  });

  it('the liveness probe stays 200 while the database is down', async () => {
    pingDb.mockReset();
    pingDb.mockResolvedValue(false);
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(pingDb).not.toHaveBeenCalled();
  });
});
