/**
 * Census: every db-StatefulSet rollout wait rides one shared budget that
 * covers real CSI attach latency.
 *
 * Class (named per the family-sweep discipline): "db StatefulSet
 * boot/rollout budget too tight for CSI volume settle". Instance that
 * bought this: run 33252884427's k8s-ha reconverge — the reseed's
 * standbyBoot `kubectl rollout status statefulset/<db> --timeout=300s` (the
 * database then ran from a Helm chart; it is now statefulset/db) timed out on DigitalOcean while the standby was still
 * settling CSI detach/attach; the failure diagnostics captured ~1 minute
 * later showed the pod 1/1 Running and every pod Ready. A healthy boot,
 * failed by its own budget. Hetzner CSI was already documented as
 * "minutes" in the same code's comments.
 *
 * Family (enumerated 2026-08-29, both modules that boot the db sts):
 *   - deploy-side reseed standbyBoot   (src/lib/deploy/k8s/ha/index.js)
 *   - deploy-side dbHostPort recreate  (src/lib/deploy/k8s/ha/index.js)
 *   - failover/restore-side reseed boot (src/lib/deploy/replication.js,
 *     whose SSH client timeout must stay ABOVE the kubectl budget —
 *     reseed-standby.test.ts pins that invariant with the numbers)
 * Deliberately NOT members: the postgres-dependent Deployment rollout
 * waits (no PVCs — nothing attaches; best-effort ignoreError) and the
 * k3s.js cluster rollout machinery (its own retry wrapper and budgets).
 *
 * The census walks both files: any `--timeout=<n>s` literal on a line
 * whose 4-line neighborhood mentions the db statefulset must either BE
 * the shared constant interpolation or carry a value >= the constant.
 * New waits added to these files are drafted automatically.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_ROLLOUT_TIMEOUT_S } from '../../../src/lib/deploy/k8s/k3s.js';
import { DB_STS_BOOT_TIMEOUT_S } from '../../../src/lib/deploy/replication.js';

const FILES = ['src/lib/deploy/k8s/ha/index.js', 'src/lib/deploy/replication.js'];

function walkJs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkJs(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [],
  );
}

// Every src file that touches the db StatefulSet: by its constant, its literal
// name, or the shared rollout-status argv builder (failover.js reaches the sts
// only through that builder, which is how it escaped the hand-kept list above).
const TOUCHES_DB_STS = /DB_STATEFULSET|statefulset\/db|k8sDbRolloutStatusArgv/;
const DB_STS_FILES = walkJs('src').filter((f) => TOUCHES_DB_STS.test(readFileSync(f, 'utf8')));

// A numeric-literal default on an argv builder's timeout parameter, e.g.
// `function k8sDbRolloutStatusArgv(timeoutSeconds = 300)`.
function numericDefaultTimeouts(source: string): Array<{ line: number; seconds: number }> {
  const hits: Array<{ line: number; seconds: number }> = [];
  source.split('\n').forEach((text, i) => {
    for (const m of text.matchAll(/\b\w*[Tt]imeout\w*\s*=\s*(\d+)\b(?=\s*[,)])/g)) {
      hits.push({ line: i + 1, seconds: Number(m[1]) });
    }
  });
  return hits;
}

// Call sites of the shared builder that hand it a bare number.
function builderCallLiterals(source: string): Array<{ line: number; seconds: number }> {
  const hits: Array<{ line: number; seconds: number }> = [];
  source.split('\n').forEach((text, i) => {
    const m = text.match(/k8sDbRolloutStatusArgv\(\s*(\d+)\s*\)/);
    if (m) hits.push({ line: i + 1, seconds: Number(m[1]) });
  });
  return hits;
}

function dbStsTimeoutLiterals(source: string): Array<{ line: number; seconds: number }> {
  const lines = source.split('\n');
  const hits: Array<{ line: number; seconds: number }> = [];
  lines.forEach((text, i) => {
    const m = text.match(/--timeout=(\d+)s/);
    if (!m) return;
    const neighborhood = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
    if (!/statefulset/i.test(neighborhood)) return;
    hits.push({ line: i + 1, seconds: Number(m[1]) });
  });
  return hits;
}

describe('db StatefulSet boot/rollout budgets (the CSI-settle class)', () => {
  it('pins the shared budget to 600s — DO CSI settle exceeded 300s on a healthy boot', () => {
    expect(DB_STS_BOOT_TIMEOUT_S).toBe(600);
  });

  it('the deploy-time db rollout wait (k3s.js awaitDbRollout) never drops below the shared floor', () => {
    // A first boot pays everything a re-boot does (CSI attach) plus the first
    // provision, the image pull and initdb, so it gets its own larger budget.
    expect(DB_ROLLOUT_TIMEOUT_S).toBeGreaterThanOrEqual(DB_STS_BOOT_TIMEOUT_S);
  });

  for (const file of FILES) {
    it(`${file}: no db-sts rollout wait carries a literal budget below the shared constant`, () => {
      const source = readFileSync(file, 'utf8');
      // The db-sts waits should interpolate DB_STS_BOOT_TIMEOUT_S; a literal
      // is tolerated only at or above it (so a deliberate longer wait can
      // exist without weakening the floor).
      for (const hit of dbStsTimeoutLiterals(source)) {
        expect(
          hit.seconds,
          `${file}:${hit.line} — db StatefulSet rollout wait budget below DB_STS_BOOT_TIMEOUT_S`,
        ).toBeGreaterThanOrEqual(DB_STS_BOOT_TIMEOUT_S);
      }
    });
  }

  it('finds the walk target set (guards the census against walking nothing)', () => {
    expect(DB_STS_FILES).toEqual(
      expect.arrayContaining([
        'src/failover.js',
        'src/restore.js',
        'src/lib/deploy/walg-role.js',
        'src/lib/deploy/replication.js',
        'src/lib/deploy/k8s/ha/index.js',
      ]),
    );
  });

  for (const file of DB_STS_FILES) {
    it(`${file}: no db-sts wait literal, builder default or builder call argument below the shared budget`, () => {
      const source = readFileSync(file, 'utf8');
      const all = [
        ...dbStsTimeoutLiterals(source),
        ...builderCallLiterals(source),
        // Only builder-shaped defaults in files that define the db argv builder.
        ...(/function k8sDbRolloutStatusArgv/.test(source) ? numericDefaultTimeouts(source) : []),
      ];
      for (const hit of all) {
        expect(
          hit.seconds,
          `${file}:${hit.line} — db StatefulSet boot wait below DB_STS_BOOT_TIMEOUT_S`,
        ).toBeGreaterThanOrEqual(DB_STS_BOOT_TIMEOUT_S);
      }
    });
  }

  it('both db-sts boot sites in the ha module use the shared constant, not a re-derived number', () => {
    const source = readFileSync('src/lib/deploy/k8s/ha/index.js', 'utf8');
    const uses = source.match(/\$\{DB_STS_BOOT_TIMEOUT_S\}s/g) ?? [];
    expect(uses.length, 'expected the standbyBoot AND dbHostPort waits to interpolate it').toBe(2);
  });
});
