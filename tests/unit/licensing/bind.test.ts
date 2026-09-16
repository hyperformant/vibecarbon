import { describe, expect, it, vi } from 'vitest';
import { bindLicense, requestRelease } from '../../../src/lib/licensing/bind.js';

const KEY = `vc-0123456789abcdef-${'a'.repeat(128)}`;
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const env = { VIBECARBON_API_BASE: 'http://stub.test' };

function fetchReturning(status: number, body: unknown, ok = status < 400) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe('bindLicense', () => {
  it('POSTs key, projectId, cliVersion to /api/v1/license/bind and returns the binding', async () => {
    const fetchImpl = fetchReturning(200, {
      projectId: PROJECT_ID,
      tier: 'graphene',
      status: 'active',
      periodEnd: '2026-10-15T00:00:00.000Z',
    });
    const r = await bindLicense({ key: KEY, projectId: PROJECT_ID.toUpperCase(), env, fetchImpl });
    expect(r).toEqual({
      ok: true,
      projectId: PROJECT_ID,
      tier: 'graphene',
      status: 'active',
      periodEnd: '2026-10-15T00:00:00.000Z',
    });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('http://stub.test/api/v1/license/bind');
    const sent = JSON.parse(String(init.body));
    expect(sent.key).toBe(KEY);
    expect(sent.projectId).toBe(PROJECT_ID);
    expect(typeof sent.cliVersion).toBe('string');
  });

  it('maps the three 4xx refusals', async () => {
    expect(
      await bindLicense({
        key: KEY,
        projectId: PROJECT_ID,
        env,
        fetchImpl: fetchReturning(409, { error: 'bound_to_other_project' }),
      }),
    ).toEqual({ ok: false, reason: 'bound_to_other_project' });
    expect(
      await bindLicense({
        key: KEY,
        projectId: PROJECT_ID,
        env,
        fetchImpl: fetchReturning(409, {
          error: 'project_already_licensed',
          switchPlan: true,
          message: 'm',
        }),
      }),
    ).toEqual({ ok: false, reason: 'project_already_licensed', switchPlan: true, message: 'm' });
    expect(
      await bindLicense({
        key: KEY,
        projectId: PROJECT_ID,
        env,
        fetchImpl: fetchReturning(403, { error: 'subscription_inactive' }),
      }),
    ).toEqual({ ok: false, reason: 'subscription_inactive' });
    expect(
      await bindLicense({
        key: KEY,
        projectId: PROJECT_ID,
        env,
        fetchImpl: fetchReturning(401, { error: 'unknown_key' }),
      }),
    ).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('treats 429/5xx and network errors as unreachable, other JSON errors as rejected', async () => {
    expect(
      (
        await bindLicense({
          key: KEY,
          projectId: PROJECT_ID,
          env,
          fetchImpl: fetchReturning(503, { error: 'x' }),
        })
      ).reason,
    ).toBe('unreachable');
    expect(
      (
        await bindLicense({
          key: KEY,
          projectId: PROJECT_ID,
          env,
          fetchImpl: fetchReturning(429, {}),
        })
      ).reason,
    ).toBe('unreachable');
    const failing = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });
    }) as unknown as typeof fetch;
    const r = await bindLicense({ key: KEY, projectId: PROJECT_ID, env, fetchImpl: failing });
    expect(r).toEqual({ ok: false, reason: 'unreachable', detail: 'ECONNREFUSED' });
    expect(
      (
        await bindLicense({
          key: KEY,
          projectId: PROJECT_ID,
          env,
          fetchImpl: fetchReturning(400, { error: 'invalid_request' }),
        })
      ).reason,
    ).toBe('rejected');
  });

  it('defaults the host to vibecarbon.com', async () => {
    const fetchImpl = fetchReturning(200, {
      projectId: PROJECT_ID,
      tier: 'graphene',
      status: 'active',
      periodEnd: 'x',
    });
    await bindLicense({ key: KEY, projectId: PROJECT_ID, env: {}, fetchImpl });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'https://vibecarbon.com/api/v1/license/bind',
    );
  });
});

describe('requestRelease', () => {
  it('POSTs the key to /release and returns ok on sent:true', async () => {
    const fetchImpl = fetchReturning(200, { sent: true });
    expect(await requestRelease({ key: KEY, env, fetchImpl })).toEqual({ ok: true });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'http://stub.test/api/v1/license/release',
    );
  });
  it('maps unknown_key, unreachable, rejected', async () => {
    expect(
      await requestRelease({
        key: KEY,
        env,
        fetchImpl: fetchReturning(401, { error: 'unknown_key' }),
      }),
    ).toEqual({ ok: false, reason: 'unknown_key' });
    expect(
      (await requestRelease({ key: KEY, env, fetchImpl: fetchReturning(500, {}) })).reason,
    ).toBe('unreachable');
    expect(
      (
        await requestRelease({
          key: KEY,
          env,
          fetchImpl: fetchReturning(400, { error: 'invalid_key' }),
        })
      ).reason,
    ).toBe('rejected');
  });
});
