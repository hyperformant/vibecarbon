/**
 * frontend_render must survive a navigation landing mid-measurement.
 *
 * LIVE RCA (digitalocean/compose-ha verify-scale, run 32665738019):
 * `page.goto(networkidle)` and the render-condition wait both absorb their
 * own timeouts — deliberately, the render assertion is the real gate. But
 * an absorbed goto timeout leaves the navigation IN FLIGHT: on a slow
 * post-scale page it committed exactly as `page.evaluate` ran, Playwright
 * threw `Execution context was destroyed, most likely because of a
 * navigation`, and the check's outer catch turned a measurement-side race
 * into the leg's failure — with the app very possibly rendering fine one
 * instant later.
 *
 * A navigation destroying the context IS the awaited condition ("the page
 * just arrived") — so the measurement retries on the new document, bounded,
 * with the retry count surfaced in the check details. Everything else stays
 * fatal: a non-race error rethrows immediately, and a race persisting
 * through every attempt rethrows rather than being absorbed.
 */
import { describe, expect, it, vi } from 'vitest';
import { NAVIGATION_RACE_RE, withNavigationRetry } from '../../e2e/checks/frontend-smoke.js';

const raceError = () =>
  new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');

describe('NAVIGATION_RACE_RE', () => {
  it('matches the captured playwright wordings of a navigation race', () => {
    for (const msg of [
      'page.evaluate: Execution context was destroyed, most likely because of a navigation',
      'Cannot find context with specified id',
      'page.evaluate: Frame was detached',
    ]) {
      expect(NAVIGATION_RACE_RE.test(msg), msg).toBe(true);
    }
  });

  it('does not match real page failures', () => {
    for (const msg of [
      'net::ERR_CONNECTION_REFUSED at https://example.test/',
      'Minified React error #306',
      'browserContext.newPage: Target closed',
    ]) {
      expect(NAVIGATION_RACE_RE.test(msg), msg).toBe(false);
    }
  });
});

describe('withNavigationRetry', () => {
  it('re-measures after a race and reports how many races it survived', async () => {
    let calls = 0;
    const beforeRetry = vi.fn(async () => {});
    const out = await withNavigationRetry(
      async () => {
        calls++;
        if (calls <= 2) throw raceError();
        return { textLen: 420 };
      },
      { beforeRetry },
    );
    expect(out.value).toEqual({ textLen: 420 });
    expect(out.navigationRaces).toBe(2);
    expect(beforeRetry).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-race error immediately — no absorber creep', async () => {
    let calls = 0;
    await expect(
      withNavigationRetry(async () => {
        calls++;
        throw new Error('net::ERR_CONNECTION_REFUSED');
      }),
    ).rejects.toThrow('ERR_CONNECTION_REFUSED');
    expect(calls).toBe(1);
  });

  it('a race persisting through every attempt stays a failure', async () => {
    let calls = 0;
    await expect(
      withNavigationRetry(async () => {
        calls++;
        throw raceError();
      }),
    ).rejects.toThrow('Execution context was destroyed');
    expect(calls).toBe(3);
  });
});
