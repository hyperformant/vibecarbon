import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForDropletIdle } from '../../../src/lib/iac/droplet-idle.js';

const reply = (actions: unknown[], status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => ({ actions }) }) as Response;
const inProgress = { id: 7, type: 'create', status: 'in-progress' };
const done = { id: 7, type: 'create', status: 'completed' };

describe('waitForDropletIdle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns at once when the first poll shows no action in progress', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply([done]));
    await waitForDropletIdle({ token: 't', dropletId: '1', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.digitalocean.com/v2/droplets/1/actions?per_page=20',
    );
  });

  it('returns after the second poll once the action completes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply([inProgress]))
      .mockResolvedValueOnce(reply([done]));
    const p = waitForDropletIdle({ token: 't', dropletId: '1', intervalMs: 1000, fetchImpl });
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws naming the action still in progress at the deadline', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply([inProgress]));
    const p = waitForDropletIdle({
      token: 't',
      dropletId: '615816242',
      timeoutMs: 5000,
      intervalMs: 1000,
      fetchImpl,
    });
    const assertion = expect(p).rejects.toThrow(/615816242.*create.*in progress/);
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
  });

  it('throws at once on a 401 without polling again or leaking the token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply([], 401));
    const err = await waitForDropletIdle({
      token: 'secret-token',
      dropletId: '1',
      fetchImpl,
    }).catch((e) => e);
    expect(err.message).toMatch(/HTTP 401/);
    expect(err.message).not.toContain('secret-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
