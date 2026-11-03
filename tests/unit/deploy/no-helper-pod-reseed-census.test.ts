/**
 * Census: the helper-pod PGDATA swap is gone, and it stays gone (Task A5).
 *
 * The k8s standby reseed used to scale the db StatefulSet to zero, mount the
 * released PVC in a short-lived `vibecarbon-pgdata-swap` pod, swap PGDATA
 * there, delete the pod and scale back up: four attach transitions of the db
 * volume per reseed. That churn is what timed out a DO k8s-ha cold deploy
 * ("Timed out after 300000ms waiting for pgdata swap pod
 * vibecarbon-pgdata-swap") and what the do-csi-stale-volumeattachment class
 * records. Every k8s reseed (the cold deploy, failover, restore) now runs in
 * place through reseedStandbyInPlace: the volume never detaches.
 *
 * Pinned here, over the whole shipped tree (src/, carbon/):
 *   - none of the helper-pod path's names or its pod name come back;
 *   - no code in src/ builds a Pod that mounts a PersistentVolumeClaim (the
 *     helper pod's shape, under any name);
 *   - the k8s-ha reseed module never scales the db to zero, and never joins a
 *     kubectl argv into an unquoted remote string (C13);
 *   - the cold deploy reaches the same in-place mechanism failover and
 *     restore use.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Every file under `dir` with one of `exts`, skipping vendored trees. */
function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.endsWith(x))) out.push(p);
  }
  return out;
}

const SHIPPED = [
  ...walk(join(ROOT, 'src'), ['.js', '.mjs', '.sh', '.yaml', '.yml']),
  ...walk(join(ROOT, 'carbon'), ['.js', '.mjs', '.ts', '.sh', '.yaml', '.yml', '.sql']),
];

/** The helper-pod path's names: its pod, its exports, its detach plumbing. */
const HELPER_POD_NAMES =
  /vibecarbon-pgdata-swap|PGDATA_SWAP_POD|PGDATA_SWAP_MOUNT_ROOT|swapPgdataViaHelperPod|buildPgdataSwapPodManifest|parsePgdataClaimFromPodJson|waitForPvDetach|deleteStaleDbVolumeAttachments/;

/**
 * A Pod built in JS that mounts a PVC: `kind: 'Pod'` (any quote) with a
 * `persistentVolumeClaim` within the same object literal's reach.
 */
const POD_WITH_PVC = /kind:\s*['"`]Pod['"`][\s\S]{0,1500}?persistentVolumeClaim/;

/** The unquoted remote kubectl join the reseed closure used to build (C13). */
const BARE_KUBECTL_JOIN = /\[\s*['"`]kubectl['"`]\s*,\s*\.\.\.\w+\s*\]\.join\(/;

const rel = (f: string) => relative(ROOT, f);

describe('the helper-pod reseed path stays deleted', () => {
  it('the matchers see what they ban (they cannot go blind)', () => {
    expect(HELPER_POD_NAMES.test("const name = 'vibecarbon-pgdata-swap';")).toBe(true);
    expect(HELPER_POD_NAMES.test('await swapPgdataViaHelperPod(k, o);')).toBe(true);
    expect(
      POD_WITH_PVC.test(
        "JSON.stringify({ kind: 'Pod', spec: { volumes: [{ name: 'p', persistentVolumeClaim: { claimName } }] } })",
      ),
    ).toBe(true);
    expect(POD_WITH_PVC.test("{ kind: 'StatefulSet', persistentVolumeClaim: {} }")).toBe(false);
    expect(BARE_KUBECTL_JOIN.test("['kubectl', ...argv].join(' ')")).toBe(true);
    expect(BARE_KUBECTL_JOIN.test("shJoin(['kubectl', ...argv])")).toBe(false);
  });

  it('no shipped file names the helper pod or its plumbing', () => {
    expect(SHIPPED.length).toBeGreaterThan(50);
    const hits = SHIPPED.filter((f) => HELPER_POD_NAMES.test(readFileSync(f, 'utf-8'))).map(rel);
    expect(hits, 'helper-pod reseed names in shipped files').toEqual([]);
  });

  it('no code in src builds a Pod that mounts a PersistentVolumeClaim', () => {
    const hits = walk(join(ROOT, 'src'), ['.js', '.mjs'])
      .filter((f) => POD_WITH_PVC.test(readFileSync(f, 'utf-8')))
      .map(rel);
    expect(hits, 'a CLI-built Pod mounting a PVC').toEqual([]);
  });

  it('the k8s-ha reseed module never scales the db to zero and quotes every remote kubectl', () => {
    const src = readFileSync(join(ROOT, 'src/lib/deploy/k8s/ha/index.js'), 'utf-8');
    expect(src).not.toMatch(/--replicas=0/);
    expect(src).not.toMatch(BARE_KUBECTL_JOIN);
    expect(readFileSync(join(ROOT, 'src/lib/deploy/replication.js'), 'utf-8')).not.toMatch(
      BARE_KUBECTL_JOIN,
    );
  });

  it('the cold deploy seeds through the in-place mechanism failover and restore use', () => {
    const ha = readFileSync(join(ROOT, 'src/lib/deploy/k8s/ha/index.js'), 'utf-8');
    const rep = readFileSync(join(ROOT, 'src/lib/deploy/replication.js'), 'utf-8');
    // The cold deploy (setupReplication) and reseedStandbyFromPrimary (failover,
    // restore) both stage with the one in-place stage builder and run the one
    // in-place reseed.
    expect(ha).toMatch(/reseedStandbyInPlace\(/);
    expect(ha).toMatch(/buildInPlaceReseedStageScript\(/);
    const fromPrimary = rep.match(
      /export async function reseedStandbyFromPrimary[\s\S]*?\n}\n/,
    )?.[0];
    expect(fromPrimary).toMatch(/reseedStandbyInPlace\(/);
    expect(fromPrimary).toMatch(/buildInPlaceReseedStageScript\(/);
  });
});
