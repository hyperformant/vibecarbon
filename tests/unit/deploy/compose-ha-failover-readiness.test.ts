/**
 * Regression guard for the compose-ha failover-readiness race — TWO RCAs deep.
 *
 * RCA 2026-05-30: Failover Step 1b runs `docker restart <project>-app` to force
 * a clean reconnect against the freshly-promoted read-write DB, but restart
 * returns when the container STARTS, not when it is READY; until it is,
 * /api/v1/notifications 500s. failover returned straight into that window and
 * verify-failover caught it. Fix: waitForNewPrimaryApi polls the endpoint
 * locally on the new primary (curl --resolve, DNS-independent) until it
 * serves 200.
 *
 * RCA 2026-08-19 (DO compose-ha, run 32309395314): the gate proved ONE of the
 * restarted services and declared the whole app tier serving while a slower
 * one was still down. Fix: the probe covers every restarted service it can
 * prove, and the census below holds every restarted service to "probed or
 * exempted". (Every service but the app has since left the restart list: auth
 * runs inside the app, so the app's DB-backed 200 covers sign-in too, and the
 * app is the only app-tier service holding database connections.)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  APP_TIER_RESTART_SERVICES,
  NEW_PRIMARY_PROBE_EXEMPT,
  newPrimaryApiProbeCmd,
  waitForNewPrimaryApi,
} from '../../../src/lib/deploy/compose/ha.js';

const noSleep = () => Promise.resolve();

const allUp = 'app=200';

describe('newPrimaryApiProbeCmd', () => {
  it('probes the app, pinned to loopback, ignoring the staging cert', () => {
    const cmd = newPrimaryApiProbeCmd('e2.appcarbon.dev');
    expect(cmd).toContain('https://e2.appcarbon.dev/api/v1/notifications');
    expect(cmd).not.toContain('/auth/v1/');
    expect(cmd).not.toContain('/storage/v1/');
    // Every curl is pinned to loopback and skips cert verification.
    const curls = cmd.split('curl ').slice(1);
    expect(curls.length).toBe(1);
    for (const c of curls) {
      expect(c).toContain('--resolve e2.appcarbon.dev:443:127.0.0.1');
      expect(c).toContain("-w '%{http_code}'");
      expect(c).toContain('-sk');
    }
    // Output is labeled so the poller can name the lagging service.
    expect(cmd).toMatch(/app=/);
  });
});

describe('waitForNewPrimaryApi', () => {
  it('resolves true as soon as every service answers', async () => {
    const runner = vi.fn().mockReturnValue(allUp);
    const ok = await waitForNewPrimaryApi('1.2.3.4', '/key', 'e2.appcarbon.dev', {
      runner,
      sleep: noSleep,
    });
    expect(ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('keeps polling through the post-restart 500 window, then passes on recovery', async () => {
    const runner = vi
      .fn()
      .mockReturnValueOnce('app=500')
      .mockReturnValueOnce('app=500')
      .mockReturnValue(allUp);
    const ok = await waitForNewPrimaryApi('1.2.3.4', '/key', 'e2.appcarbon.dev', {
      runner,
      sleep: noSleep,
    });
    expect(ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('treats a gateway timeout (504) and silence (000) as not-ready', async () => {
    const runner = vi
      .fn()
      .mockReturnValueOnce('app=000')
      .mockReturnValueOnce('app=504')
      .mockReturnValue(allUp);
    const ok = await waitForNewPrimaryApi('1.2.3.4', '/key', 'e2.appcarbon.dev', {
      runner,
      sleep: noSleep,
    });
    expect(ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('rejects the pre-sweep single-code output shape — no silent fallback to the one-service premise', async () => {
    const runner = vi.fn().mockReturnValue('200');
    const ok = await waitForNewPrimaryApi('1.2.3.4', '/key', 'e2.appcarbon.dev', {
      runner,
      sleep: noSleep,
      attempts: 3,
    });
    expect(ok).toBe(false);
  });

  it('treats a thrown probe (ssh/curl failure) as a retry, not a hard failure', async () => {
    const runner = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('ssh: connect timeout');
      })
      .mockReturnValue(allUp);
    const ok = await waitForNewPrimaryApi('1.2.3.4', '/key', 'e2.appcarbon.dev', {
      runner,
      sleep: noSleep,
    });
    expect(ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('returns false (best-effort, never throws) after exhausting attempts', async () => {
    const runner = vi.fn().mockReturnValue('app=502');
    const ok = await waitForNewPrimaryApi('1.2.3.4', '/key', 'e2.appcarbon.dev', {
      runner,
      sleep: noSleep,
      attempts: 5,
    });
    expect(ok).toBe(false);
    expect(runner).toHaveBeenCalledTimes(5);
  });
});

describe('serve-gate coverage census', () => {
  // THE INVARIANT: every service the failover restarts is either proven by the
  // serve gate or carries an explicit, reasoned exemption. Adding a service to
  // the restart list without extending the probe (or exempting it) fails here
  // — that is how the 2026-08-19 lagging-service gap becomes unrepresentable.
  it('every restarted app-tier service is probed or explicitly exempted', () => {
    const cmd = newPrimaryApiProbeCmd('e2.appcarbon.dev');
    for (const svc of APP_TIER_RESTART_SERVICES) {
      const exempt = NEW_PRIMARY_PROBE_EXEMPT[svc];
      const probed = Object.keys(NEW_PRIMARY_PROBE_URLS_BY_SERVICE).includes(svc);
      expect(
        Boolean(exempt) || probed,
        `service "${svc}" is restarted by failover but neither probed nor exempted`,
      ).toBe(true);
      if (probed) {
        expect(cmd).toContain(NEW_PRIMARY_PROBE_URLS_BY_SERVICE[svc]);
      }
    }
  });

  // Checked over the exemption map itself, not only through the restart
  // loop above (which never reaches an exemption while every restarted
  // service is probed): an entry is a restarted, unprobed service with a
  // reason, or it is stale.
  it('every exemption names a restarted, unprobed service and says why', () => {
    for (const [svc, reason] of Object.entries(NEW_PRIMARY_PROBE_EXEMPT)) {
      expect(APP_TIER_RESTART_SERVICES, `exempt "${svc}" is not restarted`).toContain(svc);
      expect(
        Object.keys(NEW_PRIMARY_PROBE_URLS_BY_SERVICE),
        `"${svc}" is both probed and exempted`,
      ).not.toContain(svc);
      expect(reason.length, `exemption for "${svc}" must say why`).toBeGreaterThan(20);
    }
  });
});

// Declared at the bottom so the census reads top-down: the path each probed
// service is proven through. Kept in the TEST deliberately — an independent
// opinion of what the cmd must contain, not an echo of how it builds it.
const NEW_PRIMARY_PROBE_URLS_BY_SERVICE: Record<string, string> = {
  app: '/api/v1/notifications',
};

describe('the restart list names only containers the stack runs', () => {
  // `docker restart` of a container that does not exist fails the whole
  // command, so a removed service left in the list breaks every failover.
  it('restarts and stops exactly the app (the only app-tier service on a database connection)', () => {
    expect(APP_TIER_RESTART_SERVICES).toEqual(['app']);
  });
});
