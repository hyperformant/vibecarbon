/**
 * Unit tests for the client API layer (src/client/lib/api.ts): the one place
 * every page's queryFn/mutationFn goes through for the session cookie, the
 * step-up retry, JSON handling, and error extraction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, apiJson, setStepUpHandler } from '@/lib/api';

const fetchMock = vi.fn();
let unregister: (() => void) | null = null;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  unregister?.();
  unregister = null;
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('apiFetch', () => {
  it('sends the session cookie same-origin and never an Authorization header', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    await apiFetch('/api/v1/thing', { headers: { 'X-Custom': 'yes' } });

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/v1/thing');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toEqual({ 'X-Custom': 'yes' });
    expect('Authorization' in init.headers).toBe(false);
  });

  it('marks a string body as JSON (caller headers win)', async () => {
    fetchMock.mockResolvedValue(json({}));
    await apiFetch('/api/v1/w', { method: 'POST', body: '{}' });
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' });

    await apiFetch('/api/v1/w', {
      method: 'POST',
      body: 'a,b',
      headers: { 'Content-Type': 'text/csv' },
    });
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ 'Content-Type': 'text/csv' });
  });

  it('on 403 mfa_required (enrolled), steps up and retries the request once', async () => {
    const handler = vi.fn(async () => true);
    unregister = setStepUpHandler(handler);
    fetchMock
      .mockResolvedValueOnce(json({ error: 'mfa_required', mfa_enrolled: true }, 403))
      .mockResolvedValueOnce(json({ ok: true }));

    const res = await apiFetch('/api/v1/organizations/o1', { method: 'DELETE' });

    expect(handler).toHaveBeenCalledWith('verify');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
    expect(res.status).toBe(200);
  });

  it('retries at most once, even if the retry is refused again', async () => {
    const handler = vi.fn(async () => true);
    unregister = setStepUpHandler(handler);
    fetchMock.mockResolvedValue(json({ error: 'mfa_required', mfa_enrolled: true }, 403));

    const res = await apiFetch('/api/v1/x', { method: 'POST', body: '{}' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(403);
  });

  it('reports enroll when the user has no second factor, and does not retry on refusal', async () => {
    const handler = vi.fn(async () => false);
    unregister = setStepUpHandler(handler);
    fetchMock.mockResolvedValueOnce(json({ error: 'mfa_required', mfa_enrolled: false }, 403));

    const res = await apiFetch('/api/v1/x');

    expect(handler).toHaveBeenCalledWith('enroll');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ error: 'mfa_required' }); // body still readable
  });

  it('reports reauth on 403 reauth_required', async () => {
    const handler = vi.fn(async () => false);
    unregister = setStepUpHandler(handler);
    fetchMock.mockResolvedValueOnce(json({ error: 'reauth_required' }, 403));
    await apiFetch('/api/v1/x');
    expect(handler).toHaveBeenCalledWith('reauth');
  });

  it('leaves other 403s alone', async () => {
    const handler = vi.fn(async () => true);
    unregister = setStepUpHandler(handler);
    fetchMock.mockResolvedValueOnce(json({ error: 'Plan required' }, 403));
    const res = await apiFetch('/api/v1/x');
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
  });
});

describe('apiJson', () => {
  it('returns the parsed body on 2xx', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await expect(apiJson<{ ok: boolean }>('/api/v1/ok')).resolves.toEqual({ ok: true });
  });

  it('JSON.stringifies object bodies and passes strings through', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    await apiJson('/api/v1/w', { method: 'POST', body: { a: 1 } });
    expect(fetchMock.mock.calls[0][1].body).toBe('{"a":1}');

    await apiJson('/api/v1/w', { method: 'POST', body: 'raw' });
    expect(fetchMock.mock.calls[1][1].body).toBe('raw');
  });

  it("throws ApiError carrying the server's error field and HTTP status", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Plan required' }, 403));
    const err = await apiJson('/api/v1/gated').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('Plan required');
    expect(err.status).toBe(403);
  });

  it('falls back to the provided message on non-JSON error bodies', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));
    const err = await apiJson('/api/v1/x', {}, 'Could not load x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('Could not load x');
    expect(err.status).toBe(502);
  });

  it('resolves undefined for 204 No Content', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(apiJson<void>('/api/v1/none', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});
