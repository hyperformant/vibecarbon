/**
 * The core rows on the admin Infrastructure page, and restart-all.
 *
 * docker-socket-proxy is listed only where it runs: a production compose
 * deployment, which sets DOCKER_API_PROXY. Local dev talks to the host
 * socket and k8s has no Docker API, so neither lists it. Restart-all never
 * restarts `app`: that is the process answering the request.
 */

import type { AuthUser as User } from '@server/auth';
import type { HonoVariables } from '@server/types';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/db/client', () => ({
  pingDb: vi.fn(async () => ({ ok: true as const, latencyMs: 1 })),
}));
const { exec } = vi.hoisted(() => ({
  exec: vi.fn(
    (_cmd: string, _opts: unknown, cb: (err: Error | null, out: { stdout: string }) => void) =>
      cb(null, { stdout: '' }),
  ),
}));
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  exec,
}));

const SUPER_ADMIN: Partial<User> = { id: 'admin-1', role: 'super_admin' };

/** Load the routes fresh under `env` (the runtime is read at module load). */
async function appWith(env: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv('KUBERNETES_SERVICE_HOST', '');
  vi.stubEnv('DOCKER_API_PROXY', '');
  vi.stubEnv('PROJECT_NAME', '');
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 200 })),
  );
  const { servicesStatusRoutes } = await import('@server/routes/_internal/services-status');
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    c.set('user', SUPER_ADMIN as any);
    await next();
  });
  app.route('/status', servicesStatusRoutes);
  return app;
}

async function containers(env: Record<string, string>): Promise<string[]> {
  const res = await (await appWith(env)).request('/status');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { services: Array<{ container: string }> };
  return body.services.map((s) => s.container);
}

afterEach(() => {
  exec.mockClear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('services status: core rows', () => {
  it('lists app, db and traefik with no socket proxy in local dev', async () => {
    const rows = await containers({});
    expect(rows).toEqual(expect.arrayContaining(['app', 'db', 'traefik']));
    expect(rows).not.toContain('docker-socket-proxy');
  });

  it('lists docker-socket-proxy when DOCKER_API_PROXY is set (production compose)', async () => {
    const rows = await containers({ DOCKER_API_PROXY: 'http://docker-socket-proxy:2375/' });
    expect(rows).toContain('docker-socket-proxy');
    const ping = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(ping).toContain('http://docker-socket-proxy:2375/_ping');
  });

  it('never lists docker-socket-proxy on k8s, even with DOCKER_API_PROXY set', async () => {
    const rows = await containers({
      KUBERNETES_SERVICE_HOST: '10.43.0.1',
      DOCKER_API_PROXY: 'http://docker-socket-proxy:2375',
    });
    expect(rows).toEqual(expect.arrayContaining(['app', 'db', 'traefik']));
    expect(rows).not.toContain('docker-socket-proxy');
  });
});

describe('services restart-all', () => {
  it('restarts every core service except app, the process answering the request', async () => {
    const app = await appWith({ DOCKER_API_PROXY: 'http://docker-socket-proxy:2375' });
    const res = await app.request('/status/restart', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ container: string }> };
    const restarted = body.results.map((r) => r.container).sort();
    expect(restarted).toEqual(['db', 'docker-socket-proxy', 'traefik']);
    const commands = exec.mock.calls.map(([cmd]) => cmd);
    expect(commands).not.toContain('docker compose restart app');
    expect(commands).toContain('docker compose restart db');
  });
});
