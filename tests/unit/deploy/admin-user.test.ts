/**
 * Unit tests for the shared GoTrue admin-user provisioning helper.
 *
 * Background: the production app super-admin (auth.users row, app_metadata
 * role=super_admin) must be created post-deploy via GoTrue's admin API. The
 * HTTP logic is identical across deploy modes — only the tunnel to reach
 * GoTrue differs (compose: ssh -L; k8s: kubectl port-forward). This module
 * holds the tunnel-agnostic HTTP half; these tests lock its contract.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  adminUserBody,
  postAdminUser,
  waitForGotrueHealth,
} from '../../../src/lib/deploy/admin-user.js';

describe('adminUserBody', () => {
  it('confirms the email and stamps the super_admin role', () => {
    expect(adminUserBody('a@b.com', 'pw')).toEqual({
      email: 'a@b.com',
      password: 'pw',
      email_confirm: true,
      app_metadata: { role: 'super_admin' },
    });
  });
});

describe('postAdminUser', () => {
  const creds = {
    adminUsersUrl: 'http://localhost:9999/admin/users',
    serviceRoleKey: 'svc-role-key',
    adminEmail: 'admin@example.com',
    adminPassword: 'Sup3r!',
  };

  it('POSTs with the service-role bearer + apikey and the super_admin payload', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const out = await postAdminUser({ ...creds, fetchImpl });

    expect(out).toEqual({ success: true, message: 'Admin user created: admin@example.com' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:9999/admin/users');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer svc-role-key');
    expect(init.headers.apikey).toBe('svc-role-key');
    expect(JSON.parse(init.body)).toEqual({
      email: 'admin@example.com',
      password: 'Sup3r!',
      email_confirm: true,
      app_metadata: { role: 'super_admin' },
    });
  });

  it('treats 422 as idempotent success (user already exists)', async () => {
    const fetchImpl = vi.fn(async () => new Response('exists', { status: 422 }));
    const out = await postAdminUser({ ...creds, fetchImpl });
    expect(out).toEqual({ success: true, message: 'Admin user already exists: admin@example.com' });
  });

  it('reports failure with status + body on other errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const out = await postAdminUser({ ...creds, fetchImpl });
    expect(out.success).toBe(false);
    expect(out.message).toContain('500');
    expect(out.message).toContain('boom');
  });
});

describe('waitForGotrueHealth', () => {
  it('returns true once the health endpoint identifies as GoTrue', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(new Response('GoTrue is healthy', { status: 200 }));
    const ok = await waitForGotrueHealth('http://localhost:9999/health', {
      fetchImpl,
      attempts: 5,
      intervalMs: 1,
    });
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns false after exhausting attempts', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const ok = await waitForGotrueHealth('http://localhost:9999/health', {
      fetchImpl,
      attempts: 3,
      intervalMs: 1,
    });
    expect(ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
