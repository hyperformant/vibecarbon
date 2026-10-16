/**
 * Authentication on the admin Overview surfaces.
 *
 * Better Auth runs inside the API server (/api/auth), so there is no auth
 * container and no "Authentication" row. Its check is folded into the App
 * row: App is healthy only if the process answers AND its in-process auth
 * router answers GET /api/auth/ok. Nothing dials a separate auth service, and
 * nothing offers to restart one. The Service Latency chart lists only
 * services one network hop away, each with a measured round trip.
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

// The App row asks the in-process auth router, never the network.
const { authHandler } = vi.hoisted(() => ({
  authHandler: vi.fn(async (_req: Request) => Response.json({ ok: true })),
}));
vi.mock('@server/auth', () => ({ auth: { handler: authHandler } }));

const { servicesStatusRoutes, checkApp } = await import(
  '@server/routes/_internal/services-status'
);
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
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  authHandler.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface StatusRow {
  name: string;
  container: string;
  status: string;
  error?: string;
}

async function statusRows(): Promise<StatusRow[]> {
  const res = await appWithAdmin().request('/status');
  expect(res.status).toBe(200);
  return ((await res.json()) as { services: StatusRow[] }).services;
}

describe('services status: auth is folded into the App row', () => {
  it('lists no Authentication row and checks auth in-process for App', async () => {
    const rows = await statusRows();
    expect(rows.map((r) => r.name)).not.toContain('Authentication');
    expect(rows.map((r) => r.container)).not.toContain('auth');
    expect(rows.find((r) => r.container === 'app')).toMatchObject({
      name: 'App',
      status: 'healthy',
    });
    const asked = authHandler.mock.calls.map(([req]) => new URL(req.url).pathname);
    expect(asked).toEqual(['/api/auth/ok']);
    for (const url of dialed()) expect(url).not.toContain('/api/auth');
  });

  it('marks App unhealthy when the auth router errors', async () => {
    authHandler.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const app = (await statusRows()).find((r) => r.container === 'app');
    expect(app).toMatchObject({ status: 'unhealthy', error: 'Auth not answering' });
  });

  it('marks App unhealthy when the auth router throws or hangs', async () => {
    const thrown = await checkApp(async () => {
      throw new Error('auth init failed');
    });
    expect(thrown).toMatchObject({ status: 'unhealthy', error: 'Auth not answering' });

    const hung = await checkApp(() => new Promise<Response>(() => {}), 30);
    expect(hung).toMatchObject({ status: 'unhealthy', error: 'Auth timeout' });
  });

  it('refuses to restart an auth container: there is none', async () => {
    const res = await appWithAdmin().request('/status/restart/auth', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});

describe('admin performance: only measured services are charted', () => {
  it('reports PostgreSQL and Traefik, with no Authentication item', async () => {
    const res = await appWithAdmin().request('/performance');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      services: {
        healthy: number;
        total: number;
        items: Array<{ name: string; status: string; latencyMs: number }>;
      };
    };
    expect(body.services.items.map((i) => i.name).sort()).toEqual(['PostgreSQL', 'Traefik']);
    expect(body.services.total).toBe(2);
    expect(pingDb).toHaveBeenCalled();
    for (const url of dialed()) expect(url).not.toContain('/api/auth');
  });
});
