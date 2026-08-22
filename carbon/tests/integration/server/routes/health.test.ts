import { describe, expect, it, vi } from 'vitest';
import { mountRoute } from '../../../_helpers/app';

// supabaseAdmin is invoked only by the readiness check. We give it a
// chainable shape so .from(...).select(...).limit(...) resolves to a
// controllable result; the test overrides the resolved value per case.
const limitMock = vi.fn();
vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ limit: limitMock }) }),
  },
}));

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
  it('returns 200 when Supabase responds without error', async () => {
    limitMock.mockResolvedValueOnce({ data: [], error: null });
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

  it('returns 503 when Supabase responds with an error', async () => {
    limitMock.mockResolvedValueOnce({ data: null, error: new Error('db down') });
    const res = await app.request('/api/health/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('not_ready');
  });

  it('returns 503 when the Supabase client throws', async () => {
    limitMock.mockRejectedValueOnce(new Error('connection refused'));
    const res = await app.request('/api/health/ready');
    expect(res.status).toBe(503);
  });
});
