/**
 * Authentication health on the admin Infrastructure surfaces.
 *
 * Auth runs inside the API server (/api/auth), so there is no auth container
 * to probe: GET /api/_internal/services/status and GET
 * /api/v1/admin/performance report it up whenever the app answers, never
 * dial a separate auth service, and never offer to restart one.
 */

import type { AuthUser as User } from '@server/auth';
import type { HonoVariables } from '@server/types';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// The database row is a `select 1` over the app's connection, not a fetch.
const { pingDb } = vi.hoisted(() => ({
  pingDb: vi.fn(async () => ({ ok: true as const, latencyMs: 1 })),
}));
vi.mock('@server/db/client', () => ({ pingDb }));

const { servicesStatusRoutes } = await import('@server/routes/_internal/services-status');
const { performanceRoutes } = await import('@server/routes/v1/performance');

const SUPER_ADMIN: Partial<User> = { id: 'admin-1', role: 'super_admin' };

function appWithAdmin() {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    c.set('user', SUPER_ADMIN as any);
    await next();
  });
  app.route('/status', servicesStatusRoutes);
  app.route('/performance', performanceRoutes);
  return app;
}

const fetchMock = vi.fn();
const dialed = () => fetchMock.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  // Every probed service answers 200; only the auth row must not be probed.
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface StatusRow {
  name: string;
  container: string;
  status: string;
  inProcess?: boolean;
}

describe('services status: Authentication is in-process', () => {
  it('reports Authentication healthy without dialing an auth service', async () => {
    const res = await appWithAdmin().request('/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { services: StatusRow[] };
    const auth = body.services.filter((s) => s.name === 'Authentication');
    expect(auth).toEqual([
      expect.objectContaining({ container: 'auth', status: 'healthy', inProcess: true }),
    ]);
    expect(dialed().length).toBeGreaterThan(0);
    for (const url of dialed()) {
      expect(url).not.toContain('/auth/v1');
      expect(url).not.toContain(':9999');
    }
  });

  it('refuses to restart the in-process auth as a container', async () => {
    const res = await appWithAdmin().request('/status/restart/auth', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});

describe('admin performance: Authentication is in-process', () => {
  it('counts Authentication as healthy, unprobed and outside the latency average', async () => {
    const res = await appWithAdmin().request('/performance');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      services: {
        healthy: number;
        total: number;
        items: Array<{ name: string; status: string; latencyMs: number }>;
      };
    };
    const auth = body.services.items.find((i) => i.name === 'Authentication');
    expect(auth).toEqual({ name: 'Authentication', status: 'healthy', latencyMs: 0 });
    // Probed: Postgres (select 1) and Traefik (fetch). Authentication is not.
    expect(pingDb).toHaveBeenCalled();
    expect(body.services.total).toBe(fetchMock.mock.calls.length + 2);
    for (const url of dialed()) {
      expect(url).not.toContain('/auth/v1');
      expect(url).not.toContain(':9999');
    }
  });
});
