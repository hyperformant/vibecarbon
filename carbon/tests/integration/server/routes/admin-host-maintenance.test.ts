import type { AuthUser as User } from '@server/auth';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';
import type { HostMaintenance } from '../../../../src/shared/host-maintenance';

const reader = vi.hoisted(() => ({ readHostMaintenance: vi.fn() }));
vi.mock('@server/lib/host-maintenance', () => reader);
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@server/lib/logger', () => ({ logger }));

const { hostMaintenanceRoutes } = await import('@server/routes/v1/admin/host-maintenance');
const { K8sApiError } = await import('@server/lib/k8s-api');

function appAs(role: string) {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'u1', role } as unknown as User);
    // aal2: this session passed a second factor, so only the role decides.
    c.set('session', { twoFactorVerified: true } as unknown as HonoVariables['session']);
    await next();
  });
  app.route('/api/v1/admin/host-maintenance', hostMaintenanceRoutes);
  return app;
}

const URL_PATH = '/api/v1/admin/host-maintenance';

const due: HostMaintenance = {
  runtime: 'compose',
  envName: 'prod',
  rebootRequired: true,
  since: '2026-11-15T06:42:10Z',
  servers: [
    {
      name: 'web-1',
      reporting: true,
      rebootRequired: true,
      since: '2026-11-15T06:42:10Z',
      packages: ['linux-base'],
    },
  ],
};

beforeEach(() => {
  reader.readHostMaintenance.mockReset();
  logger.error.mockReset();
});

describe('GET /api/v1/admin/host-maintenance', () => {
  it('refuses a user who is not a super admin', async () => {
    const res = await appAs('user').request(URL_PATH);
    expect(res.status).toBe(403);
    expect(reader.readHostMaintenance).not.toHaveBeenCalled();
  });

  it('returns the reader result to a super admin', async () => {
    reader.readHostMaintenance.mockResolvedValue(due);
    const res = await appAs('super_admin').request(URL_PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(due);
  });

  it.each([
    ['a K8sApiError', new K8sApiError(403)],
    ['a read failure', new Error('boom')],
  ])('gives 503 with an error string for %s', async (_label, err) => {
    reader.readHostMaintenance.mockRejectedValue(err);
    const res = await appAs('super_admin').request(URL_PATH);
    expect(res.status).toBe(503);
    expect(typeof (await res.json()).error).toBe('string');
  });
});
