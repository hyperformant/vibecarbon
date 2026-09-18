import { describe, expect, it, vi } from 'vitest';
import { checkRemoteHealth } from '../../../src/status.js';

describe('checkRemoteHealth', () => {
  it('probes the readiness endpoint so the db/supabase detail can render', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ready',
        timestamp: '2026-09-18T00:00:00.000Z',
        services: { database: 'connected', supabase: 'connected' },
      }),
    }));
    const out = await checkRemoteHealth('example.test', {
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(out.url).toBe('https://example.test/api/health/ready');
    expect(fetchSpy.mock.calls[0][0]).toBe('https://example.test/api/health/ready');
    expect(out.data.services.database).toBe('connected');
  });
});
