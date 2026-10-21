/**
 * haWriteReplicationOverlay's `up -d db` must render db with RECONCILE'S OWN
 * flag set (+ the replication overlay), never a subset.
 *
 * THE INCIDENT (e2 warm-deploy, 3× on 2026-08-06/07): the overlay-write step
 * recreated db with REPL_COMPOSE_FLAGS (base + prod + replication) — a
 * rendering no full-set reconcile ever computes — so every warm deploy saw a
 * config-hash mismatch and recreated db again, and the auth service 502'd through
 * createAdminUser's whole retry budget while db cycled. The kept rig's
 * .vc-render-first/last diff named the replication overlay as the drifting
 * content.
 *
 * The fix extracts the baked ${composeFlags} from reconcile.sh ON THE NODE
 * (byte-identical to future reconciles by construction) and appends the
 * overlay explicitly. This suite pins BOTH sides of that contract:
 *  - the sed in compose-ha.js extracts the exact flag string from a real
 *    renderReconcileScript() rendering (drift in either breaks it here);
 *  - the effect's source uses the extraction + explicit overlay for the db
 *    up, with the bounded base fallback — and not bare REPL_COMPOSE_FLAGS.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  composeFileFlags,
  RECONCILE_FLAGS_SED,
  renderReconcileScript,
  STANDBY_SCALE_FLAG,
} from '../../../src/lib/deploy/bundle.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const EFFECTS_SRC = readFileSync(
  join(REPO_ROOT, 'src', 'lib', 'deploy', 'effects', 'compose-ha.js'),
  'utf-8',
);
const SCALE_SRC = readFileSync(join(REPO_ROOT, 'src', 'scale.js'), 'utf-8');

/** The one extraction call shape both recreators use (the program lives in bundle.js). */
// biome-ignore lint/suspicious/noTemplateCurlyInString: the JS source text being matched, not a placeholder
const EXTRACTION_CALL = "FLAGS=$(sed -n '${RECONCILE_FLAGS_SED}' reconcile.sh | tail -1)";

/** Run the extraction program over a rendered reconcile.sh, as the node does. */
function extract(script: string): string {
  const res = spawnSync('bash', ['-c', `sed -n '${RECONCILE_FLAGS_SED}' | tail -1`], {
    input: script,
    encoding: 'utf-8',
  });
  expect(res.status).toBe(0);
  return res.stdout.trim();
}

