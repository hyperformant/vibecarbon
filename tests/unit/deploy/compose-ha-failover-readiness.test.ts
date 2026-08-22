/**
 * Regression guard for the compose-ha failover-readiness race — TWO RCAs deep.
 *
 * RCA 2026-05-30: Failover Step 1b runs `docker restart … rest app …` to force
 * a clean reconnect against the freshly-promoted read-write DB, but restart
 * returns when containers START, not when they're READY. PostgREST then spends
 * ~10-30s rebuilding its schema cache; until it does, /api/v1/notifications
 * 500s. failover returned straight into that window and verify-failover caught
 * it. Fix: waitForNewPrimaryApi polls the endpoint locally on the new primary
 * (curl --resolve, DNS-independent) until it serves 200.
 *
 * RCA 2026-08-19 (DO compose-ha, run 32309395314): the gate proved ONE of the
 * six restarted services and declared the whole app tier serving. storage-api
 * (which replays DB migrations on boot — the slowest riser) was still down
 * when verify-failover single-shot its upload: Kong answered 502 through the
 * open storage-v1-object-public route. Fix: the probe covers every Kong-routed
 * restarted service — rest/app (DB-backed 200), auth (open health route 200),
 * storage (open public-object route: any storage-api-originated status proves
 * the upstream answers; a gateway 502/503/504 or no answer does not).
 *
 * Storage is probed KEYLESS through the open route on purpose: the key-auth'd
 * /storage/v1/status would 401 at Kong before ever reaching storage-api (the
 * exact k8s auth-probe trap of 2026-07-08), and the open route is the one the
 * verify upload actually failed through.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  APP_TIER_RESTART_SERVICES,
  NEW_PRIMARY_PROBE_EXEMPT,
  newPrimaryApiProbeCmd,
  waitForNewPrimaryApi,
} from '../../../src/lib/deploy/compose/ha.js';

const noSleep = () => Promise.resolve();

const allUp = 'rest=200 auth=200 storage=400';

describe('newPrimaryApiProbeCmd', () => {
  it('probes rest/app, auth, and storage, pinned to loopback, ignoring the staging cert', () => {
    const cmd = newPrimaryApiProbeCmd('e2.appcarbon.dev');
    expect(cmd).toContain('https://e2.appcarbon.dev/api/v1/notifications');
    expect(cmd).toContain('https://e2.appcarbon.dev/auth/v1/health');
    expect(cmd).toContain('https://e2.appcarbon.dev/storage/v1/object/public/');
    // Every curl is pinned to loopback and skips cert verification.
    const curls = cmd.split('curl ').slice(1);
    expect(curls.length).toBe(3);
    for (const c of curls) {
      expect(c).toContain('--resolve e2.appcarbon.dev:443:127.0.0.1');
      expect(c).toContain("-w '%{http_code}'");
      expect(c).toContain('-sk');
    }
    // Output is labeled so the poller can name the lagging service.
    expect(cmd).toMatch(/rest=.*auth=.*storage=/s);
  });

  it("probes storage through an OPEN (keyless) route — key-auth'd paths 401 at Kong and prove nothing", () => {
    const cmd = newPrimaryApiProbeCmd('e2.appcarbon.dev');
    // /storage/v1/object/public/ is the keyless route (and the one the
    // verify upload 502'd through). /status sits behind key-auth.
    expect(cmd).not.toContain('/storage/v1/status');
  });
});

describe('waitForNewPrimaryApi', () => {
  it('resolves true as soon as every service answers (storage 400 = upstream spoke)', async () => {
    const runner = vi.fn().mockReturnValue(allUp);
    const ok = await waitForNewPrimaryApi('1.2.3.4', '/key', 'e2.appcarbon.dev', {
      runner,
      sleep: noSleep,
    });
    expect(ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('keeps polling while ONLY storage lags behind a gateway 502 (run 32309395314)', async () => {
    const runner = vi
      .fn()
      .mockReturnValueOnce('rest=200 auth=200 storage=502')
      .mockReturnValueOnce('rest=200 auth=200 storage=502')
      .mockReturnValue('rest=200 auth=200 storage=200');
    const ok = await waitForNewPrimaryApi('1.2.3.4', '/key', 'e2.appcarbon.dev', {
      runner,
      sleep: noSleep,
    });
    expect(ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('keeps polling through the PostgREST cold-cache 500 window, then passes on recovery', async () => {
    const runner = vi
      .fn()
      .mockReturnValueOnce('rest=500 auth=200 storage=200')
      .mockReturnValueOnce('rest=500 auth=200 storage=200')
      .mockReturnValue(allUp);
    const ok = await waitForNewPrimaryApi('1.2.3.4', '/key', 'e2.appcarbon.dev', {
      runner,
      sleep: noSleep,
    });
    expect(ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('does not pass while auth is still coming up', async () => {
    const runner = vi
      .fn()
      .mockReturnValueOnce('rest=200 auth=502 storage=200')
      .mockReturnValue(allUp);
    const ok = await waitForNewPrimaryApi('1.2.3.4', '/key', 'e2.appcarbon.dev', {
      runner,
      sleep: noSleep,
    });
    expect(ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('treats a storage gateway timeout (504) and silence (000) as not-ready', async () => {
    const runner = vi
      .fn()
      .mockReturnValueOnce('rest=200 auth=200 storage=000')
      .mockReturnValueOnce('rest=200 auth=200 storage=504')
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
    const runner = vi.fn().mockReturnValue('rest=200 auth=200 storage=502');
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
  // — that is how the 2026-08-19 storage gap becomes unrepresentable.
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
      } else {
        // An exemption must say WHY, not just exist.
        expect(exempt.length).toBeGreaterThan(20);
      }
    }
  });
});

// Declared at the bottom so the census reads top-down: the path each probed
// service is proven through. Kept in the TEST deliberately — an independent
// opinion of what the cmd must contain, not an echo of how it builds it.
const NEW_PRIMARY_PROBE_URLS_BY_SERVICE: Record<string, string> = {
  rest: '/api/v1/notifications',
  app: '/api/v1/notifications',
  auth: '/auth/v1/health',
  storage: '/storage/v1/object/public/',
};
