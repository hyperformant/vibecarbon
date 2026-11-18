import type { AuthUser as User } from '@server/auth';
import type { HonoVariables } from '@server/types';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/v1/admin/performance (src/server/routes/v1/performance.ts): who
 * may read it, the response shape, and how the two probes it times (Postgres
 * and Traefik) become the services summary.
 */

// The route sits behind the aal2 gate; the MFA setting is not under test here.
vi.mock('@server/lib/mfa-settings', () => ({ isMfaGloballyEnabled: async () => false }));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

type Probe = { ok: boolean; latencyMs: number };

const { pingDb, traefik } = vi.hoisted(() => ({
  pingDb: vi.fn(async (): Promise<Probe> => ({ ok: true, latencyMs: 4 })),
  // null: run the real Traefik probe against the stubbed fetch.
  traefik: { fixed: null as Probe | null },
}));
vi.mock('@server/db/client', () => ({ pingDb }));
vi.mock('@server/lib/traefik-probe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@server/lib/traefik-probe')>();
  return {
    ...real,
    probeTraefik: async (timeoutMs: number) => traefik.fixed ?? real.probeTraefik(timeoutMs),
  };
});

const { performanceRoutes } = await import('@server/routes/v1/performance');

const SUPER_ADMIN: Partial<User> = { id: 'admin-1', email: 'admin@example.com', role: 'super_admin' };

function appAs(user: Partial<User> | null) {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    if (user) c.set('user', user as any);
    await next();
  });
  app.route('/performance', performanceRoutes);
  return app;
}

type Item = { name: string; latencyMs: number; status: string };
type Body = {
  server: {
    uptimeSeconds: number;
    memoryMB: { rss: number; heapUsed: number; heapTotal: number };
    nodeVersion: string;
    platform: string;
  };
  services: { healthy: number; total: number; avgLatencyMs: number; items: Item[] };
};

async function read(): Promise<Body> {
  const res = await appAs(SUPER_ADMIN).request('/performance');
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
}

const fetchMock = vi.fn();

beforeEach(() => {
  pingDb.mockReset();
  pingDb.mockResolvedValue({ ok: true, latencyMs: 4 });
  traefik.fixed = { ok: true, latencyMs: 12 };
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('admin performance: who may read it', () => {
  it('returns 401 with no user', async () => {
    const res = await appAs(null).request('/performance');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 403 for a regular user', async () => {
    const res = await appAs({ id: 'user-1', email: 'user@example.com', role: 'user' }).request(
      '/performance'
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Super admin access required' });
  });

  it('returns 403 for a user with no role', async () => {
    const res = await appAs({ id: 'user-2', email: 'norole@example.com' }).request('/performance');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Super admin access required' });
  });

  it('returns 200 for a super admin', async () => {
    const res = await appAs(SUPER_ADMIN).request('/performance');
    expect(res.status).toBe(200);
  });
});

describe('admin performance: response shape', () => {
  it('has exactly the server and services fields at the top level', async () => {
    expect(Object.keys(await read()).sort()).toEqual(['server', 'services']);
  });

  it('reports uptime and memory as whole numbers', async () => {
    const { server } = await read();
    expect(Number.isInteger(server.uptimeSeconds)).toBe(true);
    for (const value of [server.memoryMB.rss, server.memoryMB.heapUsed, server.memoryMB.heapTotal]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('reports this process’s Node version and platform', async () => {
    const { server } = await read();
    expect(server.nodeVersion).toBe(process.version);
    expect(server.platform).toBe(`${process.platform} ${process.arch}`);
  });

  it('reports the services summary as numbers and an item list', async () => {
    const { services } = await read();
    expect(typeof services.healthy).toBe('number');
    expect(typeof services.total).toBe('number');
    expect(typeof services.avgLatencyMs).toBe('number');
    expect(Array.isArray(services.items)).toBe(true);
  });

  it('lists PostgreSQL then Traefik, each with a name, a latency and a status', async () => {
    const { services } = await read();
    expect(services.items).toEqual([
      { name: 'PostgreSQL', latencyMs: 4, status: 'healthy' },
      { name: 'Traefik', latencyMs: 12, status: 'healthy' },
    ]);
  });
});

describe('admin performance: services summary', () => {
  it('counts both services healthy and averages their latency', async () => {
    const { services } = await read();
    expect(services).toMatchObject({ healthy: 2, total: 2, avgLatencyMs: 8 });
  });

  it('counts healthy and total apart when one probe fails', async () => {
    pingDb.mockResolvedValue({ ok: false, latencyMs: 2000 });
    traefik.fixed = { ok: true, latencyMs: 13 };
    const { services } = await read();
    expect(services).toMatchObject({ healthy: 1, total: 2 });
    expect(services.items[0]).toEqual({ name: 'PostgreSQL', latencyMs: 2000, status: 'unhealthy' });
  });

  it('averages latency over the healthy services only', async () => {
    pingDb.mockResolvedValue({ ok: false, latencyMs: 2000 });
    traefik.fixed = { ok: true, latencyMs: 13 };
    expect((await read()).services.avgLatencyMs).toBe(13);
  });

  it('reports an average of 0 when no service is healthy', async () => {
    pingDb.mockResolvedValue({ ok: false, latencyMs: 2000 });
    traefik.fixed = { ok: false, latencyMs: 2000 };
    const { services } = await read();
    expect(services).toMatchObject({ healthy: 0, total: 2, avgLatencyMs: 0 });
  });
});

describe('admin performance: Traefik status from the real probe', () => {
  async function traefikStatus(): Promise<string | undefined> {
    traefik.fixed = null;
    return (await read()).services.items.find((i) => i.name === 'Traefik')?.status;
  }

  it('is healthy on a 2xx', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    expect(await traefikStatus()).toBe('healthy');
  });

  it('is unhealthy on a 5xx', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await traefikStatus()).toBe('unhealthy');
  });

  it('is unhealthy when the request fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await traefikStatus()).toBe('unhealthy');
  });
});
