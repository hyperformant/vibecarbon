/**
 * redis_ping without an SSH handle. The old fallback probed
 * `https://{domain}/health` (not a route) and passed on any truthy
 * `body.redis`; no app route reports Redis, so without SSH the check fails
 * outright and makes no HTTP request at all.
 */
import { describe, expect, it, vi } from 'vitest';

const dnsSafeFetch = vi.fn();
vi.mock('../../e2e/checks/health.js', () => ({ dnsSafeFetch }));

const { checkRedisPing } = await import('../../e2e/checks/feature-redis.js');

describe('checkRedisPing without SSH', () => {
  it('fails (never passes on an HTTP body) and names the missing SSH access', async () => {
    const r = await checkRedisPing(undefined, undefined);
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/No SSH access/);
  });

  it('makes no HTTP request', async () => {
    await checkRedisPing(undefined, undefined);
    expect(dnsSafeFetch).not.toHaveBeenCalled();
  });
});
