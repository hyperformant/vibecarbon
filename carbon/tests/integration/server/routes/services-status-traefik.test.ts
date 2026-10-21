/**
 * The Traefik row on the admin Infrastructure page and the performance page.
 *
 * In production compose, Traefik's web entrypoint redirects every request to
 * HTTPS. The probe must take that 3xx as Traefik answering and never follow
 * it (following would chase the public URL and report a running Traefik as
 * down). A network error is Traefik not running.
 */

import type { AuthUser as User } from '@server/auth';
import type { HonoVariables } from '@server/types';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These routes sit behind the aal2 gate; the MFA setting is not under test here.
vi.mock('@server/lib/mfa-settings', () => ({ isMfaGloballyEnabled: async () => false }));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const { pingDb } = vi.hoisted(() => ({
  pingDb: vi.fn(async () => ({ ok: true as const, latencyMs: 1 })),
}));
vi.mock('@server/db/client', () => ({ pingDb }));

const { servicesStatusRoutes } = await import('@server/routes/_internal/services-status');
const { performanceRoutes } = await import('@server/routes/v1/performance');
const { TRAEFIK_HEALTH_URL } = await import('@server/lib/traefik-probe');

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

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Row = { name: string; container: string; status: string; error?: string };

async function traefikRow(): Promise<Row | undefined> {
  const res = await appWithAdmin().request('/status');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { services: Row[] };
  return body.services.find((s) => s.container === 'traefik');
}

function traefikCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url) === TRAEFIK_HEALTH_URL);
}

describe('services status: Traefik row', () => {
  it('counts an HTTP to HTTPS redirect as healthy and does not follow it', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 308 }));
    expect(await traefikRow()).toMatchObject({ name: 'Traefik', status: 'healthy' });
    expect(traefikCalls()).toHaveLength(1);
    expect(traefikCalls()[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('counts a 404 (no router for the bare service name) as healthy', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await traefikRow()).toMatchObject({ status: 'healthy' });
  });

  it('reports Traefik unhealthy, not running, on a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await traefikRow()).toMatchObject({ status: 'unhealthy', error: 'Not running' });
  });

  it('reports Traefik unhealthy on a 5xx', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }));
    expect(await traefikRow()).toMatchObject({ status: 'unhealthy', error: 'HTTP 502' });
  });
});

describe('admin performance: Traefik latency', () => {
  it('uses the same probe: a redirect is healthy and is not followed', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 301 }));
    const res = await appWithAdmin().request('/performance');
    const body = (await res.json()) as { services: { items: Array<{ name: string; status: string }> } };
    expect(body.services.items.find((i) => i.name === 'Traefik')).toMatchObject({
      status: 'healthy',
    });
    expect(traefikCalls()[0][1]).toMatchObject({ redirect: 'manual' });
  });
});
