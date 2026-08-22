import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Vultr instance readiness — `waitForServer` must gate on the field that
 * describes the OPERATING SYSTEM, not the one that describes the subscription.
 *
 * Vultr's instance object carries three status-ish fields, and only one of
 * them answers "can I SSH to this box yet?":
 *
 *   status        pending | active | suspended | resizing   <- SUBSCRIPTION state
 *   power_status  running | stopped                         <- 'running' AT CREATE TIME
 *   server_status none | locked | installingbooting | ok     <- OS state (the real signal)
 *
 * The POST /v2/instances 202 response in Vultr's own API reference is the
 * proof: it returns `status: "pending"`, `power_status: "running"` and
 * `server_status: "none"` for a machine that does not exist yet. `status`
 * flips to `active` as soon as the subscription is provisioned and an IP is
 * assigned — minutes before the OS finishes installing and booting.
 *
 * This mattered: gating on `status === 'active'` returned after ~22s in CI run
 * 31663154544 while the instance was still `installingbooting`, handing a
 * not-yet-routable IP to `waitForSSH`, which then burned 273s — 4m33s of
 * "Connection timed out" then "Connection refused" — against a box that was
 * still building. That consumed nearly the whole 40-attempt SSH budget, so a
 * marginally slower boot would have failed the scale outright rather than
 * merely running slowly.
 *
 * The bug entered by ANALOGY: the line is character-for-character DigitalOcean's
 * (`status === 'active' && getPublicIP(...)`), and on DigitalOcean `active` is
 * genuinely the droplet's running state. Same spelling, different meaning —
 * which is why reading the Vultr provider next to its siblings does not reveal
 * it. Sibling gates for the record: Hetzner `status === 'running'`, Linode
 * `status === 'running'`, Scaleway `state === 'running'` — all OS-level.
 *
 * TEST SHAPE, deliberately: every not-ready case feeds the not-ready shape
 * FIRST and a ready shape SECOND, then asserts the poll advanced (two calls)
 * and resolved with the ready one. A `timeout: 0` case would be vacuous — the
 * while-loop never runs, so it throws "Server creation timed out" no matter
 * what the gate says, and the test would pass against the bug it is meant to
 * catch. These assert readiness SEMANTICS and can disagree with the code.
 */

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
}));

import { VultrProvider } from '../../../src/lib/providers/vultr.js';

const TOKEN = 'tok-vultr-wait';

function resp(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A wire-shaped ready instance object; overrides win. */
function instance(overrides: Record<string, unknown> = {}) {
  return {
    instance: {
      id: 'cb676a46-66fd-4dfb-b839-443f2e6c0b60',
      region: 'ewr',
      plan: 'vc2-4c-8gb',
      main_ip: '192.0.2.123',
      status: 'active',
      power_status: 'running',
      server_status: 'ok',
      ...overrides,
    },
  };
}

describe('VultrProvider.waitForServer readiness gate', () => {
  let provider: VultrProvider;

  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    provider = new VultrProvider(TOKEN);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Feed `notReady` then a ready instance. A correct gate polls twice and
   * resolves with the ready one; the old `status === 'active'` gate returns
   * the not-ready shape on the first poll.
   */
  async function expectKeepsPolling(notReady: Record<string, unknown>) {
    fetchWithRetryMock
      .mockResolvedValueOnce(resp(instance(notReady)))
      .mockResolvedValueOnce(resp(instance()));

    const pending = provider.waitForServer('cb676a46', 600_000);
    await vi.advanceTimersByTimeAsync(6_000);
    const out = await pending;

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(out.server_status).toBe('ok');
    expect(out.main_ip).toBe('192.0.2.123');
  }

  it('resolves on the first poll once server_status is ok', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(resp(instance()));
    const out = await provider.waitForServer('cb676a46', 600_000);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect(out.server_status).toBe('ok');
  });

  it('keeps polling while the OS is still installing and booting', async () => {
    // The exact shape that fooled the old gate: subscription active, IP
    // assigned, power_status running — but the OS is still coming up.
    await expectKeepsPolling({ server_status: 'installingbooting' });
  });

  it('keeps polling on the POST /v2/instances 202 shape', async () => {
    // Vultr's documented create response — a machine that does not exist yet.
    // power_status is ALREADY 'running' here, which is why it can never be the
    // gate.
    await expectKeepsPolling({
      status: 'pending',
      server_status: 'none',
      main_ip: '0.0.0.0',
      power_status: 'running',
    });
  });

  it('keeps polling while the instance is locked (mid-provision)', async () => {
    await expectKeepsPolling({ server_status: 'locked' });
  });

  it('keeps polling when server_status is ok but no real public IPv4 yet', async () => {
    // getPublicIP treats Vultr's '0.0.0.0' placeholder as absent.
    await expectKeepsPolling({ main_ip: '0.0.0.0' });
  });

  it('does not treat subscription-level `status: active` as OS readiness', async () => {
    // The regression guard proper. If this starts passing on the first poll,
    // the gate has reverted to the DigitalOcean-shaped copy.
    await expectKeepsPolling({ status: 'active', server_status: 'installingbooting' });
  });

  it('times out rather than hanging when the OS never comes up', async () => {
    fetchWithRetryMock.mockResolvedValue(resp(instance({ server_status: 'installingbooting' })));
    const pending = provider.waitForServer('cb676a46', 20_000);
    const assertion = expect(pending).rejects.toThrow('Server creation timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});

describe('VultrProvider server-ready budget', () => {
  it('allows a longer server-ready wait than the 300s cross-provider default', () => {
    // Moving the wait into waitForServer means waitForServer must be able to
    // absorb a genuinely slow Vultr boot. The observed CI boot was ~295s from
    // create to sshd — inside a 300s budget only by seconds. Vultr already
    // declares a 600s cloud-init budget for the same reason; the server-ready
    // budget has to be at least as generous, or the fix converts a slow scale
    // into a hard failure.
    expect(VultrProvider.WAIT_FOR_SERVER_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000);
  });

  it('applies that budget by default (scale calls waitForServer with no timeout)', async () => {
    // src/scale.js calls `provider.waitForServer(newServerId)` with no second
    // argument, so the default in the signature IS the production budget.
    const provider = new VultrProvider(TOKEN);
    const source = VultrProvider.prototype.waitForServer.toString();
    expect(source).toMatch(/timeout\s*=\s*VultrProvider\.WAIT_FOR_SERVER_TIMEOUT_MS/);
    expect(provider).toBeInstanceOf(VultrProvider);
  });
});
