/**
 * The rows on the admin Services Status panel, and restarts.
 *
 * The panel lists the containers this environment runs and no others:
 * - app, db and traefik everywhere;
 * - docker-socket-proxy only where it runs: a production compose deployment,
 *   which sets DOCKER_API_PROXY. Local dev talks to the host socket and k8s
 *   has no Docker API, so neither lists it;
 * - s3 (Garage, the dev object store) only when Docker reports it running.
 *
 * Restarts need the docker CLI and compose files next to the API, which only
 * local dev has, so production and k8s offer none. docker-socket-proxy is
 * never restartable, and restart-all never restarts `app`: that is the
 * process answering the request.
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

vi.mock('@server/auth', () => ({
  auth: { handler: vi.fn(async () => Response.json({ ok: true })) },
}));
const { listProjectContainers } = vi.hoisted(() => ({
  listProjectContainers: vi.fn(async (): Promise<Array<Record<string, string>>> => []),
}));
vi.mock('@server/lib/docker-api', async (orig) => ({
  ...(await orig<typeof import('@server/lib/docker-api')>()),
  listProjectContainers,
}));

/** What the Docker listing returns for a running litetest dev stack. */
const DEV_STACK = ['app', 'traefik', 'db', 's3'].map((service) => ({
  id: `id-${service}`,
  name: `litetest-${service}`,
  service,
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

interface Row {
  name: string;
  container: string;
  status: string;
  restartable?: boolean;
}

async function rows(env: Record<string, string>): Promise<Row[]> {
  const res = await (await appWith(env)).request('/status');
  expect(res.status).toBe(200);
  return ((await res.json()) as { services: Row[] }).services;
}

async function containers(env: Record<string, string>): Promise<string[]> {
  return (await rows(env)).map((s) => s.container);
}

afterEach(() => {
  exec.mockClear();
  listProjectContainers.mockReset();
  listProjectContainers.mockResolvedValue([]);
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

describe('services status: discovered containers', () => {
  it('lists the running dev stack, Garage included, and nothing else', async () => {
    listProjectContainers.mockResolvedValue(DEV_STACK);
    const listed = await rows({ PROJECT_NAME: 'litetest' });
    expect(listed.map((r) => r.container).sort()).toEqual(['app', 'db', 's3', 'traefik']);
    expect(listed.find((r) => r.container === 's3')).toMatchObject({
      name: 'Storage (S3)',
      status: 'healthy',
    });
  });

  it('never lists s3 when no s3 container runs (production)', async () => {
    listProjectContainers.mockResolvedValue(DEV_STACK.filter((c) => c.service !== 's3'));
    expect(await containers({ PROJECT_NAME: 'litetest' })).not.toContain('s3');
  });

  it("reports s3 unhealthy when its container's healthcheck fails", async () => {
    listProjectContainers.mockResolvedValue(
      DEV_STACK.map((c) => (c.service === 's3' ? { ...c, health: 'unhealthy' } : c)),
    );
    const s3 = (await rows({ PROJECT_NAME: 'litetest' })).find((r) => r.container === 's3');
    expect(s3).toMatchObject({ status: 'unhealthy', error: 'Container not healthy' });
  });

  it('does not list env-flagged add-ons whose containers Docker says are absent', async () => {
    listProjectContainers.mockResolvedValue(DEV_STACK);
    expect(await containers({ PROJECT_NAME: 'litetest', N8N_ENABLED: 'true' })).not.toContain(
      'n8n',
    );
  });
});

describe('services restart', () => {
  it('restarts every restartable service except app, the process answering', async () => {
    listProjectContainers.mockResolvedValue(DEV_STACK);
    const app = await appWith({ PROJECT_NAME: 'litetest' });
    const res = await app.request('/status/restart', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ container: string }> };
    const restarted = body.results.map((r) => r.container).sort();
    expect(restarted).toEqual(['db', 's3', 'traefik']);
    const commands = exec.mock.calls.map(([cmd]) => cmd);
    expect(commands).not.toContain('docker compose restart app');
    expect(commands).toContain('docker compose restart db');
  });

  it('never restarts docker-socket-proxy, alone or in restart-all', async () => {
    const env = { DOCKER_API_PROXY: 'http://docker-socket-proxy:2375' };
    const listed = await rows(env);
    expect(listed.find((r) => r.container === 'docker-socket-proxy')?.restartable).toBe(false);

    const single = await (await appWith(env)).request('/status/restart/docker-socket-proxy', {
      method: 'POST',
    });
    expect(single.status).toBe(400);

    const all = await (await appWith(env)).request('/status/restart', { method: 'POST' });
    const body = (await all.json()) as { results: Array<{ container: string }> };
    expect(body.results.map((r) => r.container)).not.toContain('docker-socket-proxy');
    expect(exec.mock.calls.map(([cmd]) => cmd)).not.toContain(
      'docker compose restart docker-socket-proxy',
    );
  });

  it('offers no restart in the production container, which has no docker CLI', async () => {
    const env = { NODE_ENV: 'production', DOCKER_API_PROXY: 'http://docker-socket-proxy:2375' };
    expect((await rows(env)).every((r) => r.restartable === false)).toBe(true);
    const res = await (await appWith(env)).request('/status/restart/db', { method: 'POST' });
    expect(res.status).toBe(501);
    expect(exec).not.toHaveBeenCalled();
  });

  it('marks the dev stack restartable', async () => {
    listProjectContainers.mockResolvedValue(DEV_STACK);
    const listed = await rows({ PROJECT_NAME: 'litetest' });
    expect(listed.every((r) => r.restartable === true)).toBe(true);
  });
});
