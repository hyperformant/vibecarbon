/**
 * Census: every db-StatefulSet rollout wait rides one shared budget that
 * covers real CSI attach latency.
 *
 * Class (named per the family-sweep discipline): "db StatefulSet
 * boot/rollout budget too tight for CSI volume settle". Instance that
 * bought this: run 33252884427's k8s-ha reconverge — the reseed's
 * standbyBoot `kubectl rollout status statefulset/supabase-supabase-db
 * --timeout=300s` timed out on DigitalOcean while the standby was still
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
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DB_STS_BOOT_TIMEOUT_S } from '../../../src/lib/deploy/replication.js';

const FILES = ['src/lib/deploy/k8s/ha/index.js', 'src/lib/deploy/replication.js'];

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

  it('both db-sts boot sites in the ha module use the shared constant, not a re-derived number', () => {
    const source = readFileSync('src/lib/deploy/k8s/ha/index.js', 'utf8');
    const uses = source.match(/\$\{DB_STS_BOOT_TIMEOUT_S\}s/g) ?? [];
    expect(uses.length, 'expected the standbyBoot AND dbHostPort waits to interpolate it').toBe(2);
  });
});