describe('haWriteReplicationOverlay flag extraction', () => {
  const FULL_FLAGS =
    '-f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.dns01.prod.yml ' +
    '-f docker-compose.observability.yml -f docker-compose.observability.prod.yml';

  it('RECONCILE_FLAGS_SED extracts the exact flag string from a real reconcile.sh rendering', () => {
    expect(extract(renderReconcileScript('myproj', FULL_FLAGS, false))).toBe(FULL_FLAGS);
  });

  it('extraction also works for the minimal (no-addon) flag set', () => {
    const minimal = '-f docker-compose.yml -f docker-compose.prod.yml';
    expect(extract(renderReconcileScript('myproj', minimal, true))).toBe(minimal);
  });

  it('lockstep: with n8n, metabase and redis on, it extracts exactly composeFileFlags(options) past the standby-scale fragment', () => {
    const options = { n8n: true, metabase: true, redis: true };
    const script = renderReconcileScript('myproj', composeFileFlags(options), false);
    // The up line now carries trailing arguments (the standby --scale fragment).
    expect(script).toContain(`up -d --remove-orphans ${STANDBY_SCALE_FLAG}`);
    expect(extract(script)).toBe(composeFileFlags(options));
    expect(composeFileFlags(options)).toContain('-f docker-compose.n8n.prod.yml');
  });

  it('compose-ha.js extracts through RECONCILE_FLAGS_SED and carries no inline sed program', () => {
    expect(EFFECTS_SRC).toContain(EXTRACTION_CALL);
    expect(EFFECTS_SRC).not.toMatch(/sed -n 's\/\^docker compose/);
  });

  it('the db up appends the replication overlay to the extracted flags and keeps the bounded fallback', () => {
    expect(EFFECTS_SRC).toMatch(
      /docker compose \$FLAGS -f docker-compose\.replication\.yml up -d --no-build db/,
    );
    expect(EFFECTS_SRC).toMatch(/\[ -n "\$FLAGS" \] \|\| FLAGS='\$\{REPL_COMPOSE_FLAGS_BASE\}'/);
  });

  it('the overlay-write db up no longer uses bare REPL_COMPOSE_FLAGS', () => {
    // REPL_COMPOSE_FLAGS (the 3-file subset) must not appear as the flag
    // source for any `up -d db` in the effects file.
    const upDbCalls = EFFECTS_SRC.match(/docker compose \$\{REPL_COMPOSE_FLAGS\}[^\n]*up -d db/g);
    expect(upDbCalls).toBeNull();
  });

  // FAMILY CENSUS (scale.js was the last surviving JS-side flag-set rebuild,
  // and it HAD drifted — redis.yml without its .prod.yml half, so a post-
  // restore force-recreate rendered every service against a set no reconcile
  // ever computes): any file that CREATES/RECREATES compose services must get
  // its overlay flags from the reconcile.sh extraction, never a hand-rolled
  // multi-overlay list.
  it('scale.js recreates via the reconcile.sh extraction and carries no hand-rolled overlay list', () => {
    // One program, two call sites: both recreators import it from bundle.js,
    // so neither can silently stop matching renderReconcileScript's shape.
    expect(SCALE_SRC, 'scale.js must extract flags from reconcile.sh').toContain(EXTRACTION_CALL);
    expect(SCALE_SRC).not.toMatch(/sed -n 's\/\^docker compose/);
    // No hand-rolled overlay lists anywhere in scale.js: an addon overlay
    // referenced as a -f literal outside bundle.js is the drift vector.
    expect(SCALE_SRC).not.toMatch(/-f docker-compose\.(observability|n8n|metabase|redis|dns01)/);
  });

  // Structural half of the census (2026-08-07 test-architecture audit): the
  // scale.js assertion above pins the one KNOWN recreator, but a NEW file
  // that hand-rolls a `-f docker-compose.<addon>` list would have escaped a
  // test that names its files. This walk bans the flag-form addon-overlay
  // literal across ALL of src/: only the base trio (yml / prod.yml /
  // replication.yml) may ever appear as a `-f` literal — the full overlay
  // set exists exactly once, in renderReconcileScript's rendering, and
  // everything that recreates services must extract it from reconcile.sh.
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
        'Extract FLAGS from reconcile.sh instead.',
    ).toEqual([]);
  });

  it('the addon-flag regex still catches the original drift shape (positive control)', () => {
    const RE = /-f docker-compose\.(?!yml\b|prod\.yml|replication\.yml)[\w.-]+/;
    expect(RE.test('-f docker-compose.redis.yml')).toBe(true);
    expect(RE.test('-f docker-compose.observability.yml')).toBe(true);
    // The sanctioned base trio must NOT be flagged.
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
  const fnStart = EFFECTS_SRC.indexOf('async function haWriteReplicationOverlay');
  const fnBody = EFFECTS_SRC.slice(
    fnStart,
    EFFECTS_SRC.indexOf('\nconst REPL_COMPOSE_FLAGS_BASE', fnStart),
  );

  it('pulls the db image explicitly before the up', () => {
    expect(fnStart).toBeGreaterThan(-1);
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

  it('the up keeps the extracted-flag invocation byte-compatible plus --no-build only', () => {
    // The 2026-08-06 config-hash lesson above still binds: same flag set,
    // same file order. --no-build changes create behaviour, not the rendered
    // config, so the hash contract survives.
    expect(fnBody).toMatch(
      /docker compose \$FLAGS -f docker-compose\.replication\.yml up -d --no-build db/,
    );
  });
});
