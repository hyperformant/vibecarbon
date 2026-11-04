/**
 * haWriteReplicationOverlay's `up -d db` must render db with RECONCILE'S OWN
 * flag set (+ the replication overlay), never a subset.
 *
 * THE INCIDENT (e2 warm-deploy, 3× on 2026-08-06/07): the overlay-write step
 * recreated db with a 3-file subset (base + prod + replication), a rendering
 * no full-set reconcile ever computes, so every warm deploy saw a config-hash
 * mismatch and recreated db again, and the auth service 502'd through
 * createAdminUser's whole retry budget while db cycled. The kept rig's
 * .vc-render-first/last diff named the replication overlay as the drifting
 * content.
 *
 * The first fix read reconcile.sh's baked flags back out of it with sed. Now
 * every server-side Compose call runs vc-compose (compose/command.js), the
 * script reconcile.sh itself runs, which adds the overlay when the node has
 * it, so the recreate renders what the next reconcile hashes by construction
 * (behavior: tests/unit/deploy/vc-compose.test.ts and
 * compose-ha-replication-overlay.test.ts; the ban on any other spelling:
 * server-compose-command-census.test.ts). This suite pins the two
 * recreators that motivated it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const EFFECTS_SRC = readFileSync(
  join(REPO_ROOT, 'src', 'lib', 'deploy', 'effects', 'compose-ha.js'),
  'utf-8',
);
const SCALE_SRC = readFileSync(join(REPO_ROOT, 'src', 'scale.js'), 'utf-8');

const fnStart = EFFECTS_SRC.indexOf('async function haWriteReplicationOverlay');
const fnBody = EFFECTS_SRC.slice(fnStart, EFFECTS_SRC.indexOf('\n}\n', fnStart));

describe('the overlay-write db recreate runs the node own -f set', () => {
  it('pulls and recreates db through vc-compose, with no -f list of its own', () => {
    expect(fnStart).toBeGreaterThan(-1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the JS source text being matched
    expect(fnBody).toContain('${VC_COMPOSE} pull db');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the JS source text being matched
    expect(fnBody).toContain('${VC_COMPOSE} up -d --no-build db');
    expect(fnBody).not.toMatch(/-f docker-compose|FLAGS|reconcile\.sh/);
  });

  it('scale.js recreates the restored stack through vc-compose too', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the JS source text being matched
    expect(SCALE_SRC).toContain('${VC_COMPOSE} up -d --force-recreate ${STANDBY_SCALE_FLAG}');
    expect(SCALE_SRC).not.toMatch(/sed -n [^\n]*reconcile\.sh/);
  });

  // Structural census (2026-08-07 test-architecture audit): a NEW file that
  // hand-rolls a `-f docker-compose.<addon>` list would escape a test that
  // names its files. Only composeFileFlags (bundle.js) builds the list, from
  // arrays, so no addon overlay ever appears as a `-f` literal in src/.
  it('no file in src/ hand-rolls a -f addon-overlay flag list', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name), out);
        else if (entry.name.endsWith('.js')) out.push(join(dir, entry.name));
      }
      return out;
    };
    const ADDON_FLAG_RE = /-f docker-compose\.(?!yml\b|prod\.yml|replication\.yml)[\w.-]+/g;
    const violations: string[] = [];
    for (const file of walk(join(REPO_ROOT, 'src'))) {
      const source = readFileSync(file, 'utf-8');
      for (const m of source.matchAll(ADDON_FLAG_RE)) {
        violations.push(`${file.slice(REPO_ROOT.length + 1)}: ${m[0]}`);
      }
    }
    expect(
      violations,
      'A hand-rolled addon-overlay -f list rebuilds a flag set no reconcile ever computes ' +
        '(the exact drift that shipped in scale.js: redis.yml without its .prod.yml half). ' +
        'Run vc-compose instead.',
    ).toEqual([]);
  });

  it('the addon-flag regex still catches the original drift shape (positive control)', () => {
    const RE = /-f docker-compose\.(?!yml\b|prod\.yml|replication\.yml)[\w.-]+/;
    expect(RE.test('-f docker-compose.redis.yml')).toBe(true);
    expect(RE.test('-f docker-compose.observability.yml')).toBe(true);
    expect(RE.test('-f docker-compose.yml -f docker-compose.prod.yml')).toBe(false);
    expect(RE.test('-f docker-compose.replication.yml')).toBe(false);
  });
});

describe('overlay db materialization is explicit, never implicit (2026-08-23)', () => {
  /**
   * Runs 32614839037/32620567017 (vultr compose-ha): the standby's FIRST db
   * image materialization happened inside this step's `up -d db` (then an
   * IMPLICIT on-server build), whose image pull alone can exceed the step's
   * 60s ssh timeout on a slow provider link. Hetzner won that race on
   * bandwidth; vultr could not, and the failure surfaced as an opaque timeout.
   * The db image is now pulled, never built, and the pull is just as large.
   *
   * Contract: pull db EXPLICITLY (its own command, pull-scale timeout, its
   * own stderr) BEFORE the recreate, and run the recreate with `--no-build`
   * so the recreate never materializes anything under the short timeout.
   */
  it('pulls the db image explicitly before the up', () => {
    const pullAt = fnBody.indexOf('pull db');
    const upAt = fnBody.indexOf('up -d --no-build db');
    expect(pullAt, 'explicit `compose pull db` missing').toBeGreaterThan(-1);
    expect(fnBody, 'the db image is pulled, never built on the server').not.toMatch(/ build db/);
    expect(upAt, '`up -d db` must carry --no-build').toBeGreaterThan(-1);
    expect(pullAt, 'pull must precede the up').toBeLessThan(upAt);
  });

  it('gives the explicit pull a pull-scale timeout, not the 60s step timeout', () => {
    // A cold db image pull is hundreds of MB; 60s is a bandwidth lottery.
    // Same 600s budget as pullComposeImages.
    const pullAt = fnBody.indexOf('pull db');
    const window = fnBody.slice(pullAt, pullAt + 400);
    expect(window).toMatch(/timeout:\s*600_000/);
  });
});
