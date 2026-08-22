/**
 * haWriteReplicationOverlay's `up -d db` must render db with RECONCILE'S OWN
 * flag set (+ the replication overlay), never a subset.
 *
 * THE INCIDENT (e2 warm-deploy, 3× on 2026-08-06/07): the overlay-write step
 * recreated db with REPL_COMPOSE_FLAGS (base + prod + replication) — a
 * rendering no full-set reconcile ever computes — so every warm deploy saw a
 * config-hash mismatch and recreated db again, and GoTrue 502'd through
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
import { renderReconcileScript } from '../../../src/lib/deploy/bundle.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const EFFECTS_SRC = readFileSync(
  join(REPO_ROOT, 'src', 'lib', 'deploy', 'effects', 'compose-ha.js'),
  'utf-8',
);

/** The literal sed program as it appears in the effect (unescape JS \\ → \). */
function sedProgramFromSource(): string {
  const m = EFFECTS_SRC.match(/FLAGS=\$\(sed -n '([^']+)' reconcile\.sh \| tail -1\)/);
  expect(m, 'the FLAGS extraction must exist in haWriteReplicationOverlay').not.toBeNull();
  return (m as RegExpMatchArray)[1].replace(/\\\\/g, '\\');
}

describe('haWriteReplicationOverlay flag extraction', () => {
  const FULL_FLAGS =
    '-f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.dns01.prod.yml ' +
    '-f docker-compose.observability.yml -f docker-compose.observability.prod.yml';

  it('the sed in the source extracts the exact flag string from a real reconcile.sh rendering', () => {
    const script = renderReconcileScript('myproj', FULL_FLAGS, false);
    const res = spawnSync('bash', ['-c', `sed -n '${sedProgramFromSource()}' | tail -1`], {
      input: script,
      encoding: 'utf-8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(FULL_FLAGS);
  });

  it('extraction also works for the minimal (no-addon) flag set', () => {
    const minimal = '-f docker-compose.yml -f docker-compose.prod.yml';
    const script = renderReconcileScript('myproj', minimal, true);
    const res = spawnSync('bash', ['-c', `sed -n '${sedProgramFromSource()}' | tail -1`], {
      input: script,
      encoding: 'utf-8',
    });
    expect(res.stdout.trim()).toBe(minimal);
  });

  it('the db up appends the replication overlay to the extracted flags and keeps the bounded fallback', () => {
    expect(EFFECTS_SRC).toMatch(
      /docker compose \$FLAGS -f docker-compose\.replication\.yml up -d db/,
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
    const scaleSrc = readFileSync(join(REPO_ROOT, 'src', 'scale.js'), 'utf-8');
    const sed = scaleSrc.match(/FLAGS=\$\(sed -n '([^']+)' reconcile\.sh \| tail -1\)/);
    expect(sed, 'scale.js must extract flags from reconcile.sh').not.toBeNull();
    // The extraction program must be IDENTICAL to the effects file's (one
    // program, two call sites — drift here means one site silently stops
    // matching renderReconcileScript's shape).
    expect((sed as RegExpMatchArray)[1]).toBe(
      (
        EFFECTS_SRC.match(
          /FLAGS=\$\(sed -n '([^']+)' reconcile\.sh \| tail -1\)/,
        ) as RegExpMatchArray
      )[1],
    );
    // No hand-rolled overlay lists anywhere in scale.js: an addon overlay
    // referenced as a -f literal outside bundle.js is the drift vector.
    expect(scaleSrc).not.toMatch(/-f docker-compose\.(observability|n8n|metabase|redis|dns01)/);
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
