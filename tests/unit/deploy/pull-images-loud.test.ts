/**
 * Image pulls must fail LOUDLY with the pull's own stderr.
 *
 * 2026-08-23, matrix 32614839037 + rerun 32620565774 (linode compose-ha
 * scale): `pullComposeImages` ran with FOUR silencing layers — three `||`
 * fallbacks ending `|| true` inside the remote command, plus
 * `ignoreError: true` on the SSH wrapper. When the pull died on the new
 * node, nothing recorded why; the failure surfaced two steps later as a
 * wall of `Error response from daemon: No such image: grafana/loki:3.3.0`
 * from `docker compose up` — downstream noise with the true cause
 * (rate limit? DNS? timeout?) permanently lost.
 *
 * That is the exact stacked-mitigation pattern this repo's mitigation
 * policy bans: an absorber that fires silently hides the regression it
 * should be surfacing.
 *
 * Contract pinned here:
 *   - a failing pull REJECTS (no ignoreError), carrying the remote stderr
 *   - the remote command has NO `|| true` / fallback-chain silencers
 *   - `--ignore-buildable` stays (db/app are built, never pulled)
 */
import { describe, expect, it } from 'vitest';

describe('pullComposeImages failure contract', () => {
  it('source: the remote pull command carries no silencing layers', async () => {
    // Structural pin on the source, not the mock: `|| true` and chained
    // `|| docker compose` fallbacks are the four-deep silencer this test
    // exists to keep dead.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/lib/deploy/compose/index.js', 'utf-8');
    const fnStart = src.indexOf('export async function pullComposeImages');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart));
    expect(fnBody, 'pull must not end in || true').not.toMatch(/\|\|\s*true/);
    expect(fnBody, 'pull must not chain fallback pulls').not.toMatch(/pull[^\n]*\|\|[^\n]*pull/);
    expect(fnBody, 'pull must not use ignoreError').not.toMatch(/ignoreError:\s*true/);
    expect(fnBody, 'buildable images are built, never pulled').toMatch(/--ignore-buildable/);
    // prod.yml resets app's build:, so --ignore-buildable does NOT cover it;
    // its local-only tag aborts a plain `compose pull` and interrupts every
    // sibling image (linode 32640636398, fifteen `Interrupted` lines). The
    // pull must enumerate services minus app.
    expect(fnBody, 'app must be excluded from the pre-pull').toMatch(
      /config --services \| grep -vx app/,
    );
  });
});
